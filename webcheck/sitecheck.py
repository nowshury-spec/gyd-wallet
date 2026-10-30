"""
sitecheck.py — Standalone HTTP reconnaissance module for WebCheck.

Performs basic HTTP fingerprinting against a target URL:
  * Server / technology headers
  * Redirect chain
  * Common sensitive-file probes (.env, .git/config, robots.txt, etc.)
  * Admin-panel detection
  * Directory listing detection

Findings from here are combined with passive_checks.py (TLS, headers,
cookies, CORS) and the active/deep scan modules to form the full report.

This is a self-contained replacement for the external sitecheck package so
the app runs out of the box without additional dependencies.
"""

import os
import re
import requests
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import urljoin, urlparse

requests.packages.urllib3.disable_warnings()

TIMEOUT = 12
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
HEADERS = {"User-Agent": USER_AGENT}


@dataclass
class Finding:
    severity: str
    title: str
    detail: str
    fix: str
    evidence: str = ""
    category: str = ""
    cve: str = ""


class SiteCheck:
    """Lightweight HTTP reconnaissance scanner."""

    def __init__(self, url: str):
        url = url.strip()
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        self.url = url
        self.target = url
        self.findings: List[Finding] = []
        self._session = requests.Session()
        self._session.headers.update(HEADERS)
        self._session.verify = False
        self._resp: Optional[requests.Response] = None

    def run(self):
        try:
            self._resp = self._session.get(self.url, timeout=TIMEOUT, allow_redirects=True)
            self.target = self._resp.url
        except requests.RequestException as e:
            self.findings.append(Finding(
                severity="INFO",
                title="Target unreachable",
                detail=f"Could not connect to {self.url}: {e}",
                fix="Verify the URL is correct and the server is online.",
                category="connectivity",
            ))
            return

        self._check_server_header()
        self._check_tech_headers()
        self._check_sensitive_files()
        self._check_admin_panels()
        self._check_directory_listing()
        self._check_http_methods()

    # ── Individual checks ─────────────────────────────────────

    def _check_server_header(self):
        server = self._resp.headers.get("Server", "")
        powered = self._resp.headers.get("X-Powered-By", "")
        if server:
            self.findings.append(Finding(
                severity="LOW",
                title="Server version disclosed",
                detail=f"The Server header reveals: {server}",
                fix="Remove or genericise the Server header (e.g. 'Server: webserver').",
                evidence=f"Server: {server}",
                category="information disclosure",
            ))
        if powered:
            self.findings.append(Finding(
                severity="LOW",
                title="Technology stack disclosed (X-Powered-By)",
                detail=f"The X-Powered-By header reveals: {powered}",
                fix="Remove the X-Powered-By header in your server/framework config.",
                evidence=f"X-Powered-By: {powered}",
                category="information disclosure",
            ))

    def _check_tech_headers(self):
        headers = self._resp.headers
        body = self._resp.text[:50000]

        techs = []
        if "wp-content" in body or "wp-includes" in body:
            techs.append("WordPress")
        if "Shopify" in headers.get("X-ShopId", "") or "shopify" in body.lower():
            techs.append("Shopify")
        if "laravel_session" in headers.get("Set-Cookie", "").lower():
            techs.append("Laravel")
        if "csrftoken" in headers.get("Set-Cookie", "") and "django" in body.lower():
            techs.append("Django")
        if "express" in headers.get("X-Powered-By", "").lower():
            techs.append("Express/Node.js")
        if "ASP.NET" in headers.get("X-Powered-By", ""):
            techs.append("ASP.NET")
        if "__cf_bm" in headers.get("Set-Cookie", ""):
            techs.append("Cloudflare")
        if headers.get("X-Drupal-Cache") or "drupal" in body.lower()[:5000]:
            techs.append("Drupal")

        if techs:
            self.findings.append(Finding(
                severity="INFO",
                title=f"Detected technologies: {', '.join(techs)}",
                detail=f"The following technologies were fingerprinted: {', '.join(techs)}. "
                       f"Knowing the stack helps an attacker pick targeted exploits.",
                fix="Minimise technology fingerprints by removing version-specific headers, "
                    "default error pages, and generator meta tags.",
                evidence=f"Detected: {', '.join(techs)}",
                category="information disclosure",
            ))

    def _check_sensitive_files(self):
        probes = [
            (".env", "CRITICAL", "Environment file exposed (.env)",
             "Contains database passwords, API keys, secrets.",
             "sensitive file"),
            (".git/config", "HIGH", "Git repository exposed (.git/config)",
             "Attackers can download the entire source code and commit history.",
             "sensitive file"),
            ("robots.txt", "INFO", "robots.txt found",
             "May reveal hidden paths that the site owner wants to keep from crawlers.",
             "information disclosure"),
            (".htaccess", "MEDIUM", "Apache .htaccess file exposed",
             "May contain rewrite rules, authentication directives, or internal paths.",
             "sensitive file"),
            ("wp-config.php.bak", "CRITICAL", "WordPress config backup exposed",
             "Contains database credentials in plain text.",
             "sensitive file"),
            ("backup.sql", "CRITICAL", "SQL backup file exposed",
             "Full database dump accessible from the web.",
             "sensitive file"),
            ("phpinfo.php", "MEDIUM", "phpinfo() page exposed",
             "Reveals PHP version, loaded modules, server paths, and environment variables.",
             "information disclosure"),
            ("server-status", "MEDIUM", "Apache server-status exposed",
             "Reveals active connections, request URIs, and client IPs.",
             "information disclosure"),
            (".DS_Store", "LOW", "macOS .DS_Store file exposed",
             "Reveals directory contents and filenames on the server.",
             "sensitive file"),
            ("crossdomain.xml", "INFO", "crossdomain.xml found",
             "Flash cross-domain policy — may allow data access from any origin.",
             "information disclosure"),
        ]
        for path, severity, title, detail, category in probes:
            try:
                url = urljoin(self.url + "/", path)
                r = self._session.get(url, timeout=TIMEOUT, allow_redirects=False)
                if r.status_code == 200 and len(r.text) > 5:
                    # Filter false positives: custom 404 pages
                    if path == "robots.txt" and "user-agent" not in r.text.lower():
                        continue
                    if path == ".env" and ("=" not in r.text[:500]):
                        continue
                    if path == ".git/config" and "[core]" not in r.text[:500]:
                        continue
                    snippet = r.text[:200].replace("\n", " ").strip()
                    self.findings.append(Finding(
                        severity=severity, title=title,
                        detail=detail,
                        fix=f"Remove or restrict access to /{path}. "
                            f"Add a deny rule in your web server config.",
                        evidence=f"GET /{path} → 200 OK. Preview: {snippet}",
                        category=category,
                    ))
            except requests.RequestException:
                continue

    def _check_admin_panels(self):
        panels = [
            "admin", "administrator", "wp-admin", "wp-login.php",
            "admin/login", "cpanel", "phpmyadmin", "adminer.php",
            "manager/html", "_admin", "backend", "dashboard/login",
        ]
        found = []
        for path in panels:
            try:
                url = urljoin(self.url + "/", path)
                r = self._session.get(url, timeout=8, allow_redirects=True)
                if r.status_code == 200 and ("login" in r.text.lower()[:3000]
                                              or "password" in r.text.lower()[:3000]
                                              or "sign in" in r.text.lower()[:3000]):
                    found.append(f"/{path} → {r.status_code}")
            except requests.RequestException:
                continue

        if found:
            self.findings.append(Finding(
                severity="MEDIUM",
                title=f"Admin panel(s) found ({len(found)})",
                detail="Publicly accessible admin login pages were found. "
                       "These are brute-force targets.",
                fix="Restrict admin panel access by IP, add rate limiting, "
                    "and use multi-factor authentication.",
                evidence="; ".join(found),
                category="information disclosure",
            ))

    def _check_directory_listing(self):
        dirs = ["images/", "uploads/", "assets/", "static/", "files/",
                "css/", "js/", "backup/", "data/"]
        for d in dirs:
            try:
                url = urljoin(self.url + "/", d)
                r = self._session.get(url, timeout=8, allow_redirects=False)
                if r.status_code == 200 and "index of" in r.text.lower()[:2000]:
                    self.findings.append(Finding(
                        severity="MEDIUM",
                        title=f"Directory listing enabled at /{d}",
                        detail=f"The directory /{d} shows its contents. Attackers can "
                               f"browse and download every file in it.",
                        fix="Disable directory listing: Apache — 'Options -Indexes'; "
                            "Nginx — 'autoindex off;'.",
                        evidence=f"GET /{d} → 200 with 'Index of' in body",
                        category="directory listing",
                    ))
                    break  # One finding is enough
            except requests.RequestException:
                continue

    def _check_http_methods(self):
        try:
            r = self._session.options(self.url, timeout=TIMEOUT)
            allow = r.headers.get("Allow", "")
            if allow:
                dangerous = [m for m in ["PUT", "DELETE", "TRACE", "CONNECT"]
                             if m in allow.upper()]
                if dangerous:
                    self.findings.append(Finding(
                        severity="MEDIUM",
                        title=f"Dangerous HTTP methods enabled: {', '.join(dangerous)}",
                        detail=f"The server allows: {allow}. Methods like PUT/DELETE "
                               f"can let attackers upload or remove files.",
                        fix="Disable unnecessary HTTP methods in your web server config.",
                        evidence=f"Allow: {allow}",
                        category="insecure configuration",
                    ))
        except requests.RequestException:
            pass


def ai_explain(url: str, findings: list, model: str = "claude-sonnet-4-20250514",
               platform: str = "the detected platform") -> Optional[str]:
    """Use the Anthropic API to generate a plain-English analysis and patch guide."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
    except Exception:
        return None

    finding_text = "\n".join(
        f"- [{getattr(f, 'severity', 'INFO')}] {getattr(f, 'title', str(f))}"
        for f in findings[:20]
    )

    prompt = (
        f"You are a senior penetration tester writing a findings summary for "
        f"a client. The target is {url} running on {platform}.\n\n"
        f"Findings:\n{finding_text}\n\n"
        f"Write a concise, professional analysis:\n"
        f"1. Overall risk assessment (1-2 sentences)\n"
        f"2. The most critical findings and why they matter\n"
        f"3. Recommended remediation steps, ordered by priority\n\n"
        f"Write clearly for a non-technical executive. No markdown headers — "
        f"use plain text with numbered sections."
    )

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text
    except Exception:
        return None

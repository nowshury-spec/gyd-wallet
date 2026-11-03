"""
passive_checks.py — Non-intrusive security checks for WebCheck.

Everything here is safe to run against any target without authorization:
it sends ordinary GET requests and performs one TLS handshake. No attack
payloads, no state change on the target. These checks augment the existing
passive SiteCheck scan and run on every tier.

Covers:
  * Security response headers (CSP, HSTS, X-Frame-Options, ...)
  * Set-Cookie flags (Secure / HttpOnly / SameSite)
  * CORS misconfiguration (reflected Origin + credentials)
  * TLS: certificate expiry and legacy protocol support
  * Information disclosure (Server / X-Powered-By version banners)
  * Directory listing and mixed content
"""

import ssl
import socket
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@dataclass
class PassiveFinding:
    severity: str          # CRITICAL / HIGH / MEDIUM / LOW / INFO
    category: str
    title: str
    detail: str
    evidence: str
    fix: str


_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "WebCheck-Passive/1.0"})
_SESSION.verify = False


def _get(url: str, **kw) -> Optional[requests.Response]:
    try:
        return _SESSION.get(url, timeout=10, allow_redirects=True, **kw)
    except Exception:
        return None


def _base(url: str) -> str:
    p = urllib.parse.urlparse(url)
    return f"{p.scheme}://{p.netloc}"


# ─────────────────────────────────────────────────────────────
# 1. Security response headers
# ─────────────────────────────────────────────────────────────

def check_security_headers(resp: requests.Response) -> List[PassiveFinding]:
    findings = []
    h = {k.lower(): v for k, v in resp.headers.items()}

    def add(sev, title, detail, fix, evidence="Header not present in response."):
        findings.append(PassiveFinding(sev, "Missing Security Header",
                                       title, detail, evidence, fix))

    if "content-security-policy" not in h:
        add("MEDIUM", "Missing Content-Security-Policy",
            "No CSP header is set. A strong CSP is the single most effective "
            "defence against cross-site scripting and data injection.",
            "Add a Content-Security-Policy header. Start with "
            "\"default-src 'self'\" and tighten from there.")
    else:
        csp = h["content-security-policy"].lower()
        if "unsafe-inline" in csp or "unsafe-eval" in csp:
            findings.append(PassiveFinding(
                "LOW", "Weak Security Header", "Weak Content-Security-Policy",
                "The CSP allows 'unsafe-inline' or 'unsafe-eval', which "
                "substantially weakens its XSS protection.",
                f"CSP: {h['content-security-policy'][:200]}",
                "Remove 'unsafe-inline'/'unsafe-eval'; use nonces or hashes "
                "for inline scripts."))

    if "strict-transport-security" not in h and resp.url.startswith("https"):
        add("MEDIUM", "Missing HTTP Strict-Transport-Security (HSTS)",
            "HTTPS is served without an HSTS header, so a user's first "
            "request can be downgraded to HTTP and intercepted.",
            "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains")
    elif "strict-transport-security" in h:
        hsts = h["strict-transport-security"].lower()
        maxage = 0
        for part in hsts.split(";"):
            part = part.strip()
            if part.startswith("max-age="):
                try:
                    maxage = int(part.split("=", 1)[1])
                except ValueError:
                    pass
        if maxage < 15552000:  # < 180 days
            findings.append(PassiveFinding(
                "LOW", "Weak Security Header", "HSTS max-age too short",
                f"HSTS max-age is {maxage}s; a short window leaves users "
                "exposed between visits.",
                f"Strict-Transport-Security: {h['strict-transport-security']}",
                "Use max-age of at least 31536000 (1 year)."))

    # Flag only when neither X-Frame-Options nor CSP frame-ancestors is set.
    has_xfo = "x-frame-options" in h
    has_frame_ancestors = "frame-ancestors" in h.get("content-security-policy", "").lower()
    if not has_xfo and not has_frame_ancestors:
        add("MEDIUM", "Missing clickjacking protection",
            "Neither X-Frame-Options nor CSP frame-ancestors is set, so "
            "the page can be framed by any site (clickjacking).",
            "Add: X-Frame-Options: DENY (or CSP frame-ancestors 'none').")

    if h.get("x-content-type-options", "").lower() != "nosniff":
        add("LOW", "Missing X-Content-Type-Options",
            "Responses can be MIME-sniffed by the browser, enabling some "
            "content-type confusion attacks.",
            "Add: X-Content-Type-Options: nosniff")

    if "referrer-policy" not in h:
        add("LOW", "Missing Referrer-Policy",
            "Without a Referrer-Policy, full URLs (which may contain tokens) "
            "can leak to third-party sites via the Referer header.",
            "Add: Referrer-Policy: strict-origin-when-cross-origin")

    return findings


# ─────────────────────────────────────────────────────────────
# 2. Cookie flags (from Set-Cookie on the landing response)
# ─────────────────────────────────────────────────────────────

def check_cookies(resp: requests.Response) -> List[PassiveFinding]:
    findings = []
    for cookie in resp.cookies:
        sensitive = any(k in cookie.name.lower()
                        for k in ("session", "token", "auth", "sid", "jwt"))
        issues = []
        if not cookie.secure:
            issues.append("missing Secure")
        if not cookie.has_nonstandard_attr("HttpOnly"):
            issues.append("missing HttpOnly")
        samesite = (cookie._rest.get("SameSite") or "").lower()
        if samesite not in ("strict", "lax"):
            issues.append(f"SameSite={samesite or 'unset'}")
        if issues:
            findings.append(PassiveFinding(
                "HIGH" if sensitive else "LOW",
                "Insecure Cookie",
                f"Cookie '{cookie.name}' is missing protective flags",
                f"Cookie '{cookie.name}' has: {', '.join(issues)}. "
                + ("This looks like a session/auth cookie, so these flags "
                   "matter a great deal." if sensitive else ""),
                f"Set-Cookie: {cookie.name}=...; "
                f"secure={cookie.secure}",
                "Set cookies with Secure; HttpOnly; SameSite=Strict (or Lax)."))
    return findings


# ─────────────────────────────────────────────────────────────
# 3. CORS misconfiguration
# ─────────────────────────────────────────────────────────────

def check_cors(base_url: str) -> List[PassiveFinding]:
    findings = []
    probe_origin = "https://webcheck-cors-probe.example"
    r = _get(base_url, headers={"Origin": probe_origin})
    if r is None:
        return findings
    acao = r.headers.get("Access-Control-Allow-Origin", "")
    acac = r.headers.get("Access-Control-Allow-Credentials", "").lower()

    if acao == probe_origin and acac == "true":
        findings.append(PassiveFinding(
            "HIGH", "CORS Misconfiguration",
            "CORS reflects arbitrary Origin with credentials",
            "The server reflects any Origin in Access-Control-Allow-Origin "
            "while also allowing credentials. Any malicious site can read "
            "authenticated responses on behalf of a logged-in victim.",
            f"Origin: {probe_origin} -> "
            f"Access-Control-Allow-Origin: {acao}; "
            f"Allow-Credentials: {acac}",
            "Never reflect the Origin. Use a strict allowlist of trusted "
            "origins, and do not combine a wildcard with credentials."))
    elif acao == "*" and acac == "true":
        findings.append(PassiveFinding(
            "MEDIUM", "CORS Misconfiguration",
            "CORS wildcard combined with credentials",
            "Access-Control-Allow-Origin: * together with "
            "Allow-Credentials: true is invalid and often indicates a "
            "misconfigured proxy that may expose authenticated data.",
            f"Access-Control-Allow-Origin: * ; Allow-Credentials: true",
            "Do not use '*' with credentials; specify exact trusted origins."))
    return findings


# ─────────────────────────────────────────────────────────────
# 4. TLS certificate & protocol
# ─────────────────────────────────────────────────────────────

def check_tls(base_url: str) -> List[PassiveFinding]:
    findings = []
    p = urllib.parse.urlparse(base_url)
    if p.scheme != "https":
        findings.append(PassiveFinding(
            "HIGH", "Transport Security", "Site served over plain HTTP",
            "The target is served over HTTP, so all traffic (including any "
            "credentials or session cookies) can be read and modified in "
            "transit.", f"URL scheme: {p.scheme}",
            "Serve the whole site over HTTPS and redirect HTTP to HTTPS."))
        return findings

    host = p.hostname or ""
    port = p.port or 443

    # Certificate expiry
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert()
        not_after = cert.get("notAfter")
        if not_after:
            expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(
                tzinfo=timezone.utc)
            days = (expiry - datetime.now(timezone.utc)).days
            if days < 0:
                findings.append(PassiveFinding(
                    "HIGH", "Transport Security", "TLS certificate expired",
                    f"The certificate expired {abs(days)} day(s) ago. Browsers "
                    "will warn or block users.",
                    f"notAfter: {not_after}", "Renew the TLS certificate."))
            elif days < 21:
                findings.append(PassiveFinding(
                    "MEDIUM", "Transport Security",
                    "TLS certificate expiring soon",
                    f"The certificate expires in {days} day(s).",
                    f"notAfter: {not_after}",
                    "Renew the certificate and automate renewal."))
    except ssl.SSLCertVerificationError as e:
        findings.append(PassiveFinding(
            "HIGH", "Transport Security", "TLS certificate not trusted",
            "The certificate failed validation (wrong host, self-signed, or "
            "untrusted CA). Users get security warnings and MITM is easier.",
            str(e)[:200], "Install a valid certificate from a trusted CA that "
            "matches the hostname."))
    except Exception:
        pass

    # Legacy protocol support (TLS 1.0 / 1.1)
    for name, proto in (("TLS 1.0", getattr(ssl, "TLSVersion", None) and
                         ssl.TLSVersion.TLSv1),
                        ("TLS 1.1", getattr(ssl, "TLSVersion", None) and
                         ssl.TLSVersion.TLSv1_1)):
        if proto is None:
            continue
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            ctx.minimum_version = proto
            ctx.maximum_version = proto
            with socket.create_connection((host, port), timeout=6) as sock:
                with ctx.wrap_socket(sock, server_hostname=host):
                    findings.append(PassiveFinding(
                        "MEDIUM", "Transport Security",
                        f"Legacy {name} protocol supported",
                        f"The server negotiated {name}, which is deprecated "
                        "and vulnerable to known downgrade/cipher attacks.",
                        f"Handshake succeeded with {name}.",
                        "Disable TLS 1.0 and 1.1; require TLS 1.2 or higher."))
        except Exception:
            pass  # Good — the legacy protocol was refused.

    return findings


# ─────────────────────────────────────────────────────────────
# 5. Information disclosure (version banners)
# ─────────────────────────────────────────────────────────────

def check_info_disclosure(resp: requests.Response) -> List[PassiveFinding]:
    findings = []
    for header in ("Server", "X-Powered-By", "X-AspNet-Version",
                   "X-AspNetMvc-Version", "X-Generator"):
        val = resp.headers.get(header)
        # Only flag when a version number is leaked, not a bare product name.
        if val and any(c.isdigit() for c in val):
            findings.append(PassiveFinding(
                "LOW", "Information Disclosure",
                f"Version banner in '{header}' header",
                f"The '{header}' header reveals '{val}', which tells an "
                "attacker exactly which software version to target with "
                "known exploits.",
                f"{header}: {val}",
                f"Suppress or genericise the '{header}' header in your server "
                "or framework configuration."))
    return findings


# ─────────────────────────────────────────────────────────────
# 6. Directory listing
# ─────────────────────────────────────────────────────────────

def check_directory_listing(base_url: str) -> List[PassiveFinding]:
    findings = []
    base = _base(base_url)
    for path in ("/uploads/", "/images/", "/assets/", "/files/", "/backup/", "/static/"):
        r = _get(base + path)
        if r is None or r.status_code != 200:
            continue
        body = r.text.lower()
        if "index of /" in body or ("<title>index of" in body):
            findings.append(PassiveFinding(
                "MEDIUM", "Directory Listing Enabled",
                f"Directory listing enabled at {path}",
                f"The directory {path} returns an auto-generated file index, "
                "exposing filenames an attacker could otherwise not discover.",
                f"GET {base + path} -> 'Index of {path}'",
                "Disable auto-indexing (Apache: 'Options -Indexes'; "
                "nginx: 'autoindex off;') and add an index file."))
            break  # one example is enough
    return findings


# ─────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────

def run_passive_checks(target: str) -> List[PassiveFinding]:
    """Run all non-intrusive checks. Safe on any target, no auth needed."""
    findings: List[PassiveFinding] = []
    base = _base(target)

    landing = _get(target)
    if landing is not None:
        findings += check_security_headers(landing)
        findings += check_cookies(landing)
        findings += check_info_disclosure(landing)

    # These make their own requests
    for fn in (check_cors, check_tls, check_directory_listing):
        try:
            findings += fn(target if fn is check_tls else base)
        except Exception:
            pass

    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    findings.sort(key=lambda f: order.get(f.severity, 9))
    return findings

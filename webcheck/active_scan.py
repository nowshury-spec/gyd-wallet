"""
active_scan.py — Active penetration testing module for WebCheck.

LEGAL NOTICE: These tests MUST only run against targets where written
permission has been granted. The calling code enforces this gate.
Never invoke directly without a signed authorization on file.

Uses OWASP ZAP via its REST API (running as a daemon on localhost:8090).
Falls back to direct Python probes when ZAP is unavailable.
"""

import re
import time
import json
import socket
import urllib.parse
import requests
from dataclasses import dataclass, field
from typing import List, Optional

# ── Silence SSL warnings for deliberate test probes ──
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ZAP_BASE = "http://127.0.0.1:8090"
ZAP_API_KEY = "webcheck-zap-key"   # set in ZAP daemon startup args


@dataclass
class ActiveFinding:
    severity: str        # CRITICAL / HIGH / MEDIUM / LOW / INFO
    category: str        # e.g. "SQL Injection", "XSS"
    title: str
    detail: str
    evidence: str        # actual response snippet / payload that confirmed it
    fix: str


# ─────────────────────────────────────────────────────────────
# ZAP helpers
# ─────────────────────────────────────────────────────────────

def _zap(path: str, params: dict = None) -> dict:
    """Call ZAP REST API. Returns {} on error."""
    try:
        r = requests.get(
            f"{ZAP_BASE}{path}",
            params={**(params or {}), "apikey": ZAP_API_KEY},
            timeout=10,
        )
        return r.json()
    except Exception:
        return {}


def zap_available() -> bool:
    result = _zap("/JSON/core/view/version/")
    return bool(result.get("version"))


def zap_spider(target: str) -> None:
    """Spider the target so ZAP builds a URL tree."""
    data = _zap("/JSON/spider/action/scan/", {"url": target, "maxChildren": 5})
    scan_id = data.get("scan", "0")
    for _ in range(30):          # wait up to 60 s
        prog = _zap("/JSON/spider/view/status/", {"scanId": scan_id})
        if prog.get("status") == "100":
            break
        time.sleep(2)


def zap_active_scan(target: str) -> str:
    """Run ZAP active scanner, return scan ID."""
    data = _zap("/JSON/ascan/action/scan/", {
        "url": target,
        "recurse": "true",
        "inScopeOnly": "true",
        "scanPolicyName": "",
        "method": "",
        "postData": "",
    })
    return data.get("scan", "0")


def zap_wait_for_scan(scan_id: str, timeout: int = 300) -> None:
    elapsed = 0
    while elapsed < timeout:
        prog = _zap("/JSON/ascan/view/status/", {"scanId": scan_id})
        if prog.get("status") == "100":
            return
        time.sleep(5)
        elapsed += 5


def zap_alerts(target: str) -> List[ActiveFinding]:
    """Pull ZAP alerts and convert to ActiveFinding objects."""
    data = _zap("/JSON/alert/view/alerts/", {"baseurl": target, "start": "0", "count": "200"})
    findings = []
    for a in data.get("alerts", []):
        risk = a.get("risk", "Informational")
        sev_map = {"High": "HIGH", "Medium": "MEDIUM", "Low": "LOW", "Informational": "INFO"}
        # ZAP calls SQL injection / code exec "High"; we surface those as CRITICAL
        name = a.get("alert", "")
        sev = sev_map.get(risk, "INFO")
        if sev == "HIGH" and any(k in name for k in ["SQL", "Injection", "Remote Code", "Command"]):
            sev = "CRITICAL"
        findings.append(ActiveFinding(
            severity=sev,
            category=name,
            title=name,
            detail=f"{a.get('description', '')} URL: {a.get('url', '')}",
            evidence=a.get("evidence", "")[:400],
            fix=a.get("solution", "Refer to OWASP remediation guidance."),
        ))
    return findings


# ─────────────────────────────────────────────────────────────
# Fallback Python probes (no ZAP required)
# ─────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "WebCheck-Security-Scanner/1.0 (authorized pentest)"})
SESSION.verify = False


def _get(url: str, **kwargs) -> Optional[requests.Response]:
    try:
        return SESSION.get(url, timeout=10, allow_redirects=True, **kwargs)
    except Exception:
        return None


def _post(url: str, data: dict, **kwargs) -> Optional[requests.Response]:
    try:
        return SESSION.post(url, data=data, timeout=10, allow_redirects=True, **kwargs)
    except Exception:
        return None


# ── SQL injection ──────────────────────────────────────────────

# Non-destructive detection payloads only. We deliberately do NOT include
# stacked/destructive statements (e.g. DROP TABLE): a scanner must never risk
# damaging a client's data. Injection is confirmed by provoking a DB error,
# not by modifying state.
SQL_PAYLOADS = ["'", "' OR '1'='1", "\" OR \"1\"=\"1", "1')"]
SQL_ERRORS   = [
    "you have an error in your sql syntax",
    "warning: mysql",
    "unclosed quotation mark",
    "quoted string not properly terminated",
    "pg_query",
    "ORA-",
    "Microsoft OLE DB",
    "SQLSTATE",
]


def probe_sqli(base_url: str) -> List[ActiveFinding]:
    findings = []
    # Try common param names on the base URL
    for param in ["id", "page", "cat", "user", "q", "search"]:
        # Baseline with a benign value: if the page already shows a DB error
        # for normal input, our payload proves nothing — skip to avoid a
        # false positive.
        baseline = _get(f"{base_url}?{param}=1")
        baseline_body = baseline.text.lower() if baseline else ""
        if any(err.lower() in baseline_body for err in SQL_ERRORS):
            continue
        for payload in SQL_PAYLOADS:
            test_url = f"{base_url}?{param}={urllib.parse.quote(payload)}"
            r = _get(test_url)
            if r is None:
                continue
            body = r.text.lower()
            for err in SQL_ERRORS:
                # Error must appear with the payload but not with benign input.
                if err.lower() in body and err.lower() not in baseline_body:
                    findings.append(ActiveFinding(
                        severity="CRITICAL",
                        category="SQL Injection",
                        title=f"SQL Injection — parameter '{param}'",
                        detail=f"The parameter '{param}' reflects a database error when sent the payload: {payload}",
                        evidence=f"Error pattern '{err}' found in response to: {test_url}",
                        fix=(
                            "Use parameterised queries / prepared statements. "
                            "Never concatenate user input into SQL strings. "
                            "Example (PHP PDO): $stmt = $pdo->prepare('SELECT * FROM users WHERE id = ?'); $stmt->execute([$id]);"
                        ),
                    ))
                    return findings   # one confirmed finding is enough; stop flooding
    return findings


# ── Reflected XSS ──────────────────────────────────────────────

XSS_PAYLOAD = "<script>alert('xss-webcheck')</script>"
XSS_ALT     = '"><img src=x onerror=alert(1)>'


def probe_xss(base_url: str) -> List[ActiveFinding]:
    findings = []
    for param in ["q", "search", "name", "message", "comment", "query"]:
        for payload in [XSS_PAYLOAD, XSS_ALT]:
            test_url = f"{base_url}?{param}={urllib.parse.quote(payload)}"
            r = _get(test_url)
            if r and payload.lower() in r.text.lower():
                findings.append(ActiveFinding(
                    severity="HIGH",
                    category="Cross-Site Scripting (XSS)",
                    title=f"Reflected XSS — parameter '{param}'",
                    detail=f"The payload {payload!r} was reflected unescaped in the response.",
                    evidence=f"Payload reflected at: {test_url}",
                    fix=(
                        "Escape all user-supplied output with htmlspecialchars() (PHP), "
                        "{{ value }} in Django/Jinja2, or React's JSX auto-escaping. "
                        "Add a Content-Security-Policy header to limit script execution."
                    ),
                ))
                return findings
    return findings


# ── Open redirect ──────────────────────────────────────────────

REDIRECT_PAYLOADS = [
    "https://evil.com",
    "//evil.com",
    "/\\evil.com",
]


def probe_open_redirect(base_url: str) -> List[ActiveFinding]:
    findings = []
    for param in ["redirect", "next", "url", "return", "returnUrl", "goto", "dest"]:
        for payload in REDIRECT_PAYLOADS:
            test_url = f"{base_url}?{param}={urllib.parse.quote(payload)}"
            r = _get(test_url, allow_redirects=False)
            if r and r.status_code in (301, 302, 303, 307, 308):
                loc = r.headers.get("Location", "")
                if "evil.com" in loc or loc.startswith("//"):
                    findings.append(ActiveFinding(
                        severity="MEDIUM",
                        category="Open Redirect",
                        title=f"Open Redirect — parameter '{param}'",
                        detail=f"The server redirected to an attacker-controlled URL: {loc}",
                        evidence=f"GET {test_url}  →  Location: {loc}",
                        fix=(
                            "Validate redirect targets against an allowlist of trusted domains. "
                            "Never trust user-supplied redirect URLs without verification."
                        ),
                    ))
                    return findings
    return findings


# ── Default / weak credentials on admin panels ─────────────────

ADMIN_PATHS = ["/wp-login.php", "/admin/login", "/administrator/index.php", "/login", "/user/login"]
WEAK_CREDS  = [("admin", "admin"), ("admin", "password"), ("admin", "123456"), ("root", "root")]


def probe_weak_creds(base_url: str) -> List[ActiveFinding]:
    findings = []
    host = urllib.parse.urlparse(base_url).scheme + "://" + urllib.parse.urlparse(base_url).netloc
    for path in ADMIN_PATHS:
        login_url = host + path
        r = _get(login_url)
        if r is None or r.status_code != 200:
            continue
        # Found a login page — try weak credentials
        for user, passwd in WEAK_CREDS:
            resp = _post(login_url, data={"username": user, "password": passwd,
                                          "log": user, "pwd": passwd, "wp-submit": "Log+In"})
            if resp is None:
                continue
            # Heuristic: if we're no longer on the login page, login succeeded
            if resp.url != login_url and "logout" in resp.text.lower():
                findings.append(ActiveFinding(
                    severity="CRITICAL",
                    category="Weak Credentials",
                    title=f"Default credentials accepted at {path}",
                    detail=f"Login succeeded with username='{user}' password='{passwd}'",
                    evidence=f"POST {login_url} → redirected to {resp.url}",
                    fix=(
                        "Immediately change admin credentials to a strong, unique password. "
                        "Enable two-factor authentication. "
                        "Consider restricting /admin and /wp-admin to specific IP addresses."
                    ),
                ))
                return findings
    return findings


# ── Port scan (top 20 common ports) ───────────────────────────

COMMON_PORTS = [21, 22, 23, 25, 53, 80, 443, 445, 1433, 1521,
                3306, 3389, 5432, 5900, 6379, 8080, 8443, 8888, 27017, 11211]
RISKY_PORTS  = {
    21:    ("FTP",           "HIGH",   "FTP transfers credentials in plaintext. Disable FTP; use SFTP instead."),
    23:    ("Telnet",        "CRITICAL","Telnet sends all data including passwords in plaintext. Disable immediately."),
    25:    ("SMTP relay",    "MEDIUM", "Open SMTP relay can be abused to send spam. Restrict to authorised senders."),
    445:   ("SMB",          "HIGH",   "SMB exposed to the internet is a critical risk (EternalBlue/WannaCry). Block at firewall."),
    1433:  ("MSSQL",        "HIGH",   "Database port should never be publicly exposed. Restrict to internal IPs only."),
    1521:  ("Oracle DB",    "HIGH",   "Database port publicly exposed. Restrict to internal IPs only."),
    3306:  ("MySQL",        "HIGH",   "MySQL port publicly exposed. Restrict to internal IPs only."),
    3389:  ("RDP",          "HIGH",   "RDP exposed to the internet is a frequent ransomware entry point. Use a VPN instead."),
    5432:  ("PostgreSQL",   "HIGH",   "Database port publicly exposed. Restrict to internal IPs only."),
    5900:  ("VNC",          "HIGH",   "VNC exposed to internet. Restrict to VPN or specific IPs."),
    6379:  ("Redis",        "CRITICAL","Redis has no auth by default. Publicly exposed Redis = full server compromise. Bind to 127.0.0.1."),
    8080:  ("Alt HTTP",     "LOW",    "Non-standard HTTP port exposed. Ensure this is intentional and traffic is encrypted."),
    27017: ("MongoDB",      "CRITICAL","MongoDB exposed to internet. Unauthenticated access likely. Bind to 127.0.0.1 immediately."),
    11211: ("Memcached",    "HIGH",   "Memcached exposed to internet. Used in DDoS amplification attacks. Bind to 127.0.0.1."),
}


def probe_ports(target: str) -> List[ActiveFinding]:
    findings = []
    hostname = urllib.parse.urlparse(target).hostname
    if not hostname:
        return findings
    try:
        ip = socket.gethostbyname(hostname)
    except Exception:
        return findings

    open_ports = []
    for port in COMMON_PORTS:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1.5)
            if s.connect_ex((ip, port)) == 0:
                open_ports.append(port)
            s.close()
        except Exception:
            pass

    for port in open_ports:
        if port in RISKY_PORTS:
            name, sev, fix = RISKY_PORTS[port]
            findings.append(ActiveFinding(
                severity=sev,
                category="Exposed Network Service",
                title=f"Dangerous port open: {port}/{name}",
                detail=f"Port {port} ({name}) is reachable from the public internet on {ip}.",
                evidence=f"TCP connect to {ip}:{port} succeeded.",
                fix=fix,
            ))
    return findings


# ─────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────

def run_active_scan(target: str, authorized: bool = False) -> List[ActiveFinding]:
    """
    Run active penetration tests against target.

    Parameters
    ----------
    target     : full URL, e.g. https://example.com
    authorized : MUST be True — caller confirms written permission exists.
                 Returns empty list if False.
    """
    if not authorized:
        raise PermissionError(
            "Active scan blocked: authorization flag not set. "
            "The site owner must provide written consent before active testing."
        )

    findings: List[ActiveFinding] = []

    if zap_available():
        # ── Full ZAP scan (preferred) ──────────────────────────
        zap_spider(target)
        scan_id = zap_active_scan(target)
        zap_wait_for_scan(scan_id, timeout=300)
        findings = zap_alerts(target)
    else:
        # ── Python fallback probes ────────────────────────────
        findings += probe_ports(target)
        findings += probe_sqli(target)
        findings += probe_xss(target)
        findings += probe_open_redirect(target)
        findings += probe_weak_creds(target)

    # Sort: CRITICAL first
    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    findings.sort(key=lambda f: order.get(f.severity, 9))
    return findings

"""
explain.py — Client-facing explanations for WebCheck findings.

For each finding we attach three things a client needs to understand the
risk in a report readout:

  * cause   — why the weakness exists (the underlying mistake)
  * attack  — how an attacker would actually exploit it, step by step
  * impact  — what the attacker gains / what the business loses

These are explanatory narratives for a remediation conversation, not
copy-paste exploit tooling. The concrete proof that the issue is real lives
in each finding's own `evidence` field (captured during the scan).

Lookup order: exact CWE/CVE tag, then a keyword match on the category.
"""

import re
from typing import Optional, Dict

# Keyed by the CWE/category tag stored on a finding (f["cve"]).
_BY_CODE: Dict[str, dict] = {
    "CWE-22": {  # Directory traversal / LFI
        "cause": (
            "The application builds a file path directly from user input "
            "(e.g. ?file=report.pdf) without checking that the result stays "
            "inside the intended folder."
        ),
        "attack": (
            "1. The attacker sees a parameter that names a file.\n"
            "2. They replace it with a path that climbs out of the web folder "
            "using ../ sequences (e.g. ../../../../etc/passwd).\n"
            "3. The server reads whatever that path points to and returns it.\n"
            "4. They now read source code, config files, and credential files "
            "at will, then use those secrets to log in elsewhere."
        ),
        "impact": (
            "Full read access to the server's filesystem: source code, "
            "database passwords, API keys and private certificates — usually "
            "the first step to a complete takeover."
        ),
    },
    "CWE-290": {  # Auth bypass via trusted header
        "cause": (
            "Access control trusts a request header such as X-Forwarded-For "
            "to decide whether a request is 'internal'. That header is sent by "
            "the client, so anyone can set it."
        ),
        "attack": (
            "1. The attacker requests a protected page and gets 403 Forbidden.\n"
            "2. They resend the same request adding X-Forwarded-For: 127.0.0.1.\n"
            "3. The server believes the request came from itself and returns "
            "the page.\n"
            "4. They browse the admin area as if they were on the internal "
            "network."
        ),
        "impact": (
            "Unauthenticated access to admin/internal functionality that was "
            "supposed to be restricted to trusted networks."
        ),
    },
    "CWE-863": {  # Auth bypass via path normalisation
        "cause": (
            "The authentication check runs on the raw request path, but the "
            "web server normalises the path differently afterwards, so a "
            "slightly altered URL slips past the check and still reaches the "
            "protected handler."
        ),
        "attack": (
            "1. The attacker finds /admin returns 403.\n"
            "2. They try variants like /admin/, /admin/./ or /admin..;/.\n"
            "3. One variant is not recognised by the auth filter but is still "
            "routed to the admin handler, returning 200 OK.\n"
            "4. They access protected functionality through the variant URL."
        ),
        "impact": (
            "Bypass of access controls on protected routes without any "
            "credentials."
        ),
    },
    "CWE-200": {  # Sensitive data / info exposure
        "cause": (
            "An endpoint returns more data than it should — secrets, internal "
            "fields, or a full API schema — often because responses are not "
            "filtered to a safe set of fields, or require no authentication."
        ),
        "attack": (
            "1. The attacker requests the endpoint directly (no login needed).\n"
            "2. The response includes sensitive fields (passwords, tokens, "
            "keys) or a complete map of every API route.\n"
            "3. They harvest the secrets, or use the schema to find and attack "
            "every other endpoint methodically."
        ),
        "impact": (
            "Leakage of credentials/secrets, or a complete blueprint of the "
            "API that makes every other attack faster and more reliable."
        ),
    },
    "CWE-215": {  # Debug/management endpoint exposed
        "cause": (
            "A debug or management endpoint (e.g. /actuator, /debug) was left "
            "enabled in production and is reachable without authentication."
        ),
        "attack": (
            "1. The attacker requests the debug endpoint.\n"
            "2. It returns environment variables, configuration, heap dumps or "
            "live metrics.\n"
            "3. They extract secrets and internal details, and in some "
            "frameworks trigger actions (e.g. shutdown, env change) directly."
        ),
        "impact": (
            "Disclosure of configuration and secrets, and sometimes direct "
            "control over the running application."
        ),
    },
    "CWE-434": {  # Unrestricted file upload
        "cause": (
            "An upload feature decides what is allowed based on the file "
            "extension or the Content-Type the client sends — both of which "
            "the client controls — instead of the real file content."
        ),
        "attack": (
            "1. The attacker uploads a script file (e.g. .php) but labels it "
            "as an image (Content-Type: image/jpeg).\n"
            "2. The server accepts it and stores it inside the web root.\n"
            "3. The attacker requests the stored file by URL; the server "
            "executes it as code.\n"
            "4. That gives them a command shell on the server."
        ),
        "impact": (
            "Remote code execution: the attacker runs their own commands on "
            "your server and can pivot to the rest of your infrastructure."
        ),
    },
    "CWE-918": {  # SSRF
        "cause": (
            "The server fetches a URL supplied by the user (for a webhook, "
            "preview, or import) without restricting where it is allowed to "
            "connect."
        ),
        "attack": (
            "1. The attacker gives the feature an internal URL instead of a "
            "normal one — e.g. the cloud metadata address 169.254.169.254.\n"
            "2. The server, trusted inside your network, makes that request "
            "for them and returns the response.\n"
            "3. They read cloud instance metadata and steal the temporary IAM "
            "credentials attached to the server.\n"
            "4. With those credentials they access your cloud account."
        ),
        "impact": (
            "Access to internal services and theft of cloud credentials, "
            "frequently escalating to full cloud-account compromise."
        ),
    },
    "CWE-614": {  # Insecure session cookie
        "cause": (
            "Session/auth cookies are set without the Secure, HttpOnly and "
            "SameSite protections, so they can be stolen or misused."
        ),
        "attack": (
            "1. Without HttpOnly, any cross-site-scripting flaw lets attacker "
            "JavaScript read the cookie.\n"
            "2. Without Secure, the cookie is sent over plain HTTP and can be "
            "sniffed on shared/public networks.\n"
            "3. Without SameSite, a malicious site can ride the user's session "
            "(CSRF).\n"
            "4. With a stolen session cookie, the attacker is logged in as the "
            "victim — no password needed."
        ),
        "impact": (
            "Account takeover by session hijacking, without ever needing the "
            "user's password."
        ),
    },
    "CWE-183": {  # Open SMTP relay
        "cause": (
            "The mail server relays messages from external senders to external "
            "recipients without requiring authentication."
        ),
        "attack": (
            "1. The attacker connects to the mail server from the internet.\n"
            "2. They send mail from any address to any recipient through it.\n"
            "3. They blast spam/phishing that appears to originate from your "
            "domain and infrastructure."
        ),
        "impact": (
            "Your domain and server IP get blacklisted, legitimate mail stops "
            "being delivered, and your brand is used to phish others."
        ),
    },
    "CWE-203": {  # SMTP user enumeration
        "cause": (
            "The mail server answers VRFY/EXPN commands, confirming whether a "
            "given mailbox exists."
        ),
        "attack": (
            "1. The attacker runs VRFY against a list of likely usernames.\n"
            "2. The server tells them which accounts are real.\n"
            "3. They focus password-guessing and phishing on confirmed, real "
            "accounts."
        ),
        "impact": (
            "A verified list of valid accounts that sharpens password attacks "
            "and phishing."
        ),
    },
    "CWE-538": {  # Sensitive file exposure
        "cause": (
            "Files that should never be web-accessible (.git, .env, backups, "
            "key files) are being served by the web server."
        ),
        "attack": (
            "1. The attacker requests well-known sensitive paths (/.env, "
            "/.git/config, /backup.sql).\n"
            "2. The server returns them.\n"
            "3. They recover source code, database credentials and private "
            "keys directly."
        ),
        "impact": (
            "Direct disclosure of credentials, source code and keys — often an "
            "instant path to full compromise."
        ),
    },
}

# Keyed by a keyword found in the finding category (lowercased).
_BY_KEYWORD = {
    "sql injection": {
        "cause": (
            "User input is concatenated straight into a database query, so "
            "input can change the meaning of the SQL instead of being treated "
            "as plain data."
        ),
        "attack": (
            "1. The attacker types a quote and SQL fragment into a parameter.\n"
            "2. The database error (or changed behaviour) confirms the input "
            "reaches the query.\n"
            "3. They craft input that returns other users' rows, dumps the "
            "whole table, or bypasses the login check entirely."
        ),
        "impact": (
            "Theft or modification of the entire database — customer data, "
            "password hashes, orders — and often login bypass."
        ),
    },
    "cross-site scripting": {
        "cause": (
            "User input is written back into the page without being escaped, "
            "so the browser runs it as part of the page's own code."
        ),
        "attack": (
            "1. The attacker crafts a link/comment containing a script.\n"
            "2. A victim opens it; the script runs in the victim's browser "
            "with the victim's session.\n"
            "3. The script steals the session cookie or performs actions as "
            "the victim (change email, transfer funds)."
        ),
        "impact": (
            "Session/account takeover and actions performed as the victim, "
            "including administrators."
        ),
    },
    "open redirect": {
        "cause": (
            "A redirect target is taken from a URL parameter and not checked "
            "against an allowlist of trusted destinations."
        ),
        "attack": (
            "1. The attacker crafts a link on your real domain that redirects "
            "to their site (yoursite.com/go?url=evil.com).\n"
            "2. A victim trusts the familiar domain and clicks.\n"
            "3. They land on a convincing phishing clone and enter their "
            "credentials."
        ),
        "impact": (
            "Your trusted domain is used to make phishing and credential theft "
            "far more convincing."
        ),
    },
    "weak credentials": {
        "cause": (
            "An account is left on a default or trivially guessable password, "
            "and there is no lockout to slow guessing."
        ),
        "attack": (
            "1. The attacker finds the login page.\n"
            "2. They try a short list of default/common passwords.\n"
            "3. One works and they are straight into the admin panel."
        ),
        "impact": "Immediate administrative access with no sophistication required.",
    },
    "exposed network service": {
        "cause": (
            "A service that should be private (database, cache, remote "
            "desktop) is reachable directly from the public internet."
        ),
        "attack": (
            "1. The attacker port-scans the host and finds the open service.\n"
            "2. Many such services have no authentication by default, or known "
            "exploits.\n"
            "3. They connect and read/modify data, or use a known exploit to "
            "run code."
        ),
        "impact": (
            "Direct access to databases/infrastructure, data theft, or remote "
            "code execution depending on the service."
        ),
    },
    "subdomain": {
        "cause": (
            "A subdomain (often dev/staging/admin) is publicly reachable and "
            "usually less hardened than the main site."
        ),
        "attack": (
            "1. The attacker enumerates subdomains and finds e.g. "
            "staging.yoursite.com.\n"
            "2. Staging often has debug mode on, weak/no auth, or real data.\n"
            "3. They break in there and pivot to the production environment or "
            "its data."
        ),
        "impact": (
            "A softer entry point that frequently leads back into production "
            "systems and data."
        ),
    },
    "missing security header": {
        "cause": (
            "The server does not send a browser-side protection header, so a "
            "defence-in-depth control that would blunt other attacks is "
            "absent."
        ),
        "attack": (
            "1. On its own this is not a break-in.\n"
            "2. But it removes a safety net: e.g. a missing CSP lets an XSS "
            "flaw run freely; a missing HSTS allows an HTTP downgrade and "
            "cookie interception.\n"
            "3. The attacker combines it with another flaw to land a much "
            "bigger hit."
        ),
        "impact": (
            "Makes other attacks (XSS, clickjacking, traffic interception) "
            "easier and more damaging."
        ),
    },
    "cors": {
        "cause": (
            "The cross-origin policy reflects any requesting site and allows "
            "credentials, so another website can read authenticated responses."
        ),
        "attack": (
            "1. A logged-in victim visits the attacker's website.\n"
            "2. That site makes a background request to your API with the "
            "victim's cookies.\n"
            "3. Because CORS allows it, the attacker's page reads the private "
            "response (the victim's data)."
        ),
        "impact": "Theft of logged-in users' private data by any malicious website.",
    },
    "transport security": {
        "cause": (
            "Traffic is not reliably protected in transit — plain HTTP, an "
            "invalid/expired certificate, or outdated TLS."
        ),
        "attack": (
            "1. The attacker gets onto the same network path (public Wi-Fi, "
            "compromised router).\n"
            "2. They read or alter unprotected/weakly-protected traffic.\n"
            "3. They capture session cookies and credentials as they pass."
        ),
        "impact": "Interception of credentials and sessions by a network attacker.",
    },
    "information disclosure": {
        "cause": (
            "The server advertises its exact software and version in response "
            "headers."
        ),
        "attack": (
            "1. The attacker reads the version from the headers.\n"
            "2. They look up known vulnerabilities for that exact version.\n"
            "3. They launch a matching, reliable exploit instead of guessing."
        ),
        "impact": "Faster, more reliable targeting of known vulnerabilities.",
    },
    "directory listing": {
        "cause": "The web server auto-generates a browsable index when no index file is present.",
        "attack": (
            "1. The attacker opens a folder URL with no index page.\n"
            "2. The server lists every file in it.\n"
            "3. They discover and download backups, uploads and files that "
            "were never meant to be found."
        ),
        "impact": "Discovery and download of hidden/sensitive files.",
    },
    "insecure cookie": {
        "cause": "Cookies lack the Secure/HttpOnly/SameSite flags that protect them.",
        "attack": (
            "1. The attacker leverages a scripting flaw or network position.\n"
            "2. The unprotected cookie is readable or interceptable.\n"
            "3. They replay it and are logged in as the victim."
        ),
        "impact": "Session hijacking and account takeover.",
    },
}


def explain(category: str, code: str = "") -> Optional[dict]:
    """Return {cause, attack, impact} for a finding, or None if unknown."""
    if code and code in _BY_CODE:
        return _BY_CODE[code]
    cat = (category or "").lower()
    for keyword, data in _BY_KEYWORD.items():
        if keyword in cat:
            return data
    return None


# ─────────────────────────────────────────────────────────────
# Indicative CVSS v3.1 base scores.
#
# These are category baselines, NOT per-instance hand-calculated vectors —
# a real engagement should adjust the vector to the specific target. They
# give the client a consistent, defensible starting rating for triage.
# Keyed by CWE/category tag first, then by severity band.
# ─────────────────────────────────────────────────────────────

_CVSS_BY_CODE = {
    "CWE-22":  (8.6, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),   # LFI/traversal
    "CWE-290": (9.8, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),   # auth bypass (header)
    "CWE-863": (8.1, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N"),   # auth bypass (path)
    "CWE-200": (7.5, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),   # info exposure
    "CWE-215": (7.5, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),   # debug endpoint
    "CWE-434": (9.8, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),   # file upload -> RCE
    "CWE-918": (9.1, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N"),   # SSRF
    "CWE-614": (7.5, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),   # insecure cookie
    "CWE-183": (8.6, "AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N"),   # open relay
    "CWE-203": (5.3, "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"),   # user enumeration
    "CWE-538": (7.5, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),   # sensitive file
}

_CVSS_BY_KEYWORD = {
    "sql injection":        (9.8, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    "cross-site scripting": (6.1, "AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"),
    "open redirect":        (6.1, "AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"),
    "weak credentials":     (9.8, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    "exposed network":      (7.5, "AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"),
    "cors":                 (6.5, "AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N"),
    "subdomain":            (5.3, "AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"),
    "transport security":   (5.9, "AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N"),
}

# Severity-band fallback when no specific mapping matches.
_CVSS_BY_SEVERITY = {
    "CRITICAL": 9.1, "HIGH": 7.5, "MEDIUM": 5.3, "LOW": 3.1, "INFO": 0.0,
}


def cvss_for(category: str, code: str = "", severity: str = "") -> tuple:
    """Return (base_score, vector_string) for a finding."""
    if code and code in _CVSS_BY_CODE:
        score, vec = _CVSS_BY_CODE[code]
        return score, f"CVSS:3.1/{vec}"
    cat = (category or "").lower()
    for keyword, (score, vec) in _CVSS_BY_KEYWORD.items():
        if keyword in cat:
            return score, f"CVSS:3.1/{vec}"
    score = _CVSS_BY_SEVERITY.get((severity or "").upper(), 0.0)
    return score, ""


def locate(finding: dict) -> str:
    """Build an honest 'where is it' string for a finding.

    A black-box scan can only locate a vulnerability by the request that
    triggered it — the URL, HTTP method, parameter, cookie, header or port.
    It has no access to the target's source, so we never claim a file/line.
    Everything here is extracted from proof the scan actually captured.
    """
    text = " ".join(str(finding.get(k, "")) for k in ("evidence", "detail", "title"))
    parts = []

    method = re.search(r"\b(GET|POST|PUT|DELETE|PATCH)\b", finding.get("evidence", ""))
    url = re.search(r"https?://[^\s'\"<>]+", finding.get("evidence", ""))
    if url:
        parts.append(f"{method.group(1) + ' ' if method else ''}{url.group(0)}")

    param = re.search(r"parameter '([^']+)'", text) or re.search(r"param '([^']+)'", text)
    if param:
        parts.append(f"parameter: {param.group(1)}")

    cookie = re.search(r"[Cc]ookie '([^']+)'", text)
    if cookie:
        parts.append(f"cookie: {cookie.group(1)}")

    header = re.search(r"header '([\w-]+)'|'([\w-]+)' header", text)
    if header:
        parts.append(f"header: {header.group(1) or header.group(2)}")

    port = re.search(r":(\d{2,5})[/\s]|port (\d{2,5})", text)
    if port and not url:
        parts.append(f"port: {port.group(1) or port.group(2)}")

    return "  ·  ".join(parts)


def enrich(finding: dict) -> dict:
    """Attach cause/attack/impact/location to a finding dict and return it."""
    data = explain(finding.get("category", ""), finding.get("cve", ""))
    if data:
        finding.setdefault("cause", data["cause"])
        finding.setdefault("attack", data["attack"])
        finding.setdefault("impact", data["impact"])
    loc = locate(finding)
    if loc:
        finding.setdefault("location", loc)
    score, vector = cvss_for(finding.get("category", ""), finding.get("cve", ""),
                             finding.get("severity", ""))
    if score:
        finding.setdefault("cvss", score)
        if vector:
            finding.setdefault("cvss_vector", vector)
    return finding

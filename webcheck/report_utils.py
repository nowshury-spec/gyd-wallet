"""
report_utils.py — Report-level synthesis for WebCheck.

Turns the flat list of findings into the three client-facing summaries:

  * summarize()     — executive summary: risk rating, counts, top ways in
  * access_path()   — a realistic attacker route chained from the findings
  * checklist()     — a deduplicated, prioritised remediation punch-list

All of this is derived from findings the scan already produced. Nothing here
contacts the target or performs any action against it.
"""

from typing import List, Dict

_SEV_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
_SEV_RANK = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "INFO": 0}


# ─────────────────────────────────────────────────────────────
# Executive summary
# ─────────────────────────────────────────────────────────────

def summarize(findings: List[dict]) -> dict:
    counts = {s: 0 for s in _SEV_ORDER}
    for f in findings:
        sev = (f.get("severity") or "INFO").upper()
        counts[sev] = counts.get(sev, 0) + 1

    # Overall risk = the worst severity present.
    rating = "INFORMATIONAL"
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        if counts.get(sev):
            rating = sev
            break

    max_cvss = max((f.get("cvss", 0) or 0) for f in findings) if findings else 0.0

    # Top "ways in": the most serious findings, most severe first then by CVSS.
    ranked = sorted(
        findings,
        key=lambda f: (_SEV_ORDER.get((f.get("severity") or "INFO").upper(), 9),
                       -(f.get("cvss", 0) or 0)),
    )
    top = []
    for f in ranked[:3]:
        top.append({
            "severity": f.get("severity", "INFO"),
            "title": f.get("title", ""),
            "location": f.get("location", ""),
            "cvss": f.get("cvss", 0),
        })

    headline = {
        "CRITICAL": "Critical weaknesses were found that give an attacker a "
                    "direct route into the system. Immediate action is required.",
        "HIGH":     "Serious weaknesses were found that an attacker could use "
                    "to gain unauthorised access. Prompt remediation is advised.",
        "MEDIUM":   "Several weaknesses were found that increase the risk of a "
                    "breach and should be addressed.",
        "LOW":      "Only minor, low-risk issues were found.",
        "INFORMATIONAL": "No material security weaknesses were detected.",
    }[rating]

    return {
        "rating": rating,
        "headline": headline,
        "counts": counts,
        "total": len(findings),
        "max_cvss": round(max_cvss, 1),
        "top_ways_in": top,
    }


# ─────────────────────────────────────────────────────────────
# Access-path narrative — how the findings chain into access
# ─────────────────────────────────────────────────────────────

def _has(findings, *keywords) -> dict:
    """Return the first finding whose category matches any keyword, else {}."""
    for f in findings:
        cat = (f.get("category") or "").lower()
        if any(k in cat for k in keywords):
            return f
    return {}


def access_path(findings: List[dict]) -> List[str]:
    """Build a plausible attacker route from the findings that exist.

    Explanatory narrative for the report — it describes how the *documented*
    weaknesses could be chained, each step tied to a real finding/location.
    """
    steps: List[str] = []

    def loc(f):
        l = f.get("location")
        return f" (at {l})" if l else ""

    # 1. Reconnaissance is always the opener.
    recon = _has(findings, "information disclosure", "subdomain", "api schema",
                 "directory listing")
    if recon:
        steps.append(
            f"Reconnaissance: the attacker maps the attack surface using "
            f"exposed information — e.g. {recon.get('title','')}"
            f"{loc(recon)} — to find version numbers, hidden hosts and endpoints.")

    # 2. Initial foothold — pick the highest-impact entry available.
    entry = (_has(findings, "sql injection")
             or _has(findings, "file upload")
             or _has(findings, "weak credentials")
             or _has(findings, "authentication bypass")
             or _has(findings, "directory traversal", "lfi")
             or _has(findings, "sensitive file")
             or _has(findings, "server-side request forgery", "ssrf")
             or _has(findings, "exposed network"))
    if entry:
        cat = (entry.get("category") or "").lower()
        if "sql injection" in cat:
            steps.append(
                f"Initial access: the attacker exploits the SQL injection "
                f"{loc(entry)} to read the user table (including password "
                f"hashes) and/or bypass the login entirely.")
        elif "file upload" in cat:
            steps.append(
                f"Initial access: the attacker abuses the unrestricted upload "
                f"{loc(entry)} to place a script file that the server then "
                f"executes, giving them a command shell.")
        elif "weak credentials" in cat:
            steps.append(
                f"Initial access: the attacker logs straight into the admin "
                f"panel {loc(entry)} using default/weak credentials.")
        elif "authentication bypass" in cat:
            steps.append(
                f"Initial access: the attacker bypasses authentication "
                f"{loc(entry)} to reach protected functionality without "
                f"credentials.")
        elif "traversal" in cat or "lfi" in cat:
            steps.append(
                f"Initial access: the attacker uses the path traversal "
                f"{loc(entry)} to read sensitive server files such as "
                f"configuration and credential files.")
        elif "sensitive file" in cat:
            steps.append(
                f"Initial access: the attacker downloads an exposed sensitive "
                f"file {loc(entry)} (e.g. .env / backup) and harvests the "
                f"credentials inside it.")
        elif "ssrf" in cat or "request forgery" in cat:
            steps.append(
                f"Initial access: the attacker uses the SSRF {loc(entry)} to "
                f"reach the cloud metadata service and steal the server's IAM "
                f"credentials.")
        elif "exposed network" in cat:
            steps.append(
                f"Initial access: the attacker connects directly to the "
                f"exposed service {loc(entry)}, which is reachable from the "
                f"internet.")

    # 3. Escalation / impact.
    creds = _has(findings, "sensitive file", "sql injection", "sensitive data",
                 "ssrf", "request forgery")
    if creds and creds is not entry:
        steps.append(
            f"Escalation: credentials or secrets obtained from "
            f"{creds.get('title','an earlier step')} are reused to access "
            f"databases, cloud accounts or other services.")

    session = _has(findings, "insecure cookie", "insecure session", "cross-site scripting")
    if session:
        steps.append(
            f"Lateral movement: weak session handling / XSS "
            f"({session.get('title','')}{loc(session)}) lets the attacker "
            f"hijack other users' sessions, including administrators.")

    # 4. Closing impact statement.
    if steps:
        steps.append(
            "Outcome: from here the attacker can read or modify data, "
            "impersonate users, and persist access until the weaknesses are "
            "fixed.")
    return steps


# ─────────────────────────────────────────────────────────────
# Remediation checklist
# ─────────────────────────────────────────────────────────────

def checklist(findings: List[dict]) -> List[dict]:
    """Deduplicated, severity-ordered list of {severity, title, fix}."""
    seen = set()
    items = []
    for f in sorted(findings, key=lambda f: _SEV_ORDER.get(
            (f.get("severity") or "INFO").upper(), 9)):
        fix = (f.get("fix") or "").strip()
        if not fix:
            continue
        key = fix[:80]
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "severity": f.get("severity", "INFO"),
            "title": f.get("title", ""),
            "fix": fix,
        })
    return items

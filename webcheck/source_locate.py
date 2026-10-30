"""
source_locate.py — Map findings to candidate source locations.

OPT-IN and OFFLINE. This never touches the target. It searches a copy of the
client's OWN source code (which you must be authorized to hold) for the code
patterns typically responsible for each finding, and reports candidate
file:line references so the client's developers know where to look.

It reports *candidates*, not certainties — a human still confirms the exact
line. That honesty matters: a scanner cannot see source, so this bridges the
gap by reading the real code rather than guessing from HTTP responses.

Usage (CLI):
    python source_locate.py <source_dir> <findings.json> [--stack php|node|python]

`findings.json` is a list of finding dicts (as produced by the scan /status
endpoint). Output is JSON: each finding with a `source_candidates` list.

Usage (library):
    from source_locate import locate_in_source
    enriched = locate_in_source(findings, "/path/to/client/src", stack="php")
"""

import os
import re
import sys
import json
import argparse
from typing import List, Dict, Optional

# Directories and extensions we never search.
SKIP_DIRS = {".git", ".svn", ".hg", "node_modules", "vendor", "dist", "build",
             "__pycache__", ".venv", "venv", "env", "bower_components",
             "coverage", ".next", ".nuxt", "target"}
TEXT_EXTS = {".php", ".phtml", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".py",
             ".rb", ".java", ".go", ".cs", ".html", ".twig", ".ejs", ".vue",
             ".yml", ".yaml", ".conf", ".config", ".htaccess", ".env",
             ".sql", ".json", ".xml"}
MAX_FILE_BYTES = 2_000_000
MAX_CANDIDATES = 8


# Patterns keyed by a keyword in the finding category / CWE.
# Each is a list of (regex, why) describing code that commonly causes the flaw.
_PATTERNS: Dict[str, List[tuple]] = {
    "sql injection": [
        (r"(SELECT|INSERT|UPDATE|DELETE)\b.*[\"'`]\s*[.+]\s*\$?\w+", "SQL built by string concatenation"),
        (r"(mysqli?_query|->query|cursor\.execute|pg_query|\$wpdb->)", "raw SQL query call"),
        (r"f[\"'].*(SELECT|INSERT|UPDATE|DELETE).*\{", "SQL built with an f-string / interpolation"),
    ],
    "cross-site scripting": [
        (r"echo\s+\$_(GET|POST|REQUEST)", "user input echoed without escaping (PHP)"),
        (r"\.innerHTML\s*=", "value written to innerHTML"),
        (r"dangerouslySetInnerHTML", "React dangerouslySetInnerHTML"),
        (r"\|\s*safe\b|autoescape\s+false|\{\%\s*autoescape\s+off", "template auto-escaping disabled"),
    ],
    "open redirect": [
        (r"(redirect|Location:)\s*.*\$?_?(GET|POST|REQUEST|query|params)", "redirect target from user input"),
        (r"res\.redirect\(\s*req\.", "Express redirect from request input"),
    ],
    "directory traversal": [
        (r"(include|require|fopen|file_get_contents|readfile)\s*\(\s*\$?_?(GET|POST|REQUEST)", "file path from user input (PHP)"),
        (r"(open|Path|join)\s*\(.*request\.(args|form|GET|POST)", "file path from user input"),
    ],
    "lfi": [
        (r"(include|require)\s*\(\s*\$", "dynamic include"),
    ],
    "file upload": [
        (r"move_uploaded_file|\$_FILES", "PHP file upload handling"),
        (r"multer|req\.files|request\.files|FormData", "file upload handling"),
        (r"\.save\(|save_to|store\(", "uploaded file being stored"),
    ],
    "server-side request forgery": [
        (r"(requests\.(get|post)|urllib|http\.get|fetch|curl_exec|file_get_contents)\s*\(\s*\$?_?(url|uri|GET|POST|REQUEST|req)", "outbound request to a user-supplied URL"),
    ],
    "ssrf": [
        (r"(requests\.(get|post)|fetch|curl_exec)\s*\(", "outbound request call"),
    ],
    "weak credentials": [
        (r"(password|passwd|pwd)\s*[=:]\s*[\"'](admin|password|123456|root|changeme)[\"']", "hard-coded weak credential"),
    ],
    "insecure cookie": [
        (r"(setcookie|set_cookie|res\.cookie|cookie\()", "cookie being set — check Secure/HttpOnly/SameSite"),
        (r"session_set_cookie_params|SESSION_COOKIE", "session cookie configuration"),
    ],
    "missing security header": [
        (r"(add_header|header\(|res\.set|helmet|Header\.set)", "where response headers are set"),
    ],
    "cors": [
        (r"Access-Control-Allow-Origin|cors\(|add_header\s+Access-Control", "CORS configuration"),
    ],
}

# Findings whose location IS a file: search for that exact file in the tree.
_FILE_FINDINGS = {
    "sensitive file": None,   # path taken from the finding's location
}


def _param_from_location(location: str) -> Optional[str]:
    m = re.search(r"parameter:\s*(\w+)", location or "")
    return m.group(1) if m else None


def _patterns_for(finding: dict) -> List[tuple]:
    cat = (finding.get("category") or "").lower()
    for keyword, pats in _PATTERNS.items():
        if keyword in cat:
            return pats
    return []


def _iter_files(source_dir: str, stack: Optional[str]):
    stack_exts = {
        "php": {".php", ".phtml", ".html", ".twig", ".htaccess", ".conf"},
        "node": {".js", ".jsx", ".ts", ".tsx", ".mjs", ".vue", ".ejs"},
        "python": {".py", ".html"},
    }.get((stack or "").lower())
    for root, dirs, files in os.walk(source_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            allowed = stack_exts if stack_exts else TEXT_EXTS
            if ext not in allowed and name not in (".env", ".htaccess"):
                continue
            yield os.path.join(root, name)


def locate_in_source(findings: List[dict], source_dir: str,
                     stack: Optional[str] = None) -> List[dict]:
    """Attach `source_candidates` (list of {file, line, snippet, why}) to each
    finding and return the list. `source_dir` must be a local source tree you
    are authorized to read."""
    if not os.path.isdir(source_dir):
        raise NotADirectoryError(source_dir)

    files = list(_iter_files(source_dir, stack))

    for finding in findings:
        candidates: List[dict] = []
        cat = (finding.get("category") or "").lower()
        param = _param_from_location(finding.get("location", ""))

        # Direct-file findings: just locate the exposed file by name.
        if "sensitive file" in cat:
            loc = finding.get("location", "")
            fname = os.path.basename(re.sub(r"[?#].*$", "", loc)) if loc else ""
            for path in files:
                if fname and os.path.basename(path) == fname:
                    candidates.append({"file": os.path.relpath(path, source_dir),
                                       "line": 0, "snippet": "(exposed file present in source)",
                                       "why": "the exposed file itself"})
            finding["source_candidates"] = candidates[:MAX_CANDIDATES]
            continue

        pats = _patterns_for(finding)
        if not pats:
            finding["source_candidates"] = []
            continue

        compiled = [(re.compile(rx, re.IGNORECASE), why) for rx, why in pats]
        param_rx = re.compile(r"\b" + re.escape(param) + r"\b") if param else None

        for path in files:
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, "r", errors="ignore") as fh:
                    lines = fh.readlines()
            except Exception:
                continue
            for i, line in enumerate(lines, 1):
                for rx, why in compiled:
                    if rx.search(line):
                        # If we know the parameter name, prefer lines that
                        # mention it — stronger candidate, listed first.
                        strong = bool(param_rx and param_rx.search(line))
                        candidates.append({
                            "file": os.path.relpath(path, source_dir),
                            "line": i,
                            "snippet": line.strip()[:200],
                            "why": why,
                            "strong": strong,
                        })
                        break
            if len(candidates) >= MAX_CANDIDATES * 3:
                break

        # Parameter-matching lines first, then truncate.
        candidates.sort(key=lambda c: (not c.get("strong", False),))
        for c in candidates:
            c.pop("strong", None)
        finding["source_candidates"] = candidates[:MAX_CANDIDATES]

    return findings


def _main(argv=None):
    ap = argparse.ArgumentParser(description="Map WebCheck findings to source locations.")
    ap.add_argument("source_dir", help="Path to the client's source tree (authorized copy).")
    ap.add_argument("findings_json", help="JSON file: a list of finding dicts.")
    ap.add_argument("--stack", choices=["php", "node", "python"], default=None,
                    help="Limit search to one stack's file types.")
    args = ap.parse_args(argv)

    with open(args.findings_json) as f:
        findings = json.load(f)
    if isinstance(findings, dict):
        findings = findings.get("findings", [])

    enriched = locate_in_source(findings, args.source_dir, args.stack)

    for f in enriched:
        print(f"\n[{f.get('severity','?')}] {f.get('title','')}")
        if f.get("location"):
            print(f"   exposed at: {f['location']}")
        cands = f.get("source_candidates", [])
        if not cands:
            print("   source candidates: (none found — confirm manually)")
        for c in cands:
            at = f"{c['file']}:{c['line']}" if c["line"] else c["file"]
            print(f"   → {at}  — {c['why']}")
            if c["snippet"]:
                print(f"       {c['snippet']}")
    print(json.dumps(enriched, indent=2), file=sys.stderr)


if __name__ == "__main__":
    _main()

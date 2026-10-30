"""
auth_store.py — Signed authorization management for WebCheck.

Each deep pentest requires a signed authorization record stored here
before the scan can run. Records are kept in a JSON file on disk
(use a database in production).
"""

import os
import re
import json
import uuid
import threading
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

AUTH_FILE = os.path.join(os.path.dirname(__file__), "authorizations.json")

# Serialises concurrent load/save so multiple request threads can't
# interleave a read-modify-write and corrupt the store.
_LOCK = threading.Lock()


def clean_domain(value: str) -> str:
    """Normalise a URL or host into a bare hostname (scheme/path/www stripped).

    NB: do not use str.lstrip("https://") for this — lstrip removes any
    leading character in the set {h,t,p,s,:,/}, so "test.com" becomes
    "est.com". This parses the host properly instead.
    """
    value = (value or "").strip().lower()
    if "://" not in value:
        value = "//" + value          # let urlparse find the netloc
    host = urllib.parse.urlparse(value).hostname or ""
    return re.sub(r"^www\.", "", host)


def _load() -> dict:
    if not os.path.exists(AUTH_FILE):
        return {}
    try:
        with open(AUTH_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data: dict):
    # Write to a temp file then atomically replace, so a crash or a
    # concurrent reader never sees a half-written file.
    tmp = f"{AUTH_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, AUTH_FILE)


def create_authorization(
    domain: str,
    company_name: str,
    authorized_by: str,           # Full name of person signing
    authorized_by_email: str,
    authorized_by_title: str,
    scope_notes: str,
    ip_address: str,
    user_agent: str,
) -> dict:
    """
    Create and store a signed authorization record.
    Returns the record with its unique auth_id.
    """
    auth_id = str(uuid.uuid4())
    record = {
        "auth_id":              auth_id,
        "domain":               clean_domain(domain),
        "company_name":         company_name,
        "authorized_by":        authorized_by,
        "authorized_by_email":  authorized_by_email,
        "authorized_by_title":  authorized_by_title,
        "scope_notes":          scope_notes,
        "signed_at":            datetime.now(timezone.utc).isoformat(),
        "signed_from_ip":       ip_address,
        "signed_user_agent":    user_agent,
        "status":               "active",
        "declaration": (
            f"I, {authorized_by} ({authorized_by_title}) of {company_name}, confirm that I am "
            f"authorized to grant permission for security testing of {domain} and all its subdomains. "
            f"I consent to WebCheck performing passive and active security scans including "
            f"penetration testing probes against this domain."
        ),
    }
    with _LOCK:
        store = _load()
        store[auth_id] = record
        _save(store)
    return record


def get_authorization(auth_id: str) -> Optional[dict]:
    store = _load()
    return store.get(auth_id)


def find_authorization_for_domain(domain: str) -> Optional[dict]:
    """Return the most recent active authorization covering a domain.

    An authorization for ``example.com`` covers ``example.com`` itself and
    any subdomain (``api.example.com``). It does NOT cover the parent of the
    authorized host: an authorization for ``foo.example.com`` must not grant
    a scan of ``example.com``. This matches the scope check in
    ``deep_scan.run_deep_scan``.
    """
    clean = clean_domain(domain)

    store = _load()
    candidates = [
        r for r in store.values()
        if r.get("status") == "active" and r.get("domain") and (
            r.get("domain") == clean or
            clean.endswith("." + r.get("domain", ""))
        )
    ]
    if not candidates:
        return None
    # Most recent
    return sorted(candidates, key=lambda r: r.get("signed_at", ""), reverse=True)[0]


def revoke_authorization(auth_id: str) -> bool:
    with _LOCK:
        store = _load()
        if auth_id in store:
            store[auth_id]["status"] = "revoked"
            store[auth_id]["revoked_at"] = datetime.now(timezone.utc).isoformat()
            _save(store)
            return True
    return False


def list_authorizations() -> list:
    return list(_load().values())

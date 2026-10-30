"""
threat_intel.py — Threat intelligence enrichment for WebCheck.

Pulls from free, no-cost public feeds to enrich scan findings:

  * CISA KEV   — Known Exploited Vulnerabilities catalog (JSON, no key)
  * NVD 2.0    — NIST National Vulnerability Database (REST, optional key)
  * FIRST EPSS — Exploitation Prediction Scoring System (REST, no key)

All data sources are public and free. NVD requests are rate-limited
(5 req/30s without a key, 50 req/30s with one).

Usage:
    from threat_intel import enrich_with_intel
    findings = enrich_with_intel(findings)
"""

import re
import time
import threading
import requests
from typing import List, Dict, Optional
from datetime import datetime, timezone, timedelta

TIMEOUT = 15
_HEADERS = {"User-Agent": "WebCheck/1.0 Security Scanner"}

# ─────────────────────────────────────────────────────────────
# CISA KEV — Known Exploited Vulnerabilities
# Free, no auth, ~1.5 MB JSON feed
# ─────────────────────────────────────────────────────────────

_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
_kev_cache: Dict[str, dict] = {}
_kev_cache_time: Optional[datetime] = None
_kev_lock = threading.Lock()
_KEV_TTL = timedelta(hours=6)


def _load_kev() -> Dict[str, dict]:
    """Fetch and cache the CISA KEV catalog, keyed by CVE ID."""
    global _kev_cache, _kev_cache_time
    with _kev_lock:
        if _kev_cache_time and datetime.now(timezone.utc) - _kev_cache_time < _KEV_TTL:
            return _kev_cache
    try:
        r = requests.get(_KEV_URL, headers=_HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        vulns = data.get("vulnerabilities", [])
        cache = {}
        for v in vulns:
            cve = v.get("cveID", "")
            if cve:
                cache[cve.upper()] = {
                    "cve": cve,
                    "vendor": v.get("vendorProject", ""),
                    "product": v.get("product", ""),
                    "name": v.get("vulnerabilityName", ""),
                    "description": v.get("shortDescription", ""),
                    "date_added": v.get("dateAdded", ""),
                    "due_date": v.get("dueDate", ""),
                    "ransomware": v.get("knownRansomwareCampaignUse", "Unknown"),
                    "action": v.get("requiredAction", ""),
                }
        with _kev_lock:
            _kev_cache = cache
            _kev_cache_time = datetime.now(timezone.utc)
        return cache
    except Exception:
        return _kev_cache


def lookup_kev(cve_id: str) -> Optional[dict]:
    """Check if a CVE is in CISA's Known Exploited Vulnerabilities list."""
    cache = _load_kev()
    return cache.get(cve_id.upper())


def search_kev_by_product(vendor: str = "", product: str = "") -> List[dict]:
    """Find KEV entries matching a vendor/product name (case-insensitive)."""
    cache = _load_kev()
    vendor_l = vendor.lower()
    product_l = product.lower()
    results = []
    for entry in cache.values():
        if vendor_l and vendor_l not in entry.get("vendor", "").lower():
            continue
        if product_l and product_l not in entry.get("product", "").lower():
            continue
        results.append(entry)
    return results


# ─────────────────────────────────────────────────────────────
# NVD 2.0 — National Vulnerability Database
# Free (5 req/30s), faster with an API key
# ─────────────────────────────────────────────────────────────

_NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
_nvd_cache: Dict[str, dict] = {}
_nvd_lock = threading.Lock()
_last_nvd_call = 0.0


def lookup_nvd(cve_id: str, api_key: str = "") -> Optional[dict]:
    """Fetch CVE details from NVD. Returns {cve, description, cvss, cwe, refs}."""
    cve_id = cve_id.upper().strip()
    if not re.match(r"^CVE-\d{4}-\d+$", cve_id):
        return None

    with _nvd_lock:
        if cve_id in _nvd_cache:
            return _nvd_cache[cve_id]

    # Rate limiting: 6 seconds between calls without a key
    global _last_nvd_call
    delay = 6.5 if not api_key else 0.7
    elapsed = time.time() - _last_nvd_call
    if elapsed < delay:
        time.sleep(delay - elapsed)

    headers = dict(_HEADERS)
    if api_key:
        headers["apiKey"] = api_key

    try:
        _last_nvd_call = time.time()
        r = requests.get(_NVD_URL, params={"cveId": cve_id},
                         headers=headers, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        vulns = data.get("vulnerabilities", [])
        if not vulns:
            return None

        cve_data = vulns[0].get("cve", {})
        descriptions = cve_data.get("descriptions", [])
        desc = next((d["value"] for d in descriptions if d.get("lang") == "en"), "")

        # CVSS — prefer 3.1, fall back to 3.0, then 2.0
        metrics = cve_data.get("metrics", {})
        cvss_score = None
        cvss_vector = ""
        for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
            entries = metrics.get(key, [])
            if entries:
                cd = entries[0].get("cvssData", {})
                cvss_score = cd.get("baseScore")
                cvss_vector = cd.get("vectorString", "")
                break

        # CWE
        cwes = []
        for weakness in cve_data.get("weaknesses", []):
            for desc_item in weakness.get("description", []):
                cwe_val = desc_item.get("value", "")
                if cwe_val.startswith("CWE-"):
                    cwes.append(cwe_val)

        result = {
            "cve": cve_id,
            "description": desc,
            "cvss": cvss_score,
            "cvss_vector": cvss_vector,
            "cwes": cwes,
            "published": cve_data.get("published", ""),
            "modified": cve_data.get("lastModified", ""),
        }

        with _nvd_lock:
            _nvd_cache[cve_id] = result
        return result

    except Exception:
        return None


# ─────────────────────────────────────────────────────────────
# FIRST EPSS — Exploitation Prediction Scoring System
# Free, no auth
# ─────────────────────────────────────────────────────────────

_EPSS_URL = "https://api.first.org/data/v1/epss"


def lookup_epss(cve_id: str) -> Optional[dict]:
    """Get EPSS probability and percentile for a CVE.
    Returns {cve, epss, percentile} or None."""
    cve_id = cve_id.upper().strip()
    if not re.match(r"^CVE-\d{4}-\d+$", cve_id):
        return None
    try:
        r = requests.get(_EPSS_URL, params={"cve": cve_id},
                         headers=_HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        entries = data.get("data", [])
        if not entries:
            return None
        entry = entries[0]
        return {
            "cve": cve_id,
            "epss": float(entry.get("epss", 0)),
            "percentile": float(entry.get("percentile", 0)),
        }
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────
# Version-to-CVE matching
# Maps detected software versions to known CVEs
# ─────────────────────────────────────────────────────────────

# Common software with well-known CVE patterns
_VERSION_CVES = {
    "apache": [
        ("2.4.49", "CVE-2021-41773", "Path traversal in Apache 2.4.49"),
        ("2.4.50", "CVE-2021-42013", "Path traversal fix bypass in Apache 2.4.50"),
        ("2.4.48", "CVE-2021-36160", "mod_proxy_uwsgi out-of-bounds read"),
    ],
    "nginx": [
        ("1.20.0", "CVE-2021-23017", "DNS resolver vulnerability in nginx"),
    ],
    "php": [
        ("8.1.0", "CVE-2024-4577", "PHP CGI argument injection"),
        ("7.4", "CVE-2022-31625", "PHP buffer overflow in pg_query_params"),
    ],
    "wordpress": [
        ("6.1", "CVE-2023-2745", "WordPress directory traversal"),
        ("5.8", "CVE-2022-21661", "WordPress SQL injection in WP_Query"),
    ],
    "jquery": [
        ("1.", "CVE-2020-11022", "jQuery XSS via HTML injection"),
        ("2.", "CVE-2020-11022", "jQuery XSS via HTML injection"),
        ("3.0", "CVE-2020-11023", "jQuery XSS in htmlPrefilter"),
        ("3.1", "CVE-2020-11023", "jQuery XSS in htmlPrefilter"),
        ("3.2", "CVE-2020-11023", "jQuery XSS in htmlPrefilter"),
        ("3.3", "CVE-2020-11023", "jQuery XSS in htmlPrefilter"),
        ("3.4", "CVE-2020-11023", "jQuery XSS in htmlPrefilter"),
    ],
    "openssh": [
        ("8.5", "CVE-2023-38408", "OpenSSH remote code execution via ssh-agent"),
        ("9.1", "CVE-2023-25136", "OpenSSH pre-auth double free"),
    ],
}


def match_version_cves(software: str, version: str) -> List[dict]:
    """Match a software name + version against known CVE patterns.
    Returns [{cve, description}]."""
    sw = software.lower().strip()
    ver = version.strip()
    if not sw or not ver:
        return []

    results = []
    for key, entries in _VERSION_CVES.items():
        if key not in sw:
            continue
        for ver_prefix, cve, desc in entries:
            if ver.startswith(ver_prefix):
                results.append({"cve": cve, "description": desc})
    return results


# ─────────────────────────────────────────────────────────────
# Finding enrichment — the main entry point
# ─────────────────────────────────────────────────────────────

def enrich_with_intel(findings: List[dict], nvd_api_key: str = "") -> List[dict]:
    """Enrich a list of finding dicts with threat intelligence.

    For each finding:
      - If it has a CVE → look up CISA KEV, NVD, and EPSS
      - If it has version info in evidence → match against known CVEs
      - Adds: kev_entry, nvd_entry, epss_entry, matched_cves
    """
    for finding in findings:
        cve = finding.get("cve", "")

        # Try to extract version info from evidence for CVE matching
        evidence = finding.get("evidence", "")
        if evidence and not cve:
            matched = _extract_and_match(evidence)
            if matched:
                finding["matched_cves"] = matched
                if not cve:
                    cve = matched[0].get("cve", "")

        if not cve:
            continue

        # CISA KEV
        kev = lookup_kev(cve)
        if kev:
            finding["kev_entry"] = kev
            finding["in_kev"] = True
            if kev.get("ransomware", "").lower() not in ("unknown", ""):
                finding["ransomware_use"] = kev["ransomware"]

        # NVD
        nvd = lookup_nvd(cve, api_key=nvd_api_key)
        if nvd:
            finding["nvd_entry"] = nvd
            if nvd.get("cvss") and not finding.get("cvss"):
                finding["cvss"] = nvd["cvss"]
                finding["cvss_vector"] = nvd.get("cvss_vector", "")

        # EPSS
        epss = lookup_epss(cve)
        if epss:
            finding["epss_entry"] = epss
            finding["epss_score"] = round(epss["epss"] * 100, 1)
            finding["epss_percentile"] = round(epss["percentile"] * 100, 1)

    return findings


def _extract_and_match(evidence: str) -> List[dict]:
    """Extract software/version from evidence text and match CVEs."""
    results = []

    patterns = [
        (r"(?:Apache|httpd)[/ ]?(\d+\.\d+\.\d+)", "apache"),
        (r"nginx[/ ]?(\d+\.\d+\.\d+)", "nginx"),
        (r"PHP[/ ]?(\d+\.\d+)", "php"),
        (r"WordPress[/ ]?(\d+\.\d+)", "wordpress"),
        (r"jQuery[/ v]?(\d+\.\d+)", "jquery"),
        (r"OpenSSH[/_]?(\d+\.\d+)", "openssh"),
        (r"Server:\s*(\S+)[/ ](\d+\.\d+)", None),
    ]

    for pat, sw in patterns:
        m = re.search(pat, evidence, re.IGNORECASE)
        if not m:
            continue
        if sw:
            ver = m.group(1)
        else:
            sw = m.group(1).lower()
            ver = m.group(2)
        matched = match_version_cves(sw, ver)
        results.extend(matched)

    return results


# ─────────────────────────────────────────────────────────────
# KEV statistics — for the report
# ─────────────────────────────────────────────────────────────

def kev_stats() -> dict:
    """Return summary stats about the KEV catalog."""
    cache = _load_kev()
    ransomware_count = sum(
        1 for v in cache.values()
        if v.get("ransomware", "").lower() not in ("unknown", "")
    )
    return {
        "total": len(cache),
        "ransomware_related": ransomware_count,
        "last_updated": _kev_cache_time.isoformat() if _kev_cache_time else None,
    }

"""
WebCheck — Security scanning web app
Three scan tiers:
  1. /scan       Passive (no permission needed)
  2. /pentest    Active — checkbox auth gate
  3. /deepscan   Full-scope — signed authorization form required
"""

import os
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from flask import Flask, render_template, request, jsonify, redirect, url_for

from sitecheck import SiteCheck, ai_explain
from active_scan import run_active_scan
from deep_scan import run_deep_scan, DeepFinding
from passive_checks import run_passive_checks
from explain import enrich
from report_utils import summarize, access_path, checklist
from threat_intel import enrich_with_intel, kev_stats
from auth_store import create_authorization, find_authorization_for_domain

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'change-me-in-production')

# In-memory job store. This is per-process, so the app MUST run as a single
# process (see render.yaml: --workers 1 --threads N); multiple gunicorn
# workers would not share this dict and /status & /report would 404 for jobs
# created in another worker. Bounded so long-running instances don't leak.
MAX_JOBS = 500
jobs = OrderedDict()   # {job_id: {...}}
_jobs_lock = threading.Lock()
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
NVD_API_KEY = os.environ.get('NVD_API_KEY', '')


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _clean_url(url: str) -> str:
    url = url.strip()
    if url and not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    return url

def _new_job(url: str, scan_type: str) -> str:
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        jobs[job_id] = {'status': 'queued', 'url': url, 'scan_type': scan_type}
        # Evict oldest finished/stale jobs once we exceed the cap.
        while len(jobs) > MAX_JOBS:
            jobs.popitem(last=False)
    return job_id

def _count(findings: list) -> dict:
    # Keys are lowercase to match report.html (job.counts.critical, ...).
    return {s.lower(): sum(1 for f in findings if f.get('severity') == s)
            for s in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')}

def _finding_dict(f) -> dict:
    base = {'severity': f.severity, 'title': f.title,
            'detail': f.detail, 'fix': f.fix}
    # DeepFinding has extra fields
    if hasattr(f, 'evidence'): base['evidence'] = f.evidence
    if hasattr(f, 'category'): base['category'] = f.category
    if hasattr(f, 'cve'):      base['cve'] = f.cve
    # Attach client-facing cause / attack-walkthrough / impact where known.
    return enrich(base)


# ─────────────────────────────────────────────────────────────
# Background workers
# ─────────────────────────────────────────────────────────────

def _passive_worker(job_id, url, platform):
    jobs[job_id]['status'] = 'running'
    try:
        sc = SiteCheck(url)
        sc.run()
        extra = run_passive_checks(url)
        findings = [_finding_dict(f) for f in sc.findings] + \
                   [_finding_dict(f) for f in extra]
        findings = enrich_with_intel(findings, nvd_api_key=NVD_API_KEY)
        ai_report = _get_ai(url, sc.findings, platform)
        jobs[job_id].update({
            'status': 'done', 'target': sc.target,
            'findings': findings, 'ai_report': ai_report,
            'scanned_at': _now(), 'counts': _count(findings),
            'intel_stats': kev_stats(),
        })
    except Exception as e:
        jobs[job_id].update({'status': 'error', 'error': str(e)})


def _active_worker(job_id, url, platform):
    jobs[job_id]['status'] = 'running'
    try:
        sc = SiteCheck(url); sc.run()
        passive = [_finding_dict(f) for f in sc.findings] + \
                  [_finding_dict(f) for f in run_passive_checks(url)]
        active_raw = run_active_scan(url, authorized=True)
        active = [{**_finding_dict(f), 'tier': 'active'} for f in active_raw]
        findings = active + passive
        findings = enrich_with_intel(findings, nvd_api_key=NVD_API_KEY)
        ai_report = _get_ai(url, sc.findings, platform)
        jobs[job_id].update({
            'status': 'done', 'target': url,
            'findings': findings, 'ai_report': ai_report,
            'scanned_at': _now(), 'counts': _count(findings),
            'active_count': len(active), 'passive_count': len(passive),
            'intel_stats': kev_stats(),
        })
    except Exception as e:
        jobs[job_id].update({'status': 'error', 'error': str(e)})


def _deep_worker(job_id, url, platform, auth_record):
    jobs[job_id]['status'] = 'running'
    try:
        # Deep scan first: run_deep_scan validates the target against the
        # authorized scope and raises PermissionError BEFORE sending any
        # probe, so an out-of-scope target never receives traffic.
        deep_raw = run_deep_scan(url, auth_record)
        deep = [{**_finding_dict(f), 'tier': 'deep'} for f in deep_raw]

        # Active probes
        active_raw = run_active_scan(url, authorized=True)
        active = [{**_finding_dict(f), 'tier': 'active'} for f in active_raw]

        # Passive
        sc = SiteCheck(url); sc.run()
        passive = [_finding_dict(f) for f in sc.findings] + \
                  [_finding_dict(f) for f in run_passive_checks(url)]

        findings = deep + active + passive
        findings = enrich_with_intel(findings, nvd_api_key=NVD_API_KEY)
        ai_report = _get_ai(url, sc.findings, platform)

        jobs[job_id].update({
            'status': 'done', 'target': url,
            'findings': findings, 'ai_report': ai_report,
            'scanned_at': _now(), 'counts': _count(findings),
            'deep_count': len(deep),
            'active_count': len(active),
            'passive_count': len(passive),
            'intel_stats': kev_stats(),
            # report.html renders the signed-authorization banner from this.
            'auth_record': auth_record,
            'authorized_by': auth_record.get('authorized_by'),
            'authorized_company': auth_record.get('company_name'),
        })
    except Exception as e:
        jobs[job_id].update({'status': 'error', 'error': str(e)})


def _get_ai(url, findings, platform):
    if not ANTHROPIC_API_KEY or not findings:
        return None
    try:
        return ai_explain(url, findings, model='claude-sonnet-4-20250514',
                          platform=platform or 'the detected platform')
    except Exception:
        return None

def _now():
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/scan', methods=['POST'])
def start_passive():
    url      = _clean_url(request.form.get('url', ''))
    platform = request.form.get('platform', '').strip()
    if not url:
        return jsonify({'error': 'URL is required'}), 400
    job_id = _new_job(url, 'passive')
    threading.Thread(target=_passive_worker, args=(job_id, url, platform), daemon=True).start()
    return jsonify({'job_id': job_id})


@app.route('/pentest', methods=['POST'])
def start_active():
    url        = _clean_url(request.form.get('url', ''))
    platform   = request.form.get('platform', '').strip()
    authorized = request.form.get('authorized') == 'yes'
    if not url:
        return jsonify({'error': 'URL is required'}), 400
    if not authorized:
        return jsonify({'error': 'Authorization required.'}), 403
    job_id = _new_job(url, 'active')
    threading.Thread(target=_active_worker, args=(job_id, url, platform), daemon=True).start()
    return jsonify({'job_id': job_id})


@app.route('/authorize', methods=['POST'])
def create_auth():
    """
    Store a signed authorization record for a domain.
    Returns auth_id which is then used to unlock /deepscan.
    """
    data = request.get_json() or request.form
    required = ['domain', 'company_name', 'authorized_by',
                'authorized_by_email', 'authorized_by_title']
    for field in required:
        if not data.get(field, '').strip():
            return jsonify({'error': f'Field required: {field}'}), 400

    record = create_authorization(
        domain               = data['domain'],
        company_name         = data['company_name'],
        authorized_by        = data['authorized_by'],
        authorized_by_email  = data['authorized_by_email'],
        authorized_by_title  = data['authorized_by_title'],
        scope_notes          = data.get('scope_notes', ''),
        ip_address           = request.remote_addr or '',
        user_agent           = request.headers.get('User-Agent', ''),
    )
    return jsonify({'auth_id': record['auth_id'], 'signed_at': record['signed_at']})


@app.route('/deepscan', methods=['POST'])
def start_deep():
    """Full-scope pentest — requires a signed authorization record."""
    url      = _clean_url(request.form.get('url', ''))
    platform = request.form.get('platform', '').strip()
    auth_id  = request.form.get('auth_id', '').strip()

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    # Look up authorization
    from auth_store import get_authorization
    import urllib.parse
    host = urllib.parse.urlparse(url).hostname or ''

    auth_record = None
    if auth_id:
        auth_record = get_authorization(auth_id)
    if not auth_record:
        auth_record = find_authorization_for_domain(host)

    if not auth_record or auth_record.get('status') != 'active':
        return jsonify({
            'error': (
                'No active authorization found for this domain. '
                'Complete the authorization form first.'
            )
        }), 403

    job_id = _new_job(url, 'deep')
    threading.Thread(target=_deep_worker,
                     args=(job_id, url, platform, auth_record), daemon=True).start()
    return jsonify({'job_id': job_id})


@app.route('/status/<job_id>')
def job_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify(job)


@app.route('/report/<job_id>')
def report(job_id):
    job = jobs.get(job_id)
    if not job or job['status'] != 'done':
        return redirect(url_for('index'))
    findings = job.get('findings', [])
    return render_template(
        'report.html', job=job,
        summary=summarize(findings),
        access_path=access_path(findings),
        checklist=checklist(findings),
    )


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)

(() => {
  const state = {
    token: localStorage.getItem('staff_token_jwt') || null,
    staff: null,
  };

  async function api(path, method = 'GET', body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function setToken(token) {
    state.token = token;
    if (token) localStorage.setItem('staff_token_jwt', token);
    else localStorage.removeItem('staff_token_jwt');
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- login / logout ----------

  const loginScreen = document.getElementById('staff-login-screen');
  const dashboardScreen = document.getElementById('staff-dashboard-screen');
  const loginForm = document.getElementById('staff-login-form');
  const codeForm = document.getElementById('staff-code-form');
  let pendingUsername = null;

  document.getElementById('staff-login-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('staff-login-username').value.trim();
    const password = document.getElementById('staff-login-password').value;
    const errBox = document.getElementById('staff-login-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/staff/login', 'POST', { username, password });
      // Username + password alone isn't enough to get in — a one-time code
      // is required next (see /api/staff/login/verify-code). With an email
      // or phone on file (see the "My email" / "My phone" fields on the
      // dashboard) and real delivery configured, data.sent means the code
      // actually went there instead of showing up right here — a genuine
      // second factor rather than just a second step. data.sentVia says
      // which channel it went out on.
      pendingUsername = username;
      document.getElementById('staff-code-display').innerHTML = data.sent
        ? `We've ${data.sentVia === 'sms' ? 'texted' : 'emailed'} your verification code. It expires in ${data.expiresInMinutes} minutes.`
        : `Since this doesn't send real emails/SMS yet, here's your simulated verification code:<strong>${data.code}</strong>It expires in ${data.expiresInMinutes} minutes.`;
      document.getElementById('staff-code-input').value = '';
      document.getElementById('staff-code-error').textContent = '';
      loginForm.classList.add('hidden');
      codeForm.classList.remove('hidden');
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('staff-code-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('staff-code-input').value.trim();
    const errBox = document.getElementById('staff-code-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/staff/login/verify-code', 'POST', { username: pendingUsername, code });
      setToken(data.token);
      state.staff = data.staff;
      codeForm.classList.add('hidden');
      loginForm.classList.remove('hidden');
      enterDashboard();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('staff-code-back-link').onclick = () => {
    codeForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    document.getElementById('staff-login-password').value = '';
  };

  document.getElementById('staff-logout-btn').onclick = () => {
    setToken(null);
    state.staff = null;
    dashboardScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  };

  // Signs this account out of every device it's logged into, including the
  // one making this request — see the comment on
  // POST /api/staff/logout-all-sessions in server.js for why there's no
  // "everywhere but here" option without tracking individual sessions.
  document.getElementById('staff-logout-all-btn').onclick = async () => {
    if (!confirm('This will sign this account out on every device, including this one. Continue?')) return;
    try {
      await api('/api/staff/logout-all-sessions', 'POST');
    } catch {
      // Even if the request fails, still clear the local token below —
      // there's nothing useful left to do with it either way.
    }
    setToken(null);
    state.staff = null;
    dashboardScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  };

  function enterDashboard() {
    const isOwner = state.staff.role === 'owner';
    document.getElementById('staff-who').textContent = `${state.staff.username}${isOwner ? ' (owner)' : ''}`;
    // The "Add employee" form and the Audit log tab are owner-only on the
    // server too (see requireStaffOwner) — hiding them here is just so a
    // regular employee never sees controls that would just 403 anyway.
    document.getElementById('add-employee-panel').classList.toggle('hidden', !isOwner);
    document.getElementById('tab-audit-log').classList.toggle('hidden', !isOwner);
    document.getElementById('my-email-input').value = state.staff.email || '';
    document.getElementById('my-email-success').textContent = '';
    document.getElementById('my-phone-input').value = state.staff.phone || '';
    document.getElementById('my-phone-success').textContent = '';
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    loadSummary();
    loadTickets();
  }

  // Lets any staff member (not just owners) add their own email so their
  // 2FA code — and, for owners, fraud alerts — can actually be delivered
  // instead of only ever shown on this screen.
  document.getElementById('my-email-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('my-email-input').value.trim();
    const errBox = document.getElementById('my-email-error');
    const successBox = document.getElementById('my-email-success');
    errBox.textContent = '';
    successBox.textContent = '';
    try {
      const data = await api('/api/staff/me/email', 'POST', { email });
      state.staff = data.staff;
      successBox.textContent = email ? 'Saved.' : 'Email removed.';
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // Same idea as the email form above, but for a phone number — see
  // POST /api/staff/me/phone in server.js.
  document.getElementById('my-phone-form').onsubmit = async (e) => {
    e.preventDefault();
    const phone = document.getElementById('my-phone-input').value.trim();
    const errBox = document.getElementById('my-phone-error');
    const successBox = document.getElementById('my-phone-success');
    errBox.textContent = '';
    successBox.textContent = '';
    try {
      const data = await api('/api/staff/me/phone', 'POST', { phone });
      state.staff = data.staff;
      successBox.textContent = phone ? 'Saved.' : 'Phone number removed.';
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  async function tryResumeSession() {
    if (!state.token) return;
    try {
      const data = await api('/api/staff/me');
      state.staff = data.staff;
      enterDashboard();
    } catch {
      setToken(null);
    }
  }

  // ---------- tabs ----------

  document.querySelectorAll('.staff-tab').forEach((btn) => {
    btn.onclick = () => switchStaffTab(btn.dataset.staffTab);
  });

  function switchStaffTab(tab) {
    document.querySelectorAll('.staff-tab').forEach((b) => b.classList.toggle('active', b.dataset.staffTab === tab));
    document.querySelectorAll('.staff-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `staff-panel-${tab}`));
    if (tab === 'tickets') loadTickets();
    if (tab === 'cashouts') loadCashouts();
    if (tab === 'employees') loadEmployees();
    if (tab === 'audit') loadAuditLog();
  }

  async function loadSummary() {
    try {
      const data = await api('/api/staff/summary');
      document.getElementById('summary-open-tickets').textContent = data.openTickets;
      document.getElementById('summary-pending-cashouts').textContent = data.pendingCashouts;
    } catch {
      // Summary is a nice-to-have; a failure here shouldn't block the rest
      // of the dashboard from working.
    }
  }

  // ---------- support tickets ----------

  let ticketsStatus = 'open';

  document.querySelectorAll('[data-tickets-status]').forEach((btn) => {
    btn.onclick = () => {
      ticketsStatus = btn.dataset.ticketsStatus;
      document
        .querySelectorAll('[data-tickets-status]')
        .forEach((b) => b.classList.toggle('active', b === btn));
      loadTickets();
    };
  });

  async function loadTickets() {
    const box = document.getElementById('tickets-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api(`/api/staff/support-tickets?status=${ticketsStatus}`);
      renderTickets(data.tickets);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderTickets(tickets) {
    const box = document.getElementById('tickets-list');
    box.innerHTML = '';
    if (tickets.length === 0) {
      box.innerHTML = `<p class="muted">No ${ticketsStatus} tickets.</p>`;
      return;
    }
    tickets.forEach((t) => {
      // Tickets created by the "Report" button on a business review (see
      // reportReview in app.js) embed a machine-readable "Review ID: <uuid>"
      // line so this dashboard can offer a one-click removal — without that,
      // staff would have to go find the review on the business's page
      // themselves. Any ticket without that line is an ordinary support
      // request and gets no such button.
      const reviewIdMatch = t.message.match(/Review ID:\s*([0-9a-f-]{10,})/i);
      const reviewId = reviewIdMatch ? reviewIdMatch[1] : null;
      const card = document.createElement('div');
      card.className = 'staff-item';
      card.innerHTML = `
        <div class="staff-item-top">
          <strong>${t.subject}</strong>
          <span class="pill ${t.status}">${t.status}</span>
        </div>
        <div class="staff-item-meta">${t.name || 'Unknown'} · ${t.email || 'no email'} · ${timeAgo(t.createdAt)}</div>
        <div class="staff-item-body">${t.message}</div>
        ${
          reviewId
            ? `<div class="staff-actions"><button class="btn small secondary remove-review-btn">Remove this review</button></div>`
            : ''
        }
        ${
          t.staffReply
            ? `<div class="staff-reply-box"><div class="muted" style="font-size:11px; font-weight:700; margin-bottom:4px;">REPLIED BY ${(t.repliedBy || '').toUpperCase()}</div>${t.staffReply}</div>`
            : ''
        }
        ${
          t.status === 'open'
            ? `<div class="staff-reply-box">
                 <textarea rows="2" placeholder="Write a reply…" class="ticket-reply-input"></textarea>
                 <div class="staff-actions">
                   <button class="btn small ticket-reply-btn">Reply</button>
                   <button class="btn small secondary ticket-reply-resolve-btn">Reply &amp; resolve</button>
                   <button class="btn small secondary ticket-resolve-btn">Mark resolved</button>
                 </div>
               </div>`
            : ''
        }
      `;
      if (reviewId) {
        card.querySelector('.remove-review-btn').onclick = () => removeReportedReview(reviewId, card);
      }
      if (t.status === 'open') {
        const textarea = card.querySelector('.ticket-reply-input');
        card.querySelector('.ticket-reply-btn').onclick = () => sendTicketReply(t.id, textarea.value, false);
        card.querySelector('.ticket-reply-resolve-btn').onclick = () => sendTicketReply(t.id, textarea.value, true);
        card.querySelector('.ticket-resolve-btn').onclick = () => resolveTicket(t.id);
      }
      box.appendChild(card);
    });
  }

  // Deliberately separate from resolving the ticket — removing a review is
  // a bigger, harder-to-undo action, so it doesn't happen automatically
  // just because a reply was sent. See DELETE /api/staff/reviews/:id.
  async function removeReportedReview(reviewId, card) {
    if (!confirm('Permanently remove this review from the business page? This cannot be undone.')) return;
    try {
      await api(`/api/staff/reviews/${reviewId}`, 'DELETE');
      const btn = card.querySelector('.remove-review-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Review removed';
      }
    } catch (err) {
      alert(err.message);
    }
  }

  async function sendTicketReply(id, reply, resolve) {
    if (!reply || !reply.trim()) return;
    try {
      await api(`/api/staff/support-tickets/${id}/reply`, 'POST', { reply: reply.trim(), resolve });
      loadTickets();
      loadSummary();
    } catch (err) {
      alert(err.message);
    }
  }

  async function resolveTicket(id) {
    try {
      await api(`/api/staff/support-tickets/${id}/resolve`, 'POST');
      loadTickets();
      loadSummary();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- cash-out queue ----------

  let cashoutsStatus = 'pending';

  document.querySelectorAll('[data-cashouts-status]').forEach((btn) => {
    btn.onclick = () => {
      cashoutsStatus = btn.dataset.cashoutsStatus;
      document
        .querySelectorAll('[data-cashouts-status]')
        .forEach((b) => b.classList.toggle('active', b === btn));
      loadCashouts();
    };
  });

  async function loadCashouts() {
    const box = document.getElementById('cashouts-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api(`/api/staff/cashouts?status=${cashoutsStatus}`);
      renderCashouts(data.cashouts);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderCashouts(cashouts) {
    const box = document.getElementById('cashouts-list');
    box.innerHTML = '';
    if (cashouts.length === 0) {
      box.innerHTML = `<p class="muted">No ${cashoutsStatus} cash-out requests.</p>`;
      return;
    }
    cashouts.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'staff-item';
      card.innerHTML = `
        <div class="staff-item-top">
          <strong>$${c.paytag || c.username} · GYD ${fmt(c.amountGyd)}</strong>
          <span class="pill ${c.status}">${c.status}</span>
        </div>
        <div class="staff-item-meta">@${c.username} · requested ${timeAgo(c.createdAt)}${
        c.resolvedAt ? ` · resolved ${timeAgo(c.resolvedAt)}` : ''
      }</div>
        ${
          c.status === 'pending'
            ? `<div class="staff-actions">
                 <button class="btn small cashout-complete-btn">Mark paid</button>
                 <button class="btn small secondary cashout-reject-btn">Reject &amp; refund</button>
               </div>`
            : ''
        }
      `;
      if (c.status === 'pending') {
        card.querySelector('.cashout-complete-btn').onclick = () => completeCashout(c.id);
        card.querySelector('.cashout-reject-btn').onclick = () => rejectCashout(c.id);
      }
      box.appendChild(card);
    });
  }

  async function completeCashout(id) {
    if (!confirm('Mark this cash-out as paid? Only do this after you\'ve actually sent the customer their money outside the app.')) return;
    try {
      await api(`/api/staff/cashouts/${id}/complete`, 'POST');
      loadCashouts();
      loadSummary();
    } catch (err) {
      alert(err.message);
    }
  }

  async function rejectCashout(id) {
    if (!confirm('Reject this request and refund the GYD back to the customer\'s balance?')) return;
    try {
      await api(`/api/staff/cashouts/${id}/reject`, 'POST');
      loadCashouts();
      loadSummary();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- employees ----------

  document.getElementById('add-employee-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-employee-username').value.trim();
    const password = document.getElementById('new-employee-password').value;
    const email = document.getElementById('new-employee-email').value.trim();
    const role = document.getElementById('new-employee-is-owner').checked ? 'owner' : 'employee';
    const errBox = document.getElementById('add-employee-error');
    errBox.textContent = '';
    try {
      await api('/api/staff/accounts', 'POST', { username, password, email, role });
      document.getElementById('add-employee-form').reset();
      loadEmployees();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  async function loadEmployees() {
    const box = document.getElementById('employees-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api('/api/staff/accounts');
      renderEmployees(data.accounts);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderEmployees(accounts) {
    const box = document.getElementById('employees-list');
    box.innerHTML = '';
    if (accounts.length === 0) {
      box.innerHTML = '<p class="muted">No employees yet.</p>';
      return;
    }
    const isOwner = state.staff.role === 'owner';
    accounts.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'staff-employee-row';
      row.innerHTML = `
        <span>${a.username} ${a.role === 'owner' ? '<span class="pill approved">owner</span>' : '<span class="pill pending">employee</span>'}${a.email ? ` <span class="muted" style="font-size:11px;">${a.email}</span>` : ''}</span>
        <span class="muted">added ${timeAgo(a.createdAt)}</span>
        ${isOwner ? '<button class="btn small secondary revoke-sessions-btn" title="Signs this account out of every device it\'s logged into">Sign out everywhere</button>' : ''}
      `;
      if (isOwner) {
        row.querySelector('.revoke-sessions-btn').onclick = () => revokeStaffSessions(a.id, a.username);
      }
      box.appendChild(row);
    });
  }

  // Owner-only — see requireStaffOwner on the server route. Lets an owner
  // cut off a specific employee's access right now (a suspected compromise,
  // someone just let go) without needing their password.
  async function revokeStaffSessions(id, username) {
    if (!confirm(`Sign "${username}" out of every device they're logged into?`)) return;
    try {
      await api(`/api/staff/accounts/${id}/revoke-sessions`, 'POST');
      alert(`${username} has been signed out everywhere.`);
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- audit log (owner-only) ----------

  async function loadAuditLog() {
    const box = document.getElementById('audit-log-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api('/api/staff/audit-log');
      renderAuditLog(data.entries);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderAuditLog(entries) {
    const box = document.getElementById('audit-log-list');
    box.innerHTML = '';
    if (entries.length === 0) {
      box.innerHTML = '<p class="muted">Nothing logged yet.</p>';
      return;
    }
    entries.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'staff-item';
      row.innerHTML = `
        <div class="staff-item-top">
          <strong>${e.action.replace(/_/g, ' ')}</strong>
          <span class="muted" style="font-size:12px;">${timeAgo(e.createdAt)}</span>
        </div>
        <div class="staff-item-meta">by ${e.staffUsername}</div>
        ${e.details ? `<div class="staff-item-body">${e.details}</div>` : ''}
      `;
      box.appendChild(row);
    });
  }

  tryResumeSession();
})();

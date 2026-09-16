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

  document.getElementById('staff-login-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('staff-login-username').value.trim();
    const password = document.getElementById('staff-login-password').value;
    const errBox = document.getElementById('staff-login-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/staff/login', 'POST', { username, password });
      setToken(data.token);
      state.staff = data.staff;
      enterDashboard();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('staff-logout-btn').onclick = () => {
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
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    loadSummary();
    loadTickets();
  }

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
      if (t.status === 'open') {
        const textarea = card.querySelector('.ticket-reply-input');
        card.querySelector('.ticket-reply-btn').onclick = () => sendTicketReply(t.id, textarea.value, false);
        card.querySelector('.ticket-reply-resolve-btn').onclick = () => sendTicketReply(t.id, textarea.value, true);
        card.querySelector('.ticket-resolve-btn').onclick = () => resolveTicket(t.id);
      }
      box.appendChild(card);
    });
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
          <strong>$${c.cashtag || c.username} · GYD ${fmt(c.amountGyd)}</strong>
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
    const role = document.getElementById('new-employee-is-owner').checked ? 'owner' : 'employee';
    const errBox = document.getElementById('add-employee-error');
    errBox.textContent = '';
    try {
      await api('/api/staff/accounts', 'POST', { username, password, role });
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
    accounts.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'staff-employee-row';
      row.innerHTML = `<span>${a.username} ${a.role === 'owner' ? '<span class="pill approved">owner</span>' : '<span class="pill pending">employee</span>'}</span><span class="muted">added ${timeAgo(a.createdAt)}</span>`;
      box.appendChild(row);
    });
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

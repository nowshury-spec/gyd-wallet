(() => {
  const state = {
    token: localStorage.getItem('token_app_jwt') || null,
    user: null,
    activeThreadUsername: null,
    pollHandle: null,
  };

  // ---------- api helper ----------

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
    if (token) localStorage.setItem('token_app_jwt', token);
    else localStorage.removeItem('token_app_jwt');
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  // ---------- auth screen ----------

  const authScreen = document.getElementById('auth-screen');
  const appScreen = document.getElementById('app-screen');

  document.getElementById('tab-login').onclick = () => switchAuthTab('login');
  document.getElementById('tab-register').onclick = () => switchAuthTab('register');

  function switchAuthTab(which) {
    const isAuthTab = which === 'login' || which === 'register';
    document.querySelector('.auth-tabs').classList.toggle('hidden', !isAuthTab);
    document.getElementById('tab-login').classList.toggle('active', which === 'login');
    document.getElementById('tab-register').classList.toggle('active', which === 'register');
    document.getElementById('login-form').classList.toggle('hidden', which !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', which !== 'register');
    document.getElementById('forgot-form').classList.toggle('hidden', which !== 'forgot');
    document.getElementById('reset-form').classList.toggle('hidden', which !== 'reset');
    document.getElementById('forgot-username-form').classList.toggle('hidden', which !== 'forgot-username');
    document.getElementById('username-result-panel').classList.toggle('hidden', which !== 'username-result');
  }

  document.getElementById('register-is-business').onchange = (e) => {
    document.getElementById('business-name-field').classList.toggle('hidden', !e.target.checked);
  };

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errBox = document.getElementById('login-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/login', 'POST', { username, password });
      setToken(data.token);
      state.user = data.user;
      enterApp();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('register-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    const isBusiness = document.getElementById('register-is-business').checked;
    const businessName = document.getElementById('register-business-name').value.trim();
    const errBox = document.getElementById('register-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/register', 'POST', { username, email, password, isBusiness, businessName });
      setToken(data.token);
      state.user = data.user;
      enterApp();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('forgot-password-link').onclick = () => {
    document.getElementById('login-error').textContent = '';
    document.getElementById('forgot-email').value = document.getElementById('login-username').value.includes('@')
      ? document.getElementById('login-username').value.trim()
      : '';
    document.getElementById('forgot-error').textContent = '';
    switchAuthTab('forgot');
  };

  document.getElementById('forgot-back-link').onclick = () => switchAuthTab('login');
  document.getElementById('reset-back-link').onclick = () => switchAuthTab('login');

  let resetEmail = '';

  document.getElementById('forgot-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    const errBox = document.getElementById('forgot-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/auth/forgot-password', 'POST', { email });
      resetEmail = email;
      // Real email delivery (see email.js) skips the on-screen code
      // entirely — data.sent means it's on its way to the inbox instead.
      document.getElementById('reset-code-display').innerHTML = data.sent
        ? `We've emailed a reset code to <strong style="font-size:16px; letter-spacing:normal;">${email}</strong>. It expires in ${data.expiresInMinutes} minutes.`
        : `Since GYD Wallet doesn't send real emails yet, here's your simulated reset code:<strong>${data.code}</strong>It expires in ${data.expiresInMinutes} minutes.`;
      document.getElementById('reset-code').value = '';
      document.getElementById('reset-new-password').value = '';
      document.getElementById('reset-error').textContent = '';
      switchAuthTab('reset');
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-new-password').value;
    const errBox = document.getElementById('reset-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/auth/reset-password', 'POST', { email: resetEmail, code, newPassword });
      setToken(data.token);
      state.user = data.user;
      enterApp();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('forgot-username-link').onclick = () => {
    document.getElementById('login-error').textContent = '';
    document.getElementById('forgot-username-email').value = document.getElementById('login-username').value.includes('@')
      ? document.getElementById('login-username').value.trim()
      : '';
    document.getElementById('forgot-username-error').textContent = '';
    switchAuthTab('forgot-username');
  };

  document.getElementById('forgot-username-back-link').onclick = () => switchAuthTab('login');
  document.getElementById('username-result-login-btn').onclick = () => switchAuthTab('login');

  document.getElementById('forgot-username-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-username-email').value.trim();
    const errBox = document.getElementById('forgot-username-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/auth/forgot-username', 'POST', { email });
      document.getElementById('username-result-display').innerHTML = data.sent
        ? `We've emailed your username to <strong class="username-value">${email}</strong>.`
        : `Here's the username on that account:<strong class="username-value">${data.username}</strong>`;
      switchAuthTab('username-result');
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('logout-btn').onclick = () => {
    setToken(null);
    state.user = null;
    if (state.pollHandle) clearInterval(state.pollHandle);
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
  };

  // Signs this account out of every device it's logged into, including
  // this one — see the comment on POST /api/security/logout-all-sessions
  // in server.js for why there's no "everywhere but here" option without
  // tracking individual sessions.
  document.getElementById('logout-all-btn').onclick = async () => {
    if (!confirm('This will sign you out on every device, including this one. Continue?')) return;
    try {
      await api('/api/security/logout-all-sessions', 'POST');
    } catch (err) {
      alert(err.message);
      return;
    }
    setToken(null);
    state.user = null;
    if (state.pollHandle) clearInterval(state.pollHandle);
    appScreen.classList.add('hidden');
    authScreen.classList.remove('hidden');
  };

  // ---------- app shell / nav ----------

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  document.getElementById('header-scan-btn').onclick = () => switchTab('qr');
  document.getElementById('header-support-btn').onclick = () => switchTab('support');

  document.querySelectorAll('.quick-action').forEach((btn) => {
    btn.onclick = () => {
      const jump = btn.dataset.tabJump;
      if (jump) {
        switchTab(jump);
        return;
      }
      switchTab('wallet');
      const focusId = btn.dataset.focus;
      requestAnimationFrame(() => {
        const el = document.getElementById(focusId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
        }
      });
    };
  });

  function switchTab(tab) {
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle(
        'active',
        b.dataset.tab === tab ||
          (tab === 'remit' && b.dataset.tab === 'send') ||
          (tab === 'bizpage' && b.dataset.tab === 'business') ||
          (tab === 'mytickets' && b.dataset.tab === 'business') ||
          (tab === 'jobs' && b.dataset.tab === 'business') ||
          (tab === 'ludo' && b.dataset.tab === 'games')
      )
    );
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${tab}`));
    if (tab === 'send') {
      loadUsers('');
      loadMoneyRequests();
    }
    if (tab === 'qr') initQrTab();
    else stopQrCamera();
    if (tab !== 'business') stopCheckinCamera();
    if (tab === 'games') loadRounds();
    if (tab === 'business') {
      loadBusiness();
      loadDirectory();
      loadMyBusinessPage();
      loadMyEvents();
      loadMyJobs();
    }
    if (tab === 'messages') loadThreads();
    if (tab === 'wallet') loadTransactions();
    if (tab === 'remit') openRemitLobby();
    if (tab === 'ludo') enterLudoTab();
    if (tab === 'mytickets') loadMyTickets();
    if (tab === 'jobs') loadJobsBoard();
    if (tab === 'support') loadSupportTickets();
  }

  document.getElementById('my-tickets-btn').onclick = () => switchTab('mytickets');
  document.getElementById('mytickets-back-btn').onclick = () => switchTab('business');
  document.getElementById('jobs-board-btn').onclick = () => switchTab('jobs');
  document.getElementById('jobs-back-btn').onclick = () => switchTab('business');

  function renderWho() {
    document.getElementById('who-username').textContent = state.user.username;
    document.getElementById('who-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
    document.getElementById('who-tag').textContent = `$${state.user.paytag}` + (state.user.isBusiness ? ` · Business` : '');
    document.getElementById('balance-gyd').textContent = fmt(state.user.gydBalance);
    document.getElementById('business-owner-panel').classList.toggle('hidden', !state.user.isBusiness);
    if (state.user.isBusiness) {
      document.getElementById('biz-wallet-balance').textContent = fmt(state.user.businessGydBalance);
    }
    const paytagInput = document.getElementById('paytag-input');
    if (document.activeElement !== paytagInput) paytagInput.value = state.user.paytag || '';
  }

  document.getElementById('paytag-save-btn').onclick = async () => {
    const val = document.getElementById('paytag-input').value.trim();
    const errBox = document.getElementById('paytag-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/me/paytag', 'POST', { paytag: val });
      state.user = data.user;
      renderWho();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- business wallet (separate balance for business accounts) ----------

  document.getElementById('biz-wallet-move-btn').onclick = async () => {
    const amount = Number(document.getElementById('biz-wallet-move-amount').value);
    const errBox = document.getElementById('biz-wallet-move-error');
    const successBox = document.getElementById('biz-wallet-move-success');
    errBox.textContent = '';
    successBox.textContent = '';
    if (!positiveWager(amount)) return (errBox.textContent = 'Enter a positive amount.');
    try {
      const data = await api('/api/business/wallet/move-to-personal', 'POST', { amount });
      state.user = data.user;
      renderWho();
      document.getElementById('biz-wallet-move-amount').value = '';
      successBox.textContent = `Moved GYD ${fmt(amount)} to your personal wallet.`;
      loadTransactions();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  async function refreshMe() {
    const data = await api('/api/me');
    state.user = data.user;
    renderWho();
  }

  async function enterApp() {
    authScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    renderWho();
    switchTab('wallet');
    if (state.pollHandle) clearInterval(state.pollHandle);
    state.pollHandle = setInterval(() => {
      refreshMe().catch(() => {});
    }, 15000);
  }

  // ---------- wallet ----------

  document.getElementById('deposit-btn').onclick = () => runWalletAction('deposit-amount', 'deposit-error', '/api/wallet/deposit');
  document.getElementById('cashout-btn').onclick = () => runWalletAction('cashout-amount', 'cashout-error', '/api/wallet/cashout');

  async function runWalletAction(inputId, errId, path) {
    const input = document.getElementById(inputId);
    const errBox = document.getElementById(errId);
    errBox.textContent = '';
    const amount = Number(input.value);
    try {
      const data = await api(path, 'POST', { amount });
      state.user = data.user;
      renderWho();
      input.value = '';
      loadTransactions();
    } catch (err) {
      errBox.textContent = err.message;
    }
  }

  async function loadTransactions() {
    const data = await api('/api/wallet/transactions');
    const tbody = document.getElementById('transactions-body');
    tbody.innerHTML = '';
    for (const tx of data.transactions) {
      const isOut = tx.from_user === state.user.id;
      const sign = tx.to_user === state.user.id && tx.from_user !== state.user.id ? '+' : isOut ? '−' : '';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tx.type.replace(/_/g, ' ')}</td>
        <td>${sign}${fmt(tx.amount)}</td>
        <td>${tx.currency}</td>
        <td><span class="pill ${tx.status}">${tx.status}</span></td>
        <td class="muted">${timeAgo(tx.created_at)}</td>
      `;
      tbody.appendChild(tr);
    }
    if (data.transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">No activity yet.</td></tr>';
    }
  }

  // ---------- pay / request (keypad) / users ----------
  //
  // One panel now does both jobs: a big amount display fed by a numeric
  // keypad (cents-first entry — typing 5 then 0 then 0 builds "$5.00"), a
  // single "To" field, and two buttons — Pay sends the money immediately,
  // Request asks for it — instead of two separate forms with their own
  // amount/recipient fields.

  let payDigits = ''; // raw digits typed so far; the rightmost two are cents

  function payAmount() {
    return Number(payDigits || '0') / 100;
  }

  function renderPayAmount() {
    document.getElementById('pay-amount-display').textContent = `$${fmt(payAmount())}`;
    const hasAmount = payAmount() > 0;
    const hasRecipient = document.getElementById('pay-to').value.trim().length > 0;
    const enabled = hasAmount && hasRecipient;
    document.getElementById('pay-pay-btn').disabled = !enabled;
    document.getElementById('pay-request-btn').disabled = !enabled;
  }

  function resetPayForm() {
    payDigits = '';
    document.getElementById('pay-to').value = '';
    document.getElementById('pay-note').value = '';
    renderPayAmount();
  }

  document.querySelectorAll('.pay-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (!key) return; // the blank filler key in the keypad grid
      if (key === 'back') payDigits = payDigits.slice(0, -1);
      // Cap at a sensible amount (99,999,999.99) so the display never overflows.
      else if (payDigits.length < 10) payDigits += key;
      renderPayAmount();
    });
  });

  document.getElementById('pay-to').addEventListener('input', renderPayAmount);

  document.getElementById('pay-pay-btn').onclick = async () => {
    const toUsername = document.getElementById('pay-to').value.trim();
    const memo = document.getElementById('pay-note').value.trim();
    const amount = payAmount();
    const errBox = document.getElementById('pay-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/transfer', 'POST', { toUsername, amount, memo: memo || undefined });
      state.user = data.user;
      renderWho();
      resetPayForm();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('pay-request-btn').onclick = async () => {
    const toHandle = document.getElementById('pay-to').value.trim();
    const note = document.getElementById('pay-note').value.trim();
    const amount = payAmount();
    const errBox = document.getElementById('pay-error');
    errBox.textContent = '';
    try {
      await api('/api/requests', 'POST', { toHandle, amount, note });
      resetPayForm();
      loadMoneyRequests();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('user-search').oninput = (e) => loadUsers(e.target.value.trim());

  async function loadUsers(q) {
    const data = await api(`/api/users?q=${encodeURIComponent(q)}`);
    const tbody = document.getElementById('users-body');
    tbody.innerHTML = '';
    for (const u of data.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>$${u.paytag}</td><td>${u.username}</td><td class="muted">${u.isBusiness ? `Business · ${u.businessName}` : 'Personal'}</td>`;
      tr.style.cursor = 'pointer';
      tr.onclick = () => {
        document.getElementById('pay-to').value = u.paytag ? `$${u.paytag}` : u.username;
        renderPayAmount();
      };
      tbody.appendChild(tr);
    }
    if (data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">No users found.</td></tr>';
    }
  }

  function requestStatusLabel(status) {
    if (status === 'pending') return 'Pending';
    if (status === 'paid') return 'Paid';
    if (status === 'declined') return 'Declined';
    if (status === 'cancelled') return 'Cancelled';
    return status;
  }

  async function loadMoneyRequests() {
    let data;
    try {
      data = await api('/api/requests');
    } catch {
      return;
    }

    const incomingBox = document.getElementById('requests-incoming-list');
    const pendingIncoming = data.incoming.filter((r) => r.status === 'pending');
    incomingBox.innerHTML = '';
    if (pendingIncoming.length === 0) {
      incomingBox.innerHTML = '<p class="muted">No requests right now.</p>';
    } else {
      pendingIncoming.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'remit-list-row';
        const label = document.createElement('div');
        label.innerHTML = `<div><strong>$${r.fromPaytag}</strong> wants GYD ${fmt(r.amount)}</div>${
          r.note ? `<div class="muted" style="font-size:11.5px; margin-top:3px;">${r.note}</div>` : ''
        }`;
        row.appendChild(label);
        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';
        btnGroup.style.flexShrink = '0';
        const payBtn = document.createElement('button');
        payBtn.className = 'btn small';
        payBtn.textContent = 'Pay';
        payBtn.onclick = () => resolveMoneyRequest(r.id, 'pay');
        const declineBtn = document.createElement('button');
        declineBtn.className = 'btn secondary small';
        declineBtn.textContent = 'Decline';
        declineBtn.onclick = () => resolveMoneyRequest(r.id, 'decline');
        btnGroup.appendChild(payBtn);
        btnGroup.appendChild(declineBtn);
        row.appendChild(btnGroup);
        incomingBox.appendChild(row);
      });
    }

    const outgoingBox = document.getElementById('requests-outgoing-list');
    outgoingBox.innerHTML = '';
    if (data.outgoing.length === 0) {
      outgoingBox.innerHTML = '<p class="muted">No requests sent yet.</p>';
    } else {
      data.outgoing.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'remit-list-row';
        const pillClass = r.status === 'paid' ? 'completed' : r.status === 'pending' ? 'pending' : 'declined';
        const label = document.createElement('div');
        label.innerHTML = `<div><strong>$${r.toPaytag}</strong> · GYD ${fmt(r.amount)} <span class="pill ${pillClass}">${requestStatusLabel(r.status)}</span></div>${
          r.note ? `<div class="muted" style="font-size:11.5px; margin-top:3px;">${r.note}</div>` : ''
        }`;
        row.appendChild(label);
        if (r.status === 'pending') {
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn secondary small';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.onclick = () => resolveMoneyRequest(r.id, 'cancel');
          row.appendChild(cancelBtn);
        }
        outgoingBox.appendChild(row);
      });
    }
  }

  async function resolveMoneyRequest(id, action) {
    try {
      const data = await api(`/api/requests/${id}/${action}`, 'POST', {});
      if (data.user) {
        state.user = data.user;
        renderWho();
      }
      loadMoneyRequests();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- games ----------

  let selectedChoice = null;
  document.querySelectorAll('.game-choice').forEach((btn) => {
    btn.onclick = () => {
      selectedChoice = btn.dataset.choice;
      document.querySelectorAll('.game-choice').forEach((b) => b.classList.toggle('selected', b === btn));
    };
  });

  function triggerConfetti(big = false) {
    const colors = ['#4954e6', '#ffce54', '#2f8fff', '#ff3d81', '#22d3c7'];
    const container = document.createElement('div');
    container.className = 'confetti-container';
    document.body.appendChild(container);
    const count = big ? 60 : 28;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = Math.random() * (big ? 0.4 : 0.25) + 's';
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      if (big) {
        piece.style.width = '11px';
        piece.style.height = '18px';
      }
      container.appendChild(piece);
    }
    setTimeout(() => container.remove(), big ? 2400 : 1900);
  }

  let coinFlipInProgress = false;

  document.getElementById('play-btn').onclick = async () => {
    if (coinFlipInProgress) return;
    const errBox = document.getElementById('game-error');
    const resultBox = document.getElementById('game-result-box');
    const coinEl = document.getElementById('flip-coin');
    const shadowEl = document.getElementById('coin-shadow');
    errBox.textContent = '';
    resultBox.innerHTML = '';
    if (!selectedChoice) {
      errBox.textContent = 'Pick heads or tails first.';
      return;
    }

    coinFlipInProgress = true;
    coinEl.getAnimations().forEach((a) => a.cancel());

    // Immediate tactile feedback the instant the button is pressed — a
    // neutral little "pick up" bounce that doesn't commit to a face, since
    // we don't know the real result until the server responds.
    coinEl.animate(
      [
        { transform: 'translateY(0) rotateY(0deg)' },
        { transform: 'translateY(-12px) rotateY(0deg)' },
        { transform: 'translateY(0) rotateY(0deg)' },
      ],
      { duration: 240, easing: 'ease-out' }
    );

    try {
      const data = await api('/api/games/coinflip', 'POST', { choice: selectedChoice });

      // Now that the real result is known, run one continuous toss that
      // actually ends showing that face — heads lands on a multiple of
      // 360°, tails on 180° plus a multiple of 360° — so the coin itself
      // (not just the text below it) shows what happened.
      const fullSpins = 4;
      const targetDeg = fullSpins * 360 + (data.result === 'tails' ? 180 : 0);
      try {
        shadowEl.animate(
          [
            { transform: 'scale(1)', opacity: 0.32 },
            { transform: 'scale(0.5)', opacity: 0.12, offset: 0.5 },
            { transform: 'scale(1)', opacity: 0.32 },
          ],
          { duration: 900, easing: 'ease-in-out' }
        );
        const coinAnim = coinEl.animate(
          [
            { transform: 'translateY(0) rotateY(0deg)', offset: 0 },
            { transform: `translateY(-54px) rotateY(${targetDeg * 0.55}deg)`, offset: 0.45 },
            { transform: `translateY(0) rotateY(${targetDeg}deg)`, offset: 1 },
          ],
          { duration: 900, easing: 'cubic-bezier(0.32, 0.1, 0.28, 1)', fill: 'forwards' }
        );
        await coinAnim.finished;
      } catch (animErr) {
        // Cosmetic only — never let an animation hiccup hide the real result.
      }

      resultBox.innerHTML = `<div class="game-result ${data.won ? 'win' : 'lose'}">
        Landed on <strong>${data.result}</strong> — ${data.won ? 'you called it! 🎉' : 'better luck next flip.'}
      </div>`;
      if (data.won) triggerConfetti();
      loadRounds();
    } catch (err) {
      errBox.textContent = err.message;
    } finally {
      coinFlipInProgress = false;
    }
  };

  function positiveWager(v) {
    return typeof v === 'number' && isFinite(v) && v > 0;
  }

  const SLOT_CLIENT_SYMBOLS = ['🍒', '🍋', '🔔', '💎'];
  const SLOT_CELL_HEIGHT = 84; // must match .slot-cell height in styles.css
  let slotSpinInProgress = false;

  function randomSlotSymbol() {
    return SLOT_CLIENT_SYMBOLS[Math.floor(Math.random() * SLOT_CLIENT_SYMBOLS.length)];
  }

  function slotCellsHtml(symbols) {
    return symbols.map((s) => `<span class="slot-cell"><span class="slot-symbol">${s}</span></span>`).join('');
  }

  // Spins one reel like the physical strip inside a real slot machine: it
  // fills the strip with a run of random symbols ending in `finalSymbol`,
  // then animates the whole strip upward past the reel window with an
  // ease-out curve, so it starts fast and visibly decelerates into place
  // rather than just swapping symbols in a box. Resolves once it's settled.
  function spinReelStrip(index, finalSymbol, { length, duration }) {
    return new Promise((resolve) => {
      const reel = document.getElementById(`slot-reel-${index}`);
      const strip = document.getElementById(`slot-strip-${index}`);
      reel.classList.remove('settled');

      const randomRun = Array.from({ length: length - 1 }, randomSlotSymbol);
      const allSymbols = [...randomRun, finalSymbol];
      strip.innerHTML = slotCellsHtml(allSymbols);
      strip.classList.add('spin-blur');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      void strip.offsetHeight; // force reflow so the transition below starts from translateY(0)

      const travel = (allSymbols.length - 1) * SLOT_CELL_HEIGHT;
      strip.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      strip.style.transform = `translateY(-${travel}px)`;

      // Sharpen the symbols again shortly before it stops, matching how a
      // real reel comes into visible focus as it slows down at the end.
      setTimeout(() => strip.classList.remove('spin-blur'), duration * 0.75);

      setTimeout(() => {
        // Collapse the strip back down to just the landed symbol so
        // transform distances never keep growing spin after spin.
        strip.style.transition = 'none';
        strip.innerHTML = slotCellsHtml([finalSymbol]);
        strip.style.transform = 'translateY(0)';
        reel.classList.add('settled', 'just-settled');
        setTimeout(() => reel.classList.remove('just-settled'), 280);
        resolve();
      }, duration);
    });
  }

  document.getElementById('slot-play-btn').onclick = async () => {
    if (slotSpinInProgress) return;
    const errBox = document.getElementById('slot-error');
    const resultBox = document.getElementById('slot-result-box');
    errBox.textContent = '';
    resultBox.innerHTML = '';

    slotSpinInProgress = true;
    try {
      const data = await api('/api/games/slots', 'POST', {});

      // All three reels start spinning together, but each runs a different
      // strip length/duration so they visibly stop left to right, like a
      // real slot machine settling one reel at a time.
      await Promise.all([
        spinReelStrip(0, data.reels[0], { length: 18, duration: 950 }),
        spinReelStrip(1, data.reels[1], { length: 24, duration: 1300 }),
        spinReelStrip(2, data.reels[2], { length: 30, duration: 1650 }),
      ]);

      if (data.jackpot) {
        resultBox.innerHTML = `<div class="game-result jackpot">💎 JACKPOT! 💎</div>`;
        triggerConfetti(true);
      } else if (data.won) {
        resultBox.innerHTML = `<div class="game-result win">Three in a row! 🎉</div>`;
        triggerConfetti();
      } else {
        resultBox.innerHTML = `<div class="game-result lose">No match this time.</div>`;
      }
      loadRounds();
    } catch (err) {
      errBox.textContent = err.message;
    } finally {
      slotSpinInProgress = false;
    }
  };

  async function loadRounds() {
    const data = await api('/api/games/history');

    const coinRows = data.rounds.filter((r) => r.game === 'coinflip');
    const coinBody = document.getElementById('rounds-body');
    coinBody.innerHTML = '';
    for (const r of coinRows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.choice}</td>
        <td>${r.outcome}</td>
        <td><span class="pill ${r.won ? 'completed' : 'declined'}">${r.won ? 'Win' : 'Lose'}</span></td>
        <td class="muted">${timeAgo(r.created_at)}</td>
      `;
      coinBody.appendChild(tr);
    }
    if (coinRows.length === 0) {
      coinBody.innerHTML = '<tr><td colspan="4" class="muted">No rounds played yet.</td></tr>';
    }

    const slotRows = data.rounds.filter((r) => r.game === 'slots');
    const slotBody = document.getElementById('slot-rounds-body');
    slotBody.innerHTML = '';
    for (const r of slotRows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-size:15px;">${r.outcome}</td>
        <td><span class="pill ${r.won ? 'completed' : 'declined'}">${r.won ? 'Win' : 'Lose'}</span></td>
        <td class="muted">${timeAgo(r.created_at)}</td>
      `;
      slotBody.appendChild(tr);
    }
    if (slotRows.length === 0) {
      slotBody.innerHTML = '<tr><td colspan="3" class="muted">No spins yet.</td></tr>';
    }
  }

  // ---------- business ----------

  document.getElementById('charge-btn').onclick = async () => {
    const customerUsername = document.getElementById('charge-username').value.trim();
    const amount = Number(document.getElementById('charge-amount').value);
    const memo = document.getElementById('charge-memo').value.trim();
    const errBox = document.getElementById('charge-error');
    errBox.textContent = '';
    try {
      await api('/api/business/charge-requests', 'POST', { customerUsername, amount, memo });
      document.getElementById('charge-username').value = '';
      document.getElementById('charge-amount').value = '';
      document.getElementById('charge-memo').value = '';
      loadBusiness();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  async function loadBusiness() {
    const data = await api('/api/business/charge-requests');

    const incomingBody = document.getElementById('incoming-charges-body');
    incomingBody.innerHTML = '';
    for (const r of data.incoming) {
      const tr = document.createElement('tr');
      const actionCell =
        r.status === 'pending'
          ? `<button class="btn small" data-approve="${r.id}">Approve</button> <button class="btn secondary small" data-decline="${r.id}">Decline</button>`
          : '';
      tr.innerHTML = `
        <td>${r.business_name || r.business_username}</td>
        <td>${fmt(r.amount)}</td>
        <td class="muted">${r.memo || '—'}</td>
        <td><span class="pill ${r.status}">${r.status}</span></td>
        <td>${actionCell}</td>
      `;
      incomingBody.appendChild(tr);
    }
    if (data.incoming.length === 0) {
      incomingBody.innerHTML = '<tr><td colspan="5" class="muted">No payment requests yet.</td></tr>';
    }
    incomingBody.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.onclick = () => resolveCharge(btn.dataset.approve, 'approve');
    });
    incomingBody.querySelectorAll('[data-decline]').forEach((btn) => {
      btn.onclick = () => resolveCharge(btn.dataset.decline, 'decline');
    });

    if (state.user.isBusiness) {
      const sentBody = document.getElementById('sent-charges-body');
      sentBody.innerHTML = '';
      for (const r of data.sent) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.customer_username}</td>
          <td>${fmt(r.amount)}</td>
          <td class="muted">${r.memo || '—'}</td>
          <td><span class="pill ${r.status}">${r.status}</span></td>
        `;
        sentBody.appendChild(tr);
      }
      if (data.sent.length === 0) {
        sentBody.innerHTML = '<tr><td colspan="4" class="muted">No requests sent yet.</td></tr>';
      }
    }
  }

  async function resolveCharge(id, action) {
    try {
      const data = await api(`/api/business/charge-requests/${id}/${action}`, 'POST', {});
      state.user = data.user;
      renderWho();
      loadBusiness();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- business directory (find a business, business pages) ----------

  const BUSINESS_CATEGORIES = [
    'Bakery & Desserts',
    'Restaurant & Food',
    'Groceries & Markets',
    'Retail & Shopping',
    'Beauty & Wellness',
    'Automotive',
    'Home & Repair Services',
    'Professional Services',
    'Health & Fitness',
    'Events & Entertainment',
    'Other',
  ];

  // A small preset palette rather than a raw color picker — enough to let a
  // business's page "feel like theirs" without needing to validate arbitrary
  // color input. Always rendered as translucent backgrounds with the solid
  // color as text/border (like the app's existing pill/tag treatment), never
  // as a solid fill behind white text, so it stays legible no matter which
  // swatch is picked.
  const THEME_SWATCHES = ['#4954e6', '#2f8fff', '#ff3d81', '#ff9f43', '#22d3c7', '#ffce54', '#a855f7', '#ff5470'];

  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(0, 217, 100, ${alpha})`;
    const num = parseInt(m[1], 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Renders a rating as "★★★★☆ 4.3 (12)" — filled stars for the rounded
  // average, empty stars for the rest, with the review count in parens so
  // it's clear at a glance how much that average is actually based on. A
  // business with no reviews yet just shows a muted "No reviews yet" line
  // instead of a 0-star row, which would otherwise look like a bad rating.
  function starSummaryHtml(avgRating, reviewCount, small) {
    const count = reviewCount || 0;
    const sizeClass = small ? ' star-summary-small' : '';
    if (!count || avgRating === null || avgRating === undefined) {
      return `<div class="star-summary${sizeClass} muted">No reviews yet</div>`;
    }
    const rounded = Math.round(avgRating);
    const stars = '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
    return `<div class="star-summary${sizeClass}"><span class="star-glyphs">${stars}</span> <span class="muted">${avgRating.toFixed(1)} (${count})</span></div>`;
  }

  ['bizpage-category', 'directory-category'].forEach((id) => {
    const sel = document.getElementById(id);
    BUSINESS_CATEGORIES.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  });

  function renderSwatches() {
    const row = document.getElementById('bizpage-swatches');
    const hiddenInput = document.getElementById('bizpage-theme-color');
    row.innerHTML = '';
    THEME_SWATCHES.forEach((color) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (color === hiddenInput.value ? ' selected' : '');
      sw.style.background = color;
      sw.onclick = () => {
        hiddenInput.value = color;
        row.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
      };
      row.appendChild(sw);
    });
  }
  renderSwatches();

  async function loadMyBusinessPage() {
    if (!state.user.isBusiness) return;
    try {
      const data = await api('/api/business/profile');
      if (data.profile) {
        document.getElementById('bizpage-category').value = data.profile.category || '';
        document.getElementById('bizpage-tagline').value = data.profile.tagline || '';
        document.getElementById('bizpage-description').value = data.profile.description || '';
        document.getElementById('bizpage-keywords').value = data.profile.keywords.join(', ');
        document.getElementById('bizpage-logo').value = data.profile.logoEmoji || '';
        document.getElementById('bizpage-phone').value = data.profile.phone || '';
        document.getElementById('bizpage-location').value = data.profile.location || '';
        document.getElementById('bizpage-theme-color').value = data.profile.themeColor || THEME_SWATCHES[0];
        document.getElementById('bizpage-offers-delivery').checked = !!data.profile.offersDelivery;
        document.getElementById('bizpage-delivery-fee').value = data.profile.deliveryFee || '';
        document.getElementById('bizpage-delivery-fee-field').classList.toggle('hidden', !data.profile.offersDelivery);
        renderSwatches();
      }
    } catch {
      // No page set up yet — leave the form at its defaults.
    }
    loadMyProducts();
  }

  // ---------- business products & prices ----------

  // A product photo is read client-side, downscaled onto a canvas, and
  // re-encoded as a compressed JPEG data: URL before it's ever sent to the
  // server — keeps the upload small (this prototype has no real file
  // storage; see db.js) without needing any image-processing library.
  let pendingProductImage = null;

  function resizeImageToDataUrl(file, maxDim = 500, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round(height * (maxDim / width));
              width = maxDim;
            } else {
              width = Math.round(width * (maxDim / height));
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Could not read that image.'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('Could not read that image.'));
      reader.readAsDataURL(file);
    });
  }

  function clearPendingProductImage() {
    pendingProductImage = null;
    document.getElementById('product-image-input').value = '';
    document.getElementById('product-image-preview').classList.add('hidden');
  }

  document.getElementById('product-image-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const errBox = document.getElementById('product-error');
    try {
      pendingProductImage = await resizeImageToDataUrl(file);
      document.getElementById('product-image-preview-img').src = pendingProductImage;
      document.getElementById('product-image-preview').classList.remove('hidden');
    } catch (err) {
      errBox.textContent = err.message;
      clearPendingProductImage();
    }
  };

  document.getElementById('product-image-remove-btn').onclick = clearPendingProductImage;

  async function loadMyProducts() {
    const box = document.getElementById('my-products-list');
    try {
      const data = await api('/api/business/products');
      renderMyProducts(data.products);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderMyProducts(products) {
    const box = document.getElementById('my-products-list');
    box.innerHTML = '';
    if (products.length === 0) {
      box.innerHTML = '<p class="muted">No products added yet.</p>';
      return;
    }
    products.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'product-row';
      row.innerHTML = `
        ${p.imageUrl ? `<img class="product-thumb" src="${p.imageUrl}" alt="${p.name}" />` : ''}
        <div class="product-info">
          <div class="product-name">${p.name}</div>
          ${p.description ? `<div class="product-description">${p.description}</div>` : ''}
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="product-price">GYD ${fmt(p.price)}</span>
        </div>
      `;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn secondary small';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        try {
          const data = await api(`/api/business/products/${p.id}`, 'DELETE');
          renderMyProducts(data.products);
        } catch (err) {
          alert(err.message);
        }
      };
      row.lastElementChild.appendChild(removeBtn);
      box.appendChild(row);
    });
  }

  document.getElementById('product-add-btn').onclick = async () => {
    const name = document.getElementById('product-name').value.trim();
    const price = Number(document.getElementById('product-price').value);
    const description = document.getElementById('product-description').value.trim();
    const errBox = document.getElementById('product-error');
    errBox.textContent = '';
    if (!name) return (errBox.textContent = 'Enter a product or service name.');
    if (!positiveWager(price)) return (errBox.textContent = 'Enter a positive price.');
    try {
      const data = await api('/api/business/products', 'POST', { name, price, description, imageData: pendingProductImage });
      document.getElementById('product-name').value = '';
      document.getElementById('product-price').value = '';
      document.getElementById('product-description').value = '';
      clearPendingProductImage();
      renderMyProducts(data.products);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- business events & tickets ----------

  function fmtEventDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  async function loadMyEvents() {
    if (!state.user.isBusiness) return;
    const box = document.getElementById('my-events-list');
    try {
      const data = await api('/api/business/events');
      renderMyEvents(data.events);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderMyEvents(events) {
    const box = document.getElementById('my-events-list');
    box.innerHTML = '';
    if (events.length === 0) {
      box.innerHTML = '<p class="muted">No events posted yet.</p>';
      return;
    }
    events.forEach((ev) => {
      const row = document.createElement('div');
      row.className = 'event-row';
      const soldText = ev.capacity === null ? `${ev.ticketsSold} sold` : `${ev.ticketsSold} / ${ev.capacity} sold`;
      const statusPill =
        ev.status === 'cancelled'
          ? '<span class="pill declined">cancelled</span>'
          : ev.soldOut
          ? '<span class="pill pending">sold out</span>'
          : '<span class="pill completed">active</span>';
      row.innerHTML = `
        <div class="event-info">
          <div class="event-title-row">
            <span class="event-name">${ev.title}</span>
            ${statusPill}
          </div>
          <div class="muted" style="font-size:12px;">${fmtEventDate(ev.eventDate)}${ev.location ? ' · ' + ev.location : ''}</div>
          <div class="muted" style="font-size:12px; margin-top:2px;">GYD ${fmt(ev.ticketPrice)}/ticket · ${soldText}</div>
        </div>
        <div class="event-actions"></div>
      `;
      const actions = row.querySelector('.event-actions');

      const attendeesBtn = document.createElement('button');
      attendeesBtn.className = 'btn secondary small';
      attendeesBtn.textContent = 'Attendees';
      attendeesBtn.onclick = () => toggleAttendees(ev.id);
      actions.appendChild(attendeesBtn);

      if (ev.status === 'active') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn secondary small';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = async () => {
          if (!confirm(`Cancel "${ev.title}"? Existing tickets stay valid, but no new ones can be sold.`)) return;
          try {
            const data = await api(`/api/business/events/${ev.id}/cancel`, 'POST', {});
            renderMyEvents(data.events);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(cancelBtn);
      }

      if (ev.ticketsSold === 0) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn secondary small';
        delBtn.textContent = 'Delete';
        delBtn.onclick = async () => {
          if (!confirm(`Delete "${ev.title}"?`)) return;
          try {
            const data = await api(`/api/business/events/${ev.id}`, 'DELETE');
            renderMyEvents(data.events);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(delBtn);
      }

      box.appendChild(row);

      const attendeesBox = document.createElement('div');
      attendeesBox.className = 'event-attendees hidden';
      attendeesBox.id = `event-attendees-${ev.id}`;
      box.appendChild(attendeesBox);
    });
  }

  async function toggleAttendees(eventId) {
    const box = document.getElementById(`event-attendees-${eventId}`);
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = '<p class="muted" style="font-size:12px;">Loading attendees…</p>';
    try {
      const data = await api(`/api/business/events/${eventId}/tickets`);
      if (data.tickets.length === 0) {
        box.innerHTML = '<p class="muted" style="font-size:12px;">No tickets sold yet.</p>';
        return;
      }
      box.innerHTML = `<div class="table-scroll"><table>
        <thead><tr><th>Buyer</th><th>Code</th><th>Status</th></tr></thead>
        <tbody>${data.tickets
          .map(
            (t) =>
              `<tr><td>${t.buyerUsername}</td><td><code>${t.ticketCode}</code></td><td><span class="pill ${
                t.status === 'checked_in' ? 'completed' : 'pending'
              }">${t.status === 'checked_in' ? 'checked in' : 'valid'}</span></td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
    } catch (err) {
      box.innerHTML = `<p class="muted" style="font-size:12px;">${err.message}</p>`;
    }
  }

  document.getElementById('event-add-btn').onclick = async () => {
    const title = document.getElementById('event-title').value.trim();
    const description = document.getElementById('event-description').value.trim();
    const location = document.getElementById('event-location').value.trim();
    const dateInput = document.getElementById('event-date').value;
    const ticketPrice = Number(document.getElementById('event-price').value);
    const capacityRaw = document.getElementById('event-capacity').value.trim();
    const errBox = document.getElementById('event-error');
    errBox.textContent = '';
    if (!title) return (errBox.textContent = 'Give your event a title.');
    if (!dateInput) return (errBox.textContent = 'Pick a date for the event.');
    if (!positiveWager(ticketPrice)) return (errBox.textContent = 'Enter a positive ticket price.');
    if (capacityRaw !== '' && (!Number.isInteger(Number(capacityRaw)) || Number(capacityRaw) <= 0)) {
      return (errBox.textContent = 'Capacity must be a positive whole number, or left blank for unlimited.');
    }
    const eventDate = fmtEventDate(new Date(dateInput).toISOString());
    try {
      const data = await api('/api/business/events', 'POST', {
        title,
        description,
        location,
        eventDate,
        ticketPrice,
        capacity: capacityRaw === '' ? null : Number(capacityRaw),
      });
      document.getElementById('event-title').value = '';
      document.getElementById('event-description').value = '';
      document.getElementById('event-location').value = '';
      document.getElementById('event-date').value = '';
      document.getElementById('event-price').value = '';
      document.getElementById('event-capacity').value = '';
      renderMyEvents(data.events);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- business jobs (job board) ----------

  async function loadMyJobs() {
    if (!state.user.isBusiness) return;
    const box = document.getElementById('my-jobs-list');
    try {
      const data = await api('/api/business/jobs');
      renderMyJobs(data.jobs);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderMyJobs(jobs) {
    const box = document.getElementById('my-jobs-list');
    box.innerHTML = '';
    if (jobs.length === 0) {
      box.innerHTML = '<p class="muted">No jobs posted yet.</p>';
      return;
    }
    jobs.forEach((j) => {
      const row = document.createElement('div');
      row.className = 'event-row';
      const statusPill =
        j.status === 'closed' ? '<span class="pill declined">closed</span>' : '<span class="pill completed">active</span>';
      const details = [j.jobType, j.location, j.payInfo].filter(Boolean).join(' · ');
      row.innerHTML = `
        <div class="event-info">
          <div class="event-title-row">
            <span class="event-name">${j.title}</span>
            ${statusPill}
          </div>
          ${details ? `<div class="muted" style="font-size:12px;">${details}</div>` : ''}
          <div class="product-description" style="margin-top:2px;">${j.description}</div>
        </div>
        <div class="event-actions"></div>
      `;
      const actions = row.querySelector('.event-actions');

      if (j.status === 'active') {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn secondary small';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = async () => {
          if (!confirm(`Close "${j.title}"? It'll come down from your page and the Jobs board.`)) return;
          try {
            const data = await api(`/api/business/jobs/${j.id}/close`, 'POST', {});
            renderMyJobs(data.jobs);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(closeBtn);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'btn secondary small';
      delBtn.textContent = 'Delete';
      delBtn.onclick = async () => {
        if (!confirm(`Delete "${j.title}"?`)) return;
        try {
          const data = await api(`/api/business/jobs/${j.id}`, 'DELETE');
          renderMyJobs(data.jobs);
        } catch (err) {
          alert(err.message);
        }
      };
      actions.appendChild(delBtn);

      box.appendChild(row);
    });
  }

  document.getElementById('job-add-btn').onclick = async () => {
    const title = document.getElementById('job-title').value.trim();
    const description = document.getElementById('job-description').value.trim();
    const location = document.getElementById('job-location').value.trim();
    const payInfo = document.getElementById('job-pay').value.trim();
    const jobType = document.getElementById('job-type').value;
    const errBox = document.getElementById('job-error');
    errBox.textContent = '';
    if (!title) return (errBox.textContent = 'Give the job a title.');
    if (!description) return (errBox.textContent = 'Add a short description of the job.');
    try {
      const data = await api('/api/business/jobs', 'POST', { title, description, location, payInfo, jobType });
      document.getElementById('job-title').value = '';
      document.getElementById('job-description').value = '';
      document.getElementById('job-location').value = '';
      document.getElementById('job-pay').value = '';
      document.getElementById('job-type').value = '';
      renderMyJobs(data.jobs);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // The site-wide jobs board: every active job posting across every
  // business, with search + job-type filtering — separate from a specific
  // business's page so someone can browse openings without already
  // knowing which businesses are hiring.
  let jobsSearchDebounce = null;
  async function loadJobsBoard() {
    const box = document.getElementById('jobs-board-list');
    const q = document.getElementById('jobs-search').value.trim();
    const jobType = document.getElementById('jobs-type-filter').value;
    box.innerHTML = '<p class="muted">Loading jobs…</p>';
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (jobType) params.set('jobType', jobType);
      const data = await api(`/api/jobs?${params.toString()}`);
      renderJobsBoard(data.jobs);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderJobsBoard(jobs) {
    const box = document.getElementById('jobs-board-list');
    box.innerHTML = '';
    if (jobs.length === 0) {
      box.innerHTML = '<p class="muted">No jobs found.</p>';
      return;
    }
    jobs.forEach((j) => {
      const row = document.createElement('div');
      row.className = 'panel event-row';
      const details = [j.jobType, j.location, j.payInfo].filter(Boolean).join(' · ');
      row.innerHTML = `
        <div class="event-info">
          <div class="event-title-row">
            <span class="event-name">${j.title}</span>
          </div>
          <div class="muted" style="font-size:12px;">${j.business.name}${details ? ' · ' + details : ''}</div>
          <div class="product-description" style="margin-top:4px;">${j.description}</div>
        </div>
        <div class="event-actions"></div>
      `;
      const actions = row.querySelector('.event-actions');
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn small';
      applyBtn.textContent = 'Apply';
      applyBtn.onclick = () => applyToJob(j);
      actions.appendChild(applyBtn);
      box.appendChild(row);
    });
  }

  function applyToJob(j) {
    switchTab('messages');
    openThread(j.business.username, `Hi, I'm interested in the ${j.title} position.`);
  }

  document.getElementById('jobs-search').addEventListener('input', () => {
    clearTimeout(jobsSearchDebounce);
    jobsSearchDebounce = setTimeout(loadJobsBoard, 300);
  });
  document.getElementById('jobs-type-filter').addEventListener('change', loadJobsBoard);

  function renderBizPageJobs(b) {
    const panel = document.getElementById('bizpage-view-jobs-panel');
    const box = document.getElementById('bizpage-view-jobs');
    box.innerHTML = '';
    const jobs = (b.jobs || []).filter((j) => j.status === 'active');
    if (jobs.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    jobs.forEach((j) => {
      const row = document.createElement('div');
      row.className = 'event-row';
      const details = [j.jobType, j.location, j.payInfo].filter(Boolean).join(' · ');
      row.innerHTML = `
        <div class="event-info">
          <div class="event-title-row">
            <span class="event-name">${j.title}</span>
          </div>
          ${details ? `<div class="muted" style="font-size:12px;">${details}</div>` : ''}
          <div class="product-description" style="margin-top:2px;">${j.description}</div>
        </div>
        <div class="event-actions"></div>
      `;
      const actions = row.querySelector('.event-actions');
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn small';
      applyBtn.textContent = 'Apply';
      applyBtn.onclick = () => applyToJob({ ...j, business: { username: b.username, name: b.businessName } });
      actions.appendChild(applyBtn);
      box.appendChild(row);
    });
  }

  // ---------- ticket check-in ----------

  async function runCheckin(rawCode) {
    const errBox = document.getElementById('checkin-error');
    const resultBox = document.getElementById('checkin-result');
    errBox.textContent = '';
    resultBox.innerHTML = '';
    const code = (rawCode || '').trim().toUpperCase();
    if (!code) {
      errBox.textContent = 'Enter or scan a ticket code.';
      return;
    }
    try {
      const data = await api(`/api/business/events/tickets/${encodeURIComponent(code)}/check-in`, 'POST', {});
      document.getElementById('checkin-code').value = '';
      if (data.ok) {
        resultBox.innerHTML = `<p><span class="pill completed">Checked in</span> ${data.ticket.buyerUsername} — ${data.eventTitle}</p>`;
      } else if (data.reason === 'already_checked_in') {
        resultBox.innerHTML = `<p><span class="pill pending">Already checked in</span> ${data.ticket.buyerUsername} — ${data.eventTitle}${
          data.ticket.checkedInAt ? ' (' + fmtEventDate(data.ticket.checkedInAt) + ')' : ''
        }</p>`;
      }
      loadMyEvents();
    } catch (err) {
      errBox.textContent = err.message;
    }
  }

  document.getElementById('checkin-btn').onclick = () => runCheckin(document.getElementById('checkin-code').value);
  document.getElementById('checkin-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCheckin(document.getElementById('checkin-code').value);
  });

  const checkinScan = { stream: null, pollHandle: null };

  async function stopCheckinCamera() {
    if (checkinScan.pollHandle) {
      clearInterval(checkinScan.pollHandle);
      checkinScan.pollHandle = null;
    }
    if (checkinScan.stream) {
      checkinScan.stream.getTracks().forEach((t) => t.stop());
      checkinScan.stream = null;
    }
    document.getElementById('checkin-camera').classList.add('hidden');
  }

  document.getElementById('checkin-scan-btn').onclick = async () => {
    const errBox = document.getElementById('checkin-error');
    errBox.textContent = '';
    if (!('BarcodeDetector' in window)) {
      errBox.textContent = "Your browser doesn't support live camera scanning — type the code instead.";
      return;
    }
    try {
      checkinScan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('checkin-video');
      video.srcObject = checkinScan.stream;
      document.getElementById('checkin-camera').classList.remove('hidden');
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      checkinScan.pollHandle = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) {
            const raw = codes[0].rawValue;
            await stopCheckinCamera();
            runCheckin(raw.replace(/^gydticket:/i, ''));
          }
        } catch {
          /* transient decode errors are expected between frames */
        }
      }, 350);
    } catch (err) {
      errBox.textContent = 'Could not access the camera: ' + err.message;
    }
  };

  document.getElementById('checkin-stop-scan-btn').onclick = stopCheckinCamera;

  // ---------- my tickets ----------

  function ticketQrUrl(code) {
    return qrImageUrl(`gydticket:${code}`);
  }

  async function loadMyTickets() {
    const box = document.getElementById('my-tickets-list');
    box.innerHTML = '<p class="muted">Loading your tickets…</p>';
    try {
      const data = await api('/api/me/tickets');
      renderMyTickets(data.tickets);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderMyTickets(tickets) {
    const box = document.getElementById('my-tickets-list');
    box.innerHTML = '';
    if (tickets.length === 0) {
      box.innerHTML = '<p class="muted">No tickets yet — buy one from a business page.</p>';
      return;
    }
    tickets.forEach((t) => {
      const checkedIn = t.status === 'checked_in';
      const card = document.createElement('div');
      card.className = 'panel ticket-card';
      card.innerHTML = `
        <div class="ticket-card-info">
          <div class="event-title-row">
            <span class="event-name">${t.event.title}</span>
            <span class="pill ${checkedIn ? 'completed' : 'pending'}">${checkedIn ? 'checked in' : 'valid'}</span>
          </div>
          <div class="muted" style="font-size:12px;">${fmtEventDate(t.event.date)}${t.event.location ? ' · ' + t.event.location : ''}</div>
          <div class="muted" style="font-size:12px;">${t.business.name || t.business.username} · GYD ${fmt(t.pricePaid)}</div>
          ${
            t.event.status === 'cancelled'
              ? '<div style="font-size:12px; color:var(--bad); font-weight:700; margin-top:4px;">This event was cancelled.</div>'
              : ''
          }
        </div>
        <div class="ticket-card-qr">
          <img src="${ticketQrUrl(t.ticketCode)}" alt="Ticket QR code" width="140" height="140" />
          <code>${t.ticketCode}</code>
        </div>
      `;
      box.appendChild(card);
    });
  }

  // ---------- help & support ----------

  document.getElementById('support-form').onsubmit = async (e) => {
    e.preventDefault();
    const subject = document.getElementById('support-subject').value.trim();
    const message = document.getElementById('support-message').value.trim();
    const errBox = document.getElementById('support-error');
    errBox.textContent = '';
    try {
      await api('/api/support/tickets', 'POST', { subject, message });
      document.getElementById('support-form').reset();
      loadSupportTickets();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  async function loadSupportTickets() {
    const box = document.getElementById('support-tickets-list');
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api('/api/support/tickets/mine');
      renderSupportTickets(data.tickets);
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  function renderSupportTickets(tickets) {
    const box = document.getElementById('support-tickets-list');
    box.innerHTML = '';
    if (tickets.length === 0) {
      box.innerHTML = '<p class="muted">No requests sent yet.</p>';
      return;
    }
    tickets.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'panel';
      card.style.marginBottom = '10px';
      card.innerHTML = `
        <div class="panel-row" style="justify-content:space-between; align-items:flex-start;">
          <strong>${t.subject}</strong>
          <span class="pill ${t.status}">${t.status}</span>
        </div>
        <div class="muted" style="font-size:12px; margin:4px 0 8px;">${timeAgo(t.createdAt)}</div>
        <div style="font-size:13px;">${t.message}</div>
        ${
          t.staffReply
            ? `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
                 <div class="muted" style="font-size:11px; font-weight:700; margin-bottom:4px;">SUPPORT REPLY</div>
                 <div style="font-size:13px;">${t.staffReply}</div>
               </div>`
            : '<div class="muted" style="font-size:12px; margin-top:8px;">Waiting on a reply…</div>'
        }
      `;
      box.appendChild(card);
    });
  }

  document.getElementById('bizpage-offers-delivery').onchange = (e) => {
    document.getElementById('bizpage-delivery-fee-field').classList.toggle('hidden', !e.target.checked);
  };

  document.getElementById('bizpage-save-btn').onclick = async () => {
    const category = document.getElementById('bizpage-category').value;
    const tagline = document.getElementById('bizpage-tagline').value.trim();
    const description = document.getElementById('bizpage-description').value.trim();
    const keywords = document.getElementById('bizpage-keywords').value.trim();
    const logoEmoji = document.getElementById('bizpage-logo').value.trim();
    const phone = document.getElementById('bizpage-phone').value.trim();
    const location = document.getElementById('bizpage-location').value.trim();
    const themeColor = document.getElementById('bizpage-theme-color').value;
    const offersDelivery = document.getElementById('bizpage-offers-delivery').checked;
    const deliveryFee = document.getElementById('bizpage-delivery-fee').value;
    const errBox = document.getElementById('bizpage-save-error');
    const successBox = document.getElementById('bizpage-save-success');
    errBox.textContent = '';
    successBox.textContent = '';
    try {
      await api('/api/business/profile', 'POST', {
        category, tagline, description, keywords, logoEmoji, phone, location, themeColor,
        offersDelivery, deliveryFee: offersDelivery ? deliveryFee : 0,
      });
      successBox.textContent = 'Saved — your page is live in the directory.';
      loadDirectory();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  let directorySearchTimer = null;
  document.getElementById('directory-search').oninput = () => {
    clearTimeout(directorySearchTimer);
    directorySearchTimer = setTimeout(loadDirectory, 250);
  };
  document.getElementById('directory-category').onchange = loadDirectory;

  async function loadDirectory() {
    const q = document.getElementById('directory-search').value.trim();
    const category = document.getElementById('directory-category').value;
    const box = document.getElementById('directory-results');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      const data = await api(`/api/business/directory?${params.toString()}`);
      box.innerHTML = '';
      if (data.businesses.length === 0) {
        box.innerHTML = '<p class="muted">No businesses found. Try a different search or category.</p>';
        return;
      }
      data.businesses.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'directory-card';
        card.innerHTML = `
          <div class="directory-logo" style="background:${hexToRgba(b.themeColor, 0.18)};">${b.logoEmoji || '🏢'}</div>
          <div class="directory-info">
            <div class="biz-name">${b.businessName}</div>
            <div class="biz-tagline">${b.tagline || ''}</div>
            ${starSummaryHtml(b.avgRating, b.reviewCount, true)}
          </div>
          <span class="pill" style="background:${hexToRgba(b.themeColor, 0.16)}; color:${b.themeColor};">${b.category}</span>
        `;
        card.onclick = () => openBusinessPage(b.username);
        box.appendChild(card);
      });
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  async function openBusinessPage(username) {
    switchTab('bizpage');
    document.getElementById('bizpage-checkout-panel').classList.add('hidden');
    try {
      const data = await api(`/api/business/directory/${encodeURIComponent(username)}`);
      const b = data.business;
      const logoEl = document.getElementById('bizpage-view-logo');
      logoEl.textContent = b.logoEmoji || '🏢';
      logoEl.style.background = hexToRgba(b.themeColor, 0.18);
      logoEl.style.border = `1px solid ${hexToRgba(b.themeColor, 0.4)}`;
      document.getElementById('bizpage-view-name').textContent = b.businessName;
      document.getElementById('bizpage-view-paytag').textContent = `$${b.paytag}`;
      const categoryEl = document.getElementById('bizpage-view-category');
      categoryEl.textContent = b.category;
      categoryEl.style.background = hexToRgba(b.themeColor, 0.16);
      categoryEl.style.color = b.themeColor;
      document.getElementById('bizpage-view-tagline').textContent = b.tagline || '';
      document.getElementById('bizpage-view-description').textContent = b.description || '';
      document.getElementById('bizpage-view-rating-summary').innerHTML = starSummaryHtml(b.avgRating, b.reviewCount, false);
      const keywordsBox = document.getElementById('bizpage-view-keywords');
      keywordsBox.innerHTML = '';
      b.keywords.forEach((k) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = k;
        keywordsBox.appendChild(chip);
      });
      const contactBits = [];
      if (b.phone) contactBits.push(`📞 ${b.phone}`);
      if (b.location) contactBits.push(`📍 ${b.location}`);
      document.getElementById('bizpage-view-contact').textContent = contactBits.join('   ·   ');
      const deliveryNote = document.getElementById('bizpage-view-delivery');
      deliveryNote.style.display = b.offersDelivery ? '' : 'none';
      deliveryNote.textContent = b.offersDelivery
        ? b.deliveryFee > 0
          ? `🚚 Delivery available — GYD ${fmt(b.deliveryFee)} fee`
          : '🚚 Free delivery available'
        : '';

      const productsBox = document.getElementById('bizpage-view-products');
      productsBox.innerHTML = '';
      if (!b.products || b.products.length === 0) {
        productsBox.innerHTML = '<p class="muted">No products listed yet.</p>';
      } else {
        b.products.forEach((p) => {
          const row = document.createElement('div');
          row.className = 'product-row';
          row.innerHTML = `
            ${p.imageUrl ? `<img class="product-thumb" src="${p.imageUrl}" alt="${p.name}" />` : ''}
            <div class="product-info">
              <div class="product-name">${p.name}</div>
              ${p.description ? `<div class="product-description">${p.description}</div>` : ''}
            </div>
            <span class="product-price">GYD ${fmt(p.price)}</span>
          `;
          productsBox.appendChild(row);
        });
      }

      renderBizPageEvents(b, username);
      renderBizPageJobs(b);
      renderBizPageReviews(b, username);

      document.getElementById('bizpage-view-message-btn').onclick = () => {
        switchTab('messages');
        openThread(b.username);
      };
      document.getElementById('bizpage-view-pay-btn').onclick = () => openCheckout(b);
    } catch (err) {
      alert(err.message);
      switchTab('business');
    }
  }

  // ---------- ratings & reviews ----------

  let reviewBusinessUsername = null;
  let reviewSelectedRating = 0;

  function setReviewStars(rating) {
    reviewSelectedRating = rating;
    document.querySelectorAll('#bizpage-review-star-picker .star-picker-btn').forEach((btn) => {
      btn.classList.toggle('selected', Number(btn.dataset.value) <= rating);
    });
  }

  document.querySelectorAll('#bizpage-review-star-picker .star-picker-btn').forEach((btn) => {
    btn.onclick = () => setReviewStars(Number(btn.dataset.value));
  });

  function renderBizPageReviews(b, username) {
    reviewBusinessUsername = username;
    const formPanel = document.getElementById('bizpage-review-form-panel');
    const errBox = document.getElementById('bizpage-review-error');
    const successBox = document.getElementById('bizpage-review-success');
    errBox.textContent = '';
    successBox.textContent = '';

    // A business can't rate its own page — hide the "rate this business"
    // form entirely when the logged-in user is viewing their own listing.
    formPanel.classList.toggle('hidden', !!b.isOwnBusiness);
    if (!b.isOwnBusiness) {
      setReviewStars(b.myReview ? b.myReview.rating : 0);
      document.getElementById('bizpage-review-comment').value = b.myReview ? b.myReview.comment || '' : '';
      document.getElementById('bizpage-review-remove-btn').classList.toggle('hidden', !b.myReview);
    }

    const box = document.getElementById('bizpage-view-reviews');
    box.innerHTML = '';
    if (!b.reviews || b.reviews.length === 0) {
      box.innerHTML = '<p class="muted">No reviews yet — be the first to rate this business.</p>';
      return;
    }
    b.reviews.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'review-row';
      row.innerHTML = `
        <div class="review-row-top">
          <span class="star-glyphs">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
          <strong>@${r.reviewerUsername}</strong>
          <button type="button" class="link-btn report-review-btn" style="margin-left:auto; font-size:11px;">Report</button>
        </div>
        ${r.comment ? `<div class="product-description" style="margin-top:4px;">${r.comment}</div>` : ''}
      `;
      row.querySelector('.report-review-btn').onclick = () => reportReview(username, r.id);
      box.appendChild(row);
    });
  }

  // Opens a support ticket for staff to look at rather than hiding the
  // review immediately — see the comment on the report endpoint in
  // server.js for why. A staff member can remove it from their portal if
  // it's actually spam or abuse.
  async function reportReview(username, reviewId) {
    const reason = prompt('Why are you reporting this review? (optional)') || '';
    try {
      await api(`/api/business/directory/${encodeURIComponent(username)}/reviews/${reviewId}/report`, 'POST', { reason });
      alert("Thanks — we've sent this to our support team to look at.");
    } catch (err) {
      alert(err.message);
    }
  }

  document.getElementById('bizpage-review-submit-btn').onclick = async () => {
    const errBox = document.getElementById('bizpage-review-error');
    const successBox = document.getElementById('bizpage-review-success');
    errBox.textContent = '';
    successBox.textContent = '';
    if (!reviewSelectedRating) return (errBox.textContent = 'Choose a star rating from 1 to 5.');
    const comment = document.getElementById('bizpage-review-comment').value.trim();
    try {
      await api(`/api/business/directory/${encodeURIComponent(reviewBusinessUsername)}/review`, 'POST', {
        rating: reviewSelectedRating,
        comment,
      });
      successBox.textContent = 'Thanks — your rating was saved.';
      openBusinessPage(reviewBusinessUsername);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('bizpage-review-remove-btn').onclick = async () => {
    const errBox = document.getElementById('bizpage-review-error');
    errBox.textContent = '';
    try {
      await api(`/api/business/directory/${encodeURIComponent(reviewBusinessUsername)}/review`, 'DELETE');
      setReviewStars(0);
      document.getElementById('bizpage-review-comment').value = '';
      openBusinessPage(reviewBusinessUsername);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  function renderBizPageEvents(b, username) {
    const panel = document.getElementById('bizpage-view-events-panel');
    const box = document.getElementById('bizpage-view-events');
    box.innerHTML = '';
    const events = (b.events || []).filter((e) => e.status === 'active');
    if (events.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    events.forEach((ev) => {
      const row = document.createElement('div');
      row.className = 'event-row';
      const availability = ev.soldOut
        ? '<span class="pill pending">sold out</span>'
        : ev.ticketsRemaining !== null
        ? `<span class="muted" style="font-size:12px;">${ev.ticketsRemaining} left</span>`
        : '';
      row.innerHTML = `
        <div class="event-info">
          <div class="event-title-row">
            <span class="event-name">${ev.title}</span>
            ${availability}
          </div>
          <div class="muted" style="font-size:12px;">${fmtEventDate(ev.eventDate)}${ev.location ? ' · ' + ev.location : ''}</div>
          ${ev.description ? `<div class="product-description" style="margin-top:2px;">${ev.description}</div>` : ''}
          <div style="font-weight:800; font-size:13.5px; margin-top:4px;">GYD ${fmt(ev.ticketPrice)} / ticket</div>
        </div>
        <div class="event-actions"></div>
      `;
      const actions = row.querySelector('.event-actions');
      if (ev.soldOut) {
        box.appendChild(row);
        return;
      }
      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.min = '1';
      qtyInput.max = String(ev.ticketsRemaining !== null ? Math.min(10, ev.ticketsRemaining) : 10);
      qtyInput.value = '1';
      qtyInput.className = 'event-qty-input';
      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn small';
      buyBtn.textContent = 'Buy ticket(s)';
      buyBtn.onclick = () => buyEventTickets(ev, Number(qtyInput.value), buyBtn, username);
      actions.appendChild(qtyInput);
      actions.appendChild(buyBtn);
      box.appendChild(row);
    });
  }

  async function buyEventTickets(ev, quantity, btn, username) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      alert('Choose at least 1 ticket.');
      return;
    }
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Buying…';
    try {
      const data = await api(`/api/events/${ev.id}/purchase`, 'POST', { quantity });
      state.user = data.user;
      renderWho();
      const codes = data.tickets.map((t) => t.ticketCode).join(', ');
      alert(
        `Bought ${data.tickets.length} ticket(s) to "${ev.title}" for GYD ${fmt(data.totalPrice)}.\n\nFind them (with QR codes) under "My tickets".\n\nCode(s): ${codes}`
      );
      openBusinessPage(username);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  document.getElementById('bizpage-back-btn').onclick = () => switchTab('business');

  // ---------- checkout (pickup vs delivery) ----------

  let checkoutBusiness = null;
  let checkoutFulfillment = 'pickup';

  function updateCheckoutTotalPreview() {
    const amount = Number(document.getElementById('checkout-amount').value);
    const preview = document.getElementById('checkout-total-preview');
    if (!amount || amount <= 0) {
      preview.textContent = '';
      return;
    }
    const fee = checkoutFulfillment === 'delivery' && checkoutBusiness ? checkoutBusiness.deliveryFee || 0 : 0;
    preview.textContent = fee > 0
      ? `Delivery fee: GYD ${fmt(fee)} · Total: GYD ${fmt(amount + fee)}`
      : `Total: GYD ${fmt(amount)}`;
  }
  document.getElementById('checkout-amount').oninput = updateCheckoutTotalPreview;

  document.querySelectorAll('.fulfillment-btn').forEach((btn) => {
    btn.onclick = () => {
      checkoutFulfillment = btn.dataset.fulfillment;
      document.querySelectorAll('.fulfillment-btn').forEach((b) => b.classList.toggle('selected', b === btn));
      document.getElementById('checkout-address-field').classList.toggle('hidden', checkoutFulfillment !== 'delivery');
      updateCheckoutTotalPreview();
    };
  });

  function openCheckout(b) {
    checkoutBusiness = b;
    checkoutFulfillment = 'pickup';
    document.getElementById('checkout-amount').value = '';
    document.getElementById('checkout-address').value = '';
    document.getElementById('checkout-error').textContent = '';
    document.getElementById('checkout-success').textContent = '';
    document.getElementById('checkout-total-preview').textContent = '';
    document.querySelectorAll('.fulfillment-btn').forEach((btn) => btn.classList.toggle('selected', btn.dataset.fulfillment === 'pickup'));
    document.getElementById('checkout-fulfillment-field').classList.toggle('hidden', !b.offersDelivery);
    document.getElementById('checkout-address-field').classList.add('hidden');
    const panel = document.getElementById('bizpage-checkout-panel');
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('checkout-pay-btn').onclick = async () => {
    const amount = Number(document.getElementById('checkout-amount').value);
    const errBox = document.getElementById('checkout-error');
    const successBox = document.getElementById('checkout-success');
    errBox.textContent = '';
    successBox.textContent = '';
    if (!positiveWager(amount)) return (errBox.textContent = 'Enter a positive amount.');
    const wantsDelivery = checkoutBusiness.offersDelivery && checkoutFulfillment === 'delivery';
    const deliveryAddress = document.getElementById('checkout-address').value.trim();
    if (wantsDelivery && !deliveryAddress) return (errBox.textContent = 'Enter a delivery address.');

    try {
      const data = await api('/api/business/checkout', 'POST', {
        businessHandle: checkoutBusiness.username,
        amount,
        fulfillment: wantsDelivery ? 'delivery' : 'pickup',
        deliveryAddress,
      });
      state.user = data.user;
      renderWho();
      successBox.textContent = wantsDelivery
        ? `Paid! Total charged: GYD ${fmt(data.total)} (delivery to ${deliveryAddress})`
        : `Paid! Total charged: GYD ${fmt(data.total)} (pickup)`;
      document.getElementById('checkout-amount').value = '';
      document.getElementById('checkout-address').value = '';
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- messaging ----------

  document.getElementById('new-thread-btn').onclick = () => {
    const username = document.getElementById('new-thread-username').value.trim();
    if (!username) return;
    document.getElementById('new-thread-username').value = '';
    openThread(username);
  };

  async function loadThreads() {
    const data = await api('/api/messages/threads');
    const list = document.getElementById('thread-list');
    list.innerHTML = '';
    for (const t of data.threads) {
      const item = document.createElement('div');
      item.className = 'thread-item' + (t.username === state.activeThreadUsername ? ' active' : '');
      item.innerHTML = `
        <div class="uname">${t.username}${t.isBusiness ? ' 🏢' : ''}</div>
        <div class="preview">${t.fromMe ? 'You: ' : ''}${t.lastMessage}</div>
      `;
      item.onclick = () => openThread(t.username);
      list.appendChild(item);
    }
    if (data.threads.length === 0) {
      list.innerHTML = '<div class="muted" style="font-size:13px;">No conversations yet.</div>';
    }
  }

  async function openThread(username, prefill) {
    state.activeThreadUsername = username;
    document.getElementById('thread-empty').classList.add('hidden');
    document.getElementById('thread-active').classList.remove('hidden');
    document.getElementById('thread-title').textContent = username;
    if (prefill) document.getElementById('compose-input').value = prefill;
    await loadThreads();
    await refreshThreadMessages();
  }

  async function refreshThreadMessages() {
    if (!state.activeThreadUsername) return;
    try {
      const data = await api(`/api/messages/thread/${encodeURIComponent(state.activeThreadUsername)}`);
      const box = document.getElementById('messages-scroll');
      box.innerHTML = '';
      for (const m of data.messages) {
        const div = document.createElement('div');
        div.className = 'bubble ' + (m.fromMe ? 'mine' : 'theirs');
        div.textContent = m.body;
        box.appendChild(div);
      }
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      document.getElementById('thread-empty').classList.remove('hidden');
      document.getElementById('thread-active').classList.add('hidden');
    }
  }

  document.getElementById('compose-send-btn').onclick = sendComposedMessage;
  document.getElementById('compose-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendComposedMessage();
  });

  async function sendComposedMessage() {
    const input = document.getElementById('compose-input');
    const body = input.value.trim();
    if (!body || !state.activeThreadUsername) return;
    input.value = '';
    try {
      await api('/api/messages', 'POST', { toUsername: state.activeThreadUsername, body });
      await refreshThreadMessages();
      await loadThreads();
    } catch (err) {
      alert(err.message);
    }
  }

  // Poll the open thread for new messages every few seconds.
  setInterval(() => {
    if (state.user && state.activeThreadUsername && !document.getElementById('panel-messages').classList.contains('hidden')) {
      refreshThreadMessages();
    }
  }, 4000);

  // ---------- scan & pay (QR codes) ----------

  const qrScan = { stream: null, detector: null, pollHandle: null };

  function buildPayPayload({ to, amount, memo }) {
    const params = new URLSearchParams({ to });
    if (amount) params.set('amount', amount);
    if (memo) params.set('memo', memo);
    return `gydpay:pay?${params.toString()}`;
  }

  // Accepts either a "gydpay:pay?to=...&amount=...&memo=..." payload, a bare
  // username, or (defensively) a full URL someone pasted with the same query
  // params — anything else is treated as invalid.
  function parsePayPayload(raw) {
    const text = (raw || '').trim();
    if (!text) return null;
    if (/^gydpay:pay\?/i.test(text) || /^https?:\/\/.*\?.*\bto=/i.test(text)) {
      try {
        const queryStr = text.split('?').slice(1).join('?');
        const params = new URLSearchParams(queryStr);
        const to = params.get('to');
        if (!to) return null;
        return { to, amount: params.get('amount') || '', memo: params.get('memo') || '' };
      } catch {
        return null;
      }
    }
    // Bare text with no scheme — treat the whole thing as a username.
    if (/^[a-zA-Z0-9_.-]{3,}$/.test(text)) {
      return { to: text, amount: '', memo: '' };
    }
    return null;
  }

  function qrImageUrl(payload) {
    // Generated by a free public QR image service, called from the user's own
    // browser (not this server) — see the README for why, and what a
    // production build should use instead.
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(payload)}`;
  }

  function refreshMyQrCode() {
    const amount = document.getElementById('qr-fixed-amount').value.trim();
    const memo = document.getElementById('qr-memo').value.trim();
    const payload = buildPayPayload({ to: state.user.paytag, amount, memo });
    document.getElementById('qr-image').src = qrImageUrl(payload);
    document.getElementById('qr-payload-text').textContent = payload;
  }

  function initQrTab() {
    refreshMyQrCode();
    ['qr-fixed-amount', 'qr-memo'].forEach((id) => {
      document.getElementById(id).oninput = refreshMyQrCode;
    });

    const supported = 'BarcodeDetector' in window;
    document.getElementById('qr-start-scan-btn').classList.toggle('hidden', !supported);
    document.getElementById('qr-support-note').textContent = supported
      ? 'Point the camera at a GYD Wallet QR code, or upload a photo of one.'
      : "Your browser doesn't support live camera scanning — upload a QR image, or paste the code manually below.";

    document.getElementById('qr-pay-confirm').classList.add('hidden');
    document.getElementById('qr-scan-error').textContent = '';
  }

  document.getElementById('qr-copy-btn').onclick = async () => {
    const text = document.getElementById('qr-payload-text').textContent;
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('qr-copy-btn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = original), 1200);
    } catch {
      alert('Could not copy automatically — select and copy the code manually.');
    }
  };

  async function stopQrCamera() {
    if (qrScan.pollHandle) {
      clearInterval(qrScan.pollHandle);
      qrScan.pollHandle = null;
    }
    if (qrScan.stream) {
      qrScan.stream.getTracks().forEach((t) => t.stop());
      qrScan.stream = null;
    }
    const active = document.getElementById('qr-scan-active');
    const idle = document.getElementById('qr-scan-idle');
    if (active) active.classList.add('hidden');
    if (idle) idle.classList.remove('hidden');
  }

  document.getElementById('qr-start-scan-btn').onclick = async () => {
    const errBox = document.getElementById('qr-scan-error');
    errBox.textContent = '';
    try {
      qrScan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.getElementById('qr-video');
      video.srcObject = qrScan.stream;
      document.getElementById('qr-scan-idle').classList.add('hidden');
      document.getElementById('qr-scan-active').classList.remove('hidden');

      qrScan.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      qrScan.pollHandle = setInterval(async () => {
        try {
          const codes = await qrScan.detector.detect(video);
          if (codes.length > 0) {
            await stopQrCamera();
            handleScannedText(codes[0].rawValue);
          }
        } catch {
          /* transient decode errors are expected between frames */
        }
      }, 350);
    } catch (err) {
      errBox.textContent = 'Could not access the camera: ' + err.message;
    }
  };

  document.getElementById('qr-stop-scan-btn').onclick = stopQrCamera;

  document.getElementById('qr-upload-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const errBox = document.getElementById('qr-scan-error');
    errBox.textContent = '';
    if (!('BarcodeDetector' in window)) {
      errBox.textContent = "Your browser can't decode QR images automatically — paste the code manually below instead.";
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(bitmap);
      if (codes.length === 0) {
        errBox.textContent = "Couldn't find a QR code in that image.";
        return;
      }
      handleScannedText(codes[0].rawValue);
    } catch (err) {
      errBox.textContent = 'Could not read that image: ' + err.message;
    } finally {
      e.target.value = '';
    }
  };

  document.getElementById('qr-manual-btn').onclick = () => {
    const input = document.getElementById('qr-manual-input');
    handleScannedText(input.value);
    input.value = '';
  };

  async function handleScannedText(rawValue) {
    const errBox = document.getElementById('qr-scan-error');
    const parsed = parsePayPayload(rawValue);
    if (!parsed) {
      errBox.textContent = "That doesn't look like a valid GYD Wallet payment code.";
      return;
    }
    if (parsed.to === state.user.username || parsed.to.replace(/^\$/, '') === state.user.paytag) {
      errBox.textContent = "That's your own code — have someone else scan it to pay you.";
      return;
    }
    errBox.textContent = '';

    let recipientInfo = { username: parsed.to, isBusiness: false, businessName: null };
    try {
      recipientInfo = await api(`/api/users/${encodeURIComponent(parsed.to)}`);
    } catch {
      errBox.textContent = 'No user with that username.';
      return;
    }

    document.getElementById('qr-confirm-username').textContent = recipientInfo.paytag ? `$${recipientInfo.paytag}` : recipientInfo.username;
    document.getElementById('qr-confirm-type').textContent = recipientInfo.isBusiness
      ? `Business · ${recipientInfo.businessName}`
      : 'Personal';
    document.getElementById('qr-confirm-amount').value = parsed.amount || '';
    document.getElementById('qr-confirm-memo').value = parsed.memo || '';
    document.getElementById('qr-confirm-error').textContent = '';
    document.getElementById('qr-pay-confirm').classList.remove('hidden');
    document.getElementById('qr-pay-confirm').dataset.toUsername = recipientInfo.username;
  }

  document.getElementById('qr-confirm-cancel-btn').onclick = () => {
    document.getElementById('qr-pay-confirm').classList.add('hidden');
  };

  document.getElementById('qr-confirm-send-btn').onclick = async () => {
    const panel = document.getElementById('qr-pay-confirm');
    const toUsername = panel.dataset.toUsername;
    const amount = Number(document.getElementById('qr-confirm-amount').value);
    const memo = document.getElementById('qr-confirm-memo').value.trim();
    const errBox = document.getElementById('qr-confirm-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/transfer', 'POST', { toUsername, amount, memo });
      state.user = data.user;
      renderWho();
      panel.classList.add('hidden');
      loadTransactions();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- GYD Direct (our own send-to-anyone transfer feature) ----------

  document.getElementById('remit-open-btn').onclick = () => switchTab('remit');
  document.getElementById('remit-back-btn').onclick = () => switchTab('send');

  // Mirrors the server's fee formula purely for an up-front estimate as the
  // user types — the server recalculates and enforces the real fee, this is
  // just so nobody is surprised by the total when they hit "Send with GYD Direct".
  function estimateRemitFee(amount) {
    return Math.round(Math.max(200, amount * 0.025) * 100) / 100;
  }

  function updateRemitFeePreview() {
    const amount = Number(document.getElementById('remit-amount').value);
    const preview = document.getElementById('remit-fee-preview');
    if (!amount || amount <= 0) {
      preview.textContent = '';
      return;
    }
    const fee = estimateRemitFee(amount);
    preview.textContent = `Fee: GYD ${fmt(fee)} · Total charged: GYD ${fmt(amount + fee)}`;
  }
  document.getElementById('remit-amount').oninput = updateRemitFeePreview;

  function remitStatusLabel(status) {
    if (status === 'pending') return 'Pending pickup';
    if (status === 'completed') return 'Picked up';
    if (status === 'cancelled') return 'Cancelled';
    return status;
  }

  async function loadRemitSentList() {
    const box = document.getElementById('remit-sent-list');
    try {
      const data = await api('/api/remit/sent');
      box.innerHTML = '';
      if (data.remittances.length === 0) {
        box.innerHTML = '<p class="muted">No transfers sent yet.</p>';
        return;
      }
      data.remittances.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'remit-list-row';
        const label = document.createElement('div');
        label.innerHTML = `<div><strong>${r.recipientName}</strong> · GYD ${fmt(r.amount)} <span class="pill ${r.status === 'completed' ? 'completed' : r.status === 'cancelled' ? 'declined' : 'pending'}">${remitStatusLabel(r.status)}</span></div>
          <div class="muted" style="font-size:11.5px; margin-top:3px;">Ref ${r.referenceCode} · fee GYD ${fmt(r.fee)} · ${timeAgo(r.createdAt)}</div>`;
        row.appendChild(label);
        if (r.status === 'pending') {
          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn secondary small';
          cancelBtn.textContent = 'Cancel & refund';
          cancelBtn.onclick = async () => {
            try {
              const res = await api(`/api/remit/${r.id}/cancel`, 'POST', {});
              state.user = res.user;
              renderWho();
              loadRemitSentList();
            } catch (err) {
              alert(err.message);
            }
          };
          row.appendChild(cancelBtn);
        }
        box.appendChild(row);
      });
    } catch (err) {
      box.innerHTML = `<p class="muted">${err.message}</p>`;
    }
  }

  async function openRemitLobby() {
    document.getElementById('remit-send-error').textContent = '';
    document.getElementById('remit-claim-error').textContent = '';
    document.getElementById('remit-claim-success').innerHTML = '';
    document.getElementById('remit-receipt-panel').hidden = true;
    await loadRemitSentList();
  }

  document.getElementById('remit-send-btn').onclick = async () => {
    const recipientName = document.getElementById('remit-name').value.trim();
    const recipientPhone = document.getElementById('remit-phone').value.trim();
    const amount = Number(document.getElementById('remit-amount').value);
    const errBox = document.getElementById('remit-send-error');
    errBox.textContent = '';
    if (!recipientName) return (errBox.textContent = "Enter the recipient's full name.");
    if (!recipientPhone) return (errBox.textContent = "Enter the recipient's phone number.");
    if (!positiveWager(amount)) return (errBox.textContent = 'Enter a positive amount to send.');

    try {
      const data = await api('/api/remit', 'POST', { recipientName, recipientPhone, amount });
      state.user = data.user;
      renderWho();

      document.getElementById('remit-name').value = '';
      document.getElementById('remit-phone').value = '';
      document.getElementById('remit-amount').value = '';
      updateRemitFeePreview();

      document.getElementById('remit-receipt-code').textContent = data.remittance.referenceCode;
      document.getElementById('remit-receipt-detail').textContent =
        `GYD ${fmt(data.remittance.amount)} to ${data.remittance.recipientName} · fee GYD ${fmt(data.remittance.fee)} · total charged GYD ${fmt(data.remittance.total)}`;
      document.getElementById('remit-receipt-panel').hidden = false;

      loadRemitSentList();
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  document.getElementById('remit-receipt-done-btn').onclick = () => {
    document.getElementById('remit-receipt-panel').hidden = true;
  };

  document.getElementById('remit-claim-btn').onclick = async () => {
    const referenceCode = document.getElementById('remit-claim-code').value.trim();
    const recipientName = document.getElementById('remit-claim-name').value.trim();
    const errBox = document.getElementById('remit-claim-error');
    const successBox = document.getElementById('remit-claim-success');
    errBox.textContent = '';
    successBox.innerHTML = '';
    if (!referenceCode) return (errBox.textContent = 'Enter the reference code.');
    if (!recipientName) return (errBox.textContent = 'Enter your name exactly as the sender typed it.');

    try {
      const data = await api('/api/remit/claim', 'POST', { referenceCode, recipientName });
      state.user = data.user;
      renderWho();
      document.getElementById('remit-claim-code').value = '';
      document.getElementById('remit-claim-name').value = '';
      successBox.innerHTML = `<div class="game-result win">Received GYD ${fmt(data.amount)}! It's in your balance now.</div>`;
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // ---------- Ludo (free to play, 2 or 4 players) ----------
  //
  // The server (see ludo.js) only ever deals in abstract numbers — a piece's
  // "progress" is 0 (at base), 1-51 (out on the shared 52-cell track),
  // 52-57 (that color's own 6-cell home stretch), or 58 (finished). Turning
  // that into an actual square on the board is entirely this client's job,
  // via the coordinate tables below — they must stay in sync with the
  // LUDO_ENTRY/LUDO_SAFE constants in ludo.js if either ever changes.

  const LUDO_ENTRY_IDX = { red: 0, green: 13, gold: 26, blue: 39 };
  const LUDO_FINISH_PROGRESS = 58;

  // The 52-cell shared outer track, walked in traversal order (index 0 is
  // red's own entry square); see ludo.js for why entries land 13 apart.
  const LUDO_PATH = [
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 7],
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
    [7, 14],
    [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
    [14, 7],
    [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    [7, 0],
    [6, 0],
  ];
  // The 4 "star" safe cells that aren't an entry square (entry + 8, see ludo.js).
  const LUDO_STAR_PATH_INDEXES = [8, 21, 34, 47];
  const LUDO_HOME_STRETCH = {
    red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
    green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
    gold: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
    blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
  };
  const LUDO_BASE_SPOTS = {
    red: [[1, 1], [1, 4], [4, 1], [4, 4]],
    green: [[1, 10], [1, 13], [4, 10], [4, 13]],
    gold: [[10, 10], [10, 13], [13, 10], [13, 13]],
    blue: [[10, 1], [10, 4], [13, 1], [13, 4]],
  };

  function ludoCellCoord(color, progress) {
    if (progress >= 1 && progress <= 51) {
      const idx = (LUDO_ENTRY_IDX[color] + progress - 1) % 52;
      return LUDO_PATH[idx];
    }
    if (progress >= 52 && progress <= 57) return LUDO_HOME_STRETCH[color][progress - 52];
    return [7, 7]; // finished — everyone piles up in the center
  }

  let ludoBoardBuilt = false;
  function buildLudoBoardGrid() {
    const board = document.getElementById('ludo-board');
    board.innerHTML = '';
    const cellSize = 100 / 15;
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const cell = document.createElement('div');
        cell.className = 'ludo-cell';
        cell.style.left = c * cellSize + '%';
        cell.style.top = r * cellSize + '%';
        cell.style.width = cellSize + '%';
        cell.style.height = cellSize + '%';
        if (r < 6 && c < 6) cell.classList.add('ludo-cell-base', 'ludo-cell-base-red');
        else if (r < 6 && c > 8) cell.classList.add('ludo-cell-base', 'ludo-cell-base-green');
        else if (r > 8 && c > 8) cell.classList.add('ludo-cell-base', 'ludo-cell-base-gold');
        else if (r > 8 && c < 6) cell.classList.add('ludo-cell-base', 'ludo-cell-base-blue');
        else if (r >= 6 && r <= 8 && c >= 6 && c <= 8) cell.classList.add('ludo-cell-center');
        else cell.classList.add('ludo-cell-path');
        board.appendChild(cell);
      }
    }
    Object.entries(LUDO_HOME_STRETCH).forEach(([color, cells]) => {
      cells.forEach(([r, c]) => board.children[r * 15 + c].classList.add('ludo-cell-stretch-' + color));
    });
    LUDO_STAR_PATH_INDEXES.forEach((si) => {
      const [r, c] = LUDO_PATH[si];
      const cell = board.children[r * 15 + c];
      cell.classList.add('ludo-cell-star');
      cell.textContent = '★';
    });
    const piecesLayer = document.createElement('div');
    piecesLayer.id = 'ludo-pieces-layer';
    piecesLayer.className = 'ludo-pieces-layer';
    board.appendChild(piecesLayer);
    ludoBoardBuilt = true;
  }

  function renderLudoPieces(table) {
    const layer = document.getElementById('ludo-pieces-layer');
    layer.innerHTML = '';
    const legalMoves = table.isYourTurn && table.pendingRoll ? table.pendingRoll.legalMoves : [];
    table.seats.forEach((seat, seatIndex) => {
      seat.pieces.forEach((progress, pieceIndex) => {
        const piece = document.createElement('div');
        piece.className = 'ludo-piece ludo-piece-' + seat.color;
        const [r, c] = progress === 0 ? LUDO_BASE_SPOTS[seat.color][pieceIndex] : ludoCellCoord(seat.color, progress);
        piece.style.left = ((c + 0.5) / 15) * 100 + '%';
        piece.style.top = ((r + 0.5) / 15) * 100 + '%';
        if (seatIndex === table.yourSeatIndex && legalMoves.includes(pieceIndex)) {
          piece.classList.add('ludo-piece-movable');
          piece.title = 'Move this piece';
          piece.onclick = () => ludoMakeMove(table.id, pieceIndex);
        }
        layer.appendChild(piece);
      });
    });
  }

  function ludoStatusMessage(table) {
    if (table.status === 'waiting') return `Waiting for players (${table.seats.length}/${table.maxPlayers})`;
    if (table.status === 'in_progress') return table.lastEvent || 'Match in progress';
    if (table.status === 'finished') {
      const winner = table.seats.find((s) => s.userId === table.winnerUserId);
      return winner ? `🎉 ${winner.username}${winner.userId === state.user.id ? ' (you)' : ''} won the match!` : 'Match finished.';
    }
    if (table.status === 'cancelled') return 'This table was cancelled.';
    return '';
  }

  function renderLudoSeats(table) {
    const wrap = document.getElementById('ludo-seats');
    wrap.innerHTML = '';
    for (let i = 0; i < table.maxPlayers; i++) {
      const seat = table.seats[i];
      const chip = document.createElement('span');
      chip.className = 'ludo-seat-chip';
      if (seat) {
        chip.classList.add('ludo-seat-chip-' + seat.color);
        if (table.status === 'in_progress' && i === table.turnIndex) chip.classList.add('ludo-seat-chip-active');
        chip.textContent = seat.username + (seat.userId === state.user.id ? ' (you)' : '');
      } else {
        chip.classList.add('ludo-seat-chip-open');
        chip.textContent = 'Open seat';
      }
      wrap.appendChild(chip);
    }
  }

  function renderLudoTableActions(table) {
    const box = document.getElementById('ludo-table-actions');
    box.innerHTML = '';
    if (table.status === 'waiting' && table.hostUserId === state.user.id) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn secondary full';
      cancelBtn.textContent = 'Cancel table';
      cancelBtn.onclick = () => ludoCancelTable(table.id);
      box.appendChild(cancelBtn);
    }
    if (table.status === 'finished' || table.status === 'cancelled') {
      const backBtn = document.createElement('button');
      backBtn.className = 'btn secondary full';
      backBtn.textContent = 'Back to lobby';
      backBtn.onclick = () => {
        ludoCurrentTableId = null;
        openLudoLobby();
      };
      box.appendChild(backBtn);
    }
  }

  function renderLudoControls(table) {
    const controls = document.getElementById('ludo-controls');
    controls.innerHTML = '';
    if (table.status !== 'in_progress') return;
    const rollBtn = document.createElement('button');
    rollBtn.className = 'btn btn-play full';
    rollBtn.id = 'ludo-roll-btn';
    if (!table.isYourTurn) {
      const waitingOn = table.seats[table.turnIndex];
      rollBtn.textContent = waitingOn ? `Waiting for ${waitingOn.username}…` : 'Waiting…';
      rollBtn.disabled = true;
    } else if (table.pendingRoll) {
      rollBtn.textContent = `Rolled ${table.pendingRoll.roll} — tap a highlighted piece`;
      rollBtn.disabled = true;
    } else {
      rollBtn.textContent = '🎲 Roll dice';
      rollBtn.onclick = () => ludoRollDice(table.id);
    }
    controls.appendChild(rollBtn);
  }

  let ludoCurrentTableId = null;

  function renderLudoTable(table) {
    if (!ludoBoardBuilt) buildLudoBoardGrid();
    document.getElementById('ludo-lobby-view').classList.add('hidden');
    document.getElementById('ludo-table-view').classList.remove('hidden');
    document.getElementById('ludo-status-text').textContent = ludoStatusMessage(table);
    renderLudoSeats(table);
    renderLudoTableActions(table);
    renderLudoPieces(table);
    renderLudoControls(table);
  }

  async function openLudoTable(id) {
    ludoCurrentTableId = id;
    try {
      const data = await api(`/api/games/ludo/tables/${id}`);
      renderLudoTable(data.table);
    } catch (err) {
      document.getElementById('ludo-game-error').textContent = err.message;
    }
  }

  function openLudoLobby() {
    document.getElementById('ludo-table-view').classList.add('hidden');
    document.getElementById('ludo-lobby-view').classList.remove('hidden');
    loadLudoLobby();
  }

  function enterLudoTab() {
    if (ludoCurrentTableId) openLudoTable(ludoCurrentTableId);
    else openLudoLobby();
  }

  async function loadLudoLobby() {
    const data = await api('/api/games/ludo/tables');

    const yoursBox = document.getElementById('ludo-your-tables');
    yoursBox.innerHTML = '';
    if (data.yourTables.length === 0) {
      yoursBox.innerHTML = '<p class="muted">No Ludo tables yet.</p>';
    } else {
      data.yourTables.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'ludo-lobby-row';
        const label =
          t.status === 'waiting' ? `Waiting (${t.seats.length}/${t.maxPlayers})`
          : t.status === 'in_progress' ? 'In progress'
          : t.status === 'finished' ? 'Finished'
          : 'Cancelled';
        const names = t.seats.map((s) => s.username).join(' vs ') || 'Empty table';
        const span = document.createElement('span');
        span.textContent = `${names} · ${label}`;
        const openBtn = document.createElement('button');
        openBtn.className = 'btn secondary small';
        openBtn.textContent = 'Open';
        openBtn.onclick = () => openLudoTable(t.id);
        row.appendChild(span);
        row.appendChild(openBtn);
        yoursBox.appendChild(row);
      });
    }

    const openBox = document.getElementById('ludo-open-tables');
    openBox.innerHTML = '';
    if (data.openTables.length === 0) {
      openBox.innerHTML = '<p class="muted">No open tables right now.</p>';
    } else {
      data.openTables.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'ludo-lobby-row';
        const hostName = t.seats[0] ? t.seats[0].username : 'someone';
        const span = document.createElement('span');
        span.textContent = `${hostName}'s table · ${t.seats.length}/${t.maxPlayers} joined`;
        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn small';
        joinBtn.textContent = 'Join';
        joinBtn.onclick = () => ludoJoinTable(t.id);
        row.appendChild(span);
        row.appendChild(joinBtn);
        openBox.appendChild(row);
      });
    }
  }

  async function ludoJoinTable(id) {
    try {
      await api(`/api/games/ludo/tables/${id}/join`, 'POST', {});
      await openLudoTable(id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function ludoCancelTable(id) {
    try {
      await api(`/api/games/ludo/tables/${id}/cancel`, 'POST', {});
      ludoCurrentTableId = null;
      openLudoLobby();
    } catch (err) {
      document.getElementById('ludo-game-error').textContent = err.message;
    }
  }

  async function ludoRollDice(id) {
    const errBox = document.getElementById('ludo-game-error');
    errBox.textContent = '';
    try {
      const data = await api(`/api/games/ludo/tables/${id}/roll`, 'POST', {});
      renderLudoTable(data.table);
    } catch (err) {
      errBox.textContent = err.message;
    }
  }

  async function ludoMakeMove(id, pieceIndex) {
    const errBox = document.getElementById('ludo-game-error');
    errBox.textContent = '';
    try {
      const data = await api(`/api/games/ludo/tables/${id}/move`, 'POST', { pieceIndex });
      renderLudoTable(data.table);
    } catch (err) {
      errBox.textContent = err.message;
    }
  }

  document.getElementById('ludo-open-btn').onclick = () => switchTab('ludo');
  document.getElementById('ludo-back-btn').onclick = () => switchTab('games');

  document.getElementById('ludo-create-btn').onclick = async () => {
    const players = Number(document.getElementById('ludo-players-select').value);
    const errBox = document.getElementById('ludo-create-error');
    errBox.textContent = '';
    try {
      const data = await api('/api/games/ludo/tables', 'POST', { players });
      await openLudoTable(data.table.id);
    } catch (err) {
      errBox.textContent = err.message;
    }
  };

  // Poll the open table for opponents' rolls/moves every couple of seconds
  // — the same lightweight approach used for open message threads above.
  setInterval(() => {
    if (
      state.user &&
      ludoCurrentTableId &&
      !document.getElementById('panel-ludo').classList.contains('hidden') &&
      !document.getElementById('ludo-table-view').classList.contains('hidden')
    ) {
      api(`/api/games/ludo/tables/${ludoCurrentTableId}`).then((data) => renderLudoTable(data.table)).catch(() => {});
    }
  }, 2000);

  // ---------- boot ----------

  (async function boot() {
    if (!state.token) return;
    try {
      await refreshMe();
      enterApp();
    } catch {
      setToken(null);
    }
  })();
})();

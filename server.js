// GYD Wallet / GYD Direct / Games / Business Portal / Messaging — Phase 1 prototype.
//
// Zero npm dependencies: built on Node's http and crypto modules, plus its
// built-in fetch() to reach the database — so `node server.js` is all
// that's needed to run it (see db.js and README.md's "Why no npm packages").
//
// IMPORTANT SCOPE NOTE (see README.md): this is a Phase 1 demo per the
// business plan. "Deposits" simulate adding real money and are NOT wired to
// a real payment processor, and "cash-out" only records a request rather
// than actually paying anyone — real money movement requires the licensing
// work described in the business plan before it can go live.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const db = require('./db');
const { hashPassword, verifyPassword, makeSessionToken, verify } = require('./auth');
const { LUDO_COLOR_SETS, ludoLegalMoves, ludoApplyMove, ludoHasWon } = require('./ludo');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- small helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Raised from a plain 1MB to accommodate a product photo, sent as a
      // base64 data: URL in the JSON body (the browser resizes/compresses it
      // first — see the product-image validation below for the actual cap
      // on how large a single photo may be).
      if (size > 3e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function now() {
  return new Date().toISOString();
}

async function getAuthedUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const data = verify(token);
  if (!data) return null;
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(data.uid);
  return user || null;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    cashtag: u.cashtag,
    email: u.email || null,
    isBusiness: !!u.is_business,
    businessName: u.business_name || null,
    gydBalance: u.gyd_balance,
    businessGydBalance: u.business_gyd_balance || 0,
    createdAt: u.created_at,
  };
}

// Deliberately simple (RFC 5322 in full is far more permissive than anyone
// actually wants to type into a signup form) — good enough to reject
// obvious typos without rejecting real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cash App-style $Cashtag: a short, unique, user-changeable payment handle
// that's separate from (but defaults to) the login username. Looking
// someone up by "handle" below accepts either their username or their
// $cashtag (with or without a leading $), the same way Cash App lets you
// pay a $Cashtag OR a full name/phone lookup.
function slugifyCashtag(base) {
  let slug = (base || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (slug.length < 3) slug = slug + 'user' + crypto.randomInt(1000);
  // Capped shorter than the 20-char max so a numeric de-dupe suffix below
  // always has room to attach — appending digits to an already-20-char
  // slug and re-slicing to 20 would just cut the suffix back off again,
  // making every candidate identical and the loop below infinite.
  return slug.slice(0, 16);
}

async function generateUniqueCashtag(base) {
  const slug = slugifyCashtag(base);
  let candidate = slug;
  let n = 0;
  while (await db.prepare('SELECT id FROM users WHERE LOWER(cashtag) = LOWER(?)').get(candidate)) {
    n += 1;
    candidate = `${slug}${n}`;
  }
  return candidate;
}

async function findUserByHandle(raw) {
  const handle = (raw || '').trim().replace(/^\$/, '');
  if (!handle) return null;
  return db.prepare('SELECT * FROM users WHERE username = ? OR LOWER(cashtag) = LOWER(?)').get(handle, handle);
}

async function isBusinessAccount(userId) {
  const row = await db.prepare('SELECT is_business FROM users WHERE id = ?').get(userId);
  return !!(row && row.is_business);
}

// A short numeric reference code for GYD Direct, our own send-to-anyone
// transfer feature — 8 digits, easy to read over the phone or copy into a
// text message.
async function generateReferenceCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await db.prepare('SELECT id FROM remittances WHERE reference_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique reference code');
}

// A simple flat-plus-percentage fee, in the same spirit as how real
// remittance services price small transfers (a flat minimum keeps tiny
// transfers from being fee-free, a percentage keeps large transfers
// proportional) — see README.md for the exact numbers and rationale.
function remittanceFee(amount) {
  return Math.round(Math.max(200, amount * 0.025) * 100) / 100;
}

async function logTx({ type, fromUser = null, toUser = null, amount, currency, status = 'completed', note = null }) {
  await db.prepare(
    `INSERT INTO transactions (id, type, from_user, to_user, amount, currency, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), type, fromUser, toUser, amount, currency, status, note, now());
}

// ---------- routing ----------

const routes = [];
function on(method, pattern, handler) {
  // pattern like '/api/messages/thread/:username' -> regex + param names
  const paramNames = [];
  const regexStr =
    '^' +
    pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/') +
    '$';
  routes.push({ method, regex: new RegExp(regexStr), paramNames, handler });
}

function requireAuth(handler) {
  return async (req, res, params, query, body) => {
    const user = await getAuthedUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated.' });
    return handler(req, res, params, query, body, user);
  };
}

function requireBusiness(handler) {
  return requireAuth(async (req, res, params, query, body, user) => {
    if (!user.is_business) return sendJson(res, 403, { error: 'This action requires a business account.' });
    return handler(req, res, params, query, body, user);
  });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

function positiveAmount(v) {
  return typeof v === 'number' && isFinite(v) && v > 0;
}

function fmtNum(v) {
  return (Math.round(v * 100) / 100).toFixed(2);
}

// ---------- auth routes ----------

on('POST', '/api/register', async (req, res, params, query, body) => {
  const { username, password, isBusiness, businessName } = body;
  const email = (body.email || '').trim().toLowerCase();
  if (!username || typeof username !== 'string' || username.length < 3) {
    return badRequest(res, 'Username must be at least 3 characters.');
  }
  // Required so a sender always has a way to reach whoever an account
  // belongs to, and so a future "forgot password" flow has somewhere to
  // go — see the email column's comment in supabase/schema.sql for why
  // the column itself stays nullable even though this endpoint requires it.
  if (!email || !EMAIL_RE.test(email)) {
    return badRequest(res, 'Enter a valid email address.');
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return badRequest(res, 'Password must be at least 6 characters.');
  }
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return badRequest(res, 'That username is already taken.');
  const existingEmail = await db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
  if (existingEmail) return badRequest(res, 'An account with that email already exists.');

  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  const cashtag = await generateUniqueCashtag(username);
  await db.prepare(
    `INSERT INTO users (id, username, cashtag, email, password_hash, password_salt, is_business, business_name, gyd_balance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, username, cashtag, email, hash, salt, isBusiness ? 1 : 0, isBusiness ? (businessName || username) : null, now());

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = makeSessionToken(id);
  sendJson(res, 201, { token, user: publicUser(user) });
});

on('POST', '/api/login', async (req, res, params, query, body) => {
  const { username, password } = body;
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !verifyPassword(password || '', user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Invalid username or password.' });
  }
  const token = makeSessionToken(user.id);
  sendJson(res, 200, { token, user: publicUser(user) });
});

on(
  'GET',
  '/api/me',
  requireAuth(async (req, res, params, query, body, user) => {
    sendJson(res, 200, { user: publicUser(user) });
  })
);

on(
  'POST',
  '/api/me/cashtag',
  requireAuth(async (req, res, params, query, body, user) => {
    const raw = (body.cashtag || '').trim().replace(/^\$/, '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(raw)) {
      return badRequest(res, '$Cashtag must be 3-20 letters, numbers, or underscores.');
    }
    const existing = await db.prepare('SELECT id FROM users WHERE LOWER(cashtag) = LOWER(?) AND id != ?').get(raw, user.id);
    if (existing) return badRequest(res, 'That $cashtag is already taken.');
    await db.prepare('UPDATE users SET cashtag = ? WHERE id = ?').run(raw, user.id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

on(
  'GET',
  '/api/users',
  requireAuth(async (req, res, params, query, body, user) => {
    const q = (query.q || '').trim();
    let rows;
    if (q) {
      rows = await db
        .prepare('SELECT id, username, cashtag, is_business, business_name FROM users WHERE (username LIKE ? OR cashtag LIKE ?) AND id != ? LIMIT 20')
        .all(`%${q}%`, `%${q}%`, user.id);
    } else {
      rows = await db
        .prepare('SELECT id, username, cashtag, is_business, business_name FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 20')
        .all(user.id);
    }
    sendJson(res, 200, {
      users: rows.map((r) => ({ id: r.id, username: r.username, cashtag: r.cashtag, isBusiness: !!r.is_business, businessName: r.business_name })),
    });
  })
);

on(
  'GET',
  '/api/users/:username',
  requireAuth(async (req, res, params) => {
    // Despite the route's :username param name (kept stable for callers),
    // this accepts either a username or a $cashtag — see findUserByHandle.
    const other = await findUserByHandle(params.username);
    if (!other) return sendJson(res, 404, { error: 'No user with that username or $cashtag.' });
    sendJson(res, 200, { id: other.id, username: other.username, cashtag: other.cashtag, isBusiness: !!other.is_business, businessName: other.business_name });
  })
);

// ---------- wallet ----------

on(
  'POST',
  '/api/wallet/deposit',
  requireAuth(async (req, res, params, query, body, user) => {
    const amount = Number(body.amount);
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    // SIMULATED: in Phase 1 there is no real payment processor connected.
    // A real build wires this endpoint to a licensed payments partner
    // (see the business plan) instead of crediting GYD directly.
    await db.prepare('UPDATE users SET gyd_balance = gyd_balance + ? WHERE id = ?').run(amount, user.id);
    await logTx({ type: 'deposit', toUser: user.id, amount, currency: 'GYD', note: 'Simulated deposit (no real payment processor connected)' });
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

// There is deliberately no coin currency or wallet-to-coins conversion
// anywhere in this app. The games below (coin flip, slot machine) are free
// to play for anyone with an account — no balance of any kind is spent or
// won — which is what keeps them completely outside of gambling law rather
// than just designed around it. See README.md's "Why the games are free to
// play" section before ever reattaching a currency to them.

on(
  'POST',
  '/api/wallet/cashout',
  requireAuth(async (req, res, params, query, body, user) => {
    const amount = Number(body.amount);
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    if (user.gyd_balance < amount) return badRequest(res, 'Not enough GYD.');

    const id = crypto.randomUUID();
    // GYD is escrowed immediately; a real payout requires a licensed
    // money-transmission partner on the backend (see the business plan).
    // The debit and the cashout-request row are created in ONE statement —
    // the request only gets inserted if the debit itself succeeds — so two
    // simultaneous cashouts can't both pass the balance check and overdraw
    // the account (a real risk now that each query is its own network
    // round trip, unlike the old single-threaded SQLite code this replaced;
    // see db.js's atomicTransfer for the same idea applied elsewhere).
    const rows = await db.raw(
      `WITH debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1 WHERE id = $2 AND gyd_balance >= $1 RETURNING gyd_balance
       ), ins AS (
         INSERT INTO cashout_requests (id, user_id, amount_gyd, status, created_at)
         SELECT $3, $2, $1, 'pending', $4 WHERE EXISTS (SELECT 1 FROM debit)
       )
       SELECT gyd_balance FROM debit`,
      [amount, user.id, id, now()]
    );
    if (rows.length === 0) return badRequest(res, 'Not enough GYD.');

    await logTx({ type: 'cashout_request', fromUser: user.id, amount, currency: 'GYD', status: 'pending', note: id });
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated), cashoutRequestId: id });
  })
);

on(
  'GET',
  '/api/wallet/transactions',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db
      .prepare('SELECT * FROM transactions WHERE from_user = ? OR to_user = ? ORDER BY created_at DESC LIMIT 100')
      .all(user.id, user.id);
    sendJson(res, 200, { transactions: rows });
  })
);

// ---------- peer-to-peer transfers ----------

on(
  'POST',
  '/api/transfer',
  requireAuth(async (req, res, params, query, body, user) => {
    // toUsername accepts either a username or a $cashtag (with or without
    // the leading $) — see findUserByHandle.
    const { memo } = body;
    const toHandle = body.toUsername || body.to;
    const amount = Number(body.amount);
    if (!toHandle) return badRequest(res, 'Choose who to send to.');
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    const recipient = await findUserByHandle(toHandle);
    if (!recipient) return badRequest(res, 'No user with that username or $cashtag.');
    if (recipient.id === user.id) return badRequest(res, "You can't send money to yourself.");
    if (user.gyd_balance < amount) return badRequest(res, 'Not enough GYD.');

    // Paying a business credits their separate business wallet, not their
    // personal balance — see db.js's atomicTransfer.
    const newBalance = await db.atomicTransfer(user.id, amount, recipient.id, !!recipient.is_business);
    if (newBalance === null) return badRequest(res, 'Not enough GYD.');

    // Paying a business account through a transfer (e.g. via a scanned QR code) is
    // logged as a business payment rather than a plain P2P transfer, so the
    // activity feed reads correctly regardless of how the payment was initiated.
    await logTx({
      type: recipient.is_business ? 'business_payment' : 'p2p_transfer',
      fromUser: user.id,
      toUser: recipient.id,
      amount,
      currency: 'GYD',
      note: memo || null,
    });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

// ---------- GYD Direct (our own send-to-anyone transfer feature) ----------
//
// This is a different shape of "send money" than the plain P2P transfer
// above: instead of paying a username you already know is on the app, you
// send to a name and phone number, pay a transfer fee on top of the amount
// (escrowed out of your balance immediately, same as a real remittance),
// and get back a reference code. The recipient — who does not need an
// account yet — "picks up" the money by entering that code plus the
// recipient name on the transfer, the same two things a real money-transfer
// pickup counter asks for. See README.md for the fee formula and the
// licensing note that comes with it.

function remittancePublic(r) {
  return {
    id: r.id,
    referenceCode: r.reference_code,
    recipientName: r.recipient_name,
    recipientPhone: r.recipient_phone,
    amount: r.amount,
    fee: r.fee,
    total: Math.round((r.amount + r.fee) * 100) / 100,
    status: r.status,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
  };
}

on(
  'POST',
  '/api/remit',
  requireAuth(async (req, res, params, query, body, user) => {
    const recipientName = (body.recipientName || '').trim();
    const recipientPhone = (body.recipientPhone || '').trim();
    const amount = Number(body.amount);
    if (!recipientName) return badRequest(res, "Enter the recipient's full name.");
    if (!recipientPhone) return badRequest(res, "Enter the recipient's phone number.");
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount to send.');

    const fee = remittanceFee(amount);
    const total = Math.round((amount + fee) * 100) / 100;
    if (user.gyd_balance < total) return badRequest(res, `Not enough GYD — sending ${fmtNum(amount)} plus a ${fmtNum(fee)} fee needs ${fmtNum(total)}.`);

    const id = crypto.randomUUID();
    const referenceCode = await generateReferenceCode();
    const rows = await db.raw(
      `WITH debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1 WHERE id = $2 AND gyd_balance >= $1 RETURNING gyd_balance
       ), ins AS (
         INSERT INTO remittances (id, reference_code, from_user, recipient_name, recipient_phone, amount, fee, status, created_at)
         SELECT $3, $4, $2, $5, $6, $7, $8, 'pending', $9 WHERE EXISTS (SELECT 1 FROM debit)
       )
       SELECT gyd_balance FROM debit`,
      [total, user.id, id, referenceCode, recipientName, recipientPhone, amount, fee, now()]
    );
    if (rows.length === 0) return badRequest(res, 'Not enough GYD.');

    await logTx({ type: 'remit_send', fromUser: user.id, amount: total, currency: 'GYD', note: `To ${recipientName}, ref ${referenceCode}` });

    const row = await db.prepare('SELECT * FROM remittances WHERE id = ?').get(id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 201, { remittance: remittancePublic(row), user: publicUser(updated) });
  })
);

on(
  'GET',
  '/api/remit/sent',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM remittances WHERE from_user = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    sendJson(res, 200, { remittances: rows.map(remittancePublic) });
  })
);

on(
  'POST',
  '/api/remit/:id/cancel',
  requireAuth(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM remittances WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Transfer not found.' });
    if (row.from_user !== user.id) return sendJson(res, 403, { error: 'This transfer is not yours to cancel.' });
    if (row.status !== 'pending') return badRequest(res, 'This transfer has already been picked up or cancelled.');

    const rows = await db.raw(
      `WITH upd AS (
         UPDATE remittances SET status = 'cancelled', cancelled_at = $1 WHERE id = $2 AND from_user = $3 AND status = 'pending' RETURNING amount, fee
       )
       UPDATE users SET gyd_balance = gyd_balance + (SELECT amount + fee FROM upd) WHERE id = $3 AND EXISTS (SELECT 1 FROM upd) RETURNING gyd_balance`,
      [now(), row.id, user.id]
    );
    if (rows.length === 0) return badRequest(res, 'This transfer has already been picked up or cancelled.');

    const total = Math.round((row.amount + row.fee) * 100) / 100;
    await logTx({ type: 'remit_refund', toUser: user.id, amount: total, currency: 'GYD', note: `Cancelled transfer ${row.reference_code}` });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

on(
  'GET',
  '/api/remit/lookup',
  requireAuth(async (req, res, params, query) => {
    const code = (query.code || '').trim();
    if (!code) return badRequest(res, 'Enter a reference code.');
    const row = await db.prepare('SELECT * FROM remittances WHERE reference_code = ?').get(code);
    if (!row) return sendJson(res, 404, { error: 'No transfer found with that reference code.' });
    // Deliberately does not reveal who sent it, or the recipient's phone
    // number — just enough to confirm you have the right code before you
    // type in the recipient name, the way a real pickup screen would.
    sendJson(res, 200, {
      status: row.status,
      amount: row.status === 'pending' ? row.amount : null,
    });
  })
);

on(
  'POST',
  '/api/remit/claim',
  requireAuth(async (req, res, params, query, body, user) => {
    const code = (body.referenceCode || '').trim();
    const name = (body.recipientName || '').trim();
    if (!code) return badRequest(res, 'Enter the reference code.');
    if (!name) return badRequest(res, 'Enter the recipient name exactly as the sender typed it.');

    const row = await db.prepare('SELECT * FROM remittances WHERE reference_code = ?').get(code);
    if (!row) return badRequest(res, 'No transfer found with that reference code.');
    if (row.status !== 'pending') return badRequest(res, 'This transfer has already been picked up or was cancelled.');
    if (row.recipient_name.trim().toLowerCase() !== name.toLowerCase()) {
      return badRequest(res, "That name doesn't match the recipient name on this transfer.");
    }

    const rows = await db.raw(
      `WITH upd AS (
         UPDATE remittances SET status = 'completed', completed_at = $1, claimed_by_user_id = $2 WHERE id = $3 AND status = 'pending' RETURNING amount
       )
       UPDATE users SET gyd_balance = gyd_balance + (SELECT amount FROM upd) WHERE id = $2 AND EXISTS (SELECT 1 FROM upd) RETURNING gyd_balance`,
      [now(), user.id, row.id]
    );
    if (rows.length === 0) return badRequest(res, 'This transfer has already been picked up or was cancelled.');

    await logTx({ type: 'remit_claim', toUser: user.id, amount: row.amount, currency: 'GYD', note: `Picked up transfer ${row.reference_code}` });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated), amount: row.amount });
  })
);

// ---------- request money (Cash App-style pay/request) ----------
//
// Cash App lets you either pay someone or request money from them; this is
// the request half. Unlike GYD Direct above, this only ever moves money
// between two existing accounts — from_user is the person asking to be
// paid, to_user is the person being asked to pay, and paying it is just a
// transfer gated behind the payer's approval instead of happening instantly.

function moneyRequestPublicIncoming(r) {
  return {
    id: r.id,
    fromUsername: r.from_username,
    fromCashtag: r.from_cashtag,
    amount: r.amount,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function moneyRequestPublicOutgoing(r) {
  return {
    id: r.id,
    toUsername: r.to_username,
    toCashtag: r.to_cashtag,
    amount: r.amount,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

on(
  'POST',
  '/api/requests',
  requireAuth(async (req, res, params, query, body, user) => {
    const toHandle = (body.toHandle || body.toUsername || '').trim();
    const amount = Number(body.amount);
    const note = (body.note || '').trim().slice(0, 300);
    if (!toHandle) return badRequest(res, "Enter a username or $cashtag to request from.");
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount to request.');
    const payer = await findUserByHandle(toHandle);
    if (!payer) return badRequest(res, 'No user with that username or $cashtag.');
    if (payer.id === user.id) return badRequest(res, "You can't request money from yourself.");

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO money_requests (id, from_user, to_user, amount, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, user.id, payer.id, amount, note || null, now());
    sendJson(res, 201, { id });
  })
);

on(
  'GET',
  '/api/requests',
  requireAuth(async (req, res, params, query, body, user) => {
    const incoming = await db
      .prepare(
        `SELECT r.*, u.username AS from_username, u.cashtag AS from_cashtag
         FROM money_requests r JOIN users u ON u.id = r.from_user
         WHERE r.to_user = ? ORDER BY r.created_at DESC LIMIT 50`
      )
      .all(user.id);
    const outgoing = await db
      .prepare(
        `SELECT r.*, u.username AS to_username, u.cashtag AS to_cashtag
         FROM money_requests r JOIN users u ON u.id = r.to_user
         WHERE r.from_user = ? ORDER BY r.created_at DESC LIMIT 50`
      )
      .all(user.id);
    sendJson(res, 200, {
      incoming: incoming.map(moneyRequestPublicIncoming),
      outgoing: outgoing.map(moneyRequestPublicOutgoing),
    });
  })
);

on(
  'POST',
  '/api/requests/:id/pay',
  requireAuth(async (req, res, params, query, body, user) => {
    const request = await db.prepare('SELECT * FROM money_requests WHERE id = ?').get(params.id);
    if (!request) return sendJson(res, 404, { error: 'Request not found.' });
    if (request.to_user !== user.id) return sendJson(res, 403, { error: 'This request is not addressed to you.' });
    if (request.status !== 'pending') return badRequest(res, 'This request has already been resolved.');
    if (user.gyd_balance < request.amount) return badRequest(res, 'Not enough GYD to pay this request.');

    // If a business sent this request, paying it is "buying from the
    // business" — it lands in their business wallet, not their personal one.
    const requesterIsBusiness = await isBusinessAccount(request.from_user);
    const creditColumn = requesterIsBusiness ? 'business_gyd_balance' : 'gyd_balance';
    const rows = await db.raw(
      `WITH req AS (
         SELECT amount, from_user FROM money_requests WHERE id = $1 AND to_user = $2 AND status = 'pending'
       ), debit AS (
         UPDATE users SET gyd_balance = gyd_balance - (SELECT amount FROM req)
         WHERE id = $2 AND EXISTS (SELECT 1 FROM req) AND gyd_balance >= (SELECT amount FROM req)
         RETURNING gyd_balance
       ), credit AS (
         UPDATE users SET ${creditColumn} = ${creditColumn} + (SELECT amount FROM req)
         WHERE id = (SELECT from_user FROM req) AND EXISTS (SELECT 1 FROM debit)
         RETURNING 1
       ), upd AS (
         UPDATE money_requests SET status = 'paid', resolved_at = $3 WHERE id = $1 AND EXISTS (SELECT 1 FROM debit) RETURNING 1
       )
       SELECT gyd_balance FROM debit`,
      [request.id, user.id, now()]
    );
    if (rows.length === 0) {
      return badRequest(res, 'This request could not be paid — it may have just been resolved, or you may not have enough GYD.');
    }

    await logTx({
      type: 'request_payment',
      fromUser: user.id,
      toUser: request.from_user,
      amount: request.amount,
      currency: 'GYD',
      note: request.note,
    });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

on(
  'POST',
  '/api/requests/:id/decline',
  requireAuth(async (req, res, params, query, body, user) => {
    const request = await db.prepare('SELECT * FROM money_requests WHERE id = ?').get(params.id);
    if (!request) return sendJson(res, 404, { error: 'Request not found.' });
    if (request.to_user !== user.id) return sendJson(res, 403, { error: 'This request is not addressed to you.' });
    if (request.status !== 'pending') return badRequest(res, 'This request has already been resolved.');
    await db.prepare("UPDATE money_requests SET status = 'declined', resolved_at = ? WHERE id = ?").run(now(), request.id);
    sendJson(res, 200, { ok: true });
  })
);

on(
  'POST',
  '/api/requests/:id/cancel',
  requireAuth(async (req, res, params, query, body, user) => {
    const request = await db.prepare('SELECT * FROM money_requests WHERE id = ?').get(params.id);
    if (!request) return sendJson(res, 404, { error: 'Request not found.' });
    if (request.from_user !== user.id) return sendJson(res, 403, { error: 'This request is not yours to cancel.' });
    if (request.status !== 'pending') return badRequest(res, 'This request has already been resolved.');
    await db.prepare("UPDATE money_requests SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(now(), request.id);
    sendJson(res, 200, { ok: true });
  })
);

// ---------- games (free to play — no coins, no wager, nothing paid out) ----------
//
// Both games below are pure entertainment: nobody spends or wins anything
// of value, so anyone with an account can play as much as they want at zero
// cost. That also means there's nothing here for gambling law to look at —
// no currency is wagered and nothing of real-world value is paid out, which
// is a stronger position than the old "one-way coins" design (that avoided
// the question by construction; this one avoids it because there's simply
// no stake at all). See README.md's "Why the games are free to play".

on(
  'POST',
  '/api/games/coinflip',
  requireAuth(async (req, res, params, query, body, user) => {
    const choice = body.choice === 'heads' ? 'heads' : body.choice === 'tails' ? 'tails' : null;
    if (!choice) return badRequest(res, 'Choose heads or tails.');

    const result = crypto.randomInt(2) === 0 ? 'heads' : 'tails';
    const won = result === choice;

    await db.prepare(
      `INSERT INTO game_rounds (id, user_id, game, choice, outcome, won, created_at)
       VALUES (?, ?, 'coinflip', ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), user.id, choice, result, won ? 1 : 0, now());

    sendJson(res, 200, { result, won });
  })
);

on(
  'GET',
  '/api/games/history',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM game_rounds WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    sendJson(res, 200, { rounds: rows });
  })
);

// Slot machine: three independent reels, each drawn from a weighted symbol
// table. A "win" is an exact three-of-a-kind — the rarer the symbol, the
// bigger the celebration (see the client's confetti/jackpot treatment) even
// though nothing of value actually changes hands. Weights are unchanged
// from the original priced version purely to keep the same odds/feel: about
// a 1-in-5 spin landing a match, with the rarest symbol (💎) landing a
// three-of-a-kind roughly 1 spin in 10,000 for that special jackpot moment.
const SLOT_SYMBOLS = [
  { symbol: '🍒', weight: 55 },
  { symbol: '🍋', weight: 28 },
  { symbol: '🔔', weight: 12 },
  { symbol: '💎', weight: 5 },
];
const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

function spinSlotReel() {
  const roll = crypto.randomInt(SLOT_TOTAL_WEIGHT);
  let cumulative = 0;
  for (const s of SLOT_SYMBOLS) {
    cumulative += s.weight;
    if (roll < cumulative) return s;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

on(
  'POST',
  '/api/games/slots',
  requireAuth(async (req, res, params, query, body, user) => {
    const reels = [spinSlotReel(), spinSlotReel(), spinSlotReel()];
    const won = reels[0].symbol === reels[1].symbol && reels[1].symbol === reels[2].symbol;
    const jackpot = won && reels[0].symbol === '💎';

    await db.prepare(
      `INSERT INTO game_rounds (id, user_id, game, choice, outcome, won, created_at)
       VALUES (?, ?, 'slots', NULL, ?, ?, ?)`
    ).run(crypto.randomUUID(), user.id, reels.map((r) => r.symbol).join(''), won ? 1 : 0, now());

    sendJson(res, 200, { reels: reels.map((r) => r.symbol), won, jackpot });
  })
);

// ---------- Ludo (2- or 4-player, free to play, no wager) ----------
//
// This is a head-to-head board game rather than a house game — real time,
// turn-based, played between actual people at a shared "table" — so it
// needs matchmaking (tables to create/join/cancel) on top of the actual
// game rules in ludo.js. Just like coin flip and slots, nothing of value is
// staked: there was an earlier version of this feature where tables wagered
// GYD/coins into a pot the winner took, but that's gone now for the same
// reason coins are gone everywhere else — see README.md's "Why the games
// are free to play". Winning a match is just bragging rights.

async function loadLudoTable(id) {
  const row = await db.prepare('SELECT * FROM ludo_tables WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state) };
}

async function saveLudoTable(table) {
  await db.prepare(
    `UPDATE ludo_tables SET status = ?, state = ?, winner_user_id = ?, started_at = ?, finished_at = ? WHERE id = ?`
  ).run(table.status, JSON.stringify(table.state), table.winner_user_id || null, table.started_at || null, table.finished_at || null, table.id);
}

function publicLudoTable(table, forUserId) {
  const seatIndex = table.state.seats.findIndex((s) => s.userId === forUserId);
  return {
    id: table.id,
    hostUserId: table.host_user_id,
    maxPlayers: table.max_players,
    status: table.status,
    winnerUserId: table.winner_user_id || null,
    createdAt: table.created_at,
    startedAt: table.started_at || null,
    finishedAt: table.finished_at || null,
    seats: table.state.seats.map((s) => ({ color: s.color, userId: s.userId, username: s.username, pieces: s.pieces })),
    turnIndex: table.state.turnIndex,
    pendingRoll: table.state.pendingRoll || null,
    lastEvent: table.state.lastEvent || null,
    yourSeatIndex: seatIndex,
    isYourTurn: table.status === 'in_progress' && seatIndex !== -1 && seatIndex === table.state.turnIndex,
  };
}

on(
  'POST',
  '/api/games/ludo/tables',
  requireAuth(async (req, res, params, query, body, user) => {
    const maxPlayers = Number(body.players);
    if (maxPlayers !== 2 && maxPlayers !== 4) return badRequest(res, 'Choose 2 or 4 players.');
    const colors = LUDO_COLOR_SETS[maxPlayers];
    const state = {
      seats: [{ color: colors[0], userId: user.id, username: user.username, pieces: [0, 0, 0, 0] }],
      turnIndex: 0,
      pendingRoll: null,
      consecutiveSixes: 0,
      lastEvent: null,
    };
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO ludo_tables (id, host_user_id, max_players, status, state, created_at) VALUES (?, ?, ?, 'waiting', ?, ?)`
    ).run(id, user.id, maxPlayers, JSON.stringify(state), now());
    sendJson(res, 201, { table: publicLudoTable(await loadLudoTable(id), user.id) });
  })
);

on(
  'GET',
  '/api/games/ludo/tables',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM ludo_tables ORDER BY created_at DESC LIMIT 100').all();
    const tables = rows.map((r) => ({ ...r, state: JSON.parse(r.state) }));
    const yours = tables.filter((t) => t.status !== 'cancelled' && t.state.seats.some((s) => s.userId === user.id));
    const open = tables.filter(
      (t) => t.status === 'waiting' && t.state.seats.length < t.max_players && !t.state.seats.some((s) => s.userId === user.id)
    );
    sendJson(res, 200, {
      yourTables: yours.map((t) => publicLudoTable(t, user.id)),
      openTables: open.map((t) => publicLudoTable(t, user.id)),
    });
  })
);

on(
  'GET',
  '/api/games/ludo/tables/:id',
  requireAuth(async (req, res, params, query, body, user) => {
    const table = await loadLudoTable(params.id);
    if (!table) return badRequest(res, 'Table not found.');
    sendJson(res, 200, { table: publicLudoTable(table, user.id) });
  })
);

on(
  'POST',
  '/api/games/ludo/tables/:id/join',
  requireAuth(async (req, res, params, query, body, user) => {
    const table = await loadLudoTable(params.id);
    if (!table) return badRequest(res, 'Table not found.');
    if (table.status !== 'waiting') return badRequest(res, 'This table already started or ended.');
    if (table.state.seats.some((s) => s.userId === user.id)) return badRequest(res, "You're already at this table.");
    if (table.state.seats.length >= table.max_players) return badRequest(res, 'This table is full.');

    const colors = LUDO_COLOR_SETS[table.max_players];
    const nextColor = colors[table.state.seats.length];
    table.state.seats.push({ color: nextColor, userId: user.id, username: user.username, pieces: [0, 0, 0, 0] });

    if (table.state.seats.length === table.max_players) {
      table.status = 'in_progress';
      table.started_at = now();
      table.state.turnIndex = 0;
      table.state.lastEvent = `Match started — ${table.state.seats[0].username} goes first.`;
    }
    await saveLudoTable(table);
    sendJson(res, 200, { table: publicLudoTable(table, user.id) });
  })
);

on(
  'POST',
  '/api/games/ludo/tables/:id/cancel',
  requireAuth(async (req, res, params, query, body, user) => {
    const table = await loadLudoTable(params.id);
    if (!table) return badRequest(res, 'Table not found.');
    if (table.host_user_id !== user.id) return badRequest(res, 'Only the host can cancel this table.');
    if (table.status !== 'waiting') return badRequest(res, 'Only a table still waiting for players can be cancelled.');
    table.status = 'cancelled';
    await saveLudoTable(table);
    sendJson(res, 200, { table: publicLudoTable(table, user.id) });
  })
);

on(
  'POST',
  '/api/games/ludo/tables/:id/roll',
  requireAuth(async (req, res, params, query, body, user) => {
    const table = await loadLudoTable(params.id);
    if (!table) return badRequest(res, 'Table not found.');
    if (table.status !== 'in_progress') return badRequest(res, 'This match is not in progress.');
    const seatIndex = table.state.seats.findIndex((s) => s.userId === user.id);
    if (seatIndex === -1) return badRequest(res, "You're not a player at this table.");
    if (seatIndex !== table.state.turnIndex) return badRequest(res, "It's not your turn.");
    if (table.state.pendingRoll) return badRequest(res, 'Choose a piece to move before rolling again.');

    const roll = 1 + crypto.randomInt(6);
    const seat = table.state.seats[seatIndex];
    table.state.consecutiveSixes = roll === 6 ? (table.state.consecutiveSixes || 0) + 1 : 0;

    // Rolling three 6s in a row forfeits the turn immediately — the classic
    // anti-stalling rule, so one lucky (or blocked) player can't hog the
    // board forever.
    if (table.state.consecutiveSixes >= 3) {
      table.state.consecutiveSixes = 0;
      table.state.pendingRoll = null;
      table.state.lastEvent = `${seat.username} rolled a third 6 in a row — turn forfeited.`;
      table.state.turnIndex = (table.state.turnIndex + 1) % table.state.seats.length;
      await saveLudoTable(table);
      return sendJson(res, 200, { table: publicLudoTable(table, user.id), roll, legalMoves: [], forfeited: true });
    }

    const legalMoves = ludoLegalMoves(seat.pieces, roll);
    if (legalMoves.length === 0) {
      table.state.pendingRoll = null;
      table.state.lastEvent = `${seat.username} rolled a ${roll} — no legal move.`;
      table.state.turnIndex = (table.state.turnIndex + 1) % table.state.seats.length;
      await saveLudoTable(table);
      return sendJson(res, 200, { table: publicLudoTable(table, user.id), roll, legalMoves: [], turnPassed: true });
    }

    table.state.pendingRoll = { roll, legalMoves };
    table.state.lastEvent = `${seat.username} rolled a ${roll}.`;
    await saveLudoTable(table);
    sendJson(res, 200, { table: publicLudoTable(table, user.id), roll, legalMoves });
  })
);

on(
  'POST',
  '/api/games/ludo/tables/:id/move',
  requireAuth(async (req, res, params, query, body, user) => {
    const table = await loadLudoTable(params.id);
    if (!table) return badRequest(res, 'Table not found.');
    if (table.status !== 'in_progress') return badRequest(res, 'This match is not in progress.');
    const seatIndex = table.state.seats.findIndex((s) => s.userId === user.id);
    if (seatIndex === -1) return badRequest(res, "You're not a player at this table.");
    if (seatIndex !== table.state.turnIndex) return badRequest(res, "It's not your turn.");
    const pending = table.state.pendingRoll;
    if (!pending) return badRequest(res, 'Roll the dice first.');
    const pieceIndex = Number(body.pieceIndex);
    if (!pending.legalMoves.includes(pieceIndex)) return badRequest(res, 'That piece cannot move with this roll.');

    const seat = table.state.seats[seatIndex];
    const roll = pending.roll;
    const { captured, finished } = ludoApplyMove(table.state, seatIndex, pieceIndex, roll);
    table.state.pendingRoll = null;

    let gameWon = false;
    if (ludoHasWon(seat)) {
      gameWon = true;
      table.status = 'finished';
      table.winner_user_id = seat.userId;
      table.finished_at = now();
      table.state.lastEvent = `🎉 ${seat.username} won the match!`;
    } else {
      let eventMsg = `${seat.username} moved a piece`;
      if (captured) eventMsg += ' and sent an opponent home';
      if (finished) eventMsg += ' — it reached home!';
      table.state.lastEvent = eventMsg + '.';
      // Rolling a 6, capturing an opponent, or getting a piece home all earn
      // another turn — otherwise play passes to the next seat.
      const extraTurn = roll === 6 || captured || finished;
      if (!extraTurn) {
        table.state.turnIndex = (table.state.turnIndex + 1) % table.state.seats.length;
        table.state.consecutiveSixes = 0;
      }
    }

    await saveLudoTable(table);
    sendJson(res, 200, { table: publicLudoTable(table, user.id), captured, finished, gameWon });
  })
);

// ---------- business payment portal ----------

on(
  'POST',
  '/api/business/charge-requests',
  requireBusiness(async (req, res, params, query, body, user) => {
    const { customerUsername, memo } = body;
    const amount = Number(body.amount);
    if (!customerUsername) return badRequest(res, 'Enter the customer\'s username.');
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    const customer = await db.prepare('SELECT * FROM users WHERE username = ?').get(customerUsername);
    if (!customer) return badRequest(res, 'No user with that username.');

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO charge_requests (id, business_id, customer_id, amount, memo, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, user.id, customer.id, amount, memo || null, now());
    sendJson(res, 201, { id });
  })
);

on(
  'GET',
  '/api/business/charge-requests',
  requireAuth(async (req, res, params, query, body, user) => {
    const asCustomer = await db
      .prepare(
        `SELECT cr.*, u.username AS business_username, u.business_name
         FROM charge_requests cr JOIN users u ON u.id = cr.business_id
         WHERE cr.customer_id = ? ORDER BY cr.created_at DESC LIMIT 50`
      )
      .all(user.id);
    const asBusiness = user.is_business
      ? await db
          .prepare(
            `SELECT cr.*, u.username AS customer_username
             FROM charge_requests cr JOIN users u ON u.id = cr.customer_id
             WHERE cr.business_id = ? ORDER BY cr.created_at DESC LIMIT 50`
          )
          .all(user.id)
      : [];
    sendJson(res, 200, { incoming: asCustomer, sent: asBusiness });
  })
);

function resolveChargeRequest(action) {
  return requireAuth(async (req, res, params, query, body, user) => {
    const request = await db.prepare('SELECT * FROM charge_requests WHERE id = ?').get(params.id);
    if (!request) return sendJson(res, 404, { error: 'Charge request not found.' });
    if (request.customer_id !== user.id) return sendJson(res, 403, { error: 'This request is not addressed to you.' });
    if (request.status !== 'pending') return badRequest(res, 'This request has already been resolved.');

    if (action === 'approve') {
      if (user.gyd_balance < request.amount) return badRequest(res, 'Not enough GYD to approve this payment.');
      // Charge requests can only be created by a business account (see
      // requireBusiness above), so this always lands in a business wallet.
      // The balance check, the debit, the credit, and the status flip all
      // happen in ONE statement so a double-click (or any other race)
      // can't double-charge the customer — see the cashout/transfer
      // comments above for why this matters now that every query is a
      // separate network round trip.
      const rows = await db.raw(
        `WITH req AS (
           SELECT amount, business_id FROM charge_requests WHERE id = $1 AND customer_id = $2 AND status = 'pending'
         ), debit AS (
           UPDATE users SET gyd_balance = gyd_balance - (SELECT amount FROM req)
           WHERE id = $2 AND EXISTS (SELECT 1 FROM req) AND gyd_balance >= (SELECT amount FROM req)
           RETURNING gyd_balance
         ), credit AS (
           UPDATE users SET business_gyd_balance = business_gyd_balance + (SELECT amount FROM req)
           WHERE id = (SELECT business_id FROM req) AND EXISTS (SELECT 1 FROM debit)
           RETURNING 1
         ), upd AS (
           UPDATE charge_requests SET status = 'approved', resolved_at = $3 WHERE id = $1 AND EXISTS (SELECT 1 FROM debit) RETURNING 1
         )
         SELECT gyd_balance FROM debit`,
        [request.id, user.id, now()]
      );
      if (rows.length === 0) {
        return badRequest(res, 'This payment could not be approved — it may have just been resolved, or you may not have enough GYD.');
      }
      await logTx({
        type: 'business_payment',
        fromUser: user.id,
        toUser: request.business_id,
        amount: request.amount,
        currency: 'GYD',
        note: request.memo,
      });
    } else {
      const rows = await db.raw(
        `UPDATE charge_requests SET status = 'declined', resolved_at = $1 WHERE id = $2 AND status = 'pending' RETURNING id`,
        [now(), request.id]
      );
      if (rows.length === 0) return badRequest(res, 'This request has already been resolved.');
    }

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  });
}

on('POST', '/api/business/charge-requests/:id/approve', resolveChargeRequest('approve'));
on('POST', '/api/business/charge-requests/:id/decline', resolveChargeRequest('decline'));

// ---------- business directory (find a business, business pages) ----------
//
// Separate from having a business account: a business only shows up here
// once it fills in a page (category, tagline, and optionally a description,
// freeform keywords, contact info, a logo emoji, and a page color). Search
// matches name, tagline, description, category, AND keywords, so someone
// searching "cake" finds every business that listed "cake" among what they
// offer, even if their category is just "Bakery & Desserts" and their name
// doesn't mention cake at all — the point is matching what they sell, not
// just how they're filed.

function businessProfilePublic(row) {
  return {
    username: row.username,
    cashtag: row.cashtag,
    businessName: row.business_name,
    category: row.category,
    tagline: row.tagline,
    description: row.description,
    keywords: (row.keywords || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    themeColor: row.theme_color,
    logoEmoji: row.logo_emoji,
    phone: row.phone,
    location: row.location,
    offersDelivery: !!row.offers_delivery,
    deliveryFee: row.delivery_fee || 0,
    updatedAt: row.updated_at,
  };
}

on(
  'GET',
  '/api/business/profile',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db
      .prepare('SELECT u.*, bp.* FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?')
      .get(user.id);
    sendJson(res, 200, { profile: row ? businessProfilePublic(row) : null });
  })
);

on(
  'POST',
  '/api/business/profile',
  requireBusiness(async (req, res, params, query, body, user) => {
    const category = (body.category || '').trim().slice(0, 40);
    const tagline = (body.tagline || '').trim().slice(0, 140);
    const description = (body.description || '').trim().slice(0, 1000);
    const keywords = (body.keywords || '').trim().slice(0, 300);
    const themeColor = /^#[0-9a-fA-F]{6}$/.test(body.themeColor || '') ? body.themeColor : '#00d964';
    const logoEmoji = (body.logoEmoji || '').trim().slice(0, 8);
    const phone = (body.phone || '').trim().slice(0, 40);
    const location = (body.location || '').trim().slice(0, 140);
    const offersDelivery = body.offersDelivery ? 1 : 0;
    const deliveryFeeRaw = Number(body.deliveryFee);
    const deliveryFee = offersDelivery && isFinite(deliveryFeeRaw) && deliveryFeeRaw >= 0 ? deliveryFeeRaw : 0;
    if (!category) return badRequest(res, 'Choose a category for your business.');
    if (!tagline) return badRequest(res, 'Add a short tagline for your page.');
    if (body.offersDelivery && !(isFinite(deliveryFeeRaw) && deliveryFeeRaw >= 0)) {
      return badRequest(res, 'Enter a delivery fee of 0 or more (0 means free delivery).');
    }

    const existing = await db.prepare('SELECT user_id FROM business_profiles WHERE user_id = ?').get(user.id);
    if (existing) {
      await db.prepare(
        `UPDATE business_profiles
         SET category = ?, tagline = ?, description = ?, keywords = ?, theme_color = ?, logo_emoji = ?, phone = ?, location = ?, offers_delivery = ?, delivery_fee = ?, updated_at = ?
         WHERE user_id = ?`
      ).run(category, tagline, description, keywords, themeColor, logoEmoji, phone, location, offersDelivery, deliveryFee, now(), user.id);
    } else {
      await db.prepare(
        `INSERT INTO business_profiles (user_id, category, tagline, description, keywords, theme_color, logo_emoji, phone, location, offers_delivery, delivery_fee, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(user.id, category, tagline, description, keywords, themeColor, logoEmoji, phone, location, offersDelivery, deliveryFee, now());
    }

    const row = await db
      .prepare('SELECT u.*, bp.* FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?')
      .get(user.id);
    sendJson(res, 200, { profile: businessProfilePublic(row) });
  })
);

on(
  'GET',
  '/api/business/directory',
  requireAuth(async (req, res, params, query) => {
    const q = (query.q || '').trim();
    const category = (query.category || '').trim();
    let sql = 'SELECT u.*, bp.* FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE 1=1';
    const args = [];
    if (category) {
      sql += ' AND bp.category = ?';
      args.push(category);
    }
    if (q) {
      // Matches the business name/tagline/description/category/keywords, AND
      // any product or service name/description they've listed — so
      // searching a product name (e.g. "chocolate cake") finds a business
      // even if that exact phrase never made it into their keywords field.
      sql += ` AND (
        u.business_name LIKE ? OR bp.tagline LIKE ? OR bp.description LIKE ? OR bp.keywords LIKE ? OR bp.category LIKE ?
        OR EXISTS (SELECT 1 FROM business_products p WHERE p.business_id = u.id AND (p.name LIKE ? OR p.description LIKE ?))
      )`;
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like, like);
    }
    sql += ' ORDER BY bp.updated_at DESC LIMIT 50';
    const rows = await db.prepare(sql).all(...args);
    sendJson(res, 200, { businesses: rows.map(businessProfilePublic) });
  })
);

on(
  'GET',
  '/api/business/directory/:handle',
  requireAuth(async (req, res, params) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $cashtag.' });
    const row = await db
      .prepare('SELECT u.*, bp.* FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?')
      .get(bizUser.id);
    if (!row) return sendJson(res, 404, { error: 'This business has not set up their page yet.' });
    const products = await db
      .prepare('SELECT * FROM business_products WHERE business_id = ? ORDER BY created_at ASC')
      .all(bizUser.id);
    const events = await db
      .prepare("SELECT * FROM business_events WHERE business_id = ? AND status = 'active' ORDER BY event_date ASC")
      .all(bizUser.id);
    const eventsPublic = await Promise.all(events.map(async (e) => businessEventPublic(e, await countTicketsSold(e.id))));
    const jobs = await db
      .prepare("SELECT * FROM job_postings WHERE business_id = ? AND status = 'active' ORDER BY created_at DESC")
      .all(bizUser.id);
    sendJson(res, 200, {
      business: {
        ...businessProfilePublic(row),
        products: products.map(businessProductPublic),
        events: eventsPublic,
        jobs: jobs.map((j) => jobPostingPublic(j)),
      },
    });
  })
);

// ---------- business products & prices ----------
//
// A simple price list attached to a business's page — not tied to payments
// (paying still just moves GYD to a business by username/$cashtag/QR/charge
// request, same as before); this is purely informational, like a printed
// menu or catalog a customer reads before deciding to buy or message.

function businessProductPublic(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    description: row.description,
    imageUrl: row.image_data || null,
    createdAt: row.created_at,
  };
}

// A product photo arrives as a data: URL (the browser resizes/compresses it
// client-side first — see app.js) rather than a real file upload, since this
// prototype has no file storage. Capped well under the request body limit
// above so one oversized photo can't crowd out everything else in the body.
function validateProductImage(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || !raw.startsWith('data:image/')) {
    return { ok: false, error: 'Product photo must be a valid image file.' };
  }
  if (raw.length > 2_000_000) {
    return { ok: false, error: "That photo is too large — try a smaller one." };
  }
  return { ok: true, value: raw };
}

on(
  'GET',
  '/api/business/products',
  requireBusiness(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM business_products WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 200, { products: rows.map(businessProductPublic) });
  })
);

on(
  'POST',
  '/api/business/products',
  requireBusiness(async (req, res, params, query, body, user) => {
    const name = (body.name || '').trim().slice(0, 80);
    const price = Number(body.price);
    const description = (body.description || '').trim().slice(0, 300);
    if (!name) return badRequest(res, 'Enter a product or service name.');
    if (!positiveAmount(price)) return badRequest(res, 'Enter a positive price.');
    const image = validateProductImage(body.imageData);
    if (!image.ok) return badRequest(res, image.error);

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO business_products (id, business_id, name, price, description, image_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, user.id, name, price, description || null, image.value, now());
    const rows = await db.prepare('SELECT * FROM business_products WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 201, { products: rows.map(businessProductPublic) });
  })
);

on(
  'DELETE',
  '/api/business/products/:id',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM business_products WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Product not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This product is not yours to remove.' });
    await db.prepare('DELETE FROM business_products WHERE id = ?').run(params.id);
    const rows = await db.prepare('SELECT * FROM business_products WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 200, { products: rows.map(businessProductPublic) });
  })
);

// ---------- business events & tickets ----------
//
// A business can post an event (a concert, a sale, a class — anything with
// a date and a ticket price) on its own page. A customer buys a ticket
// (1-10 at a time) straight from the business's public page; the business
// gets paid into its business wallet net of a platform fee, and the buyer
// gets back a short unique code for each ticket, which the app renders as
// a QR image (see app.js) the same way "Your code" does for QR pay. At the
// door, the event's own coordinator scans (or types in) that code to check
// the ticket in — see the check-in endpoint below.

const EVENT_TICKET_FEE_RATE = 0.035; // the platform's cut of the ticket price — see README.md

function businessEventPublic(row, ticketsSold) {
  const capacity = row.capacity === null || row.capacity === undefined ? null : row.capacity;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    eventDate: row.event_date,
    ticketPrice: row.ticket_price,
    capacity,
    ticketsSold,
    ticketsRemaining: capacity === null ? null : Math.max(0, capacity - ticketsSold),
    soldOut: capacity !== null && ticketsSold >= capacity,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function countTicketsSold(eventId) {
  const row = await db.prepare('SELECT COUNT(*) as n FROM event_tickets WHERE event_id = ?').get(eventId);
  return row ? Number(row.n) : 0;
}

function eventTicketPublic(row, buyerUsername) {
  return {
    id: row.id,
    ticketCode: row.ticket_code,
    buyerUsername,
    pricePaid: row.price_paid,
    platformFee: row.platform_fee,
    status: row.status,
    purchasedAt: row.purchased_at,
    checkedInAt: row.checked_in_at || null,
  };
}

// A short, unique ticket code — same idea as the GYD Direct reference code
// above, but identifying one specific purchased ticket rather than a
// pending transfer. This is exactly what gets encoded into the ticket's QR
// image and what a coordinator scans (or types) at the door.
async function generateTicketCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const existing = await db.prepare('SELECT id FROM event_tickets WHERE ticket_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique ticket code');
}

on(
  'GET',
  '/api/business/events',
  requireBusiness(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM business_events WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    const events = await Promise.all(rows.map(async (r) => businessEventPublic(r, await countTicketsSold(r.id))));
    sendJson(res, 200, { events });
  })
);

on(
  'POST',
  '/api/business/events',
  requireBusiness(async (req, res, params, query, body, user) => {
    const title = (body.title || '').trim().slice(0, 100);
    const description = (body.description || '').trim().slice(0, 1000);
    const location = (body.location || '').trim().slice(0, 140);
    const eventDate = (body.eventDate || '').trim().slice(0, 60);
    const ticketPrice = Number(body.ticketPrice);
    const capacity =
      body.capacity === '' || body.capacity === undefined || body.capacity === null ? null : Math.floor(Number(body.capacity));

    if (!title) return badRequest(res, 'Give your event a title.');
    if (!eventDate) return badRequest(res, 'Enter a date (and time, if you like) for the event.');
    if (!positiveAmount(ticketPrice)) return badRequest(res, 'Enter a positive ticket price.');
    if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
      return badRequest(res, 'Capacity must be a positive whole number, or left blank for unlimited.');
    }

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO business_events (id, business_id, title, description, location, event_date, ticket_price, capacity, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(id, user.id, title, description || null, location || null, eventDate, ticketPrice, capacity, now());

    const rows = await db.prepare('SELECT * FROM business_events WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    const events = await Promise.all(rows.map(async (r) => businessEventPublic(r, await countTicketsSold(r.id))));
    sendJson(res, 201, { events });
  })
);

on(
  'POST',
  '/api/business/events/:id/cancel',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM business_events WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Event not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This event is not yours to cancel.' });
    await db.prepare("UPDATE business_events SET status = 'cancelled' WHERE id = ?").run(params.id);
    const rows = await db.prepare('SELECT * FROM business_events WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    const events = await Promise.all(rows.map(async (r) => businessEventPublic(r, await countTicketsSold(r.id))));
    sendJson(res, 200, { events });
  })
);

on(
  'DELETE',
  '/api/business/events/:id',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM business_events WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Event not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This event is not yours to remove.' });
    if ((await countTicketsSold(row.id)) > 0) {
      return badRequest(res, 'This event already has tickets sold — cancel it instead of deleting it.');
    }
    await db.prepare('DELETE FROM business_events WHERE id = ?').run(params.id);
    const rows = await db.prepare('SELECT * FROM business_events WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    const events = await Promise.all(rows.map(async (r) => businessEventPublic(r, await countTicketsSold(r.id))));
    sendJson(res, 200, { events });
  })
);

on(
  'GET',
  '/api/business/events/:id/tickets',
  requireBusiness(async (req, res, params, query, body, user) => {
    const event = await db.prepare('SELECT * FROM business_events WHERE id = ?').get(params.id);
    if (!event) return sendJson(res, 404, { error: 'Event not found.' });
    if (event.business_id !== user.id) return sendJson(res, 403, { error: 'This event is not yours.' });
    const rows = await db
      .prepare(
        `SELECT t.*, u.username AS buyer_username FROM event_tickets t
         JOIN users u ON u.id = t.buyer_user_id
         WHERE t.event_id = ? ORDER BY t.purchased_at DESC`
      )
      .all(params.id);
    sendJson(res, 200, {
      event: businessEventPublic(event, rows.length),
      tickets: rows.map((r) => eventTicketPublic(r, r.buyer_username)),
    });
  })
);

on(
  'POST',
  '/api/events/:id/purchase',
  requireAuth(async (req, res, params, query, body, user) => {
    const event = await db.prepare('SELECT * FROM business_events WHERE id = ?').get(params.id);
    if (!event) return badRequest(res, 'Event not found.');
    if (event.status !== 'active') return badRequest(res, 'This event is no longer selling tickets.');
    if (event.business_id === user.id) return badRequest(res, "You can't buy a ticket to your own event.");

    const quantity = Math.floor(Number(body.quantity ?? 1));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return badRequest(res, 'Choose between 1 and 10 tickets.');
    }

    const alreadySold = await countTicketsSold(event.id);
    if (event.capacity !== null && alreadySold + quantity > event.capacity) {
      const remaining = Math.max(0, event.capacity - alreadySold);
      return badRequest(res, remaining === 0 ? 'This event is sold out.' : `Only ${remaining} ticket(s) left.`);
    }

    const totalPrice = Math.round(event.ticket_price * quantity * 100) / 100;
    if (user.gyd_balance < totalPrice) return badRequest(res, 'Not enough GYD.');

    // The platform takes its cut out of the ticket price rather than adding a
    // fee on top — the buyer pays exactly ticketPrice × quantity, and the
    // business receives the rest. See README.md for why the fee itself
    // isn't credited to any account (same treatment as GYD Direct's fee).
    const perTicketFee = Math.round(event.ticket_price * EVENT_TICKET_FEE_RATE * 100) / 100;
    const totalFee = Math.round(perTicketFee * quantity * 100) / 100;
    const netToBusiness = Math.round((totalPrice - totalFee) * 100) / 100;

    // One atomic statement: debits the buyer and credits the business only
    // if the buyer has enough GYD AND the event still has room for
    // `quantity` more tickets, both checked against the row as it stands at
    // the moment of the update — closes the obvious "two buyers grab the
    // last ticket at once" race that a separate check-then-write couldn't.
    const debitRows = await db.raw(
      `WITH info AS (
         SELECT capacity, (SELECT COUNT(*) FROM event_tickets WHERE event_id = $4) as sold
         FROM business_events WHERE id = $4
       ), debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1
         WHERE id = $2 AND gyd_balance >= $1
           AND ( (SELECT capacity FROM info) IS NULL OR (SELECT sold FROM info) + $5 <= (SELECT capacity FROM info) )
         RETURNING gyd_balance
       ), credit AS (
         UPDATE users SET business_gyd_balance = business_gyd_balance + $3 WHERE id = $6 AND EXISTS (SELECT 1 FROM debit) RETURNING 1
       )
       SELECT gyd_balance FROM debit`,
      [totalPrice, user.id, netToBusiness, event.id, quantity, event.business_id]
    );
    if (debitRows.length === 0) {
      return badRequest(res, 'This purchase could not be completed — the event may have just sold out, or your balance changed. Please try again.');
    }

    const tickets = [];
    try {
      for (let i = 0; i < quantity; i++) {
        const ticketId = crypto.randomUUID();
        const code = await generateTicketCode();
        await db.prepare(
          `INSERT INTO event_tickets (id, event_id, buyer_user_id, ticket_code, price_paid, platform_fee, status, purchased_at)
           VALUES (?, ?, ?, ?, ?, ?, 'valid', ?)`
        ).run(ticketId, event.id, user.id, code, event.ticket_price, perTicketFee, now());
        tickets.push({ id: ticketId, ticketCode: code });
      }
    } catch (err) {
      // The payment already went through but issuing the ticket(s) failed
      // (a rare mid-request hiccup) — refund both sides rather than leave
      // the buyer charged with nothing to show for it.
      console.error('Ticket issuance failed after payment, refunding:', err);
      await db.raw('UPDATE users SET gyd_balance = gyd_balance + $1 WHERE id = $2', [totalPrice, user.id]);
      await db.raw('UPDATE users SET business_gyd_balance = business_gyd_balance - $1 WHERE id = $2', [netToBusiness, event.business_id]);
      return sendJson(res, 500, { error: 'Could not complete the purchase — you have not been charged. Please try again.' });
    }

    await logTx({
      type: 'event_ticket',
      fromUser: user.id,
      toUser: event.business_id,
      amount: totalPrice,
      currency: 'GYD',
      note: `${quantity} ticket(s) to "${event.title}"`,
    });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 201, { user: publicUser(updated), tickets, totalPrice, fee: totalFee });
  })
);

on(
  'GET',
  '/api/me/tickets',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db
      .prepare(
        `SELECT t.*, e.title AS event_title, e.event_date, e.location AS event_location, e.status AS event_status,
                bu.username AS business_username, bu.business_name AS business_name
         FROM event_tickets t
         JOIN business_events e ON e.id = t.event_id
         JOIN users bu ON bu.id = e.business_id
         WHERE t.buyer_user_id = ?
         ORDER BY t.purchased_at DESC`
      )
      .all(user.id);
    sendJson(res, 200, {
      tickets: rows.map((r) => ({
        id: r.id,
        ticketCode: r.ticket_code,
        status: r.status,
        pricePaid: r.price_paid,
        purchasedAt: r.purchased_at,
        checkedInAt: r.checked_in_at || null,
        event: { title: r.event_title, date: r.event_date, location: r.event_location, status: r.event_status },
        business: { username: r.business_username, name: r.business_name },
      })),
    });
  })
);

on(
  'POST',
  '/api/business/events/tickets/:code/check-in',
  requireBusiness(async (req, res, params, query, body, user) => {
    const code = (params.code || '').trim().toUpperCase();
    const ticket = await db.prepare('SELECT * FROM event_tickets WHERE ticket_code = ?').get(code);
    if (!ticket) return badRequest(res, 'No ticket with that code.');
    const event = await db.prepare('SELECT * FROM business_events WHERE id = ?').get(ticket.event_id);
    if (!event || event.business_id !== user.id) return sendJson(res, 403, { error: "This ticket isn't for one of your events." });
    const buyer = await db.prepare('SELECT username FROM users WHERE id = ?').get(ticket.buyer_user_id);
    const buyerUsername = buyer ? buyer.username : 'unknown';

    if (ticket.status === 'checked_in') {
      return sendJson(res, 200, {
        ok: false,
        reason: 'already_checked_in',
        eventTitle: event.title,
        ticket: eventTicketPublic(ticket, buyerUsername),
      });
    }

    await db.prepare("UPDATE event_tickets SET status = 'checked_in', checked_in_at = ? WHERE id = ?").run(now(), ticket.id);
    const updated = await db.prepare('SELECT * FROM event_tickets WHERE id = ?').get(ticket.id);
    sendJson(res, 200, { ok: true, eventTitle: event.title, ticket: eventTicketPublic(updated, buyerUsername) });
  })
);

// ---------- business jobs (job board) ----------
//
// A business can post a job opening on its own page; it also shows up in
// the site-wide jobs board below so someone doesn't have to already know
// about a business to find its openings. There's no in-app applicant
// tracker — "Apply" just starts a message thread with the business through
// the existing messaging feature (see /api/messages above), the same way a
// customer would message a business about anything else.

const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary'];

function jobPostingPublic(row, business) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    payInfo: row.pay_info,
    jobType: row.job_type,
    status: row.status,
    createdAt: row.created_at,
    business: business
      ? { username: business.username, name: business.business_name || business.username }
      : undefined,
  };
}

on(
  'GET',
  '/api/business/jobs',
  requireBusiness(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM job_postings WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    sendJson(res, 200, { jobs: rows.map((r) => jobPostingPublic(r)) });
  })
);

on(
  'POST',
  '/api/business/jobs',
  requireBusiness(async (req, res, params, query, body, user) => {
    const title = (body.title || '').trim().slice(0, 100);
    const description = (body.description || '').trim().slice(0, 2000);
    const location = (body.location || '').trim().slice(0, 140);
    const payInfo = (body.payInfo || '').trim().slice(0, 100);
    const jobType = JOB_TYPES.includes(body.jobType) ? body.jobType : null;

    if (!title) return badRequest(res, 'Give the job a title.');
    if (!description) return badRequest(res, 'Add a short description of the job.');

    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO job_postings (id, business_id, title, description, location, pay_info, job_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(id, user.id, title, description, location || null, payInfo || null, jobType, now());

    const rows = await db.prepare('SELECT * FROM job_postings WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    sendJson(res, 201, { jobs: rows.map((r) => jobPostingPublic(r)) });
  })
);

on(
  'POST',
  '/api/business/jobs/:id/close',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM job_postings WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Job posting not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This job posting is not yours to close.' });
    await db.prepare("UPDATE job_postings SET status = 'closed' WHERE id = ?").run(params.id);
    const rows = await db.prepare('SELECT * FROM job_postings WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    sendJson(res, 200, { jobs: rows.map((r) => jobPostingPublic(r)) });
  })
);

on(
  'DELETE',
  '/api/business/jobs/:id',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM job_postings WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Job posting not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This job posting is not yours to remove.' });
    await db.prepare('DELETE FROM job_postings WHERE id = ?').run(params.id);
    const rows = await db.prepare('SELECT * FROM job_postings WHERE business_id = ? ORDER BY created_at DESC').all(user.id);
    sendJson(res, 200, { jobs: rows.map((r) => jobPostingPublic(r)) });
  })
);

// The site-wide jobs board: every active job posting across every business,
// newest first, optionally filtered by a search term (matches title,
// description, or location) or an exact job type — separate from a
// business's own page so someone looking for work can browse openings
// without already knowing which businesses are hiring.
on(
  'GET',
  '/api/jobs',
  requireAuth(async (req, res, params, query) => {
    const q = (query.q || '').trim();
    const jobType = (query.jobType || '').trim();
    let sql = `SELECT j.*, u.username, u.business_name FROM job_postings j JOIN users u ON u.id = j.business_id WHERE j.status = 'active'`;
    const args = [];
    if (jobType) {
      sql += ' AND j.job_type = ?';
      args.push(jobType);
    }
    if (q) {
      sql += ' AND (j.title LIKE ? OR j.description LIKE ? OR j.location LIKE ?)';
      const like = `%${q}%`;
      args.push(like, like, like);
    }
    sql += ' ORDER BY j.created_at DESC LIMIT 100';
    const rows = await db.prepare(sql).all(...args);
    sendJson(res, 200, {
      jobs: rows.map((r) => jobPostingPublic(r, { username: r.username, business_name: r.business_name })),
      jobTypes: JOB_TYPES,
    });
  })
);

// ---------- business checkout (pickup vs delivery) ----------
//
// A lightweight checkout for paying a business found through the directory:
// underneath it's the same GYD transfer as everywhere else, but when the
// business offers delivery the customer can choose delivery over pickup,
// adding the business's own delivery fee to the total. That fee goes to the
// business (they're the one arranging the delivery), not the platform —
// unlike GYD Direct's fee, which the platform keeps. Pickup never needs an
// address; delivery always does.

on(
  'POST',
  '/api/business/checkout',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(body.businessHandle || '');
    if (!bizUser || !bizUser.is_business) return badRequest(res, 'No business with that username or $cashtag.');
    if (bizUser.id === user.id) return badRequest(res, "You can't check out with your own business.");

    const profileRow = await db.prepare('SELECT * FROM business_profiles WHERE user_id = ?').get(bizUser.id);
    const amount = Number(body.amount);
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');

    const wantsDelivery = body.fulfillment === 'delivery';
    if (wantsDelivery && !(profileRow && profileRow.offers_delivery)) {
      return badRequest(res, 'This business does not offer delivery.');
    }
    const deliveryAddress = wantsDelivery ? (body.deliveryAddress || '').trim().slice(0, 200) : '';
    if (wantsDelivery && !deliveryAddress) return badRequest(res, 'Enter a delivery address.');

    const deliveryFee = wantsDelivery ? profileRow.delivery_fee || 0 : 0;
    const total = Math.round((amount + deliveryFee) * 100) / 100;
    if (user.gyd_balance < total) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(total)}.`);

    const newBalance = await db.atomicTransfer(user.id, total, bizUser.id, true);
    if (newBalance === null) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(total)}.`);

    const note = wantsDelivery
      ? `Delivery to ${deliveryAddress} (delivery fee GYD ${fmtNum(deliveryFee)})`
      : 'Pickup';
    await logTx({ type: 'business_payment', fromUser: user.id, toUser: bizUser.id, amount: total, currency: 'GYD', note });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, {
      user: publicUser(updated),
      total,
      fulfillment: wantsDelivery ? 'delivery' : 'pickup',
      deliveryFee,
    });
  })
);

// ---------- business wallet (separate balance for business accounts) ----------
//
// A business account has two GYD balances (see db.js and db.atomicTransfer
// above): gyd_balance for their own personal spending (deposits, buying
// coins, cashing out, sending money to others — same as any account), and
// business_gyd_balance for money customers pay the business. This is the
// one way funds cross from the business wallet into the personal one — a
// deliberate, one-directional "owner's draw", so the business's takings
// never mix into personal spending money without the owner choosing to
// move them. There is no endpoint that moves money the other way (personal
// into business) since nothing in this prototype needs to fund the
// business wallet directly — it only ever fills up from customer payments.

on(
  'POST',
  '/api/business/wallet/move-to-personal',
  requireBusiness(async (req, res, params, query, body, user) => {
    const amount = Number(body.amount);
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    if (user.business_gyd_balance < amount) return badRequest(res, 'Not enough in your business wallet.');

    const rows = await db.raw(
      `UPDATE users SET business_gyd_balance = business_gyd_balance - $1, gyd_balance = gyd_balance + $1
       WHERE id = $2 AND business_gyd_balance >= $1
       RETURNING gyd_balance, business_gyd_balance`,
      [amount, user.id]
    );
    if (rows.length === 0) return badRequest(res, 'Not enough in your business wallet.');

    await logTx({ type: 'business_wallet_transfer', toUser: user.id, amount, currency: 'GYD', note: 'Moved from business wallet to personal wallet' });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

// ---------- messaging ----------

on(
  'POST',
  '/api/messages',
  requireAuth(async (req, res, params, query, body, user) => {
    const { toUsername, body: text } = body;
    if (!toUsername) return badRequest(res, 'Choose who to message.');
    if (!text || !text.trim()) return badRequest(res, 'Message cannot be empty.');
    if (toUsername === user.username) return badRequest(res, "You can't message yourself.");
    const recipient = await db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
    if (!recipient) return badRequest(res, 'No user with that username.');

    await db.prepare(
      `INSERT INTO messages (id, from_user, to_user, body, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)`
    ).run(crypto.randomUUID(), user.id, recipient.id, text.trim().slice(0, 2000), now());
    sendJson(res, 201, { ok: true });
  })
);

on(
  'GET',
  '/api/messages/threads',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db
      .prepare(
        `SELECT m.*,
                CASE WHEN m.from_user = ? THEN m.to_user ELSE m.from_user END AS other_id
         FROM messages m
         WHERE m.from_user = ? OR m.to_user = ?
         ORDER BY m.created_at DESC`
      )
      .all(user.id, user.id, user.id);

    const seen = new Map();
    for (const r of rows) {
      if (!seen.has(r.other_id)) seen.set(r.other_id, r);
    }
    const threads = [];
    for (const [otherId, lastMsg] of seen.entries()) {
      const other = await db.prepare('SELECT username, business_name, is_business FROM users WHERE id = ?').get(otherId);
      threads.push({
        username: other ? other.username : '(deleted user)',
        isBusiness: other ? !!other.is_business : false,
        lastMessage: lastMsg.body,
        lastAt: lastMsg.created_at,
        fromMe: lastMsg.from_user === user.id,
      });
    }
    sendJson(res, 200, { threads });
  })
);

on(
  'GET',
  '/api/messages/thread/:username',
  requireAuth(async (req, res, params, query, body, user) => {
    const other = await db.prepare('SELECT * FROM users WHERE username = ?').get(params.username);
    if (!other) return sendJson(res, 404, { error: 'No user with that username.' });

    const rows = await db
      .prepare(
        `SELECT * FROM messages
         WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
         ORDER BY created_at ASC LIMIT 200`
      )
      .all(user.id, other.id, other.id, user.id);

    await db.prepare('UPDATE messages SET is_read = 1 WHERE from_user = ? AND to_user = ?').run(other.id, user.id);

    sendJson(res, 200, {
      messages: rows.map((m) => ({ body: m.body, fromMe: m.from_user === user.id, createdAt: m.created_at })),
    });
  })
);

// ---------- static file serving ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, parsedUrl) {
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, parsedUrl);
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    const params = {};
    route.paramNames.forEach((name, i) => (params[name] = match[i + 1]));

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readJsonBody(req);
      } catch {
        return badRequest(res, 'Invalid JSON body.');
      }
    }

    try {
      return await route.handler(req, res, params, parsedUrl.query, body);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'Internal server error.' });
    }
  }

  sendJson(res, 404, { error: 'No such API route.' });
});

server.listen(PORT, () => {
  console.log(`GYD Wallet running at http://localhost:${PORT}`);
});

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
const { hashPassword, verifyPassword, makeSessionToken, makeStaffSessionToken, sign, verify } = require('./auth');
const { LUDO_COLOR_SETS, ludoLegalMoves, ludoApplyMove, ludoHasWon } = require('./ludo');
const { emailEnabled, sendEmail, codeEmailHtml } = require('./email');
const { smsEnabled, sendSms } = require('./sms');
const { dropshippingEnabled, fetchProductsFromCJ, placeOrderWithCJ } = require('./dropshipping');
const {
  googleEnabled,
  facebookEnabled,
  googleAuthUrl,
  facebookAuthUrl,
  googleProfileFromCode,
  facebookProfileFromCode,
} = require('./oauth');

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

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
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
  if (!user) return null;
  // "Log out of all other devices" (POST /api/security/logout-all-sessions)
  // sets sessions_invalidated_at to the moment it's clicked — any token
  // issued before that, including one an attacker stole earlier, stops
  // working immediately even though it hasn't hit its 7-day expiry yet.
  if (user.sessions_invalidated_at && (!data.iat || data.iat < new Date(user.sessions_invalidated_at).getTime())) {
    return null;
  }
  return user;
}

// Staff sessions are a completely separate token shape (see auth.js's
// makeStaffSessionToken) — a customer token has no `role` field at all, so
// it can never satisfy `data.role === 'staff'` here no matter what account
// it belongs to, and a staff token has no `uid` so it can't be used with
// getAuthedUser above either.
async function getAuthedStaff(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const data = verify(token);
  if (!data || data.role !== 'staff') return null;
  const staff = await db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(data.sid);
  if (!staff) return null;
  // Same session-revocation check as getAuthedUser above — lets a staff
  // member log themselves out everywhere, or an owner cut off a specific
  // employee's access outright (see /api/staff/logout-all-sessions and
  // /api/staff/accounts/:id/revoke-sessions).
  if (staff.sessions_invalidated_at && (!data.iat || data.iat < new Date(staff.sessions_invalidated_at).getTime())) {
    return null;
  }
  return staff;
}

function publicStaff(s) {
  return { id: s.id, username: s.username, role: s.role || 'employee', createdAt: s.created_at, email: s.email || null, phone: s.phone || null };
}

// A permanent, append-only record of anything a staff member does that
// could move money or grant access — see the staff_audit_log comment in
// supabase/schema.sql. This never updates or deletes a row, only inserts,
// and nothing in the staff portal's UI or API ever exposes a way to edit or
// remove an entry — that's what makes it trustworthy as a fraud/theft
// check rather than something an employee could quietly tidy up after
// themselves.
async function logStaffAction(staff, action, target, details) {
  await db.prepare(
    `INSERT INTO staff_audit_log (id, staff_id, staff_username, action, target, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), staff.id, staff.username, action, target || null, details || null, now());

  if (FRAUD_ALERT_ACTIONS.has(action)) {
    await maybeSendFraudAlert(staff);
  }
}

// Which audit-log actions count toward the real-time fraud check below —
// the cash-out queue is the one place a single staff member's actions
// directly move real money, so it's the one worth watching automatically.
const FRAUD_ALERT_ACTIONS = new Set(['cashout_completed', 'cashout_rejected']);
const FRAUD_ALERT_WINDOW_MINUTES = 15;
const FRAUD_ALERT_WINDOW_MS = FRAUD_ALERT_WINDOW_MINUTES * 60 * 1000;
const FRAUD_ALERT_THRESHOLD = 5; // this many cash-out actions by one staff member inside the window
const FRAUD_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // don't re-alert on the same staff member more than once per hour

// A lightweight, real-time alternative to someone having to remember to
// open the audit log: if one staff member races through an unusual number
// of cash-out payouts/rejections in a short window, every owner with an
// email on file (see PATCH /api/staff/me/email) gets a heads-up right
// away. This app has no scheduler for a periodic digest (see README's
// "Why no npm packages"), so this runs inline with the very request that
// crosses the threshold instead — the check itself is cheap (one COUNT
// query), and the cooldown below means it only actually sends mail the
// first time a given staff member trips it in an hour.
async function maybeSendFraudAlert(staff) {
  if (!emailEnabled()) return; // nowhere to send it — same graceful no-op as everywhere else in email.js
  const alertKey = `fraud-alert:${staff.id}`;
  if (rateLimitPeek(alertKey).count > 0) return; // already alerted on this staff member recently
  const cutoff = new Date(Date.now() - FRAUD_ALERT_WINDOW_MS).toISOString();
  const recent = await db
    .prepare(`SELECT COUNT(*) AS n FROM staff_audit_log WHERE staff_id = ? AND action LIKE 'cashout_%' AND created_at >= ?`)
    .get(staff.id, cutoff);
  if (Number(recent.n) < FRAUD_ALERT_THRESHOLD) return;

  rateLimitRecord(alertKey, FRAUD_ALERT_COOLDOWN_MS);
  const owners = await db.prepare(`SELECT email FROM staff_accounts WHERE role = 'owner' AND email IS NOT NULL`).all();
  for (const owner of owners) {
    await sendEmail(
      owner.email,
      'GYD Wallet: unusual staff activity',
      `<div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <p><strong>${staff.username}</strong> has processed ${recent.n} cash-out payouts/rejections in the last ${FRAUD_ALERT_WINDOW_MINUTES} minutes.</p>
        <p>This may be completely normal — a busy shift, a backlog getting cleared — but it's worth a look at the audit log if it isn't what you'd expect.</p>
      </div>`
    );
  }
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    paytag: u.paytag,
    email: u.email || null,
    isBusiness: !!u.is_business,
    businessName: u.business_name || null,
    isCourier: !!u.is_courier,
    courierGydBalance: u.courier_gyd_balance || 0,
    gydBalance: u.gyd_balance,
    businessGydBalance: u.business_gyd_balance || 0,
    createdAt: u.created_at,
  };
}

// Deliberately simple (RFC 5322 in full is far more permissive than anyone
// actually wants to type into a signup form) — good enough to reject
// obvious typos without rejecting real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// $Paytag: a short, unique, user-changeable payment handle that's separate
// from (but defaults to) the login username. Looking someone up by "handle"
// below accepts either their username or their $paytag (with or without a
// leading $), so a sender can use whichever one they actually know.
function slugifyPaytag(base) {
  let slug = (base || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (slug.length < 3) slug = slug + 'user' + crypto.randomInt(1000);
  // Capped shorter than the 20-char max so a numeric de-dupe suffix below
  // always has room to attach — appending digits to an already-20-char
  // slug and re-slicing to 20 would just cut the suffix back off again,
  // making every candidate identical and the loop below infinite.
  return slug.slice(0, 16);
}

async function generateUniquePaytag(base) {
  const slug = slugifyPaytag(base);
  let candidate = slug;
  let n = 0;
  while (await db.prepare('SELECT id FROM users WHERE LOWER(paytag) = LOWER(?)').get(candidate)) {
    n += 1;
    candidate = `${slug}${n}`;
  }
  return candidate;
}

// Only used for accounts created via "Continue with Google/Facebook" —
// a password signup always has the person type their own username. Reuses
// the same slugify-then-de-dupe shape as generateUniquePaytag above, just
// against the username column instead.
async function generateUniqueUsername(base) {
  let slug = (base || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (slug.length < 3) slug = 'user' + crypto.randomInt(1000000);
  slug = slug.slice(0, 16);
  let candidate = slug;
  let n = 0;
  while (await db.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) {
    n += 1;
    candidate = `${slug}${n}`;
  }
  return candidate;
}

// Turns a Google/Facebook profile into a GYD Wallet user, in three
// possible ways:
//   1. This exact provider account has signed in before -> that user.
//   2. First time from this provider, but its (verified) email matches an
//      existing password account -> link the two, so someone doesn't end
//      up with two separate wallets just because they used "Continue with
//      Google" once instead of typing the password they already have.
//   3. Neither -> a brand-new account, with no usable password (a random
//      one is generated and never shared) until/unless they set one later
//      via the existing "Forgot your password?" flow, which only needs a
//      verified email on file.
async function findOrCreateOAuthUser(provider, profile) {
  const identity = await db
    .prepare('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?')
    .get(provider, profile.providerUserId);
  if (identity) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
  }

  let user = null;
  if (profile.email) {
    user = await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(profile.email);
  }

  if (!user) {
    const usernameBase = profile.name || (profile.email ? profile.email.split('@')[0] : provider);
    const username = await generateUniqueUsername(usernameBase);
    const paytag = await generateUniquePaytag(username);
    const { salt, hash } = hashPassword(crypto.randomBytes(32).toString('hex'));
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO users (id, username, paytag, email, password_hash, password_salt, is_business, business_name, gyd_balance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`
      )
      .run(id, username, paytag, profile.email || null, hash, salt, now());
    user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  await db
    .prepare(
      `INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, email, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), user.id, provider, profile.providerUserId, profile.email || null, now());

  return user;
}

async function findUserByHandle(raw) {
  const handle = (raw || '').trim().replace(/^\$/, '');
  if (!handle) return null;
  return db.prepare('SELECT * FROM users WHERE username = ? OR LOWER(paytag) = LOWER(?)').get(handle, handle);
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

function requireCourier(handler) {
  return requireAuth(async (req, res, params, query, body, user) => {
    if (!user.is_courier) return sendJson(res, 403, { error: 'This action requires a courier account.' });
    return handler(req, res, params, query, body, user);
  });
}

function requireStaffAuth(handler) {
  return async (req, res, params, query, body) => {
    const staff = await getAuthedStaff(req);
    if (!staff) return sendJson(res, 401, { error: 'Not authenticated.' });
    return handler(req, res, params, query, body, staff);
  };
}

// The actual fraud/theft control on top of requireStaffAuth: an 'employee'
// can use the support/cash-out queues, but only an 'owner' can
// create another staff account or read the audit log — so no single
// employee, however compromised or dishonest, can quietly grant an
// accomplice access or cover their tracks. See the role comment on
// staff_accounts in supabase/schema.sql.
function requireStaffOwner(handler) {
  return requireStaffAuth(async (req, res, params, query, body, staff) => {
    if (staff.role !== 'owner') return sendJson(res, 403, { error: 'This action requires an owner-level staff account.' });
    return handler(req, res, params, query, body, staff);
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
  const paytag = await generateUniquePaytag(username);
  await db.prepare(
    `INSERT INTO users (id, username, paytag, email, password_hash, password_salt, is_business, business_name, gyd_balance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, username, paytag, email, hash, salt, isBusiness ? 1 : 0, isBusiness ? (businessName || username) : null, now());

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = makeSessionToken(id);
  sendJson(res, 201, { token, user: publicUser(user) });
});

const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS_PER_IP = 30; // backstop against one IP guessing across many usernames

on('POST', '/api/login', async (req, res, params, query, body) => {
  const { username, password } = body;
  const ip = getClientIp(req);
  const perAccountKey = `login:${(username || '').toLowerCase()}:${ip}`;
  const perIpKey = `login-ip:${ip}`;

  const perAccountBucket = rateLimitPeek(perAccountKey);
  const perIpBucket = rateLimitPeek(perIpKey);
  if (perAccountBucket.count >= LOGIN_MAX_ATTEMPTS || perIpBucket.count >= LOGIN_MAX_ATTEMPTS_PER_IP) {
    const bucket = perAccountBucket.count >= LOGIN_MAX_ATTEMPTS ? perAccountBucket : perIpBucket;
    return sendJson(res, 429, {
      error: `Too many login attempts. Try again in ${retryAfterMinutes(bucket)} minute(s).`,
    });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !verifyPassword(password || '', user.password_salt, user.password_hash)) {
    rateLimitRecord(perAccountKey, LOGIN_WINDOW_MS);
    rateLimitRecord(perIpKey, LOGIN_WINDOW_MS);
    return sendJson(res, 401, { error: 'Invalid username or password.' });
  }
  rateLimitReset(perAccountKey);
  const token = makeSessionToken(user.id);
  sendJson(res, 200, { token, user: publicUser(user) });
});

// ---------- social sign-in (Google / Facebook) ----------
//
// A full-page redirect flow, not fetch/AJAX — that's simply how every
// OAuth provider's consent screen works: the browser navigates away to
// Google or Facebook, then back to our own /api/auth/<provider>/callback.
// That callback has no in-page JS running mid-navigation to hand the SPA
// its new session token as a JSON response, so it redirects one more time
// to the app's own root with the token in the query string; app.js's
// boot() picks it up from there exactly like a password login would, then
// strips it from the address bar. See oauth.js for the provider-specific
// pieces, and README's "Setting up social sign-in" for the env vars this
// is gated behind (both providers off is a normal, fully working state —
// the buttons just don't show).
function oauthState(provider) {
  return sign({ purpose: 'oauth_state', provider, nonce: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60 * 1000 });
}

function validOauthState(token, provider) {
  const data = verify(token);
  return !!(data && data.purpose === 'oauth_state' && data.provider === provider);
}

on('GET', '/api/auth/social-providers', async (req, res) => {
  sendJson(res, 200, { google: googleEnabled(), facebook: facebookEnabled() });
});

on('GET', '/api/auth/google/start', async (req, res) => {
  if (!googleEnabled()) return sendJson(res, 503, { error: 'Google sign-in is not set up yet.' });
  redirect(res, googleAuthUrl(oauthState('google')));
});

on('GET', '/api/auth/google/callback', async (req, res, params, query) => {
  if (!googleEnabled()) return redirect(res, '/?oauth_error=' + encodeURIComponent('Google sign-in is not set up yet.'));
  try {
    if (query.error) throw new Error('Google sign-in was cancelled.');
    if (!validOauthState(query.state, 'google')) throw new Error('That sign-in link expired — please try again.');
    const profile = await googleProfileFromCode(query.code);
    const user = await findOrCreateOAuthUser('google', profile);
    const token = makeSessionToken(user.id);
    redirect(res, '/?oauth_token=' + encodeURIComponent(token));
  } catch (err) {
    redirect(res, '/?oauth_error=' + encodeURIComponent(err.message));
  }
});

on('GET', '/api/auth/facebook/start', async (req, res) => {
  if (!facebookEnabled()) return sendJson(res, 503, { error: 'Facebook sign-in is not set up yet.' });
  redirect(res, facebookAuthUrl(oauthState('facebook')));
});

on('GET', '/api/auth/facebook/callback', async (req, res, params, query) => {
  if (!facebookEnabled()) return redirect(res, '/?oauth_error=' + encodeURIComponent('Facebook sign-in is not set up yet.'));
  try {
    if (query.error) throw new Error('Facebook sign-in was cancelled.');
    if (!validOauthState(query.state, 'facebook')) throw new Error('That sign-in link expired — please try again.');
    const profile = await facebookProfileFromCode(query.code);
    const user = await findOrCreateOAuthUser('facebook', profile);
    const token = makeSessionToken(user.id);
    redirect(res, '/?oauth_token=' + encodeURIComponent(token));
  } catch (err) {
    redirect(res, '/?oauth_error=' + encodeURIComponent(err.message));
  }
});

const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RESET_CODE_ATTEMPTS = 5; // wrong guesses allowed before a fresh code is required
const FORGOT_MAX_PER_IP = 8; // requests per IP per window, for both forgot-* endpoints
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const RESET_PASSWORD_MAX_PER_IP = 30; // backstop against guessing codes across many emails
const RESET_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

// Forgotten password, step 1: look the account up by email and issue a
// reset code. There's no real email sending wired up in this Phase 1
// prototype (see "Why no npm packages" in README.md), so — in the same
// "simulated" spirit as deposits — the code is handed straight back in
// this response and shown on screen instead of actually being emailed.
// Wiring in a real mail provider later just means deleting the `code`
// line from this response and emailing it instead; nothing else changes.
//
// IMPORTANT: this always responds with a freshly generated code, whether
// or not the email actually has an account — the code just never gets
// stored anywhere for an email that doesn't match one. If this instead
// returned an error for unknown emails, anyone could use this endpoint to
// check which emails have accounts here; responding identically either way
// closes that off without changing anything a real user experiences.
on('POST', '/api/auth/forgot-password', async (req, res, params, query, body) => {
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return badRequest(res, 'Enter a valid email address.');
  }

  const ipKey = `forgot-password-ip:${getClientIp(req)}`;
  const ipBucket = rateLimitPeek(ipKey);
  if (ipBucket.count >= FORGOT_MAX_PER_IP) {
    return sendJson(res, 429, {
      error: `Too many requests. Try again in ${retryAfterMinutes(ipBucket)} minute(s).`,
    });
  }
  rateLimitRecord(ipKey, FORGOT_WINDOW_MS);

  const user = await db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(email);
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  let sent = false;

  if (user) {
    // Only one active code per user at a time — clear out any earlier
    // unused one so there's nothing stale left to accidentally match.
    await db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    await db.prepare(
      `INSERT INTO password_resets (id, user_id, code, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), user.id, code, createdAt, expiresAt);

    // With real email delivery configured (see email.js), send the code
    // there instead of handing it back in this response — see
    // "Setting up real email delivery" in README.md for how to turn this
    // on. Falls back to the old on-screen behavior if sending fails for
    // any reason (bad key, provider outage), so this can never lock
    // someone out of resetting their own password.
    if (emailEnabled()) {
      const result = await sendEmail(
        email,
        'Your GYD Wallet reset code',
        codeEmailHtml('Here is your GYD Wallet password reset code:', code, 15)
      );
      sent = result.sent;
    }
  }
  // NOTE: when email is configured, this response takes measurably longer
  // for an email that has an account (it waits on the real send) than one
  // that doesn't — a minor timing side-channel on top of the response-shape
  // protection above. Not worth the complexity of an artificial delay for
  // what's still a Phase 1 prototype, but worth knowing about.

  if (sent) {
    sendJson(res, 200, { sent: true, expiresInMinutes: 15 });
  } else {
    sendJson(res, 200, { code, expiresInMinutes: 15 });
  }
});

// Forgotten password, step 2: spend the code from step 1 to set a new
// password. Logs the person straight in afterward (same response shape as
// /api/login) so they don't have to re-enter the new password immediately.
on('POST', '/api/auth/reset-password', async (req, res, params, query, body) => {
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  const { newPassword } = body;
  if (!email || !EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
  if (!code) return badRequest(res, 'Enter the reset code.');
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return badRequest(res, 'Password must be at least 6 characters.');
  }

  const ipKey = `reset-password-ip:${getClientIp(req)}`;
  const ipBucket = rateLimitPeek(ipKey);
  if (ipBucket.count >= RESET_PASSWORD_MAX_PER_IP) {
    return sendJson(res, 429, {
      error: `Too many attempts from this connection. Try again in ${retryAfterMinutes(ipBucket)} minute(s).`,
    });
  }
  rateLimitRecord(ipKey, RESET_PASSWORD_WINDOW_MS);

  // Same "invalid or expired" message for every failure case below — unknown
  // email, no active code, expired code, wrong code, too many guesses — so
  // this endpoint can't be used to check whether an email has an account
  // (see the enumeration note on /api/auth/forgot-password above).
  const invalidMsg = 'That reset code is invalid or has expired.';

  const user = await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
  if (!user) return badRequest(res, invalidMsg);

  const reset = await db
    .prepare('SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(user.id);
  if (!reset || new Date(reset.expires_at).getTime() < Date.now()) {
    return badRequest(res, invalidMsg);
  }
  // A 6-digit code only has 1,000,000 possibilities, so without this an
  // automated script could simply try all of them inside the 15-minute
  // window. Capping wrong guesses per code makes that infeasible — after
  // this many misses, the code is dead even if it hasn't expired yet, and
  // the only way forward is requesting a brand new one.
  if (reset.attempts >= MAX_RESET_CODE_ATTEMPTS) {
    return badRequest(res, 'Too many incorrect attempts. Request a new reset code.');
  }
  if (reset.code !== code) {
    await db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?').run(reset.id);
    return badRequest(res, invalidMsg);
  }

  const { salt, hash } = hashPassword(newPassword);
  await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, user.id);
  await db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), reset.id);

  const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const token = makeSessionToken(user.id);
  sendJson(res, 200, { token, user: publicUser(updated) });
});

// Forgotten username: same "simulated" idea as forgot-password above, but
// simpler — there's no secret to reset, just a lookup, so the username is
// handed straight back and shown on screen instead of being emailed.
//
// NOTE (unlike forgot-password above): this one CAN'T fully hide whether an
// email has an account, because the whole point is showing the real
// username on screen — there's no fake value to hand back instead without
// actively misleading someone who typos their own email. The IP rate limit
// below is the mitigation: it caps how many emails any one visitor can
// probe per window, without needing real email delivery to close this off
// completely (which would require sending the username out-of-band instead
// of displaying it, the same way a production build should for the reset
// code above).
on('POST', '/api/auth/forgot-username', async (req, res, params, query, body) => {
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return badRequest(res, 'Enter a valid email address.');
  }

  const ipKey = `forgot-username-ip:${getClientIp(req)}`;
  const ipBucket = rateLimitPeek(ipKey);
  if (ipBucket.count >= FORGOT_MAX_PER_IP) {
    return sendJson(res, 429, {
      error: `Too many requests. Try again in ${retryAfterMinutes(ipBucket)} minute(s).`,
    });
  }
  rateLimitRecord(ipKey, FORGOT_WINDOW_MS);

  const user = await db.prepare('SELECT username FROM users WHERE LOWER(email) = ?').get(email);
  if (!user) return badRequest(res, 'No account found with that email.');

  if (emailEnabled()) {
    const result = await sendEmail(
      email,
      'Your GYD Wallet username',
      `<div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto;">
        <p>Your GYD Wallet username is:</p>
        <p style="font-size: 22px; font-weight: 800; text-align: center; margin: 24px 0;">${user.username}</p>
      </div>`
    );
    if (result.sent) return sendJson(res, 200, { sent: true });
  }

  sendJson(res, 200, { username: user.username });
});

// "Log out of all other devices" — see users.sessions_invalidated_at in
// supabase/schema.sql for the mechanism. This also signs the current
// device out (the token making this very request was issued before "now"
// too), which is a deliberate simplification: without tracking individual
// sessions there's no way to tell "this device" apart from any other, so
// the safest, clearest behavior is "everywhere, including here" — the
// person just logs back in on this device afterward.
on(
  'POST',
  '/api/security/logout-all-sessions',
  requireAuth(async (req, res, params, query, body, user) => {
    await db.prepare('UPDATE users SET sessions_invalidated_at = ? WHERE id = ?').run(now(), user.id);
    sendJson(res, 200, { ok: true });
  })
);

// Turning an existing personal account into a business account, in place
// — same account, same login, same personal GYD balance untouched. Until
// now this flag was only ever set once at signup (see isBusiness in
// /api/register above); this is the first way to flip it afterward.
// business_gyd_balance already defaults to 0 for every account (see
// schema.sql), so there's nothing to initialize beyond the flag and name.
on(
  'POST',
  '/api/account/upgrade-to-business',
  requireAuth(async (req, res, params, query, body, user) => {
    if (user.is_business) return badRequest(res, 'This account is already a business account.');
    const businessName = (body.businessName || '').trim().slice(0, 80) || user.username;
    await db.prepare('UPDATE users SET is_business = 1, business_name = ? WHERE id = ?').run(businessName, user.id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

// Same idea as upgrading to a business account right above, but for
// delivering dropshipping orders instead of running a storefront — see the
// "dropshipping" and "courier" sections further down. Nothing to name or
// configure: courier_gyd_balance already defaults to 0, so there's just
// the one flag to flip.
on(
  'POST',
  '/api/account/upgrade-to-courier',
  requireAuth(async (req, res, params, query, body, user) => {
    if (user.is_courier) return badRequest(res, 'This account is already a courier account.');
    await db.prepare('UPDATE users SET is_courier = true WHERE id = ?').run(user.id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, { user: publicUser(updated) });
  })
);

on(
  'GET',
  '/api/me',
  requireAuth(async (req, res, params, query, body, user) => {
    sendJson(res, 200, { user: publicUser(user) });
  })
);

on(
  'POST',
  '/api/me/paytag',
  requireAuth(async (req, res, params, query, body, user) => {
    const raw = (body.paytag || '').trim().replace(/^\$/, '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(raw)) {
      return badRequest(res, '$Paytag must be 3-20 letters, numbers, or underscores.');
    }
    const existing = await db.prepare('SELECT id FROM users WHERE LOWER(paytag) = LOWER(?) AND id != ?').get(raw, user.id);
    if (existing) return badRequest(res, 'That $paytag is already taken.');
    await db.prepare('UPDATE users SET paytag = ? WHERE id = ?').run(raw, user.id);
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
        .prepare('SELECT id, username, paytag, is_business, business_name FROM users WHERE (username LIKE ? OR paytag LIKE ?) AND id != ? LIMIT 20')
        .all(`%${q}%`, `%${q}%`, user.id);
    } else {
      rows = await db
        .prepare('SELECT id, username, paytag, is_business, business_name FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 20')
        .all(user.id);
    }
    sendJson(res, 200, {
      users: rows.map((r) => ({ id: r.id, username: r.username, paytag: r.paytag, isBusiness: !!r.is_business, businessName: r.business_name })),
    });
  })
);

on(
  'GET',
  '/api/users/:username',
  requireAuth(async (req, res, params) => {
    // Despite the route's :username param name (kept stable for callers),
    // this accepts either a username or a $paytag — see findUserByHandle.
    const other = await findUserByHandle(params.username);
    if (!other) return sendJson(res, 404, { error: 'No user with that username or $paytag.' });
    sendJson(res, 200, { id: other.id, username: other.username, paytag: other.paytag, isBusiness: !!other.is_business, businessName: other.business_name });
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
    // toUsername accepts either a username or a $paytag (with or without
    // the leading $) — see findUserByHandle.
    const { memo } = body;
    const toHandle = body.toUsername || body.to;
    const amount = Number(body.amount);
    if (!toHandle) return badRequest(res, 'Choose who to send to.');
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    const recipient = await findUserByHandle(toHandle);
    if (!recipient) return badRequest(res, 'No user with that username or $paytag.');
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

    // With real SMS delivery configured (see sms.js), text the reference
    // code straight to the recipient instead of leaving the sender to
    // relay it by hand — see "Setting up real SMS delivery" in README.md
    // for how to turn this on. Never blocks the transfer itself: if the
    // text fails to send for any reason, the transfer still went through
    // and the sender can still share the code themselves (the UI shows
    // that instruction either way).
    let smsSent = false;
    if (smsEnabled()) {
      const result = await sendSms(
        recipientPhone,
        `${user.username} sent you GYD ${fmtNum(amount)} via GYD Direct. Your reference code is ${referenceCode}. Enter it, with your name exactly as "${recipientName}", under "Receive money" in the GYD Wallet app to collect it.`
      );
      smsSent = result.sent;
    }

    const row = await db.prepare('SELECT * FROM remittances WHERE id = ?').get(id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 201, { remittance: { ...remittancePublic(row), smsSent }, user: publicUser(updated) });
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

// ---------- request money (pay/request) ----------
//
// The pay/request panel lets you either pay someone or request money from
// them; this is the request half. Unlike GYD Direct above, this only ever
// moves money between two existing accounts — from_user is the person
// asking to be paid, to_user is the person being asked to pay, and paying
// it is just a transfer gated behind the payer's approval instead of
// happening instantly.

function moneyRequestPublicIncoming(r) {
  return {
    id: r.id,
    fromUsername: r.from_username,
    fromPaytag: r.from_paytag,
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
    toPaytag: r.to_paytag,
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
    if (!toHandle) return badRequest(res, "Enter a username or $paytag to request from.");
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount to request.');
    const payer = await findUserByHandle(toHandle);
    if (!payer) return badRequest(res, 'No user with that username or $paytag.');
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
        `SELECT r.*, u.username AS from_username, u.paytag AS from_paytag
         FROM money_requests r JOIN users u ON u.id = r.from_user
         WHERE r.to_user = ? ORDER BY r.created_at DESC LIMIT 50`
      )
      .all(user.id);
    const outgoing = await db
      .prepare(
        `SELECT r.*, u.username AS to_username, u.paytag AS to_paytag
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

// Fixed set a business page's dietary_tags column is restricted to — kept
// short and Guyana-relevant (halal in particular) so it stays a meaningful
// filter facet in the directory rather than freeform text search would
// already cover via keywords.
const ALLOWED_DIETARY_TAGS = ['vegan', 'vegetarian', 'gluten-free', 'halal', 'kosher', 'dairy-free', 'nut-free'];

function businessProfilePublic(row) {
  return {
    // business_profiles.user_id (its primary key, always present since
    // every join that builds one of these rows includes bp.*).
    userId: row.user_id,
    username: row.username,
    paytag: row.paytag,
    businessName: row.business_name,
    category: row.category,
    tagline: row.tagline,
    description: row.description,
    keywords: (row.keywords || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    dietaryTags: (row.dietary_tags || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    themeColor: row.theme_color,
    logoEmoji: row.logo_emoji,
    phone: row.phone,
    location: row.location,
    website: row.website || null,
    hours: row.hours || null,
    offersDelivery: !!row.offers_delivery,
    deliveryFee: row.delivery_fee || 0,
    // The first photo in the gallery (see /api/business/photos below) —
    // cheap to include everywhere via a correlated subquery so directory
    // cards get a cover image without a second round trip per business.
    coverPhotoUrl: row.cover_photo_url || null,
    updatedAt: row.updated_at,
    // Always 'approved' now — the staff review gate this used to reflect
    // was removed, but the field stays for compatibility with anything
    // still reading it.
    reviewStatus: row.review_status || 'approved',
    avgRating: row.avg_rating != null ? Math.round(Number(row.avg_rating) * 10) / 10 : null,
    reviewCount: row.review_count != null ? Number(row.review_count) : 0,
  };
}

on(
  'GET',
  '/api/business/profile',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db
      .prepare(
        `SELECT u.*, bp.*,
           (SELECT AVG(rating) FROM business_reviews br WHERE br.business_id = u.id) AS avg_rating,
           (SELECT COUNT(*) FROM business_reviews br WHERE br.business_id = u.id) AS review_count,
           (SELECT url FROM business_photos bph WHERE bph.business_id = u.id ORDER BY bph.created_at ASC LIMIT 1) AS cover_photo_url
         FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?`
      )
      .get(user.id);
    if (!row) return sendJson(res, 200, { profile: null, photos: [] });
    const photos = await db.prepare('SELECT * FROM business_photos WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 200, { profile: businessProfilePublic(row), photos: photos.map(businessPhotoPublic) });
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
    // Accepts either an array (checkboxes on the frontend) or a
    // comma-separated string, and silently drops anything not on the
    // allow-list rather than rejecting the save over it.
    const dietaryTagsInput = Array.isArray(body.dietaryTags)
      ? body.dietaryTags
      : (body.dietaryTags || '').split(',');
    const dietaryTags = dietaryTagsInput
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => ALLOWED_DIETARY_TAGS.includes(t))
      .join(',');
    const themeColor = /^#[0-9a-fA-F]{6}$/.test(body.themeColor || '') ? body.themeColor : '#4954e6';
    const logoEmoji = (body.logoEmoji || '').trim().slice(0, 8);
    const phone = (body.phone || '').trim().slice(0, 40);
    const location = (body.location || '').trim().slice(0, 140);
    let website = (body.website || '').trim().slice(0, 200);
    if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
    const hours = (body.hours || '').trim().slice(0, 200);
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
      // An edit to an already-reviewed page never resets its review_status
      // — only a brand new page (the branch below) starts out 'pending', so
      // a business that's already approved isn't yanked out of the
      // directory just for touching up their tagline or hours.
      await db.prepare(
        `UPDATE business_profiles
         SET category = ?, tagline = ?, description = ?, keywords = ?, dietary_tags = ?, theme_color = ?, logo_emoji = ?, phone = ?, location = ?, website = ?, hours = ?, offers_delivery = ?, delivery_fee = ?, updated_at = ?
         WHERE user_id = ?`
      ).run(category, tagline, description, keywords, dietaryTags, themeColor, logoEmoji, phone, location, website || null, hours || null, offersDelivery, deliveryFee, now(), user.id);
    } else {
      // A brand new business page goes live in the directory immediately —
      // no staff approval step.
      await db.prepare(
        `INSERT INTO business_profiles (user_id, category, tagline, description, keywords, dietary_tags, theme_color, logo_emoji, phone, location, website, hours, offers_delivery, delivery_fee, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(user.id, category, tagline, description, keywords, dietaryTags, themeColor, logoEmoji, phone, location, website || null, hours || null, offersDelivery, deliveryFee, now());
    }

    const row = await db
      .prepare(
        `SELECT u.*, bp.*,
           (SELECT AVG(rating) FROM business_reviews br WHERE br.business_id = u.id) AS avg_rating,
           (SELECT COUNT(*) FROM business_reviews br WHERE br.business_id = u.id) AS review_count,
           (SELECT url FROM business_photos bph WHERE bph.business_id = u.id ORDER BY bph.created_at ASC LIMIT 1) AS cover_photo_url
         FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?`
      )
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
    const dietary = (query.dietary || '').trim().toLowerCase();
    let sql = `SELECT u.*, bp.*,
      (SELECT AVG(rating) FROM business_reviews br WHERE br.business_id = u.id) AS avg_rating,
      (SELECT COUNT(*) FROM business_reviews br WHERE br.business_id = u.id) AS review_count,
      (SELECT url FROM business_photos bph WHERE bph.business_id = u.id ORDER BY bph.created_at ASC LIMIT 1) AS cover_photo_url
      FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.review_status = 'approved'`;
    const args = [];
    if (category) {
      sql += ' AND bp.category = ?';
      args.push(category);
    }
    if (dietary && ALLOWED_DIETARY_TAGS.includes(dietary)) {
      // Wrapped in commas so "vegan" doesn't match as a substring of some
      // other tag — with today's allow-list that can't happen, but it keeps
      // this correct if a future tag name overlaps with another.
      sql += " AND (',' || bp.dietary_tags || ',') LIKE ?";
      args.push(`%,${dietary},%`);
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
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    const row = await db
      .prepare(
        `SELECT u.*, bp.*,
           (SELECT AVG(rating) FROM business_reviews br WHERE br.business_id = u.id) AS avg_rating,
           (SELECT COUNT(*) FROM business_reviews br WHERE br.business_id = u.id) AS review_count,
           (SELECT url FROM business_photos bph WHERE bph.business_id = u.id ORDER BY bph.created_at ASC LIMIT 1) AS cover_photo_url
         FROM business_profiles bp JOIN users u ON u.id = bp.user_id WHERE bp.user_id = ?`
      )
      .get(bizUser.id);
    if (!row) return sendJson(res, 404, { error: 'This business has not set up their page yet.' });
    const photos = await db
      .prepare('SELECT * FROM business_photos WHERE business_id = ? ORDER BY created_at ASC')
      .all(bizUser.id);
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
    const reviews = await db
      .prepare(
        `SELECT r.*, u.username FROM business_reviews r JOIN users u ON u.id = r.reviewer_id
         WHERE r.business_id = ? ORDER BY r.created_at DESC LIMIT 200`
      )
      .all(bizUser.id);
    const myReviewRow = reviews.find((r) => r.reviewer_id === user.id);
    const tips = await db
      .prepare(
        `SELECT t.*, u.username FROM business_tips t JOIN users u ON u.id = t.user_id
         WHERE t.business_id = ? ORDER BY t.created_at DESC LIMIT 200`
      )
      .all(bizUser.id);
    const myTipRow = tips.find((t) => t.user_id === user.id);
    sendJson(res, 200, {
      business: {
        ...businessProfilePublic(row),
        photos: photos.map(businessPhotoPublic),
        products: products.map(businessProductPublic),
        events: eventsPublic,
        jobs: jobs.map((j) => jobPostingPublic(j)),
        reviews: reviews.map(businessReviewPublic),
        myReview: myReviewRow ? businessReviewPublic(myReviewRow) : null,
        tips: tips.map(businessTipPublic),
        myTip: myTipRow ? businessTipPublic(myTipRow) : null,
        isOwnBusiness: bizUser.id === user.id,
      },
    });
  })
);

// ---------- business photo gallery ----------
//
// Unlike a product photo (a base64 data: URL stored right in the row — see
// business_products above), gallery photos go into a real Supabase Storage
// bucket (see db.js's storageUpload/storageDelete) since a business can
// have up to MAX_BUSINESS_PHOTOS of these: storing them as data: URLs would
// make every profile/directory query drag that much base64 text along.

const MAX_BUSINESS_PHOTOS = 20;

function businessPhotoPublic(row) {
  return { id: row.id, url: row.url, createdAt: row.created_at };
}

// Same idea as validateProductImage above, just with a bigger size cap
// since this is the main photo gallery rather than a small product thumb —
// still well under readJsonBody's 3MB body cap once base64-encoded.
function validateBusinessPhoto(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('data:image/')) {
    return { ok: false, error: 'Choose a photo to upload.' };
  }
  if (raw.length > 2_200_000) {
    return { ok: false, error: 'That photo is too large — try a smaller one.' };
  }
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(raw);
  if (!match) {
    return { ok: false, error: 'Business photo must be a JPEG, PNG, or WEBP image.' };
  }
  return { ok: true, mime: `image/${match[1]}`, ext: match[1] === 'jpeg' ? 'jpg' : match[1], base64: match[2] };
}

on(
  'GET',
  '/api/business/photos',
  requireBusiness(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM business_photos WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 200, { photos: rows.map(businessPhotoPublic) });
  })
);

on(
  'POST',
  '/api/business/photos',
  requireBusiness(async (req, res, params, query, body, user) => {
    const validated = validateBusinessPhoto(body.imageData);
    if (!validated.ok) return badRequest(res, validated.error);
    const countRow = await db.prepare('SELECT COUNT(*) as n FROM business_photos WHERE business_id = ?').get(user.id);
    if (Number(countRow.n) >= MAX_BUSINESS_PHOTOS) {
      return badRequest(res, `You've reached the ${MAX_BUSINESS_PHOTOS}-photo limit — remove one to add another.`);
    }
    const id = crypto.randomUUID();
    const storagePath = `${user.id}/${id}.${validated.ext}`;
    let url;
    try {
      url = await db.storageUpload('business-photos', storagePath, Buffer.from(validated.base64, 'base64'), validated.mime);
    } catch (err) {
      return sendJson(res, 502, { error: `Could not upload that photo: ${err.message}` });
    }
    await db.prepare(
      'INSERT INTO business_photos (id, business_id, url, storage_path, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, user.id, url, storagePath, now());
    const rows = await db.prepare('SELECT * FROM business_photos WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 201, { photos: rows.map(businessPhotoPublic) });
  })
);

on(
  'DELETE',
  '/api/business/photos/:id',
  requireBusiness(async (req, res, params, query, body, user) => {
    const row = await db.prepare('SELECT * FROM business_photos WHERE id = ?').get(params.id);
    if (!row) return sendJson(res, 404, { error: 'Photo not found.' });
    if (row.business_id !== user.id) return sendJson(res, 403, { error: 'This photo is not yours to remove.' });
    await db.storageDelete('business-photos', row.storage_path);
    await db.prepare('DELETE FROM business_photos WHERE id = ?').run(params.id);
    const rows = await db.prepare('SELECT * FROM business_photos WHERE business_id = ? ORDER BY created_at ASC').all(user.id);
    sendJson(res, 200, { photos: rows.map(businessPhotoPublic) });
  })
);

// A customer's star rating (1-5) and optional comment on a business's page
// — see business_reviews in schema.sql. One review per (business, customer)
// pair: submitting again updates the existing row (an upsert) rather than
// adding a second one, so a business's average can't be padded by the same
// person rating it repeatedly.
function businessReviewPublic(row) {
  return {
    id: row.id,
    reviewerUsername: row.username,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

on(
  'POST',
  '/api/business/directory/:handle/review',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    if (bizUser.id === user.id) return badRequest(res, "You can't rate your own business.");
    const rating = Math.round(Number(body.rating));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return badRequest(res, 'Choose a rating from 1 to 5 stars.');
    }
    const comment = (body.comment || '').trim().slice(0, 1000);
    const profile = await db.prepare('SELECT user_id FROM business_profiles WHERE user_id = ?').get(bizUser.id);
    if (!profile) return badRequest(res, "This business hasn't set up their page yet.");

    const existing = await db
      .prepare('SELECT id FROM business_reviews WHERE business_id = ? AND reviewer_id = ?')
      .get(bizUser.id, user.id);
    if (existing) {
      await db.prepare(
        `UPDATE business_reviews SET rating = ?, comment = ?, updated_at = ? WHERE id = ?`
      ).run(rating, comment || null, now(), existing.id);
    } else {
      await db.prepare(
        `INSERT INTO business_reviews (id, business_id, reviewer_id, rating, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), bizUser.id, user.id, rating, comment || null, now(), now());
    }

    const row = await db
      .prepare('SELECT r.*, u.username FROM business_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.business_id = ? AND r.reviewer_id = ?')
      .get(bizUser.id, user.id);
    sendJson(res, 200, { review: businessReviewPublic(row) });
  })
);

on(
  'DELETE',
  '/api/business/directory/:handle/review',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    await db.prepare('DELETE FROM business_reviews WHERE business_id = ? AND reviewer_id = ?').run(bizUser.id, user.id);
    sendJson(res, 200, { ok: true });
  })
);

// A business removing a specific review from its own page — distinct from
// the route above, which is a customer removing their own. No staff ticket
// involved (unlike reportReview below): the business owner can take this
// down immediately, at the cost of a customer's honest bad review being
// just as easy to erase as spam. That trade-off was a deliberate choice,
// not an oversight — see the conversation that added this route.
on(
  'DELETE',
  '/api/business/directory/:handle/reviews/:reviewId',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    if (bizUser.id !== user.id) return sendJson(res, 403, { error: 'Only this business can remove a review from its own page.' });
    await db.prepare('DELETE FROM business_reviews WHERE id = ? AND business_id = ?').run(params.reviewId, bizUser.id);
    sendJson(res, 200, { ok: true });
  })
);

// Reporting a review someone thinks is spam, abusive, or fake. This
// doesn't hide or delete anything by itself — it just opens a normal
// support ticket (same queue and UI staff already use for everything
// else) with the review's details attached, including a machine-readable
// "Review ID:" line the staff portal looks for to offer a one-click
// "Remove this review" button (see /api/staff/reviews/:id below and
// renderTickets in staff.js). Keeping this as a ticket rather than an
// auto-hide means a report can't be used to yank a business's honest bad
// review off their own page just by someone clicking a button.
on(
  'POST',
  '/api/business/directory/:handle/reviews/:reviewId/report',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    const review = await db
      .prepare('SELECT r.*, u.username AS reviewer_username FROM business_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.id = ? AND r.business_id = ?')
      .get(params.reviewId, bizUser.id);
    if (!review) return sendJson(res, 404, { error: 'That review no longer exists.' });

    const ipKey = `report-review-ip:${getClientIp(req)}`;
    const ipBucket = rateLimitPeek(ipKey);
    if (ipBucket.count >= 10) {
      return sendJson(res, 429, { error: `Too many reports. Try again in ${retryAfterMinutes(ipBucket)} minute(s).` });
    }
    rateLimitRecord(ipKey, 15 * 60 * 1000);

    const reason = (body.reason || '').trim().slice(0, 500);
    const message =
      `A review was reported on ${bizUser.username}'s business page.\n\n` +
      `Reviewer: @${review.reviewer_username}\n` +
      `Rating: ${review.rating} star(s)\n` +
      `Comment: ${review.comment || '(no comment)'}\n` +
      (reason ? `Reporter's reason: ${reason}\n` : '') +
      `\nReview ID: ${review.id}`;

    await db.prepare(
      `INSERT INTO support_tickets (id, user_id, name, email, subject, message, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
    ).run(crypto.randomUUID(), user.id, user.username, user.email || null, `Reported review on ${bizUser.username}`, message, now());

    sendJson(res, 200, { ok: true });
  })
);

// A short, Foursquare-style tip ("ask for the corner table", "cash only")
// — see business_tips in schema.sql. One tip per (business, customer) pair,
// same upsert-on-resubmit pattern as business_reviews above, so it stays a
// single running note rather than a feed a person can flood.
function businessTipPublic(row) {
  return {
    id: row.id,
    username: row.username,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

on(
  'POST',
  '/api/business/directory/:handle/tips',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    if (bizUser.id === user.id) return badRequest(res, "You can't leave a tip on your own business.");
    const text = (body.text || '').trim().slice(0, 300);
    if (!text) return badRequest(res, 'Write a tip before saving.');
    const profile = await db.prepare('SELECT user_id FROM business_profiles WHERE user_id = ?').get(bizUser.id);
    if (!profile) return badRequest(res, "This business hasn't set up their page yet.");

    const existing = await db
      .prepare('SELECT id FROM business_tips WHERE business_id = ? AND user_id = ?')
      .get(bizUser.id, user.id);
    if (existing) {
      await db.prepare(`UPDATE business_tips SET text = ?, updated_at = ? WHERE id = ?`).run(text, now(), existing.id);
    } else {
      await db.prepare(
        `INSERT INTO business_tips (id, business_id, user_id, text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), bizUser.id, user.id, text, now(), now());
    }

    const row = await db
      .prepare('SELECT t.*, u.username FROM business_tips t JOIN users u ON u.id = t.user_id WHERE t.business_id = ? AND t.user_id = ?')
      .get(bizUser.id, user.id);
    sendJson(res, 200, { tip: businessTipPublic(row) });
  })
);

on(
  'DELETE',
  '/api/business/directory/:handle/tips',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    await db.prepare('DELETE FROM business_tips WHERE business_id = ? AND user_id = ?').run(bizUser.id, user.id);
    sendJson(res, 200, { ok: true });
  })
);

// A business removing a specific tip from its own page — same instant,
// no-staff-ticket removal as the review route above, and the same
// trade-off: quick to clear spam, just as quick to erase a fair complaint.
on(
  'DELETE',
  '/api/business/directory/:handle/tips/:tipId',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(params.handle);
    if (!bizUser || !bizUser.is_business) return sendJson(res, 404, { error: 'No business with that username or $paytag.' });
    if (bizUser.id !== user.id) return sendJson(res, 403, { error: 'Only this business can remove a tip from its own page.' });
    await db.prepare('DELETE FROM business_tips WHERE id = ? AND business_id = ?').run(params.tipId, bizUser.id);
    sendJson(res, 200, { ok: true });
  })
);

// ---------- business products & prices ----------
//
// A simple price list attached to a business's page — not tied to payments
// (paying still just moves GYD to a business by username/$paytag/QR/charge
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

// Guyana's 10 administrative regions, for filtering the jobs board — same
// fixed allow-list pattern as ALLOWED_DIETARY_TAGS above.
const GUYANA_REGIONS = [
  { value: 'barima-waini', label: 'Region 1 — Barima-Waini' },
  { value: 'pomeroon-supenaam', label: 'Region 2 — Pomeroon-Supenaam' },
  { value: 'essequibo-islands-wd', label: 'Region 3 — Essequibo Islands-West Demerara' },
  { value: 'demerara-mahaica', label: 'Region 4 — Demerara-Mahaica' },
  { value: 'mahaica-berbice', label: 'Region 5 — Mahaica-Berbice' },
  { value: 'east-berbice-corentyne', label: 'Region 6 — East Berbice-Corentyne' },
  { value: 'cuyuni-mazaruni', label: 'Region 7 — Cuyuni-Mazaruni' },
  { value: 'potaro-siparuni', label: 'Region 8 — Potaro-Siparuni' },
  { value: 'upper-takutu-upper-essequibo', label: 'Region 9 — Upper Takutu-Upper Essequibo' },
  { value: 'upper-demerara-berbice', label: 'Region 10 — Upper Demerara-Berbice' },
];
const GUYANA_REGION_VALUES = GUYANA_REGIONS.map((r) => r.value);

function jobPostingPublic(row, extra) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    payInfo: row.pay_info,
    jobType: row.job_type,
    region: row.region || null,
    status: row.status,
    createdAt: row.created_at,
    // Always 'approved' now — see the same field on businessProfilePublic
    // above for why it's still here.
    reviewStatus: row.review_status || 'approved',
    business: extra && extra.username
      ? {
          username: extra.username,
          name: extra.business_name || extra.username,
          logoEmoji: extra.logo_emoji || null,
          themeColor: extra.theme_color || null,
        }
      : undefined,
    isSaved: extra ? !!extra.is_saved : false,
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
    const region = GUYANA_REGION_VALUES.includes(body.region) ? body.region : null;

    if (!title) return badRequest(res, 'Give the job a title.');
    if (!description) return badRequest(res, 'Add a short description of the job.');

    // Goes live on the public /api/jobs board immediately — no staff
    // approval step.
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO job_postings (id, business_id, title, description, location, pay_info, job_type, region, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(id, user.id, title, description, location || null, payInfo || null, jobType, region, now());

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
  requireAuth(async (req, res, params, query, body, user) => {
    const q = (query.q || '').trim();
    const jobType = (query.jobType || '').trim();
    const region = (query.region || '').trim();
    let sql = `SELECT j.*, u.username, u.business_name, bp.logo_emoji, bp.theme_color,
      (SELECT 1 FROM saved_jobs sj WHERE sj.job_id = j.id AND sj.user_id = ?) AS is_saved
      FROM job_postings j
      JOIN users u ON u.id = j.business_id
      LEFT JOIN business_profiles bp ON bp.user_id = j.business_id
      WHERE j.status = 'active' AND j.review_status = 'approved'`;
    const args = [user.id];
    if (jobType) {
      sql += ' AND j.job_type = ?';
      args.push(jobType);
    }
    if (region && GUYANA_REGION_VALUES.includes(region)) {
      sql += ' AND j.region = ?';
      args.push(region);
    }
    if (q) {
      sql += ' AND (j.title LIKE ? OR j.description LIKE ? OR j.location LIKE ?)';
      const like = `%${q}%`;
      args.push(like, like, like);
    }
    sql += ' ORDER BY j.created_at DESC LIMIT 100';
    const rows = await db.prepare(sql).all(...args);
    sendJson(res, 200, {
      jobs: rows.map((r) =>
        jobPostingPublic(r, {
          username: r.username,
          business_name: r.business_name,
          logo_emoji: r.logo_emoji,
          theme_color: r.theme_color,
          is_saved: r.is_saved,
        })
      ),
      jobTypes: JOB_TYPES,
      regions: GUYANA_REGIONS,
    });
  })
);

// Bookmarking a job on the jobs board — see saved_jobs in schema.sql.
// Toggled from the ☆ button on each job card; purely personal, doesn't
// notify the business.
on(
  'POST',
  '/api/jobs/:id/save',
  requireAuth(async (req, res, params, query, body, user) => {
    const job = await db.prepare('SELECT id FROM job_postings WHERE id = ?').get(params.id);
    if (!job) return sendJson(res, 404, { error: 'This job posting no longer exists.' });
    const existing = await db.prepare('SELECT id FROM saved_jobs WHERE user_id = ? AND job_id = ?').get(user.id, params.id);
    if (!existing) {
      await db.prepare('INSERT INTO saved_jobs (id, user_id, job_id, created_at) VALUES (?, ?, ?, ?)').run(
        crypto.randomUUID(),
        user.id,
        params.id,
        now()
      );
    }
    sendJson(res, 200, { ok: true, saved: true });
  })
);

on(
  'DELETE',
  '/api/jobs/:id/save',
  requireAuth(async (req, res, params, query, body, user) => {
    await db.prepare('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?').run(user.id, params.id);
    sendJson(res, 200, { ok: true, saved: false });
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
//
// Delivery still pays the business instantly (nothing to redeem in person).
// Pickup instead HOLDS the money — see the business_orders section right
// below — since a delivery has no "come show your code" moment but a
// pickup does.

on(
  'POST',
  '/api/business/checkout',
  requireAuth(async (req, res, params, query, body, user) => {
    const bizUser = await findUserByHandle(body.businessHandle || '');
    if (!bizUser || !bizUser.is_business) return badRequest(res, 'No business with that username or $paytag.');
    if (bizUser.id === user.id) return badRequest(res, "You can't check out with your own business.");

    const profileRow = await db.prepare('SELECT * FROM business_profiles WHERE user_id = ?').get(bizUser.id);

    // Checking out from the product cart (tap products, they add up) sends
    // { productId, quantity } pairs rather than a typed-in amount. When
    // that's present, the total is always computed here from this
    // business's own stored prices — never trusted from the client — so a
    // tampered request can't check out for less than the real menu price.
    // The plain "type an amount and pay" flow (tips, custom quotes, a
    // business with no product catalog) still works exactly as before when
    // no items are sent.
    let amount;
    let resolvedItems = null;
    if (Array.isArray(body.items) && body.items.length > 0) {
      const productRows = await db.prepare('SELECT * FROM business_products WHERE business_id = ?').all(bizUser.id);
      const productsById = new Map(productRows.map((p) => [p.id, p]));
      resolvedItems = [];
      for (const entry of body.items) {
        const product = productsById.get(entry.productId);
        if (!product) return badRequest(res, 'One of the items in your cart is no longer available — please review your order.');
        const quantity = Math.floor(Number(entry.quantity));
        if (!Number.isFinite(quantity) || quantity < 1) return badRequest(res, 'Invalid quantity in your cart.');
        resolvedItems.push({ productId: product.id, name: product.name, price: product.price, quantity });
      }
      amount = Math.round(resolvedItems.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100) / 100;
    } else {
      amount = Number(body.amount);
    }
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

    const itemsSummary = resolvedItems ? resolvedItems.map((i) => `${i.quantity}x ${i.name}`).join(', ') : '';

    if (wantsDelivery) {
      const newBalance = await db.atomicTransfer(user.id, total, bizUser.id, true);
      if (newBalance === null) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(total)}.`);
      await logTx({
        type: 'business_payment', fromUser: user.id, toUser: bizUser.id, amount: total, currency: 'GYD',
        note: `Delivery to ${deliveryAddress} (delivery fee GYD ${fmtNum(deliveryFee)})`
          + (itemsSummary ? ` — ${itemsSummary}` : ''),
      });
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return sendJson(res, 200, { user: publicUser(updated), total, fulfillment: 'delivery', deliveryFee, items: resolvedItems });
    }

    // Pickup: debit the customer now (same as a real charge) but hold the
    // money in a pending business_orders row rather than crediting the
    // business — see releasePendingOrder/refundPendingOrder below for what
    // moves it from there. One atomic statement so the debit and the order
    // row are created together or not at all, same "debit + conditional
    // insert" idiom as generateReferenceCode's caller (/api/remit) above.
    const orderId = crypto.randomUUID();
    const pickupCode = await generatePickupCode();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + PICKUP_HOLD_HOURS * 3600 * 1000).toISOString();
    const itemsJson = resolvedItems ? JSON.stringify(resolvedItems) : null;
    const rows = await db.raw(
      `WITH debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1 WHERE id = $2 AND gyd_balance >= $1 RETURNING gyd_balance
       ), ins AS (
         INSERT INTO business_orders (id, business_id, customer_id, amount, pickup_code, status, created_at, expires_at, items)
         SELECT $3, $4, $2, $1, $5, 'pending', $6, $7, $8 WHERE EXISTS (SELECT 1 FROM debit)
       )
       SELECT gyd_balance FROM debit`,
      [total, user.id, orderId, bizUser.id, pickupCode, createdAt, expiresAt, itemsJson]
    );
    if (rows.length === 0) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(total)}.`);

    await logTx({
      type: 'business_order_hold', fromUser: user.id, toUser: null, amount: total, currency: 'GYD', status: 'pending',
      note: `Pickup order ${pickupCode} — held until pickup or ${PICKUP_HOLD_HOURS}h`
        + (itemsSummary ? ` — ${itemsSummary}` : ''),
    });

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    sendJson(res, 200, {
      user: publicUser(updated),
      total,
      fulfillment: 'pickup',
      items: resolvedItems,
      deliveryFee: 0,
      order: {
        id: orderId, pickupCode, amount: total, status: 'pending', releaseReason: null,
        createdAt, expiresAt, resolvedAt: null,
        businessUsername: bizUser.username, businessName: bizUser.business_name,
      },
    });
  })
);

// ---------- pickup orders (hold-until-pickup escrow) ----------
//
// A pickup order's money is debited from the customer at checkout (above)
// but held rather than paid to the business right away. It's released one
// of three ways: the business redeems the customer's pickup code in person
// (releasePendingOrder, reason 'redeemed'); nobody redeems it and the
// PICKUP_HOLD_HOURS window passes, so it releases automatically the next
// time anyone looks at it (autoReleaseExpiredFor* below, reason
// 'auto_released' — there's no background worker in this app, so "the next
// time anyone looks at it" is how the 24-hour deadline actually gets
// enforced, same zero-infrastructure approach as everything else here); or
// either side cancels it first for a full refund (refundPendingOrder).

const PICKUP_HOLD_HOURS = 24;

function businessOrderPublic(row) {
  let items = null;
  if (row.items) {
    try {
      items = JSON.parse(row.items);
    } catch (e) {
      items = null;
    }
  }
  return {
    id: row.id,
    pickupCode: row.pickup_code,
    amount: row.amount,
    status: row.status,
    releaseReason: row.release_reason || null,
    lockedByBusiness: !!row.locked_by_business,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at || null,
    businessUsername: row.business_username || undefined,
    businessName: row.business_display_name || undefined,
    customerUsername: row.customer_username || undefined,
    items,
  };
}

// Same idea as generateTicketCode/generateReferenceCode above — a short,
// unique, human-typeable code. Hex like a ticket code (rather than numeric
// like a GYD Direct reference code) since this one's read off a customer's
// screen at a counter rather than read aloud over the phone.
async function generatePickupCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const existing = await db.prepare('SELECT id FROM business_orders WHERE pickup_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique pickup code');
}

// Credits the business's wallet with the held amount and marks the order
// completed. The `claim` UPDATE's own WHERE (id = ? AND status = 'pending')
// is the atomic guard — same idiom as atomicTransfer's `WHERE gyd_balance >=
// ?` — so if two release attempts land at once (a cashier redeeming the
// instant the 24-hour hold expires) only one can ever flip status and thus
// only one credits the business. Returns false if the order wasn't pending.
async function releasePendingOrder(orderId, reason) {
  const rows = await db.raw(
    `WITH claim AS (
       UPDATE business_orders SET status = 'completed', release_reason = $2, resolved_at = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING business_id, customer_id, amount, pickup_code
     ), credit AS (
       UPDATE users SET business_gyd_balance = business_gyd_balance + (SELECT amount FROM claim)
       WHERE id = (SELECT business_id FROM claim) AND EXISTS (SELECT 1 FROM claim)
       RETURNING id
     )
     SELECT business_id, customer_id, amount, pickup_code FROM claim`,
    [orderId, reason, now()]
  );
  if (rows.length === 0) return false;
  const { business_id, customer_id, amount, pickup_code } = rows[0];
  await logTx({
    type: 'business_payment', fromUser: customer_id, toUser: business_id, amount, currency: 'GYD',
    note: reason === 'redeemed'
      ? `Pickup order ${pickup_code} redeemed at the store`
      : `Pickup order ${pickup_code} auto-released after ${PICKUP_HOLD_HOURS}h — never redeemed`,
  });
  return true;
}

// The escape hatch for either side: refunds the customer in full and marks
// the order cancelled. Same atomic-claim guard as releasePendingOrder.
async function refundPendingOrder(orderId, reason) {
  const rows = await db.raw(
    `WITH claim AS (
       UPDATE business_orders SET status = 'cancelled', release_reason = $2, resolved_at = $3
       WHERE id = $1 AND status = 'pending'
       RETURNING customer_id, amount, pickup_code
     ), refund AS (
       UPDATE users SET gyd_balance = gyd_balance + (SELECT amount FROM claim)
       WHERE id = (SELECT customer_id FROM claim) AND EXISTS (SELECT 1 FROM claim)
       RETURNING id
     )
     SELECT customer_id, amount, pickup_code FROM claim`,
    [orderId, reason, now()]
  );
  if (rows.length === 0) return false;
  const { customer_id, amount, pickup_code } = rows[0];
  await logTx({
    type: 'business_order_refund', fromUser: null, toUser: customer_id, amount, currency: 'GYD',
    note: reason === 'cancelled_by_business'
      ? `Pickup order ${pickup_code} cancelled by the business — refunded`
      : `Pickup order ${pickup_code} cancelled — refunded`,
  });
  return true;
}

// Called at the top of the two "list my orders" endpoints below so the
// 24-hour deadline gets enforced lazily, the moment either side next looks
// — see the section comment above for why there's no scheduled job doing
// this instead.
async function autoReleaseExpiredForBusiness(businessId) {
  const rows = await db.prepare(
    "SELECT id FROM business_orders WHERE business_id = ? AND status = 'pending' AND expires_at <= ?"
  ).all(businessId, now());
  for (const row of rows) await releasePendingOrder(row.id, 'auto_released');
}

async function autoReleaseExpiredForCustomer(customerId) {
  const rows = await db.prepare(
    "SELECT id FROM business_orders WHERE customer_id = ? AND status = 'pending' AND expires_at <= ?"
  ).all(customerId, now());
  for (const row of rows) await releasePendingOrder(row.id, 'auto_released');
}

on(
  'GET',
  '/api/orders/mine',
  requireAuth(async (req, res, params, query, body, user) => {
    await autoReleaseExpiredForCustomer(user.id);
    const rows = await db
      .prepare(
        `SELECT bo.*, u.username AS business_username, u.business_name AS business_display_name
         FROM business_orders bo JOIN users u ON u.id = bo.business_id
         WHERE bo.customer_id = ? ORDER BY bo.created_at DESC LIMIT 50`
      )
      .all(user.id);
    sendJson(res, 200, { orders: rows.map(businessOrderPublic) });
  })
);

on(
  'POST',
  '/api/orders/:id/cancel',
  requireAuth(async (req, res, params, query, body, user) => {
    const order = await db.prepare('SELECT * FROM business_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.customer_id !== user.id) return sendJson(res, 403, { error: "This order isn't yours to cancel." });
    if (order.status !== 'pending') return badRequest(res, 'This order is no longer pending.');
    if (order.locked_by_business) {
      return badRequest(res, 'The business has already started preparing this order — contact them directly if you need to cancel.');
    }
    const refunded = await refundPendingOrder(order.id, 'cancelled_by_customer');
    if (!refunded) return badRequest(res, 'This order was already resolved — try refreshing.');
    const updated = await db
      .prepare(
        `SELECT bo.*, u.username AS business_username, u.business_name AS business_display_name
         FROM business_orders bo JOIN users u ON u.id = bo.business_id WHERE bo.id = ?`
      )
      .get(order.id);
    sendJson(res, 200, { order: businessOrderPublic(updated) });
  })
);

on(
  'GET',
  '/api/business/orders',
  requireBusiness(async (req, res, params, query, body, user) => {
    await autoReleaseExpiredForBusiness(user.id);
    const rows = await db
      .prepare(
        `SELECT bo.*, u.username AS customer_username
         FROM business_orders bo JOIN users u ON u.id = bo.customer_id
         WHERE bo.business_id = ? AND bo.status = 'pending' ORDER BY bo.created_at ASC LIMIT 100`
      )
      .all(user.id);
    sendJson(res, 200, { orders: rows.map(businessOrderPublic) });
  })
);

on(
  'POST',
  '/api/business/orders/:code/redeem',
  requireBusiness(async (req, res, params, query, body, user) => {
    const code = (params.code || '').trim().toUpperCase();
    const order = await db.prepare('SELECT * FROM business_orders WHERE pickup_code = ?').get(code);
    if (!order) return badRequest(res, 'No pending order with that code.');
    if (order.business_id !== user.id) return sendJson(res, 403, { error: "This order isn't for your business." });

    if (order.status !== 'pending') {
      return sendJson(res, 200, {
        ok: false,
        reason: order.status === 'completed' ? 'already_completed' : 'cancelled',
        order: businessOrderPublic(order),
      });
    }

    const alreadyExpired = new Date(order.expires_at).getTime() <= Date.now();
    const released = await releasePendingOrder(order.id, alreadyExpired ? 'auto_released' : 'redeemed');
    const fresh = await db.prepare('SELECT * FROM business_orders WHERE id = ?').get(order.id);
    if (!released) {
      // Someone else (another tab, or the lazy auto-release check) resolved
      // it a moment ago — report the real current state rather than erroring.
      return sendJson(res, 200, {
        ok: false,
        reason: fresh.status === 'completed' ? 'already_completed' : 'cancelled',
        order: businessOrderPublic(fresh),
      });
    }
    sendJson(res, 200, { ok: true, alreadyExpired, order: businessOrderPublic(fresh) });
  })
);

on(
  'POST',
  '/api/business/orders/:id/cancel',
  requireBusiness(async (req, res, params, query, body, user) => {
    const order = await db.prepare('SELECT * FROM business_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.business_id !== user.id) return sendJson(res, 403, { error: "This order isn't yours to cancel." });
    if (order.status !== 'pending') return badRequest(res, 'This order is no longer pending.');
    const refunded = await refundPendingOrder(order.id, 'cancelled_by_business');
    if (!refunded) return badRequest(res, 'This order was already resolved — try refreshing.');
    const updated = await db
      .prepare(
        `SELECT bo.*, u.username AS customer_username
         FROM business_orders bo JOIN users u ON u.id = bo.customer_id WHERE bo.id = ?`
      )
      .get(order.id);
    sendJson(res, 200, { order: businessOrderPublic(updated) });
  })
);

// A business marks a pending order "being prepared" once they start on it —
// closes the gap where a store bakes/bags an order in advance of pickup,
// the customer cancels for a full refund before the code is ever redeemed,
// and the store is out whatever it already put into fulfilling it. Once
// locked, only the business can still cancel/refund it (see the lock check
// added to the customer's own cancel endpoint above); the business's own
// cancel endpoint above is intentionally unaffected by this lock. One-way —
// there's no unlock — since the point is "the store already committed to
// this," not a toggle.
on(
  'POST',
  '/api/business/orders/:id/lock',
  requireBusiness(async (req, res, params, query, body, user) => {
    const order = await db.prepare('SELECT * FROM business_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.business_id !== user.id) return sendJson(res, 403, { error: "This order isn't yours." });
    if (order.status !== 'pending') return badRequest(res, 'This order is no longer pending.');
    await db.prepare('UPDATE business_orders SET locked_by_business = TRUE WHERE id = ?').run(order.id);
    const updated = await db
      .prepare(
        `SELECT bo.*, u.username AS customer_username
         FROM business_orders bo JOIN users u ON u.id = bo.customer_id WHERE bo.id = ?`
      )
      .get(order.id);
    sendJson(res, 200, { order: businessOrderPublic(updated) });
  })
);

// ---------- dropshipping (CJdropshipping-sourced products) ----------
//
// A second, separate shop alongside the local business directory above:
// products sourced from CJdropshipping rather than a Guyanese business, so
// there's no local business_products row or business wallet to credit —
// the whole GYD amount the buyer pays just leaves the platform (covering
// what CJ is owed plus the platform's own cut), the same way a personal
// GYD Direct transfer's fee isn't credited to anyone's wallet either. See
// dropshipping.js for the actual CJ API calls and why they're unverified.
//
// The cart itself is client-side only — see app.js's `carts` object, reused
// here under its own key — exactly like the local-business product cart;
// a database row only gets created once someone actually pays (see
// dropshipping_orders in supabase/schema.sql).
//
// This whole feature is OFF by default: with no CJ_API_KEY/CJ_ACCOUNT_ID
// configured, the product list is simply always empty (nothing to sync)
// and checkout refuses outright, rather than taking someone's GYD for an
// order that could never actually be placed with CJ.

// No real exchange-rate API wired up yet — override with USD_TO_GYD_RATE
// if this needs to track the real rate more closely in the meantime; see
// README's "Setting up CJdropshipping" section. Only used at SYNC time now
// (see the sync endpoint below) — every price a customer actually sees or
// pays comes straight from the pinned dropshipping_products.price_gyd
// column, never recomputed from this rate on the fly, so browsing and
// checkout can never disagree on a price.
const USD_TO_GYD_RATE = Number(process.env.USD_TO_GYD_RATE) || 210;
// The platform's cut on a dropshipped order, added on top of cost (unlike
// EVENT_TICKET_FEE_RATE above, there's no local business to net it out of
// here) — shown to the buyer as a separate line at checkout, never hidden
// in the item price.
const DROPSHIP_FEE_RATE = 0.03;
// Flat local-delivery pricing — getting the order from the Guyana
// warehouse to the customer's door once it's landed, separate from CJ's
// own international shipping. Applies regardless of order size (one
// shipment, one delivery run) EXCEPT once the cart's total weight crosses
// the oversized-cargo threshold, which charges more since one bulky item
// costs more to actually deliver than a normal parcel would.
const DROPSHIP_STANDARD_DELIVERY_GYD = 500;
const DROPSHIP_OVERSIZE_DELIVERY_GYD = 1500;
const DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG = 5;

function dropshippingProductPublic(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    priceUsd: row.price_usd,
    priceGyd: row.price_gyd,
    weightKg: row.weight_kg,
    imageUrl: row.image_url || null,
    category: row.category || null,
    inStock: !!row.in_stock,
  };
}

function dropshippingOrderPublic(row) {
  let items = [];
  try {
    items = JSON.parse(row.items) || [];
  } catch (e) {
    items = [];
  }
  let shippingAddress = null;
  try {
    shippingAddress = JSON.parse(row.shipping_address);
  } catch (e) {
    shippingAddress = null;
  }
  return {
    id: row.id,
    status: row.status,
    items,
    totalUsd: row.total_usd,
    totalGyd: row.total_gyd,
    platformFeeGyd: row.platform_fee_gyd,
    deliveryFeeGyd: row.delivery_fee_gyd,
    totalWeightKg: row.total_weight_kg,
    amountChargedGyd: row.amount_charged_gyd,
    usdToGydRate: row.usd_to_gyd_rate,
    shippingAddress,
    fulfillment: row.fulfillment || null,
    // Only ever returned to endpoints scoped to this order's own customer
    // (dropshippingOrderPublic is never used for the courier's open-board
    // view — see dropshippingDeliveryPublic below, which deliberately
    // leaves deliveryCode out) — this is the code the customer reads out
    // to whichever courier shows up, or shows at the warehouse counter.
    warehousePickupCode: row.warehouse_pickup_code || null,
    deliveryCode: row.delivery_code || null,
    trackingNumber: row.tracking_number || null,
    createdAt: row.created_at,
    placedAt: row.placed_at || null,
    arrivedAt: row.arrived_at || null,
    claimedAt: row.claimed_at || null,
    resolvedAt: row.resolved_at || null,
  };
}

// The courier-facing view of a delivery — same underlying row as
// dropshippingOrderPublic above, but deliberately WITHOUT deliveryCode:
// couriers only ever get to enter that code (blind, told to them by the
// customer in person), never read it from the API, or "confirming" a
// delivery would mean nothing. Includes the shipping address, which
// dropshippingOrderPublic's own callers don't need but a courier obviously
// does.
function dropshippingDeliveryPublic(row) {
  let items = [];
  try {
    items = JSON.parse(row.items) || [];
  } catch (e) {
    items = [];
  }
  let shippingAddress = null;
  try {
    shippingAddress = JSON.parse(row.shipping_address);
  } catch (e) {
    shippingAddress = null;
  }
  return {
    id: row.id,
    status: row.status,
    items,
    shippingAddress,
    deliveryFeeGyd: row.delivery_fee_gyd,
    totalWeightKg: row.total_weight_kg,
    isOversizeCargo: row.total_weight_kg > DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG,
    createdAt: row.created_at,
    claimedAt: row.claimed_at || null,
    resolvedAt: row.resolved_at || null,
  };
}

// Same idea as generatePickupCode above, applied to the two new codes this
// section needs — a short, unique, human-typeable/readable-aloud code.
async function generateWarehousePickupCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const existing = await db.prepare('SELECT id FROM dropshipping_orders WHERE warehouse_pickup_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique warehouse pickup code');
}
async function generateDeliveryCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const existing = await db.prepare('SELECT id FROM dropshipping_orders WHERE delivery_code = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique delivery code');
}

// Shop screen: browse whatever's currently synced from CJ. Always
// available to any logged-in user (browsing doesn't need CJ credentials —
// only checkout does), optionally filtered by category. `enabled` in the
// response tells the client whether checkout will actually work, so it can
// show "coming soon" messaging instead of a dead Checkout button when this
// hasn't been configured yet.
on(
  'GET',
  '/api/shop/dropshipping-products',
  requireAuth(async (req, res, params, query) => {
    const rows = query.category
      ? await db.prepare('SELECT * FROM dropshipping_products WHERE in_stock = TRUE AND category = ? ORDER BY created_at DESC').all(query.category)
      : await db.prepare('SELECT * FROM dropshipping_products WHERE in_stock = TRUE ORDER BY created_at DESC').all();
    sendJson(res, 200, {
      products: rows.map(dropshippingProductPublic),
      enabled: dropshippingEnabled(),
      feeRate: DROPSHIP_FEE_RATE,
      delivery: {
        standardGyd: DROPSHIP_STANDARD_DELIVERY_GYD,
        oversizeGyd: DROPSHIP_OVERSIZE_DELIVERY_GYD,
        oversizeThresholdKg: DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG,
      },
    });
  })
);

// Refreshes the local product cache from CJ's catalog. Owner-level staff
// only (same requireStaffOwner gate as the other account-wide admin
// actions in the staff portal below) — this hits an external API and
// rewrites a shared table, not something any one business or customer
// should be able to trigger. Refuses cleanly if CJ isn't configured yet.
on(
  'POST',
  '/api/admin/dropshipping/sync-products',
  requireStaffOwner(async (req, res) => {
    if (!dropshippingEnabled()) {
      return badRequest(res, 'CJdropshipping is not configured — set CJ_API_KEY and CJ_ACCOUNT_ID first.');
    }
    const result = await fetchProductsFromCJ({ limit: 100, offset: 0 });
    if (!result.ok) return badRequest(res, `Could not reach CJdropshipping (${result.reason}).`);
    const syncedAt = now();
    for (const p of result.products) {
      // Pinned once here, at sync time — see the USD_TO_GYD_RATE comment
      // above for why this never gets recomputed at browse/checkout time.
      const priceGyd = Math.round(p.priceUsd * USD_TO_GYD_RATE * 100) / 100;
      const weightKg = Number(p.weightKg) || 0;
      const existing = await db.prepare('SELECT id FROM dropshipping_products WHERE cj_product_id = ?').get(p.cjProductId);
      if (existing) {
        await db.prepare(
          `UPDATE dropshipping_products
           SET name = ?, description = ?, price_usd = ?, price_gyd = ?, weight_kg = ?, image_url = ?, category = ?, in_stock = ?, last_synced_at = ?
           WHERE cj_product_id = ?`
        ).run(p.name, p.description, p.priceUsd, priceGyd, weightKg, p.imageUrl, p.category, p.inStock, syncedAt, p.cjProductId);
      } else {
        await db.prepare(
          `INSERT INTO dropshipping_products
           (id, cj_product_id, name, description, price_usd, price_gyd, weight_kg, image_url, category, in_stock, last_synced_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), p.cjProductId, p.name, p.description, p.priceUsd, priceGyd, weightKg, p.imageUrl, p.category, p.inStock, syncedAt, syncedAt);
      }
    }
    sendJson(res, 200, { success: true, productsCount: result.products.length, syncedAt });
  })
);

// Checkout — the one real money-moving endpoint in this section. Prices are
// always recomputed here from this server's own dropshipping_products
// table (never trusted from the client), same "server is the price
// authority" rule as /api/business/checkout above.
on(
  'POST',
  '/api/dropshipping/checkout',
  requireAuth(async (req, res, params, query, body, user) => {
    if (!dropshippingEnabled()) {
      return badRequest(res, "Dropshipping checkout isn't available yet — this needs a CJdropshipping API key configured on the server before real orders can be placed.");
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return badRequest(res, 'Your cart is empty.');
    }
    const productRows = await db.prepare('SELECT * FROM dropshipping_products WHERE in_stock = TRUE').all();
    const productsById = new Map(productRows.map((p) => [p.id, p]));
    const resolvedItems = [];
    let totalWeightKg = 0;
    for (const entry of body.items) {
      const product = productsById.get(entry.productId);
      if (!product) return badRequest(res, 'One of the items in your cart is no longer available — please review your order.');
      const quantity = Math.floor(Number(entry.quantity));
      if (!Number.isFinite(quantity) || quantity < 1) return badRequest(res, 'Invalid quantity in your cart.');
      // priceGyd is the same pinned number this product was shown at while
      // browsing (see dropshippingProductPublic) — never a fresh
      // USD-to-GYD conversion done here, so this total can never come out
      // different from what the cart displayed.
      resolvedItems.push({ cjProductId: product.cj_product_id, name: product.name, priceUsd: product.price_usd, priceGyd: product.price_gyd, quantity });
      totalWeightKg += (product.weight_kg || 0) * quantity;
    }

    const shipping = body.shippingAddress || {};
    const name = (shipping.name || '').trim().slice(0, 100);
    const phone = (shipping.phone || '').trim().slice(0, 40);
    const address = (shipping.address || '').trim().slice(0, 200);
    const city = (shipping.city || '').trim().slice(0, 100);
    const country = (shipping.country || 'GY').trim().slice(0, 60);
    if (!name || !phone || !address || !city) {
      return badRequest(res, 'Enter a full shipping name, phone, address, and city.');
    }
    const shippingAddress = { name, phone, address, city, country };

    // Kept for the record and for placing the order with CJ (which deals
    // in USD) — no longer part of the GYD math below.
    const totalUsd = Math.round(resolvedItems.reduce((sum, i) => sum + i.priceUsd * i.quantity, 0) * 100) / 100;
    const totalGyd = Math.round(resolvedItems.reduce((sum, i) => sum + i.priceGyd * i.quantity, 0) * 100) / 100;
    const platformFeeGyd = Math.round(totalGyd * DROPSHIP_FEE_RATE * 100) / 100;
    // No delivery fee charged here — nobody knows yet whether this order
    // will end up picked up in person or delivered, since that choice only
    // happens once it's actually landed at the warehouse (see
    // POST /api/dropshipping/orders/:id/choose-fulfillment below, which is
    // where delivery_fee_gyd actually gets charged, using this same frozen
    // total_weight_kg to pick the tier).
    const amountChargedGyd = Math.round((totalGyd + platformFeeGyd) * 100) / 100;
    if (!positiveAmount(amountChargedGyd)) return badRequest(res, 'Enter a positive amount.');
    if (user.gyd_balance < amountChargedGyd) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(amountChargedGyd)}.`);

    // Debit-only atomic guard (no credit side — see the section note above
    // for why), same "debit CTE + conditional insert" idiom as the pickup
    // order checkout above.
    const orderId = crypto.randomUUID();
    const createdAt = now();
    const itemsJson = JSON.stringify(resolvedItems);
    const shippingJson = JSON.stringify(shippingAddress);
    const rows = await db.raw(
      `WITH debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1 WHERE id = $2 AND gyd_balance >= $1 RETURNING gyd_balance
       ), ins AS (
         INSERT INTO dropshipping_orders
           (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at)
         SELECT $3, $2, 'pending', $4, $5, $6, $7, $8, $9, $1, $10, $11 WHERE EXISTS (SELECT 1 FROM debit)
       )
       SELECT gyd_balance FROM debit`,
      [amountChargedGyd, user.id, orderId, itemsJson, totalUsd, totalGyd, platformFeeGyd, totalWeightKg, USD_TO_GYD_RATE, shippingJson, createdAt]
    );
    if (rows.length === 0) return badRequest(res, `Not enough GYD — this checkout needs ${fmtNum(amountChargedGyd)}.`);

    await logTx({
      type: 'dropshipping_order', fromUser: user.id, toUser: null, amount: amountChargedGyd, currency: 'GYD',
      note: `Dropshipping order — ${resolvedItems.map((i) => `${i.quantity}x ${i.name}`).join(', ')} `
        + `(platform fee GYD ${fmtNum(platformFeeGyd)}; delivery fee decided once it arrives)`,
    });

    // Actually place it with CJ. If that fails, refund in full — the buyer
    // shouldn't stay charged for an order that never went anywhere.
    const placeResult = await placeOrderWithCJ({ items: resolvedItems, shipping: shippingAddress });
    let finalStatus = 'pending';
    let finalUser = user;
    if (placeResult.ok) {
      const placedAt = now();
      await db.prepare(
        `UPDATE dropshipping_orders SET status = 'placed_with_cj', cj_order_id = ?, tracking_number = ?, placed_at = ? WHERE id = ?`
      ).run(placeResult.cjOrderId, placeResult.tracking || null, placedAt, orderId);
      finalStatus = 'placed_with_cj';
      finalUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else {
      await db.raw(
        `WITH credit AS (
           UPDATE users SET gyd_balance = gyd_balance + $1 WHERE id = $2 RETURNING gyd_balance
         ), upd AS (
           UPDATE dropshipping_orders SET status = 'cancelled', resolved_at = $3 WHERE id = $4 RETURNING 1
         )
         SELECT gyd_balance FROM credit`,
        [amountChargedGyd, user.id, now(), orderId]
      );
      await logTx({
        type: 'dropshipping_refund', fromUser: null, toUser: user.id, amount: amountChargedGyd, currency: 'GYD',
        note: `Refund — CJdropshipping order could not be placed (${placeResult.reason})`,
      });
      finalUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      return badRequest(res, `This order could not be placed with CJdropshipping (${placeResult.reason}) — you have been refunded GYD ${fmtNum(amountChargedGyd)}.`);
    }

    const orderRow = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(orderId);
    sendJson(res, 200, { user: publicUser(finalUser), order: dropshippingOrderPublic(orderRow), status: finalStatus });
  })
);

on(
  'GET',
  '/api/dropshipping/orders/mine',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db.prepare('SELECT * FROM dropshipping_orders WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    sendJson(res, 200, { orders: rows.map(dropshippingOrderPublic) });
  })
);

// The moment the pickup-vs-delivery split actually happens. Only reachable
// once staff has marked the order 'arrived_at_warehouse' (see
// POST /api/staff/dropshipping-orders/:id/mark-arrived below) — nobody,
// including the customer, knows which path an order will take before
// then, which is exactly why no delivery fee was charged back at checkout.
on(
  'POST',
  '/api/dropshipping/orders/:id/choose-fulfillment',
  requireAuth(async (req, res, params, query, body, user) => {
    const order = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.user_id !== user.id) return sendJson(res, 403, { error: "This order isn't yours." });
    if (order.status !== 'arrived_at_warehouse') {
      return badRequest(res, 'This order is not ready for pickup or delivery yet.');
    }
    const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : body.fulfillment === 'pickup' ? 'pickup' : null;
    if (!fulfillment) return badRequest(res, 'Choose either pickup or delivery.');

    if (fulfillment === 'pickup') {
      // Free — nothing changes hands for a pickup, so there's nothing to
      // guard atomically beyond the status check itself.
      const code = await generateWarehousePickupCode();
      const rows = await db.raw(
        `UPDATE dropshipping_orders SET status = 'awaiting_pickup', fulfillment = 'pickup', warehouse_pickup_code = $1
         WHERE id = $2 AND status = 'arrived_at_warehouse' RETURNING id`,
        [code, order.id]
      );
      if (rows.length === 0) return badRequest(res, 'This order is not ready for pickup or delivery yet.');
      const updated = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(order.id);
      return sendJson(res, 200, { order: dropshippingOrderPublic(updated) });
    }

    // Delivery — this is the moment the delivery fee (see
    // DROPSHIP_STANDARD_DELIVERY_GYD / DROPSHIP_OVERSIZE_DELIVERY_GYD above)
    // actually gets charged, using the weight frozen on this order back at
    // checkout to pick the tier. Friendly pre-check first, same pattern as
    // every other charge in this file — the atomic statement below is the
    // real guard.
    const deliveryFeeGyd = order.total_weight_kg > DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG
      ? DROPSHIP_OVERSIZE_DELIVERY_GYD
      : DROPSHIP_STANDARD_DELIVERY_GYD;
    if (user.gyd_balance < deliveryFeeGyd) {
      return badRequest(res, `Not enough GYD for delivery — this needs ${fmtNum(deliveryFeeGyd)}. You can still choose pickup instead.`);
    }
    const deliveryCode = await generateDeliveryCode();

    // Three-part atomic statement: "gate" flips the order and is what
    // serializes two concurrent choose-fulfillment calls on the same order
    // (the second one's WHERE status = 'arrived_at_warehouse' simply won't
    // match once the first has run); "debit" only fires if the gate passed
    // AND the balance is actually there; "revert" undoes the gate if the
    // debit didn't happen — so an order can never end up sitting in
    // 'awaiting_courier' without the fee actually paid, and can never be
    // double-charged.
    const rows = await db.raw(
      `WITH gate AS (
         UPDATE dropshipping_orders
         SET status = 'awaiting_courier', fulfillment = 'delivery', delivery_fee_gyd = $1, delivery_code = $2
         WHERE id = $3 AND status = 'arrived_at_warehouse'
         RETURNING id
       ), debit AS (
         UPDATE users SET gyd_balance = gyd_balance - $1
         WHERE id = $4 AND gyd_balance >= $1 AND EXISTS (SELECT 1 FROM gate)
         RETURNING gyd_balance
       ), revert AS (
         UPDATE dropshipping_orders
         SET status = 'arrived_at_warehouse', fulfillment = NULL, delivery_fee_gyd = NULL, delivery_code = NULL
         WHERE id = $3 AND EXISTS (SELECT 1 FROM gate) AND NOT EXISTS (SELECT 1 FROM debit)
         RETURNING 1
       )
       SELECT gyd_balance FROM debit`,
      [deliveryFeeGyd, deliveryCode, order.id, user.id]
    );
    if (rows.length === 0) {
      const freshOrder = await db.prepare('SELECT status FROM dropshipping_orders WHERE id = ?').get(order.id);
      if (freshOrder && freshOrder.status !== 'arrived_at_warehouse') {
        return badRequest(res, 'This order is no longer ready for pickup or delivery — try refreshing.');
      }
      return badRequest(res, `Not enough GYD for delivery — this needs ${fmtNum(deliveryFeeGyd)}. You can still choose pickup instead.`);
    }

    await logTx({
      type: 'dropshipping_delivery_fee', fromUser: user.id, toUser: null, amount: deliveryFeeGyd, currency: 'GYD',
      note: `Delivery fee for dropshipping order ${order.id}${order.total_weight_kg > DROPSHIP_OVERSIZE_WEIGHT_THRESHOLD_KG ? ' (oversize cargo)' : ''}`,
    });

    const updatedUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const updatedOrder = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(order.id);
    sendJson(res, 200, { user: publicUser(updatedUser), order: dropshippingOrderPublic(updatedOrder) });
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

// ---------- courier (dropshipping delivery) ----------
//
// The third account role alongside personal and business (see is_courier /
// courier_gyd_balance in supabase/schema.sql) — anyone can opt in, same as
// upgrading to a business account (see POST /api/account/upgrade-to-courier
// above). A courier claims a delivery once its customer has chosen
// delivery (status 'awaiting_courier' — see
// POST /api/dropshipping/orders/:id/choose-fulfillment above), and gets
// paid the delivery fee only once they've actually entered the delivery
// code the customer reads out to them at handoff — see the comment on
// dropshippingDeliveryPublic above for why that code is never exposed to
// the courier through any of these endpoints.

on(
  'GET',
  '/api/courier/available-deliveries',
  requireCourier(async (req, res, params, query, body, user) => {
    const rows = await db
      .prepare(`SELECT * FROM dropshipping_orders WHERE status = 'awaiting_courier' AND courier_id IS NULL ORDER BY created_at ASC LIMIT 200`)
      .all();
    sendJson(res, 200, { deliveries: rows.map(dropshippingDeliveryPublic) });
  })
);

on(
  'POST',
  '/api/courier/deliveries/:id/claim',
  requireCourier(async (req, res, params, query, body, user) => {
    // Atomic claim — the WHERE clause is the whole guard: only the first of
    // two couriers tapping "claim" on the same delivery at once actually
    // gets it.
    const rows = await db.raw(
      `UPDATE dropshipping_orders SET courier_id = $1, status = 'out_for_delivery', claimed_at = $2
       WHERE id = $3 AND status = 'awaiting_courier' AND courier_id IS NULL RETURNING id`,
      [user.id, now(), params.id]
    );
    if (rows.length === 0) return badRequest(res, 'This delivery was already claimed.');
    const updated = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(params.id);
    sendJson(res, 200, { delivery: dropshippingDeliveryPublic(updated) });
  })
);

on(
  'GET',
  '/api/courier/deliveries/mine',
  requireCourier(async (req, res, params, query, body, user) => {
    const rows = await db.prepare(`SELECT * FROM dropshipping_orders WHERE courier_id = ? ORDER BY claimed_at DESC`).all(user.id);
    sendJson(res, 200, { deliveries: rows.map(dropshippingDeliveryPublic) });
  })
);

on(
  'POST',
  '/api/courier/deliveries/:id/confirm',
  requireCourier(async (req, res, params, query, body, user) => {
    const order = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Delivery not found.' });
    if (order.courier_id !== user.id) return sendJson(res, 403, { error: "This delivery isn't yours." });
    if (order.status !== 'out_for_delivery') return badRequest(res, 'This delivery is not out for confirmation.');
    const enteredCode = (body.code || '').trim().toUpperCase();
    if (!enteredCode) return badRequest(res, 'Enter the code the customer gives you.');
    if (enteredCode !== (order.delivery_code || '').toUpperCase()) {
      return badRequest(res, "That code doesn't match — ask the customer to read it out again.");
    }

    // Atomic: only pays out once, and only for the delivery this courier
    // actually holds — same "credit only fires off a successful gate"
    // idiom as everywhere else money moves in this file.
    const rows = await db.raw(
      `WITH gate AS (
         UPDATE dropshipping_orders SET status = 'delivered', resolved_at = $1
         WHERE id = $2 AND status = 'out_for_delivery' AND courier_id = $3
         RETURNING delivery_fee_gyd
       ), credit AS (
         UPDATE users SET courier_gyd_balance = courier_gyd_balance + (SELECT delivery_fee_gyd FROM gate)
         WHERE id = $3 AND EXISTS (SELECT 1 FROM gate)
         RETURNING courier_gyd_balance
       )
       SELECT courier_gyd_balance FROM credit`,
      [now(), order.id, user.id]
    );
    if (rows.length === 0) return badRequest(res, 'This delivery is not out for confirmation.');

    await logTx({
      type: 'dropshipping_delivery_payout', fromUser: null, toUser: user.id, amount: order.delivery_fee_gyd, currency: 'GYD',
      note: `Delivery payout for dropshipping order ${order.id}`,
    });

    const updatedUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const updatedOrder = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(order.id);
    sendJson(res, 200, { user: publicUser(updatedUser), order: dropshippingDeliveryPublic(updatedOrder) });
  })
);

on(
  'POST',
  '/api/courier/wallet/move-to-personal',
  requireCourier(async (req, res, params, query, body, user) => {
    const amount = Number(body.amount);
    if (!positiveAmount(amount)) return badRequest(res, 'Enter a positive amount.');
    if (user.courier_gyd_balance < amount) return badRequest(res, 'Not enough in your courier wallet.');

    const rows = await db.raw(
      `UPDATE users SET courier_gyd_balance = courier_gyd_balance - $1, gyd_balance = gyd_balance + $1
       WHERE id = $2 AND courier_gyd_balance >= $1
       RETURNING gyd_balance, courier_gyd_balance`,
      [amount, user.id]
    );
    if (rows.length === 0) return badRequest(res, 'Not enough in your courier wallet.');

    await logTx({ type: 'courier_wallet_transfer', toUser: user.id, amount, currency: 'GYD', note: 'Moved from courier wallet to personal wallet' });

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

// ---------- security headers ----------
// Applied to every response (API and static alike). These don't replace
// having good application logic (the rate limiting and validation
// elsewhere in this file matter far more), but they close off a handful of
// cheap browser-level attacks: forcing HTTPS, stopping this site from being
// framed by another page (clickjacking), stopping the browser from
// "helpfully" guessing a file's type in a way that enables an XSS, and
// restricting where scripts/styles/images/connections are allowed to come
// from so an injected `<script src="evil.example">` (if one ever slipped
// through) would simply be refused by the browser.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; " +
  "img-src 'self' data: https://api.qrserver.com; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

function applySecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', CSP);
}

// ---------- lightweight rate limiting ----------
// A small in-memory guard against brute-forcing (guessing passwords or
// reset codes) and against hammering the account-lookup endpoints. It's
// intentionally simple — a Map, not a separate service — since this is a
// single-instance Phase 1 prototype; the trade-off is that counts reset if
// the server restarts or redeploys. That's an acceptable gap for a
// prototype (it still stops casual/automated abuse), but a production
// deployment behind multiple instances should move this to something
// shared, like a Redis counter.
const rateLimitBuckets = new Map(); // key -> { count, resetAt }

function rateLimitPeek(key) {
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) return { count: 0, resetAt: 0 };
  return bucket;
}

function rateLimitRecord(key, windowMs) {
  const nowMs = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= nowMs) {
    bucket = { count: 0, resetAt: nowMs + windowMs };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
}

function rateLimitReset(key) {
  rateLimitBuckets.delete(key);
}

function retryAfterMinutes(bucket) {
  return Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 60000));
}

// Periodic cleanup so this Map doesn't grow forever on a long-running
// process — expired buckets are also skipped on read, this just reclaims
// their memory.
setInterval(() => {
  const nowMs = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= nowMs) rateLimitBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function getClientIp(req) {
  // Render (like most PaaS providers) sits in front of the app as a proxy
  // and forwards the real client IP as the first entry of this header.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------- support tickets (customer-facing) ----------
//
// A lightweight "contact support" channel: a customer submits a ticket
// (logged in or not — someone locked out of their account still needs a
// way to ask for help), and a staff member answers it from the staff
// portal (see the staff routes below). There's no live back-and-forth
// thread yet — one message in, one staff reply out — see the note on the
// support_tickets table in supabase/schema.sql for the natural next step.

function supportTicketPublic(row) {
  return {
    id: row.id,
    subject: row.subject,
    message: row.message,
    status: row.status,
    staffReply: row.staff_reply || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

on('POST', '/api/support/tickets', async (req, res, params, query, body) => {
  const subject = (body.subject || '').trim().slice(0, 140);
  const message = (body.message || '').trim().slice(0, 2000);
  if (!subject) return badRequest(res, 'Add a short subject line.');
  if (!message) return badRequest(res, 'Describe the issue you\'re having.');

  const ipKey = `support-ticket-ip:${getClientIp(req)}`;
  const ipBucket = rateLimitPeek(ipKey);
  if (ipBucket.count >= 10) {
    return sendJson(res, 429, {
      error: `Too many requests. Try again in ${retryAfterMinutes(ipBucket)} minute(s).`,
    });
  }
  rateLimitRecord(ipKey, 15 * 60 * 1000);

  // If the request carries a valid session, attach it to the ticket and
  // pull name/email from the account instead of trusting client-supplied
  // values for those — a logged-in submission can't spoof whose ticket it
  // is. Someone without a session (or who isn't logged in right now) must
  // supply their own name and email so staff have a way to identify them.
  const authedUser = await getAuthedUser(req);
  let userId = null;
  let name = null;
  let email = null;
  if (authedUser) {
    userId = authedUser.id;
    name = authedUser.username;
    email = authedUser.email || null;
  } else {
    name = (body.name || '').trim().slice(0, 80);
    email = (body.email || '').trim().slice(0, 200);
    if (!name) return badRequest(res, 'Enter your name.');
    if (!email || !EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
  }

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO support_tickets (id, user_id, name, email, subject, message, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(id, userId, name, email, subject, message, now());

  sendJson(res, 201, { ticketId: id });
});

on(
  'GET',
  '/api/support/tickets/mine',
  requireAuth(async (req, res, params, query, body, user) => {
    const rows = await db
      .prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(user.id);
    sendJson(res, 200, { tickets: rows.map(supportTicketPublic) });
  })
);

// ---------- staff portal ----------
//
// A completely separate login system for employees (see auth.js's
// makeStaffSessionToken and requireStaffAuth above) — a customer account,
// even a business one, has no access here no matter what. There's no
// self-signup: the first staff account is seeded directly, and any
// logged-in staff member can create another from the "Add employee" panel
// in public/staff.html (POST /api/staff/accounts below). The portal itself
// is public/staff.html + public/staff.js, served the same static way as
// the customer app but as its own page — see README.md for the URL.

const STAFF_LOGIN_MAX_ATTEMPTS = 8;
const STAFF_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const STAFF_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_STAFF_CODE_ATTEMPTS = 5;

// Step 1 of staff login: username + password only gets a one-time code, not
// a session — see /api/staff/login/verify-code below for step 2. The code
// comes back in this same response and staff.js shows it on screen, the
// same "simulated" pattern as /api/auth/forgot-password (see
// staff_login_codes in supabase/schema.sql for the important caveat: this
// is a real second STEP today, but not yet a real second FACTOR until an
// actual email/SMS integration replaces "shown on screen").
on('POST', '/api/staff/login', async (req, res, params, query, body) => {
  const { username, password } = body;
  const ip = getClientIp(req);
  const key = `staff-login:${(username || '').toLowerCase()}:${ip}`;
  const bucket = rateLimitPeek(key);
  if (bucket.count >= STAFF_LOGIN_MAX_ATTEMPTS) {
    return sendJson(res, 429, {
      error: `Too many login attempts. Try again in ${retryAfterMinutes(bucket)} minute(s).`,
    });
  }

  const staff = await db.prepare('SELECT * FROM staff_accounts WHERE username = ?').get(username || '');
  if (!staff || !verifyPassword(password || '', staff.password_salt, staff.password_hash)) {
    rateLimitRecord(key, STAFF_LOGIN_WINDOW_MS);
    return sendJson(res, 401, { error: 'Invalid username or password.' });
  }
  rateLimitReset(key);

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  await db.prepare('DELETE FROM staff_login_codes WHERE staff_id = ?').run(staff.id);
  await db.prepare(
    `INSERT INTO staff_login_codes (id, staff_id, code, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), staff.id, code, now(), new Date(Date.now() + STAFF_CODE_TTL_MS).toISOString());

  // With an email or phone on file AND real delivery configured (see
  // email.js, sms.js, PATCH /api/staff/me/email, and PATCH
  // /api/staff/me/phone), this is a genuine second factor — the code goes
  // somewhere the password alone doesn't get you. Email is tried first
  // when both are on file (it was the first channel this app supported);
  // SMS is the fallback. Without either configured, or without delivery
  // set up at all, this falls back to the original "shown on screen"
  // behavior, same as every other simulated code in this app.
  let sent = false;
  let sentVia = null;
  if (staff.email && emailEnabled()) {
    const result = await sendEmail(
      staff.email,
      'Your GYD Wallet staff verification code',
      codeEmailHtml('Here is your GYD Wallet staff login verification code:', code, 10)
    );
    sent = result.sent;
    if (sent) sentVia = 'email';
  }
  if (!sent && staff.phone && smsEnabled()) {
    const result = await sendSms(staff.phone, `Your GYD Wallet staff login verification code is ${code}. It expires in 10 minutes.`);
    sent = result.sent;
    if (sent) sentVia = 'sms';
  }

  sendJson(res, 200, {
    requiresCode: true,
    username: staff.username,
    expiresInMinutes: 10,
    ...(sent ? { sent: true, sentVia } : { code }),
  });
});

// Step 2: spend the code from step 1 to actually get a session token.
on('POST', '/api/staff/login/verify-code', async (req, res, params, query, body) => {
  const username = (body.username || '').trim();
  const code = (body.code || '').trim();
  const ip = getClientIp(req);
  const key = `staff-login-code:${username.toLowerCase()}:${ip}`;
  const bucket = rateLimitPeek(key);
  if (bucket.count >= STAFF_LOGIN_MAX_ATTEMPTS) {
    return sendJson(res, 429, {
      error: `Too many attempts. Try again in ${retryAfterMinutes(bucket)} minute(s).`,
    });
  }

  const invalidMsg = 'That code is invalid or has expired — log in again to get a new one.';
  const staff = await db.prepare('SELECT * FROM staff_accounts WHERE username = ?').get(username || '');
  if (!staff) {
    rateLimitRecord(key, STAFF_LOGIN_WINDOW_MS);
    return badRequest(res, invalidMsg);
  }

  const pending = await db
    .prepare('SELECT * FROM staff_login_codes WHERE staff_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(staff.id);
  if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
    rateLimitRecord(key, STAFF_LOGIN_WINDOW_MS);
    return badRequest(res, invalidMsg);
  }
  if (pending.attempts >= MAX_STAFF_CODE_ATTEMPTS) {
    return badRequest(res, 'Too many incorrect attempts. Log in again to get a new code.');
  }
  if (pending.code !== code) {
    rateLimitRecord(key, STAFF_LOGIN_WINDOW_MS);
    await db.prepare('UPDATE staff_login_codes SET attempts = attempts + 1 WHERE id = ?').run(pending.id);
    return badRequest(res, invalidMsg);
  }

  rateLimitReset(key);
  await db.prepare('UPDATE staff_login_codes SET used_at = ? WHERE id = ?').run(now(), pending.id);
  const token = makeStaffSessionToken(staff.id);
  sendJson(res, 200, { token, staff: publicStaff(staff) });
});

on(
  'GET',
  '/api/staff/me',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    sendJson(res, 200, { staff: publicStaff(staff) });
  })
);

// Lets a staff member set or change the email their own login codes and
// (for an owner) fraud alerts go to — see email.js. Self-service only:
// nobody else can set another account's delivery address for them.
on(
  'POST',
  '/api/staff/me/email',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const email = (body.email || '').trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address.');
    await db.prepare('UPDATE staff_accounts SET email = ? WHERE id = ?').run(email || null, staff.id);
    const updated = await db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(staff.id);
    sendJson(res, 200, { staff: publicStaff(updated) });
  })
);

// Same idea as POST /api/staff/me/email above, but for a phone number —
// lets a staff member receive their login verification code by text (see
// sms.js) instead of, or in addition to, email. Self-service only.
// Deliberately permissive validation (digits, spaces, +, -, parens): phone
// number formats vary too much internationally to validate strictly, and
// Twilio itself is the real check when a code actually gets sent.
const PHONE_RE = /^[+()\d][\d\s()+-]{5,19}$/;
on(
  'POST',
  '/api/staff/me/phone',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const phone = (body.phone || '').trim();
    if (phone && !PHONE_RE.test(phone)) return badRequest(res, 'Enter a valid phone number.');
    await db.prepare('UPDATE staff_accounts SET phone = ? WHERE id = ?').run(phone || null, staff.id);
    const updated = await db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(staff.id);
    sendJson(res, 200, { staff: publicStaff(updated) });
  })
);

// A staff member logging themselves out of every device they're signed in
// on — same mechanism and same "signs out this device too" trade-off as
// POST /api/security/logout-all-sessions above, applied to staff_accounts.
on(
  'POST',
  '/api/staff/logout-all-sessions',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    await db.prepare('UPDATE staff_accounts SET sessions_invalidated_at = ? WHERE id = ?').run(now(), staff.id);
    await logStaffAction(staff, 'staff_logged_out_everywhere', staff.id, `${staff.username} signed out of all devices`);
    sendJson(res, 200, { ok: true });
  })
);

on(
  'GET',
  '/api/staff/accounts',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const rows = await db.prepare('SELECT * FROM staff_accounts ORDER BY created_at ASC').all();
    sendJson(res, 200, { accounts: rows.map(publicStaff) });
  })
);

// A staff account can approve cash-outs and (with owner role) create other
// staff logins or read the audit log, so it needs a real password, not just
// the bare-minimum 6 characters a customer account requires. This is the
// direct fix for exactly what happened when the first account here was
// created with a password identical to its own username: at least 10
// characters, a mix of letters and digits, and never the username itself
// (in any capitalization) or one of the handful of passwords everyone
// tries first.
const COMMON_WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
  'letmein', 'welcome', 'welcome1', 'admin1234', 'changeme', 'employee1',
]);
function validateStaffPassword(username, password) {
  if (!password || typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include both letters and numbers.';
  }
  if (password.toLowerCase() === (username || '').toLowerCase()) {
    return "Password can't be the same as the username.";
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common — choose something harder to guess.';
  }
  return null;
}

on(
  'POST',
  '/api/staff/accounts',
  // Owner-only — see requireStaffOwner's comment for why this is the actual
  // fraud/theft control, not just a permissions nicety.
  requireStaffOwner(async (req, res, params, query, body, staff) => {
    const username = (body.username || '').trim();
    const password = body.password;
    const role = body.role === 'owner' ? 'owner' : 'employee';
    const email = (body.email || '').trim().toLowerCase();
    if (!username || username.length < 3) return badRequest(res, 'Username must be at least 3 characters.');
    const passwordError = validateStaffPassword(username, password);
    if (passwordError) return badRequest(res, passwordError);
    if (email && !EMAIL_RE.test(email)) return badRequest(res, 'Enter a valid email address, or leave it blank.');
    const existing = await db.prepare('SELECT id FROM staff_accounts WHERE username = ?').get(username);
    if (existing) return badRequest(res, 'That username is already taken.');

    const newId = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);
    await db.prepare(
      `INSERT INTO staff_accounts (id, username, password_hash, password_salt, role, created_at, email) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newId, username, hash, salt, role, now(), email || null);
    await logStaffAction(staff, 'staff_account_created', newId, `Created ${role} account "${username}"`);

    const rows = await db.prepare('SELECT * FROM staff_accounts ORDER BY created_at ASC').all();
    sendJson(res, 201, { accounts: rows.map(publicStaff) });
  })
);

// An owner cutting off a specific employee's access outright — e.g. right
// after letting them go, or the moment their account is suspected
// compromised — without needing to know or reset their password first.
// Uses the exact same mechanism as a staff member logging themselves out
// (see staff_accounts.sessions_invalidated_at), just triggered by someone
// else on their behalf.
on(
  'POST',
  '/api/staff/accounts/:id/revoke-sessions',
  requireStaffOwner(async (req, res, params, query, body, staff) => {
    const target = await db.prepare('SELECT id, username FROM staff_accounts WHERE id = ?').get(params.id);
    if (!target) return sendJson(res, 404, { error: 'Staff account not found.' });
    await db.prepare('UPDATE staff_accounts SET sessions_invalidated_at = ? WHERE id = ?').run(now(), target.id);
    await logStaffAction(staff, 'staff_sessions_revoked', target.id, `Signed "${target.username}" out of all devices`);
    sendJson(res, 200, { ok: true });
  })
);

// A quick set of counts for the dashboard's summary/badges, so a staff
// member can see at a glance what needs attention without opening every
// panel.
on(
  'GET',
  '/api/staff/summary',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const [openTickets, pendingCashouts] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'").get(),
      db.prepare("SELECT COUNT(*) AS n FROM cashout_requests WHERE status = 'pending'").get(),
    ]);
    sendJson(res, 200, {
      openTickets: Number(openTickets.n),
      pendingCashouts: Number(pendingCashouts.n),
    });
  })
);

// ---- staff: support tickets ----

on(
  'GET',
  '/api/staff/support-tickets',
  requireStaffAuth(async (req, res, params, query) => {
    const status = query.status === 'resolved' ? 'resolved' : 'open';
    const rows = await db
      .prepare('SELECT * FROM support_tickets WHERE status = ? ORDER BY created_at ASC LIMIT 200')
      .all(status);
    sendJson(res, 200, {
      tickets: rows.map((r) => ({
        ...supportTicketPublic(r),
        name: r.name,
        email: r.email,
        repliedBy: r.replied_by,
      })),
    });
  })
);

on(
  'POST',
  '/api/staff/support-tickets/:id/reply',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const reply = (body.reply || '').trim().slice(0, 2000);
    const resolve = !!body.resolve;
    if (!reply) return badRequest(res, 'Write a reply before sending.');

    const ticket = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(params.id);
    if (!ticket) return sendJson(res, 404, { error: 'Ticket not found.' });

    await db.prepare(
      `UPDATE support_tickets
       SET staff_reply = ?, replied_by = ?, status = ?, resolved_at = ?
       WHERE id = ?`
    ).run(reply, staff.username, resolve ? 'resolved' : 'open', resolve ? now() : null, params.id);

    const updated = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(params.id);
    sendJson(res, 200, {
      ticket: { ...supportTicketPublic(updated), name: updated.name, email: updated.email, repliedBy: updated.replied_by },
    });
  })
);

on(
  'POST',
  '/api/staff/support-tickets/:id/resolve',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const ticket = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(params.id);
    if (!ticket) return sendJson(res, 404, { error: 'Ticket not found.' });
    await db.prepare("UPDATE support_tickets SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now(), params.id);
    sendJson(res, 200, { ok: true });
  })
);

// Removing a reported business review — reached from the "Remove this
// review" button staff.js shows on a "Reported review on ..." ticket (see
// POST /api/business/directory/:handle/reviews/:reviewId/report above).
// Any staff member can do this, not just an owner — it's ordinary content
// moderation, not an account-access or money-moving action — but it's
// still logged, same as everything else staff can do.
on(
  'DELETE',
  '/api/staff/reviews/:id',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const review = await db.prepare('SELECT * FROM business_reviews WHERE id = ?').get(params.id);
    if (!review) return sendJson(res, 404, { error: 'That review no longer exists.' });
    await db.prepare('DELETE FROM business_reviews WHERE id = ?').run(params.id);
    await logStaffAction(staff, 'review_removed', params.id, `Removed a ${review.rating}-star review on business ${review.business_id}`);
    sendJson(res, 200, { ok: true });
  })
);

// ---- staff: cash-out queue ----
//
// A cash-out request only ever gets created as 'pending' (see
// /api/wallet/cashout above) and, before this portal existed, had no way
// to ever move past that — the GYD was escrowed out of the customer's
// balance but nobody could mark the request handled. "Complete" means a
// staff member actually paid the customer outside the app (see the scope
// note on /api/wallet/cashout); "reject" refunds the escrowed GYD back to
// the customer's balance instead, for when a request can't be honored.

on(
  'GET',
  '/api/staff/cashouts',
  requireStaffAuth(async (req, res, params, query) => {
    const status = ['pending', 'completed', 'rejected'].includes(query.status) ? query.status : 'pending';
    const rows = await db
      .prepare(
        `SELECT c.*, u.username, u.paytag FROM cashout_requests c JOIN users u ON u.id = c.user_id
         WHERE c.status = ? ORDER BY c.created_at ASC LIMIT 200`
      )
      .all(status);
    sendJson(res, 200, {
      cashouts: rows.map((r) => ({
        id: r.id,
        username: r.username,
        paytag: r.paytag,
        amountGyd: r.amount_gyd,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      })),
    });
  })
);

on(
  'POST',
  '/api/staff/cashouts/:id/complete',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const rows = await db.raw(
      `UPDATE cashout_requests SET status = 'completed', resolved_at = $1, resolved_by = $2
       WHERE id = $3 AND status = 'pending' RETURNING id, user_id, amount_gyd`,
      [now(), staff.id, params.id]
    );
    if (rows.length === 0) return badRequest(res, 'That request is no longer pending.');
    // This is the single most fraud-sensitive action in the whole portal —
    // it's a staff member's word that money actually left the building,
    // with nothing in the app itself able to verify that. The audit log
    // entry is what makes that claim checkable after the fact: an owner
    // can see exactly which employee marked which payout complete, and
    // when, permanently.
    await logStaffAction(
      staff,
      'cashout_completed',
      params.id,
      `Marked GYD ${rows[0].amount_gyd} cash-out paid for user ${rows[0].user_id}`
    );
    sendJson(res, 200, { ok: true });
  })
);

on(
  'POST',
  '/api/staff/cashouts/:id/reject',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    // One atomic statement: only refunds if the request was still pending,
    // so it can never be double-refunded by two staff clicking at once.
    const rows = await db.raw(
      `WITH upd AS (
         UPDATE cashout_requests SET status = 'rejected', resolved_at = $1, resolved_by = $2
         WHERE id = $3 AND status = 'pending'
         RETURNING user_id, amount_gyd
       ), credit AS (
         UPDATE users SET gyd_balance = gyd_balance + (SELECT amount_gyd FROM upd)
         WHERE id = (SELECT user_id FROM upd)
       )
       SELECT * FROM upd`,
      [now(), staff.id, params.id]
    );
    if (rows.length === 0) return badRequest(res, 'That request is no longer pending.');
    const { user_id, amount_gyd } = rows[0];
    await logTx({
      type: 'cashout_rejected_refund',
      toUser: user_id,
      amount: amount_gyd,
      currency: 'GYD',
      note: `Refund for rejected cash-out ${params.id}`,
    });
    await logStaffAction(staff, 'cashout_rejected', params.id, `Rejected & refunded GYD ${amount_gyd} for user ${user_id}`);
    sendJson(res, 200, { ok: true });
  })
);

// ---- staff: dropshipping (warehouse arrivals & pickups) ----
//
// The one manual step standing in for a real CJdropshipping tracking
// webhook (see the file-level comment in dropshipping.js) — until CJ
// actually pushes "landed in Guyana" events at us, a staff member has to
// eyeball incoming shipments and mark them here. This is also where a
// staff member redeems a customer's warehouse pickup code in person,
// mirroring how a business redeems a local pickup order's code above (see
// POST /api/business/orders/:code/redeem).

on(
  'GET',
  '/api/staff/dropshipping-orders',
  requireStaffAuth(async (req, res, params, query) => {
    const rows = await db
      .prepare(
        `SELECT o.*, u.username AS customer_username
         FROM dropshipping_orders o JOIN users u ON u.id = o.user_id
         WHERE o.status IN ('placed_with_cj', 'arrived_at_warehouse', 'awaiting_pickup', 'awaiting_courier', 'out_for_delivery')
         ORDER BY o.created_at ASC LIMIT 200`
      )
      .all();
    sendJson(res, 200, {
      orders: rows.map((r) => ({ ...dropshippingOrderPublic(r), customerUsername: r.customer_username })),
    });
  })
);

on(
  'POST',
  '/api/staff/dropshipping-orders/:id/mark-arrived',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const order = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(params.id);
    if (!order) return sendJson(res, 404, { error: 'Order not found.' });
    if (order.status !== 'placed_with_cj') return badRequest(res, 'This order is not awaiting arrival.');

    const arrivedAt = now();
    const rows = await db.raw(
      `UPDATE dropshipping_orders SET status = 'arrived_at_warehouse', arrived_at = $1
       WHERE id = $2 AND status = 'placed_with_cj' RETURNING id`,
      [arrivedAt, order.id]
    );
    if (rows.length === 0) return badRequest(res, 'This order is not awaiting arrival.');

    // Best-effort customer notification — see the notification caveat in
    // README.md: this app can only ever email the customer (no phone
    // number is collected at signup, and there's no calling integration
    // anywhere in this codebase), and even that only if RESEND_API_KEY is
    // configured. A failed or skipped notification never blocks the
    // warehouse status update itself.
    if (emailEnabled()) {
      const customer = await db.prepare('SELECT email, username FROM users WHERE id = ?').get(order.user_id);
      if (customer && customer.email) {
        await sendEmail(
          customer.email,
          'Your order has arrived — GYD Wallet',
          `<div style="font-family: -apple-system, sans-serif; max-width: 420px; margin: 0 auto;">
             <p>Hi ${customer.username},</p>
             <p>Your order has arrived at our Guyana warehouse. Open the app and go to My Orders to choose whether you'd like to pick it up in person or have it delivered.</p>
           </div>`
        );
      }
    }

    await logStaffAction(staff, 'dropshipping_marked_arrived', order.id, `Marked dropshipping order ${order.id} arrived at warehouse`);
    const updated = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(order.id);
    sendJson(res, 200, { order: dropshippingOrderPublic(updated) });
  })
);

on(
  'POST',
  '/api/staff/dropshipping-orders/redeem-pickup',
  requireStaffAuth(async (req, res, params, query, body, staff) => {
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return badRequest(res, "Enter the customer's pickup code.");
    const order = await db.prepare('SELECT * FROM dropshipping_orders WHERE warehouse_pickup_code = ?').get(code);
    if (!order) return badRequest(res, 'No pending pickup with that code.');
    if (order.status !== 'awaiting_pickup') return badRequest(res, 'This order is no longer awaiting pickup.');

    const rows = await db.raw(
      `UPDATE dropshipping_orders SET status = 'picked_up', resolved_at = $1
       WHERE id = $2 AND status = 'awaiting_pickup' RETURNING id`,
      [now(), order.id]
    );
    if (rows.length === 0) return badRequest(res, 'This order is no longer awaiting pickup.');

    await logStaffAction(staff, 'dropshipping_pickup_redeemed', order.id, `Redeemed warehouse pickup for dropshipping order ${order.id}`);
    const updated = await db.prepare('SELECT * FROM dropshipping_orders WHERE id = ?').get(order.id);
    sendJson(res, 200, { order: dropshippingOrderPublic(updated) });
  })
);

// The audit trail itself — owner-only (see requireStaffOwner). Read-only:
// there is deliberately no endpoint anywhere that edits or deletes an
// entry once written.
on(
  'GET',
  '/api/staff/audit-log',
  requireStaffOwner(async (req, res, params, query) => {
    const rows = await db.prepare('SELECT * FROM staff_audit_log ORDER BY created_at DESC LIMIT 300').all();
    sendJson(res, 200, {
      entries: rows.map((r) => ({
        id: r.id,
        staffUsername: r.staff_username,
        action: r.action,
        target: r.target,
        details: r.details,
        createdAt: r.created_at,
      })),
    });
  })
);

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
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

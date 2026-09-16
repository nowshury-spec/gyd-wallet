// Password hashing + stateless signed session tokens.
// No external dependencies: uses Node's built-in crypto module only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SECRET_PATH = path.join(DATA_DIR, 'session-secret.key');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function getSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SECRET_PATH)) {
    fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(SECRET_PATH, 'utf8');
}

const SECRET = getSecret();

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(check, hash);
}

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function makeSessionToken(userId) {
  return sign({ uid: userId, exp: Date.now() + TOKEN_TTL_MS });
}

// A separate token shape for employee/staff logins (see server.js's
// /api/staff/* routes and the staff portal in public/staff.html). Carrying
// `role: 'staff'` means a customer token and a staff token are never
// interchangeable even though they're both just signed JSON underneath —
// server.js's requireStaffAuth checks for this exact role before trusting
// the token at all, and a regular customer session (uid, no role) simply
// doesn't have it.
function makeStaffSessionToken(staffId) {
  return sign({ sid: staffId, role: 'staff', exp: Date.now() + TOKEN_TTL_MS });
}

module.exports = { hashPassword, verifyPassword, makeSessionToken, makeStaffSessionToken, verify };

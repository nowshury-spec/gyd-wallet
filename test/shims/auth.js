// Test-only stand-in for the real auth.js. HMAC-signed tokens and scrypt
// password hashes — enough for the server to run; NOT a copy of the real
// implementation, which wasn't available when these tests were written.
const crypto = require('crypto');

const SECRET = crypto.randomBytes(32);
const SESSION_MS = 7 * 24 * 3600 * 1000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (data.exp && data.exp < Date.now()) return null;
  return data;
}

function makeSessionToken(uid) {
  return sign({ uid, iat: Date.now(), exp: Date.now() + SESSION_MS });
}
function makeStaffSessionToken(sid) {
  return sign({ sid, role: 'staff', iat: Date.now(), exp: Date.now() + SESSION_MS });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

module.exports = { sign, verify, makeSessionToken, makeStaffSessionToken, hashPassword, verifyPassword };

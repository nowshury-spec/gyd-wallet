// Unit tests for auth.js password hashing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const { hashPassword, verifyPassword } = require('../auth');

test('checking passwords does not freeze the server (event loop stays responsive)', async () => {
  const { salt, hash } = await hashPassword('correct horse 1');
  // Measure the longest gap between timer ticks while 30 password checks run
  // — that's how long every other request would have had to wait.
  let worstGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const t = performance.now();
    worstGap = Math.max(worstGap, t - last);
    last = t;
  }, 5);
  const results = await Promise.all(Array.from({ length: 30 }, () => verifyPassword('correct horse 1', salt, hash)));
  // Count the stretch since the last tick too: if the checks blocked, the
  // timer may never have ticked at all while they ran.
  worstGap = Math.max(worstGap, performance.now() - last);
  clearInterval(timer);
  assert.ok(results.every(Boolean));
  console.log(`# longest freeze while checking 30 passwords: ${worstGap.toFixed(0)} ms`);
  assert.ok(worstGap < 100, `the main thread was blocked for ${worstGap.toFixed(0)} ms`);
});

test('passwords stored before this change still verify', async () => {
  // Exactly how the previous auth.js created hashes (synchronous scrypt, 64 bytes).
  const salt = crypto.randomBytes(16).toString('hex');
  const oldHash = crypto.scryptSync('an existing password', salt, 64).toString('hex');
  assert.equal(await verifyPassword('an existing password', salt, oldHash), true);
  assert.equal(await verifyPassword('wrong password', salt, oldHash), false);
});

test('new hashes are salted and verify correctly', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword('same password', a.salt, a.hash), true);
  assert.equal(await verifyPassword('Same password', a.salt, a.hash), false);
});

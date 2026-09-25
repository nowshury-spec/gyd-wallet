const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uniqueName } = require('./harness');
const { hashPassword } = require('../auth');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => {
  await env.stop();
});

function codeFromMail(mail) {
  const m = /class="code">(\d+)</.exec(mail.html);
  return m && m[1];
}

function makeStaff({ email = null } = {}) {
  const username = uniqueName('staff');
  const password = 'staff password 123';
  const { salt, hash } = hashPassword(password);
  env.sql(`INSERT INTO staff_accounts (id, username, password_hash, password_salt, role, created_at, email)
           VALUES ('${username}', '${username}', '${hash}', '${salt}', 'owner', now()::text, ${email ? `'${email}'` : 'NULL'});`);
  return { username, password };
}

test('with no email provider and no demo flag, codes are never handed out', async (t) => {
  await env.startServer({});
  const u = await env.makeUser();
  const fp = await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  assert.equal(fp.status, 503);
  assert.equal(fp.data.code, undefined);

  const fu = await env.api('POST', '/api/auth/forgot-username', { body: { email: u.email } });
  assert.equal(fu.status, 503);
  assert.equal(fu.data.username, undefined);

  const staff = makeStaff();
  const sl = await env.api('POST', '/api/staff/login', { body: { username: staff.username, password: staff.password } });
  assert.equal(sl.status, 503);
  assert.equal(sl.data.code, undefined);
});

test('with email configured, forgot-password answers identically for registered and unknown emails', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1' });
  const u = await env.makeUser();
  const known = await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const unknown = await env.api('POST', '/api/auth/forgot-password', { body: { email: `nobody_${Date.now()}@example.test` } });
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, unknown.data);
  assert.deepEqual(known.data, { sent: true, expiresInMinutes: 15 });
  const mails = env.mail();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, u.email);
  assert.match(codeFromMail(mails[0]), /^\d{6}$/);
});

test('a failed email send is not turned into an on-screen code', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1', TEST_EMAIL_FAIL: '1' });
  const u = await env.makeUser();
  const r = await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { sent: true, expiresInMinutes: 15 });
});

test('resetting a password verifies the email and signs out every existing session', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1' });
  const u = await env.makeUser();
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 200);
  await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const code = codeFromMail(env.mail().at(-1));
  const r = await env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code, newPassword: 'a brand new pw' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 401, 'old session must be revoked');
  assert.equal((await env.api('GET', '/api/me', { token: r.data.token })).status, 200, 'new session must work');
  const [row] = env.query(`SELECT email_verified FROM users WHERE id = '${u.id}'`);
  assert.equal(row.email_verified, true);
  // The code can't be used a second time.
  const again = await env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code, newPassword: 'another pw 99' } });
  assert.equal(again.status, 400);
});

test('parallel wrong guesses cannot exceed the per-code attempt limit', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1' });
  const u = await env.makeUser();
  await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const code = codeFromMail(env.mail().at(-1));
  const wrong = code === '000000' ? '000001' : '000000';
  await Promise.all(
    Array.from({ length: 12 }, () =>
      env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code: wrong, newPassword: 'whatever pw' } })
    )
  );
  const [row] = env.query(`SELECT attempts FROM password_resets WHERE user_id = '${u.id}'`);
  assert.equal(row.attempts, 5);
  const right = await env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code, newPassword: 'whatever pw' } });
  assert.equal(right.status, 400, 'the correct code must be dead once the attempts are used up');
});

test('staff 2FA: code is emailed, works once, and parallel guesses are capped', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1' });
  const email = `${uniqueName('s')}@example.test`;
  const staff = makeStaff({ email });
  const login = await env.api('POST', '/api/staff/login', { body: { username: staff.username, password: staff.password } });
  assert.equal(login.status, 200);
  assert.equal(login.data.sent, true);
  assert.equal(login.data.code, undefined);
  const code = codeFromMail(env.mail().at(-1));
  const ok = await env.api('POST', '/api/staff/login/verify-code', { body: { username: staff.username, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const reuse = await env.api('POST', '/api/staff/login/verify-code', { body: { username: staff.username, code } });
  assert.equal(reuse.status, 400);

  await env.api('POST', '/api/staff/login', { body: { username: staff.username, password: staff.password } });
  const code2 = codeFromMail(env.mail().at(-1));
  const wrong = code2 === '000000' ? '000001' : '000000';
  await Promise.all(
    Array.from({ length: 10 }, () => env.api('POST', '/api/staff/login/verify-code', { body: { username: staff.username, code: wrong } }))
  );
  const late = await env.api('POST', '/api/staff/login/verify-code', { body: { username: staff.username, code: code2 } });
  assert.equal(late.status, 400);
});

test('staff with no deliverable channel cannot log in outside demo mode', async () => {
  await env.startServer({ TEST_EMAIL_ENABLED: '1' });
  const staff = makeStaff(); // no email on file
  const r = await env.api('POST', '/api/staff/login', { body: { username: staff.username, password: staff.password } });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, undefined);
});

test('SHOW_CODES_ON_SCREEN demo mode shows codes, identically for unknown emails, and does not verify the email', async () => {
  await env.startServer({ SHOW_CODES_ON_SCREEN: 'true' });
  const u = await env.makeUser();
  const known = await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const unknown = await env.api('POST', '/api/auth/forgot-password', { body: { email: `nobody_${Date.now()}@example.test` } });
  assert.match(known.data.code, /^\d{6}$/);
  assert.match(unknown.data.code, /^\d{6}$/);
  assert.deepEqual(Object.keys(known.data).sort(), Object.keys(unknown.data).sort());
  const r = await env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code: known.data.code, newPassword: 'demo mode pw' } });
  assert.equal(r.status, 200);
  const [row] = env.query(`SELECT email_verified FROM users WHERE id = '${u.id}'`);
  assert.equal(row.email_verified, false);

  const staff = makeStaff();
  const sl = await env.api('POST', '/api/staff/login', { body: { username: staff.username, password: staff.password } });
  assert.equal(sl.status, 200);
  assert.match(sl.data.code, /^\d{6}$/);
});

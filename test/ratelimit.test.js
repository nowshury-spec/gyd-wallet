const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => {
  await env.stop();
});

test('login lockout persists across a server restart', async () => {
  const u = await env.makeUser();
  const ip = '198.51.100.7';
  for (let i = 0; i < 8; i++) {
    const r = await env.api('POST', '/api/login', { ip, body: { username: u.username, password: 'wrong password' } });
    assert.equal(r.status, 401);
  }
  assert.equal((await env.api('POST', '/api/login', { ip, body: { username: u.username, password: 'correct horse 1' } })).status, 429);

  await env.startServer({}); // simulates a deploy / Render waking from sleep
  const after = await env.api('POST', '/api/login', { ip, body: { username: u.username, password: 'correct horse 1' } });
  assert.equal(after.status, 429, 'the lockout must survive a restart');

  // A different client IP is a different bucket.
  const other = await env.api('POST', '/api/login', { ip: '198.51.100.8', body: { username: u.username, password: 'correct horse 1' } });
  assert.equal(other.status, 200);
});

test('a spoofed X-Forwarded-For entry does not give a fresh rate-limit bucket', async () => {
  const u = await env.makeUser();
  const realIp = '198.51.100.20';
  for (let i = 0; i < 8; i++) {
    // The attacker prepends a random fake IP each time; the proxy-appended real IP is last.
    await env.api('POST', '/api/login', { ip: `9.9.9.${i}, ${realIp}`, body: { username: u.username, password: 'wrong password' } });
  }
  const r = await env.api('POST', '/api/login', { ip: `8.8.8.8, ${realIp}`, body: { username: u.username, password: 'correct horse 1' } });
  assert.equal(r.status, 429);
});

test('parallel failed logins are all counted', async () => {
  const u = await env.makeUser();
  const ip = '198.51.100.30';
  await Promise.all(
    Array.from({ length: 8 }, () => env.api('POST', '/api/login', { ip, body: { username: u.username, password: 'wrong password' } }))
  );
  const [row] = env.query(`SELECT count FROM rate_limits WHERE key = 'login:${u.username.toLowerCase()}:${ip}'`);
  assert.equal(row.count, 8);
});

test('behind Render, the client IP comes from True-Client-IP and X-Forwarded-For spoofing is ignored', async () => {
  await env.startServer({ RENDER: 'true' });
  try {
    const u = await env.makeUser();
    const hit = (clientIp, fakeXff) =>
      fetch(`http://127.0.0.1:${env.port}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'True-Client-IP': clientIp,
          // Render's real shape: client, Cloudflare edge, Render-internal.
          'X-Forwarded-For': `${fakeXff}, ${clientIp}, 172.71.195.123, 10.226.90.65`,
        },
        body: JSON.stringify({ username: u.username, password: 'wrong password' }),
      });
    for (let i = 0; i < 8; i++) await hit('203.0.113.50', `9.9.9.${i}`);
    const blocked = await hit('203.0.113.50', '1.1.1.1');
    assert.equal(blocked.status, 429, 'same client, rotating fake XFF: still limited');
    const otherUser = await hit('203.0.113.51', '1.1.1.1');
    assert.equal(otherUser.status, 401, 'a different real client (same internal hop) must not share the bucket');
  } finally {
    await env.startServer({});
  }
});

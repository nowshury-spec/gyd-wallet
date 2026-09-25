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

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('business photos upload to storage, are publicly viewable, and can be deleted', async () => {
  const biz = await env.makeUser({ business: true });
  const up = await env.api('POST', '/api/business/photos', { token: biz.token, body: { imageData: PNG_1PX } });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const photo = up.data.photos[0];
  assert.ok(photo.url.startsWith(`${env.supabase.url}/storage/v1/object/public/business-photos/`), photo.url);

  const img = await fetch(photo.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(PNG_1PX.split(',')[1], 'base64'));

  const other = await env.makeUser({ business: true });
  assert.equal((await env.api('DELETE', `/api/business/photos/${photo.id}`, { token: other.token })).status, 403);

  const del = await env.api('DELETE', `/api/business/photos/${photo.id}`, { token: biz.token });
  assert.equal(del.status, 200);
  assert.equal(del.data.photos.length, 0);
  assert.equal((await fetch(photo.url)).status, 404);
});

test('the page security policy allows images from the Supabase project', async () => {
  const r = await fetch(`http://127.0.0.1:${env.port}/`);
  const csp = r.headers.get('content-security-policy');
  const imgSrc = /img-src ([^;]+)/.exec(csp)[1];
  assert.ok(imgSrc.split(' ').includes(env.supabase.url), imgSrc);
});

test('db.js works with a new-format secret key (sent in the apikey header only)', async () => {
  // The default test setup already uses an sb_secret_ key; the fake rejects
  // it with "Invalid JWT" if it's ever sent as a Bearer token.
  const u = await env.makeUser({ balance: 100 });
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 200);
});

test('db.js works with a legacy JWT service_role key', async () => {
  await env.startServer({ SUPABASE_KEY: env.legacyServiceKey });
  try {
    const u = await env.makeUser();
    assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 200);
  } finally {
    await env.startServer({});
  }
});

test('with the public anon key the app cannot touch the database at all', async () => {
  await env.startServer({ SUPABASE_KEY: env.anonKey });
  try {
    const r = await env.api('POST', '/api/register', { body: { username: 'anonkeytest', email: 'anonkey@example.test', password: 'correct horse 1' } });
    assert.equal(r.status, 500);
    assert.match(env.serverLog, /public anon\/publishable key/, 'startup should flag the wrong key');
  } finally {
    await env.startServer({});
  }
});

test('sessions survive a restart (stable SESSION_SECRET)', async () => {
  const u = await env.makeUser();
  await env.startServer({});
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 200);
});

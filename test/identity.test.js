const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uniqueName } = require('./harness');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => {
  await env.stop();
});

const register = (username, email) =>
  env.api('POST', '/api/register', { body: { username, email: email || `${uniqueName('e')}@example.test`, password: 'correct horse 1' } });

test('usernames are restricted to letters, numbers and underscores', async () => {
  for (const bad of ['has space', '<b>x</b>', 'dot.name', 'ab', 'x'.repeat(21)]) {
    const r = await register(bad);
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await register(uniqueName('ok_'))).status, 201);
});

test('usernames are unique case-insensitively and cannot reuse someone else\'s $paytag', async () => {
  const base = uniqueName('Case');
  assert.equal((await register(base)).status, 201);
  assert.equal((await register(base.toUpperCase())).status, 400);

  const owner = await env.makeUser();
  const tag = uniqueName('tag');
  assert.equal((await env.api('POST', '/api/me/paytag', { token: owner.token, body: { paytag: tag } })).status, 200);
  assert.equal((await register(tag)).status, 400, 'a new username may not equal an existing paytag');
});

test('a $paytag cannot be set to another account\'s username', async () => {
  const alice = await env.makeUser();
  const mallory = await env.makeUser();
  const r = await env.api('POST', '/api/me/paytag', { token: mallory.token, body: { paytag: alice.username } });
  assert.equal(r.status, 400);
});

test('legacy collision: a bare name matching two accounts is refused, $paytag still works', async () => {
  const a = await env.makeUser();
  const b = await env.makeUser();
  const payer = await env.makeUser({ balance: 1000 });
  // Recreate the pre-fix situation directly in the DB: a changed their paytag
  // away from their username, and b then took a's username as a paytag.
  const setupSql = env.sql(`UPDATE users SET paytag = '${a.username}_x' WHERE id = '${a.id}';
                            UPDATE users SET paytag = '${a.username}' WHERE id = '${b.id}';`);
  assert.ok(setupSql.ok, setupSql.err);

  const bare = await env.api('POST', '/api/transfer', { token: payer.token, body: { toUsername: a.username, amount: 100 } });
  assert.equal(bare.status, 400);
  assert.match(bare.data.error, /\$paytag/);
  assert.equal(env.balanceOf(payer.id).g, 1000);

  const tagged = await env.api('POST', '/api/transfer', { token: payer.token, body: { toUsername: `$${a.username}`, amount: 100 } });
  assert.equal(tagged.status, 200);
  assert.equal(env.balanceOf(b.id).g, 100, '$name must resolve to the paytag owner');
  assert.equal(env.balanceOf(a.id).g, 0);

  const lookup = await env.api('GET', `/api/users/${a.username}`, { token: payer.token });
  assert.equal(lookup.status, 409);
});

async function googleSignIn(profile) {
  const start = await env.api('GET', '/api/auth/google/start');
  const state = new URL(start.headers.get('location'), 'http://x').searchParams.get('state');
  const code = Buffer.from(JSON.stringify(profile)).toString('base64url');
  const cb = await env.api('GET', `/api/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`);
  const loc = new URL(cb.headers.get('location'), 'http://x');
  return { token: loc.searchParams.get('oauth_token'), error: loc.searchParams.get('oauth_error') };
}

test('Google sign-in does NOT link into an account whose email was never verified (pre-account takeover)', async () => {
  const victimEmail = `${uniqueName('victim')}@example.test`;
  const attacker = await env.makeUser({ email: victimEmail }); // attacker squats on the victim's email
  const r = await googleSignIn({ providerUserId: uniqueName('g'), email: victimEmail, name: 'Victim' });
  assert.equal(r.token, null);
  assert.match(r.error, /already exists/);
  const links = env.query(`SELECT 1 FROM oauth_identities WHERE user_id = '${attacker.id}'`);
  assert.equal(links.length, 0);
});

test('Google sign-in links into an existing account once its email is verified', async () => {
  const u = await env.makeUser();
  env.sql(`UPDATE users SET email_verified = true WHERE id = '${u.id}';`);
  const r = await googleSignIn({ providerUserId: uniqueName('g'), email: u.email.toUpperCase(), name: 'Owner' });
  assert.ok(r.token, r.error);
  const me = await env.api('GET', '/api/me', { token: r.token });
  assert.equal(me.data.user.id, u.id);
});

test('Google sign-in with a new email creates a verified account', async () => {
  const email = `${uniqueName('new')}@example.test`;
  const r = await googleSignIn({ providerUserId: uniqueName('g'), email, name: 'New Person' });
  assert.ok(r.token, r.error);
  const [row] = env.query(`SELECT email_verified FROM users WHERE email = '${email}'`);
  assert.equal(row.email_verified, true);
});

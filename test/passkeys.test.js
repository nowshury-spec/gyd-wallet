// "Sign in with Face ID" (passkeys). A small simulated authenticator below
// plays the part of the phone: it holds a real key pair and signs exactly
// what an iPhone/Android/Windows device would, so the server's checks run
// against genuine signatures.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup } = require('./harness');

let env;
test.before(async () => {
  env = await setup({ SHOW_CODES_ON_SCREEN: 'true' });
});
test.after(async () => {
  await env.stop();
});

const PASSWORD = 'correct horse 1'; // what harness.makeUser registers with
const b64 = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function makeAuthenticator({ rsa = false, counter = false } = {}) {
  const { privateKey, publicKey } = rsa
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credId = crypto.randomBytes(32);
  let uses = 0;
  const site = () => ({ origin: `http://127.0.0.1:${env.port}`, rpId: '127.0.0.1' });

  function clientData(type, challenge, extra) {
    return b64(JSON.stringify({ type, challenge, origin: site().origin, crossOrigin: false, ...extra }));
  }
  function authData({ flags, attested, rpId, signCount }) {
    const head = Buffer.alloc(37);
    sha256(rpId || site().rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(signCount !== undefined ? signCount : counter ? ++uses : 0, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credId, Buffer.from([0xa0])]);
  }

  return {
    credId: b64(credId),
    privateKey,
    register(options, o = {}) {
      return {
        id: b64(credId),
        rawId: b64(credId),
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', options.publicKey.challenge, o.clientData),
          authenticatorData: b64(authData({ flags: o.flags !== undefined ? o.flags : 0x45, attested: true })),
          publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
          publicKeyAlgorithm: rsa ? -257 : -7,
        },
      };
    },
    login(options, o = {}) {
      const cd = clientData('webauthn.get', options.publicKey.challenge, o.clientData);
      const ad = authData({ flags: o.flags !== undefined ? o.flags : 0x05, rpId: o.rpId, signCount: o.signCount });
      const signedBy = o.signWith || privateKey;
      const signature = crypto.sign('sha256', Buffer.concat([ad, sha256(Buffer.from(cd, 'base64url'))]), signedBy);
      return {
        id: b64(credId),
        rawId: b64(credId),
        type: 'public-key',
        response: { clientDataJSON: cd, authenticatorData: b64(ad), signature: b64(signature), userHandle: o.userHandle },
      };
    },
  };
}

async function enroll(user, authenticator, { name = 'Test phone' } = {}) {
  const options = await env.api('POST', '/api/passkeys/register/options', { token: user.token, body: { password: PASSWORD } });
  assert.equal(options.status, 200, JSON.stringify(options.data));
  const r = await env.api('POST', '/api/passkeys/register', {
    token: user.token,
    body: { token: options.data.token, credential: authenticator.register(options.data), name },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.passkey;
}

async function loginOptions() {
  const o = await env.api('POST', '/api/auth/passkey/options', { body: {} });
  assert.equal(o.status, 200);
  return o.data;
}

async function signIn(authenticator, overrides) {
  const options = await loginOptions();
  return env.api('POST', '/api/auth/passkey/login', {
    body: { token: options.token, credential: authenticator.login(options, overrides) },
  });
}

test('Face ID can be set up and then used to sign in', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  const added = await enroll(u, phone, { name: 'iPhone' });
  assert.equal(added.name, 'iPhone');

  const list = await env.api('GET', '/api/passkeys', { token: u.token });
  assert.deepEqual(list.data.passkeys.map((p) => p.name), ['iPhone']);

  const r = await signIn(phone, { userHandle: b64(u.id) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.id, u.id);
  const me = await env.api('GET', '/api/me', { token: r.data.token });
  assert.equal(me.data.user.id, u.id);
  const [row] = env.query(`SELECT last_used_at FROM passkeys WHERE user_id = '${u.id}'`);
  assert.ok(row.last_used_at);
});

test('Windows Hello style RSA keys work too', async () => {
  const u = await env.makeUser();
  const pc = makeAuthenticator({ rsa: true });
  await enroll(u, pc);
  assert.equal((await signIn(pc)).status, 200);
});

test('setting up Face ID needs the account password, and is tied to that account', async () => {
  const u = await env.makeUser();
  const wrong = await env.api('POST', '/api/passkeys/register/options', { token: u.token, body: { password: 'nope' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.token, undefined);
  assert.equal((await env.api('POST', '/api/passkeys/register/options', { body: { password: PASSWORD } })).status, 401);

  // A set-up started by one account can't be finished by another.
  const other = await env.makeUser();
  const options = await env.api('POST', '/api/passkeys/register/options', { token: u.token, body: { password: PASSWORD } });
  const r = await env.api('POST', '/api/passkeys/register', {
    token: other.token,
    body: { token: options.data.token, credential: makeAuthenticator().register(options.data) },
  });
  assert.equal(r.status, 400);
  assert.equal(env.query(`SELECT 1 FROM passkeys WHERE user_id IN ('${u.id}', '${other.id}')`).length, 0);
});

test('a set-up without Face ID / fingerprint actually checked is refused', async () => {
  const u = await env.makeUser();
  const options = await env.api('POST', '/api/passkeys/register/options', { token: u.token, body: { password: PASSWORD } });
  const r = await env.api('POST', '/api/passkeys/register', {
    token: u.token,
    body: { token: options.data.token, credential: makeAuthenticator().register(options.data, { flags: 0x41 }) },
  });
  assert.equal(r.status, 400);
});

test('a sign-in can only be used once', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  await enroll(u, phone);
  const options = await loginOptions();
  const body = { token: options.token, credential: phone.login(options) };
  assert.equal((await env.api('POST', '/api/auth/passkey/login', { body })).status, 200);
  assert.equal((await env.api('POST', '/api/auth/passkey/login', { body })).status, 401);
});

test('forged or mismatched sign-ins are refused', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  await enroll(u, phone);
  const stranger = makeAuthenticator();

  const cases = {
    'signed by a different key': { signWith: stranger.privateKey },
    'made on another website': { clientData: { origin: 'https://evil.example' } },
    'key for another site': { rpId: 'evil.example' },
    'no Face ID / fingerprint check': { flags: 0x01 },
    'wrong account named': { userHandle: b64('someone-else') },
  };
  for (const [what, overrides] of Object.entries(cases)) {
    const r = await signIn(phone, overrides);
    assert.equal(r.status, 401, what);
    assert.equal(r.data.token, undefined, what);
  }
  assert.equal((await signIn(stranger)).status, 401, 'device never set up');

  // A response made for one challenge, sent with another challenge's token.
  const a = await loginOptions();
  const b = await loginOptions();
  const r = await env.api('POST', '/api/auth/passkey/login', { body: { token: b.token, credential: phone.login(a) } });
  assert.equal(r.status, 401, 'challenge swapped');

  // The real thing still works afterwards.
  assert.equal((await signIn(phone)).status, 200);
});

test('a Face ID challenge token is never accepted as a login session', async () => {
  const options = await loginOptions();
  assert.equal((await env.api('GET', '/api/me', { token: options.token })).status, 401);
  const u = await env.makeUser();
  const reg = await env.api('POST', '/api/passkeys/register/options', { token: u.token, body: { password: PASSWORD } });
  assert.equal((await env.api('GET', '/api/me', { token: reg.data.token })).status, 401);
});

test('keys that count their uses must count upwards (a copied key is refused)', async () => {
  const u = await env.makeUser();
  const key = makeAuthenticator({ counter: true });
  await enroll(u, key);
  assert.equal((await signIn(key)).status, 200);
  assert.equal((await signIn(key)).status, 200);
  assert.equal((await signIn(key, { signCount: 1 })).status, 401);
});

test('removing a device turns Face ID off there, and only the owner can remove it', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  const added = await enroll(u, phone);
  const other = await env.makeUser();
  assert.equal((await env.api('DELETE', `/api/passkeys/${added.id}`, { token: other.token })).status, 404);
  assert.equal((await signIn(phone)).status, 200);
  assert.equal((await env.api('DELETE', `/api/passkeys/${added.id}`, { token: u.token })).status, 200);
  assert.equal((await signIn(phone)).status, 401);
});

test('a password reset turns Face ID off on every device', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  await enroll(u, phone);
  const fp = await env.api('POST', '/api/auth/forgot-password', { body: { email: u.email } });
  const reset = await env.api('POST', '/api/auth/reset-password', { body: { email: u.email, code: fp.data.code, newPassword: 'a brand new pw' } });
  assert.equal(reset.status, 200);
  assert.equal(env.query(`SELECT 1 FROM passkeys WHERE user_id = '${u.id}'`).length, 0);
  assert.equal((await signIn(phone)).status, 401);
});

test('deleting the account erases its Face ID keys', async () => {
  const u = await env.makeUser();
  const phone = makeAuthenticator();
  await enroll(u, phone);
  const del = await env.api('POST', '/api/account/delete', { token: u.token, body: { password: PASSWORD } });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(env.query(`SELECT 1 FROM passkeys WHERE user_id = '${u.id}'`).length, 0);
  assert.equal((await signIn(phone)).status, 401);
});

test('"Log out of all devices" also turns Face ID off, so nobody can sign straight back in', async () => {
  const u = await env.makeUser();
  const ownPhone = makeAuthenticator();
  const intrudersPhone = makeAuthenticator();
  await enroll(u, ownPhone);
  await enroll(u, intrudersPhone); // someone who once had the password
  assert.equal((await signIn(intrudersPhone)).status, 200);

  const out = await env.api('POST', '/api/security/logout-all-sessions', { token: u.token });
  assert.equal(out.status, 200);
  assert.equal((await env.api('GET', '/api/me', { token: u.token })).status, 401, 'old session ended');
  assert.equal((await signIn(intrudersPhone)).status, 401, 'Face ID no longer gets back in');
  assert.equal((await signIn(ownPhone)).status, 401);
  assert.equal(env.query(`SELECT 1 FROM passkeys WHERE user_id = '${u.id}'`).length, 0);

  // The owner logs in with the password and can turn Face ID on again.
  const login = await env.api('POST', '/api/login', { body: { username: u.username, password: PASSWORD } });
  assert.equal(login.status, 200);
  await enroll({ ...u, token: login.data.token }, makeAuthenticator());
});

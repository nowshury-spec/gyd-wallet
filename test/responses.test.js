// The "user" object each money endpoint returns is now built from values the
// write already returned instead of re-reading the row. These tests check the
// response matches what's actually in the database afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, uniqueName } = require('./harness');
const { hashPassword } = require('../auth');

let env;
let staffToken;
test.before(async () => {
  env = await setup({ SHOW_CODES_ON_SCREEN: 'true' });
  const username = uniqueName('staff');
  const { salt, hash } = await hashPassword('staff password 123');
  env.sql(`INSERT INTO staff_accounts (id, username, password_hash, password_salt, role, created_at)
           VALUES ('${username}', '${username}', '${hash}', '${salt}', 'employee', now()::text);`);
  const login = await env.api('POST', '/api/staff/login', { body: { username, password: 'staff password 123' } });
  staffToken = (await env.api('POST', '/api/staff/login/verify-code', { body: { username, code: login.data.code } })).data.token;
});
test.after(async () => {
  await env.stop();
});

function assertMatchesDb(apiUser, userId) {
  const db = env.balanceOf(userId);
  assert.equal(Number(apiUser.gydBalance), db.g, 'gydBalance');
  assert.equal(Number(apiUser.businessGydBalance), db.b, 'businessGydBalance');
  assert.equal(Number(apiUser.courierGydBalance), db.c, 'courierGydBalance');
}

test('deposit returns the real new balance', async () => {
  const u = await env.makeUser({ balance: 10 });
  const r = await env.api('POST', '/api/wallet/deposit', { token: u.token, body: { amount: 5.25 } });
  assert.equal(r.status, 200);
  assertMatchesDb(r.data.user, u.id);
});

test('a deposit that fails is not recorded in the transaction history', async () => {
  const u = await env.makeUser();
  // One more deposit here overflows NUMERIC(14,2), so the balance update fails.
  env.sql(`UPDATE users SET gyd_balance = 999999999999 WHERE id = '${u.id}';`);
  const r = await env.api('POST', '/api/wallet/deposit', { token: u.token, body: { amount: 1000000000 } });
  assert.notEqual(r.status, 200);
  const logged = env.query(`SELECT 1 FROM transactions WHERE type = 'deposit' AND to_user = '${u.id}'`);
  assert.equal(logged.length, 0, 'no deposit may be logged when the balance never changed');
});

test('cash-out, transfer, and GYD Direct return the real balances', async () => {
  const a = await env.makeUser({ balance: 5000 });
  const b = await env.makeUser();
  let r = await env.api('POST', '/api/wallet/cashout', { token: a.token, body: { amount: 100 } });
  assertMatchesDb(r.data.user, a.id);
  r = await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 250.5 } });
  assertMatchesDb(r.data.user, a.id);
  r = await env.api('POST', '/api/remit', { token: a.token, body: { recipientName: 'Jo', recipientPhone: '+5926000000', amount: 1000 } });
  assert.equal(r.status, 201);
  assertMatchesDb(r.data.user, a.id);
  const sent = await env.api('GET', '/api/remit/sent', { token: a.token });
  assert.deepEqual(
    { ...r.data.remittance, smsSent: undefined },
    { ...sent.data.remittances.find((x) => x.id === r.data.remittance.id), smsSent: undefined },
    'the returned remittance must match what was stored'
  );
});

test('paying a money request and approving/declining a charge return the real balance', async () => {
  const payer = await env.makeUser({ balance: 5000 });
  const requester = await env.makeUser();
  const req = await env.api('POST', '/api/requests', { token: requester.token, body: { toHandle: payer.username, amount: 40 } });
  let r = await env.api('POST', `/api/requests/${req.data.id}/pay`, { token: payer.token });
  assertMatchesDb(r.data.user, payer.id);

  const biz = await env.makeUser({ business: true });
  const c1 = await env.api('POST', '/api/business/charge-requests', { token: biz.token, body: { customerUsername: payer.username, amount: 60 } });
  r = await env.api('POST', `/api/business/charge-requests/${c1.data.id}/approve`, { token: payer.token });
  assertMatchesDb(r.data.user, payer.id);
  const c2 = await env.api('POST', '/api/business/charge-requests', { token: biz.token, body: { customerUsername: payer.username, amount: 70 } });
  r = await env.api('POST', `/api/business/charge-requests/${c2.data.id}/decline`, { token: payer.token });
  assertMatchesDb(r.data.user, payer.id);
});

test('business and courier wallet moves, and delivery confirmation, return the real balances', async () => {
  const biz = await env.makeUser({ business: true });
  env.sql(`UPDATE users SET business_gyd_balance = 300 WHERE id = '${biz.id}';`);
  let r = await env.api('POST', '/api/business/wallet/move-to-personal', { token: biz.token, body: { amount: 120 } });
  assertMatchesDb(r.data.user, biz.id);

  const courier = await env.makeUser();
  const apply = await env.api('POST', '/api/account/apply-courier', { token: courier.token, body: {} });
  await env.api('POST', `/api/staff/courier-applications/${apply.data.application.id}/approve`, { token: staffToken });
  const customer = await env.makeUser();
  const code = `RC${Date.now()}`;
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at, delivery_fee_gyd, delivery_code, courier_id)
           VALUES ('resp-deliv', '${customer.id}', 'out_for_delivery', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text, 500, '${code}', '${courier.id}');`);
  r = await env.api('POST', '/api/courier/deliveries/resp-deliv/confirm', { token: courier.token, body: { code } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assertMatchesDb(r.data.user, courier.id);
  assert.equal(r.data.order.status, 'delivered');
  r = await env.api('POST', '/api/courier/wallet/move-to-personal', { token: courier.token, body: { amount: 200 } });
  assertMatchesDb(r.data.user, courier.id);
});

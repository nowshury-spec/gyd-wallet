const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { setup, uniqueName } = require('./harness');
const { hashPassword } = require('../auth');

let env;
let staffToken;
test.before(async () => {
  // Demo mode so the test can read the staff 2FA code from the response.
  env = await setup({ SHOW_CODES_ON_SCREEN: 'true' });
  const username = uniqueName('staff');
  const { salt, hash } = hashPassword('staff password 123');
  env.sql(`INSERT INTO staff_accounts (id, username, password_hash, password_salt, role, created_at)
           VALUES ('${username}', '${username}', '${hash}', '${salt}', 'employee', now()::text);`);
  const login = await env.api('POST', '/api/staff/login', { body: { username, password: 'staff password 123' } });
  const verify = await env.api('POST', '/api/staff/login/verify-code', { body: { username, code: login.data.code } });
  staffToken = verify.data.token;
  assert.ok(staffToken);
});
test.after(async () => {
  await env.stop();
});

async function approvedCourier() {
  const u = await env.makeUser();
  const apply = await env.api('POST', '/api/account/apply-courier', { token: u.token, body: {} });
  const approve = await env.api('POST', `/api/staff/courier-applications/${apply.data.application.id}/approve`, { token: staffToken });
  assert.equal(approve.status, 200);
  return u;
}

test('rapid repeated "apply" taps create only one pending application', async () => {
  const u = await env.makeUser();
  const results = await Promise.all(Array.from({ length: 6 }, () => env.api('POST', '/api/account/apply-courier', { token: u.token, body: {} })));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201));
  const ids = new Set(results.map((r) => r.data.application.id));
  assert.equal(ids.size, 1);
  const [{ n }] = env.query(`SELECT count(*)::int AS n FROM courier_applications WHERE user_id = '${u.id}' AND status = 'pending'`);
  assert.equal(n, 1);
});

test('revoking a courier releases their deliveries, pays out their courier wallet, and removes access', async () => {
  const courier = await approvedCourier();
  const customer = await env.makeUser();
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at, delivery_fee_gyd, delivery_code)
           VALUES ('deliv-1', '${customer.id}', 'awaiting_courier', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text, 500, 'CODE${Date.now()}');
           UPDATE users SET courier_gyd_balance = 700 WHERE id = '${courier.id}';`);
  const claim = await env.api('POST', '/api/courier/deliveries/deliv-1/claim', { token: courier.token });
  assert.equal(claim.status, 200);

  const apps = await env.api('GET', '/api/staff/courier-applications?status=approved', { token: staffToken });
  const mine = apps.data.applications.find((a) => a.userId === courier.id);
  assert.ok(mine, 'staff listing must include userId');

  const r = await env.api('POST', `/api/staff/couriers/${courier.id}/revoke`, { token: staffToken, body: { reason: 'Left the team' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.swept, 700);
  assert.equal(r.data.released, 1);

  const [order] = env.query(`SELECT status, courier_id FROM dropshipping_orders WHERE id = 'deliv-1'`);
  assert.equal(order.status, 'awaiting_courier');
  assert.equal(order.courier_id, null);
  const bal = env.balanceOf(courier.id);
  assert.equal(bal.g, 700);
  assert.equal(bal.c, 0);
  assert.equal((await env.api('GET', '/api/courier/deliveries/mine', { token: courier.token })).status, 403);

  const own = await env.api('GET', '/api/account/courier-application', { token: courier.token });
  assert.equal(own.data.application.status, 'revoked');
  assert.equal(own.data.application.staffNote, 'Left the team');

  const again = await env.api('POST', `/api/staff/couriers/${courier.id}/revoke`, { token: staffToken, body: {} });
  assert.equal(again.status, 400);
});

test('re-running the schema closes pre-existing duplicate pending applications', async () => {
  const u = await env.makeUser();
  const setupSql = env.sql(`DROP INDEX uniq_courier_applications_one_pending;
    INSERT INTO courier_applications (id, user_id, status, created_at) VALUES
      ('dup-1', '${u.id}', 'pending', '2026-01-01T00:00:00.000Z'),
      ('dup-2', '${u.id}', 'pending', '2026-01-02T00:00:00.000Z');`);
  assert.ok(setupSql.ok, setupSql.err);
  env.sqlFile(path.join(__dirname, '..', 'supabase', 'schema.sql'));
  const rows = env.query(`SELECT id, status FROM courier_applications WHERE user_id = '${u.id}' ORDER BY id`);
  assert.deepEqual(rows, [
    { id: 'dup-1', status: 'pending' },
    { id: 'dup-2', status: 'rejected' },
  ]);
  const [idx] = env.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'uniq_courier_applications_one_pending'`);
  assert.equal(idx.n, 1);
});

test('confirming the same delivery twice at once pays the courier only once', async () => {
  const courier = await approvedCourier();
  const customer = await env.makeUser();
  const code = `DC${Date.now()}`;
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at, delivery_fee_gyd, delivery_code, courier_id)
           VALUES ('deliv-race', '${customer.id}', 'out_for_delivery', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text, 500, '${code}', '${courier.id}');`);
  const undo = env.slowWrites('users');
  let results;
  try {
    results = await Promise.all(
      [1, 2].map(() => env.api('POST', '/api/courier/deliveries/deliv-race/confirm', { token: courier.token, body: { code } }))
    );
  } finally {
    undo();
  }
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(courier.id).c, 500);
});

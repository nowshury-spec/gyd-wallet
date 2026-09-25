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

test('exec_query: a value containing another placeholder is not re-expanded (SQL injection)', async () => {
  const victim = await env.makeUser();
  const payload = '||(SELECT string_agg(password_hash, chr(44)) FROM users)||';
  const r = env.sql(
    `SELECT public.exec_query('INSERT INTO users (id, username, email, password_hash, password_salt, business_name, created_at) VALUES ($1, $2, $3, $4, $4, $5, $4)',
       '["attacker-row", ${JSON.stringify(payload)}, "atk@example.test", "x", "$2"]'::jsonb);`,
    { role: 'service_role' }
  );
  assert.ok(r.ok, r.err);
  const [row] = env.query(`SELECT business_name FROM users WHERE id = 'attacker-row'`);
  assert.equal(row.business_name, '$2');
  assert.ok(victim.id);
});

test('a malformed URL gets a 400 and does not crash the server', async () => {
  const bad = await fetch(`http://127.0.0.1:${env.port}/%E0%A4%A`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${env.port}/index.html`);
  assert.equal(ok.status, 200);
});

test('security headers include the tightened CSP', async () => {
  const r = await fetch(`http://127.0.0.1:${env.port}/`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
});

test('P2P transfer moves exactly the amount, and refuses to overdraw', async () => {
  const a = await env.makeUser({ balance: 1000 });
  const b = await env.makeUser();
  const r = await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 250.5 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.balanceOf(a.id).g, 749.5);
  assert.equal(env.balanceOf(b.id).g, 250.5);
  const over = await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 5000 } });
  assert.equal(over.status, 400);
  assert.equal(env.balanceOf(a.id).g, 749.5);
});

test('choosing delivery without enough GYD leaves the order untouched (no unpaid order on the courier board)', async () => {
  const u = await env.makeUser({ balance: 100 });
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at)
           VALUES ('ord-poor', '${u.id}', 'arrived_at_warehouse', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text);`);
  const r = await env.api('POST', '/api/dropshipping/orders/ord-poor/choose-fulfillment', { token: u.token, body: { fulfillment: 'delivery' } });
  assert.equal(r.status, 400);
  const [o] = env.query(`SELECT status, delivery_fee_gyd, delivery_code FROM dropshipping_orders WHERE id = 'ord-poor'`);
  assert.equal(o.status, 'arrived_at_warehouse');
  assert.equal(Number(o.delivery_fee_gyd), 0);
  assert.equal(o.delivery_code, null);
  assert.equal(env.balanceOf(u.id).g, 100);
});

test('choosing delivery with enough GYD charges the fee once and moves the order', async () => {
  const u = await env.makeUser({ balance: 1000 });
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at)
           VALUES ('ord-ok', '${u.id}', 'arrived_at_warehouse', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text);`);
  const [r1, r2] = await Promise.all([
    env.api('POST', '/api/dropshipping/orders/ord-ok/choose-fulfillment', { token: u.token, body: { fulfillment: 'delivery' } }),
    env.api('POST', '/api/dropshipping/orders/ord-ok/choose-fulfillment', { token: u.token, body: { fulfillment: 'delivery' } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 400]);
  const [o] = env.query(`SELECT status, delivery_fee_gyd::float AS fee FROM dropshipping_orders WHERE id = 'ord-ok'`);
  assert.equal(o.status, 'awaiting_courier');
  assert.equal(o.fee, 500);
  assert.equal(env.balanceOf(u.id).g, 500);
});

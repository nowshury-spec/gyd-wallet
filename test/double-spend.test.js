// Double-submit races on the flows where a status is checked on one row and
// money moves on another. Each test slows down writes to `users` so the two
// requests are guaranteed to overlap inside Postgres (see slowWrites).
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

async function twiceAtOnce(fn) {
  const undo = env.slowWrites('users');
  try {
    return await Promise.all([fn(), fn()]);
  } finally {
    undo();
  }
}

test('paying the same money request twice at once charges only once', async () => {
  const requester = await env.makeUser();
  const payer = await env.makeUser({ balance: 10000 });
  const reqRes = await env.api('POST', '/api/requests', { token: requester.token, body: { toHandle: payer.username, amount: 100 } });
  assert.equal(reqRes.status, 201);
  const results = await twiceAtOnce(() => env.api('POST', `/api/requests/${reqRes.data.id}/pay`, { token: payer.token }));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(payer.id).g, 9900);
  assert.equal(env.balanceOf(requester.id).g, 100);
});

test('approving the same charge request twice at once charges only once', async () => {
  const biz = await env.makeUser({ business: true });
  const customer = await env.makeUser({ balance: 10000 });
  const cr = await env.api('POST', '/api/business/charge-requests', { token: biz.token, body: { customerUsername: customer.username, amount: 100 } });
  assert.equal(cr.status, 201);
  const results = await twiceAtOnce(() => env.api('POST', `/api/business/charge-requests/${cr.data.id}/approve`, { token: customer.token }));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(customer.id).g, 9900);
  assert.equal(env.balanceOf(biz.id).b, 100);
});

test('choosing paid delivery twice at once charges the fee only once', async () => {
  const u = await env.makeUser({ balance: 10000 });
  env.sql(`INSERT INTO dropshipping_orders (id, user_id, status, items, total_usd, total_gyd, platform_fee_gyd, total_weight_kg, usd_to_gyd_rate, amount_charged_gyd, shipping_address, created_at)
           VALUES ('race-deliv', '${u.id}', 'arrived_at_warehouse', '[]', 1, 210, 6, 1, 210, 216, '{}', now()::text);`);
  const results = await twiceAtOnce(() =>
    env.api('POST', '/api/dropshipping/orders/race-deliv/choose-fulfillment', { token: u.token, body: { fulfillment: 'delivery' } })
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(u.id).g, 9500);
});

test('two simultaneous transfers cannot overdraw a balance', async () => {
  const a = await env.makeUser({ balance: 100 });
  const b = await env.makeUser();
  const c = await env.makeUser();
  const undo = env.slowWrites('users');
  let results;
  try {
    results = await Promise.all([
      env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 100 } }),
      env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: c.username, amount: 100 } }),
    ]);
  } finally {
    undo();
  }
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(a.id).g, 0);
  assert.equal(env.balanceOf(b.id).g + env.balanceOf(c.id).g, 100);
});

test('two simultaneous cash-outs cannot overdraw a balance', async () => {
  const a = await env.makeUser({ balance: 100 });
  const results = await twiceAtOnce(() => env.api('POST', '/api/wallet/cashout', { token: a.token, body: { amount: 100 } }));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(a.id).g, 0);
  const [{ n }] = env.query(`SELECT count(*)::int AS n FROM cashout_requests WHERE user_id = '${a.id}'`);
  assert.equal(n, 1);
});

test('a GYD Direct transfer can only be picked up once, even by two people at once', async () => {
  const sender = await env.makeUser({ balance: 5000 });
  const rem = await env.api('POST', '/api/remit', { token: sender.token, body: { recipientName: 'Jo Smith', recipientPhone: '1', amount: 1000 } });
  const x = await env.makeUser();
  const y = await env.makeUser();
  const undo = env.slowWrites('users');
  let results;
  try {
    results = await Promise.all(
      [x, y].map((u) => env.api('POST', '/api/remit/claim', { token: u.token, body: { referenceCode: rem.data.remittance.referenceCode, recipientName: 'Jo Smith' } }))
    );
  } finally {
    undo();
  }
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(x.id).g + env.balanceOf(y.id).g, 1000);
});

test('a GYD Direct transfer cannot be both picked up and refunded', async () => {
  const sender = await env.makeUser({ balance: 5000 });
  const rem = await env.api('POST', '/api/remit', { token: sender.token, body: { recipientName: 'Jo Smith', recipientPhone: '1', amount: 1000 } });
  const afterSend = env.balanceOf(sender.id).g;
  const taker = await env.makeUser();
  const undo = env.slowWrites('users');
  let results;
  try {
    results = await Promise.all([
      env.api('POST', '/api/remit/claim', { token: taker.token, body: { referenceCode: rem.data.remittance.referenceCode, recipientName: 'Jo Smith' } }),
      env.api('POST', `/api/remit/${rem.data.remittance.id}/cancel`, { token: sender.token }),
    ]);
  } finally {
    undo();
  }
  assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(','));
  const refunded = env.balanceOf(sender.id).g > afterSend;
  const claimed = env.balanceOf(taker.id).g > 0;
  assert.ok(refunded !== claimed, 'exactly one of refund / pickup may happen');
});

test('moving business earnings twice at once cannot overdraw the business wallet', async () => {
  const biz = await env.makeUser({ business: true });
  env.sql(`UPDATE users SET business_gyd_balance = 100 WHERE id = '${biz.id}';`);
  const results = await twiceAtOnce(() => env.api('POST', '/api/business/wallet/move-to-personal', { token: biz.token, body: { amount: 100 } }));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  const bal = env.balanceOf(biz.id);
  assert.equal(bal.b, 0);
  assert.equal(bal.g, 100);
});

test('a pickup order cannot be both redeemed by the business and cancelled by the customer', async () => {
  const biz = await env.makeUser({ business: true });
  const customer = await env.makeUser({ balance: 1000 });
  const chk = await env.api('POST', '/api/business/checkout', { token: customer.token, body: { businessHandle: biz.username, amount: 500 } });
  const order = chk.data.order;
  const undo = env.slowWrites('users');
  let results;
  try {
    results = await Promise.all([
      env.api('POST', `/api/business/orders/${order.pickupCode}/redeem`, { token: biz.token }),
      env.api('POST', `/api/orders/${order.id}/cancel`, { token: customer.token }),
    ]);
  } finally {
    undo();
  }
  const paidBiz = env.balanceOf(biz.id).b === 500;
  const refunded = env.balanceOf(customer.id).g === 1000;
  assert.ok(paidBiz !== refunded, `exactly one outcome (business paid: ${paidBiz}, customer refunded: ${refunded})`);
});

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

test('money columns are exact decimals and small amounts add up exactly', async () => {
  const [col] = env.query(
    `SELECT data_type, numeric_scale FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'gyd_balance'`
  );
  assert.equal(col.data_type, 'numeric');
  assert.equal(col.numeric_scale, 2);
  const a = await env.makeUser({ balance: 1 });
  const b = await env.makeUser();
  for (let i = 0; i < 3; i++) {
    const r = await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 0.1 } });
    assert.equal(r.status, 200);
  }
  const [row] = env.query(`SELECT gyd_balance::text AS g FROM users WHERE id = '${b.id}'`);
  assert.equal(row.g, '0.30');
});

test('amounts must be whole cents and within range', async () => {
  const a = await env.makeUser({ balance: 1000 });
  const b = await env.makeUser();
  for (const amount of [0.001, 1.005, 2e9, -5, 0]) {
    const r = await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount } });
    assert.equal(r.status, 400, `amount ${amount}`);
  }
  assert.equal(env.balanceOf(a.id).g, 1000);
});

async function makeEvent(biz, { capacity = null, ticketPrice = 1000 } = {}) {
  const r = await env.api('POST', '/api/business/events', {
    token: biz.token,
    body: { title: 'Show', eventDate: '2027-01-01T20:00', ticketPrice, capacity },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.events[0];
}

test('concurrent buyers cannot oversell an event', async () => {
  const biz = await env.makeUser({ business: true });
  const ev = await makeEvent(biz, { capacity: 3, ticketPrice: 1000 });
  const buyers = await Promise.all(Array.from({ length: 8 }, () => env.makeUser({ balance: 5000 })));
  const results = await Promise.all(buyers.map((b) => env.api('POST', `/api/events/${ev.id}/purchase`, { token: b.token, body: { quantity: 1 } })));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 3, results.map((r) => r.status).join(','));
  const [{ n }] = env.query(`SELECT count(*)::int AS n FROM event_tickets WHERE event_id = '${ev.id}'`);
  assert.equal(n, 3);
  const charged = buyers.filter((b) => env.balanceOf(b.id).g === 4000).length;
  const untouched = buyers.filter((b) => env.balanceOf(b.id).g === 5000).length;
  assert.equal(charged, 3);
  assert.equal(untouched, 5);
  // 3 tickets × (1000 − 35 platform fee)
  assert.equal(env.balanceOf(biz.id).b, 2895);
  for (const r of ok) assert.equal(r.data.tickets.length, 1);
});

test('cancelling an event refunds every ticket holder in full and voids the tickets', async () => {
  const biz = await env.makeUser({ business: true });
  const ev = await makeEvent(biz, { ticketPrice: 1000 });
  const b1 = await env.makeUser({ balance: 5000 });
  const b2 = await env.makeUser({ balance: 5000 });
  const p1 = await env.api('POST', `/api/events/${ev.id}/purchase`, { token: b1.token, body: { quantity: 2 } });
  const p2 = await env.api('POST', `/api/events/${ev.id}/purchase`, { token: b2.token, body: { quantity: 1 } });
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 201);
  assert.equal(env.balanceOf(biz.id).b, 2895);

  const cancel = await env.api('POST', `/api/business/events/${ev.id}/cancel`, { token: biz.token });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.refundedTickets, 3);
  assert.equal(env.balanceOf(b1.id).g, 5000);
  assert.equal(env.balanceOf(b2.id).g, 5000);
  assert.equal(env.balanceOf(biz.id).b, 0);

  const statuses = env.query(`SELECT DISTINCT status FROM event_tickets WHERE event_id = '${ev.id}'`);
  assert.deepEqual(statuses.map((s) => s.status), ['refunded']);
  const code = p1.data.tickets[0].ticketCode;
  const checkin = await env.api('POST', `/api/business/events/tickets/${code}/check-in`, { token: biz.token });
  assert.equal(checkin.data.ok, false);
  assert.equal(checkin.data.reason, 'refunded');
  const late = await env.api('POST', `/api/events/${ev.id}/purchase`, { token: b1.token, body: { quantity: 1 } });
  assert.equal(late.status, 400);
});

test('an event cannot be cancelled if the business wallet cannot cover the refunds', async () => {
  const biz = await env.makeUser({ business: true });
  const ev = await makeEvent(biz, { ticketPrice: 1000 });
  const b = await env.makeUser({ balance: 5000 });
  await env.api('POST', `/api/events/${ev.id}/purchase`, { token: b.token, body: { quantity: 1 } });
  const move = await env.api('POST', '/api/business/wallet/move-to-personal', { token: biz.token, body: { amount: 965 } });
  assert.equal(move.status, 200);
  const cancel = await env.api('POST', `/api/business/events/${ev.id}/cancel`, { token: biz.token });
  assert.equal(cancel.status, 400);
  const [row] = env.query(`SELECT status FROM business_events WHERE id = '${ev.id}'`);
  assert.equal(row.status, 'active');
  assert.equal(env.balanceOf(b.id).g, 4000);
});

test('a ticket can only be checked in once, even with simultaneous scans', async () => {
  const biz = await env.makeUser({ business: true });
  const ev = await makeEvent(biz);
  const b = await env.makeUser({ balance: 5000 });
  const p = await env.api('POST', `/api/events/${ev.id}/purchase`, { token: b.token, body: { quantity: 1 } });
  const code = p.data.tickets[0].ticketCode;
  const scans = await Promise.all(Array.from({ length: 4 }, () => env.api('POST', `/api/business/events/tickets/${code}/check-in`, { token: biz.token })));
  assert.equal(scans.filter((s) => s.data.ok).length, 1);
});

async function pickupOrder(customer, biz, amount = 500) {
  const r = await env.api('POST', '/api/business/checkout', { token: customer.token, body: { businessHandle: biz.username, amount } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.order;
}

test('a customer cannot cancel a pickup order the business has locked', async () => {
  const biz = await env.makeUser({ business: true });
  const c = await env.makeUser({ balance: 1000 });
  const order = await pickupOrder(c, biz);
  assert.equal((await env.api('POST', `/api/business/orders/${order.id}/lock`, { token: biz.token })).status, 200);
  const r = await env.api('POST', `/api/orders/${order.id}/cancel`, { token: c.token });
  assert.equal(r.status, 400);
  assert.equal(env.balanceOf(c.id).g, 500);
});

test('a customer cannot cancel a pickup order after its pickup window ends', async () => {
  const biz = await env.makeUser({ business: true });
  const c = await env.makeUser({ balance: 1000 });
  const order = await pickupOrder(c, biz);
  env.sql(`UPDATE business_orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${order.id}';`);
  const r = await env.api('POST', `/api/orders/${order.id}/cancel`, { token: c.token });
  assert.equal(r.status, 400);
  assert.equal(env.balanceOf(c.id).g, 500);
});

test('a customer can still cancel an unlocked, unexpired pickup order', async () => {
  const biz = await env.makeUser({ business: true });
  const c = await env.makeUser({ balance: 1000 });
  const order = await pickupOrder(c, biz);
  const r = await env.api('POST', `/api/orders/${order.id}/cancel`, { token: c.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.balanceOf(c.id).g, 1000);
});

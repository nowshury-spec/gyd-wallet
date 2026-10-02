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

const del = (u, password = 'correct horse 1') => env.api('POST', '/api/account/delete', { token: u.token, body: { password } });

test('deleting an account erases personal details, keeps payment records, and locks the account out', async () => {
  const a = await env.makeUser({ balance: 500 });
  const b = await env.makeUser();
  assert.equal((await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 500 } })).status, 200);
  await env.api('POST', '/api/messages', { token: b.token, body: { toUsername: a.username, body: 'thanks!' } });

  const r = await del(a);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const [row] = env.query(`SELECT username, paytag, email, deleted_at IS NOT NULL AS gone FROM users WHERE id = '${a.id}'`);
  assert.equal(row.gone, true);
  assert.equal(row.email, null);
  assert.equal(row.paytag, null);
  assert.match(row.username, /^deleted-[0-9a-f]{12}$/);
  const [{ n: msgs }] = env.query(`SELECT count(*)::int AS n FROM messages WHERE from_user = '${a.id}' OR to_user = '${a.id}'`);
  assert.equal(msgs, 0);
  // The other person's payment history is untouched.
  const [{ n: txs }] = env.query(`SELECT count(*)::int AS n FROM transactions WHERE from_user = '${a.id}' AND to_user = '${b.id}'`);
  assert.equal(txs, 1);

  // The old session, the old password and the old name all stop working.
  assert.equal((await env.api('GET', '/api/me', { token: a.token })).status, 401);
  assert.equal((await env.api('POST', '/api/login', { body: { username: a.username, password: 'correct horse 1' } })).status, 401);
  assert.equal((await env.api('POST', '/api/login', { body: { username: row.username, password: 'deleted' } })).status, 401);
  // Nobody can pay or message the dead account, even by its placeholder name.
  for (const name of [a.username, row.username]) {
    const pay = await env.api('POST', '/api/transfer', { token: b.token, body: { toUsername: name, amount: 1 } });
    assert.equal(pay.status, 400, `paying ${name} must be refused cleanly`);
    assert.match(pay.data.error, /No user with that username/);
    const msg = await env.api('POST', '/api/messages', { token: b.token, body: { toUsername: name, body: 'hi' } });
    assert.equal(msg.status, 400);
  }
  assert.equal(env.balanceOf(b.id).g, 500, 'the would-be payer keeps their money');
  // The username is free for someone new.
  const reuse = await env.api('POST', '/api/register', { body: { username: a.username, email: a.email, password: 'correct horse 1' } });
  assert.equal(reuse.status, 201, JSON.stringify(reuse.data));
});

test('a wrong password does not delete, and repeated guesses are limited', async () => {
  const u = await env.makeUser();
  for (let i = 0; i < 8; i++) assert.equal((await del(u, 'wrong password')).status, 400);
  assert.equal((await del(u)).status, 429, 'locked after 8 wrong guesses');
  const [row] = env.query(`SELECT deleted_at FROM users WHERE id = '${u.id}'`);
  assert.equal(row.deleted_at, null);
});

test('money still in the account, or in motion, blocks deletion', async () => {
  const withBalance = await env.makeUser({ balance: 10 });
  const r1 = await del(withBalance);
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /balance must be GYD 0/);

  const bizMoney = await env.makeUser({ business: true });
  env.sql(`UPDATE users SET business_gyd_balance = 5 WHERE id = '${bizMoney.id}'`);
  assert.match((await del(bizMoney)).data.error, /balance must be GYD 0/);

  const cashingOut = await env.makeUser({ balance: 100 });
  assert.equal((await env.api('POST', '/api/wallet/cashout', { token: cashingOut.token, body: { amount: 100 } })).status, 200);
  assert.match((await del(cashingOut)).data.error, /cash-out request/);

  const remitter = await env.makeUser({ balance: 1000 });
  const remit = await env.api('POST', '/api/remit', { token: remitter.token, body: { recipientName: 'Jo', recipientPhone: '+5926000000', amount: 100 } });
  assert.equal(remit.status, 201, JSON.stringify(remit.data));
  env.sql(`UPDATE users SET gyd_balance = 0 WHERE id = '${remitter.id}'`);
  assert.match((await del(remitter)).data.error, /GYD Direct/);

  for (const u of [withBalance, bizMoney, cashingOut, remitter]) {
    const [row] = env.query(`SELECT deleted_at FROM users WHERE id = '${u.id}'`);
    assert.equal(row.deleted_at, null);
  }
});

test('a business with sold tickets must cancel the event first; one without is closed down cleanly', async () => {
  const biz = await env.makeUser({ business: true });
  const buyer = await env.makeUser({ balance: 5000 });
  const ev = await env.api('POST', '/api/business/events', { token: biz.token, body: { title: 'Show', eventDate: '2027-01-01T20:00', ticketPrice: 1000 } });
  assert.equal(ev.status, 201, JSON.stringify(ev.data));
  const eventId = ev.data.events[0].id;
  assert.equal((await env.api('POST', `/api/events/${eventId}/purchase`, { token: buyer.token, body: { quantity: 1 } })).status, 201);
  env.sql(`UPDATE users SET business_gyd_balance = 0, gyd_balance = 0 WHERE id = '${biz.id}'`);
  assert.match((await del(biz)).data.error, /tickets sold/);

  const other = await env.makeUser({ business: true });
  await env.api('POST', '/api/business/events', { token: other.token, body: { title: 'Empty', eventDate: '2027-01-01T20:00', ticketPrice: 1000 } });
  await env.api('POST', '/api/business/products', { token: other.token, body: { name: 'Cake', price: 100 } });
  assert.equal((await del(other)).status, 200);
  const [e] = env.query(`SELECT status FROM business_events WHERE business_id = '${other.id}'`);
  assert.equal(e.status, 'cancelled');
  const [{ n }] = env.query(`SELECT count(*)::int AS n FROM business_products WHERE business_id = '${other.id}'`);
  assert.equal(n, 0);
  const [u] = env.query(`SELECT is_business, business_name FROM users WHERE id = '${other.id}'`);
  assert.equal(u.is_business, 0);
  assert.equal(u.business_name, null);
});

test('the database refuses to credit an account once it is deleted', async () => {
  const u = await env.makeUser();
  assert.equal((await del(u)).status, 200);
  const r = env.sql(`UPDATE users SET gyd_balance = gyd_balance + 1 WHERE id = '${u.id}'`);
  assert.equal(r.ok, false);
  assert.match(r.err, /users_deleted_accounts_hold_no_money/);
});

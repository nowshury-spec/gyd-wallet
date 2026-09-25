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

async function send(sender, recipientName = 'Jane Doe', amount = 1000) {
  const r = await env.api('POST', '/api/remit', { token: sender.token, body: { recipientName, recipientPhone: '+5926000000', amount } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.remittance;
}

test('reference codes are 8 digits', async () => {
  const sender = await env.makeUser({ balance: 5000 });
  const rem = await send(sender);
  assert.match(rem.referenceCode, /^\d{8}$/);
});

test('the right name picks up the money once; spacing and case are ignored', async () => {
  const sender = await env.makeUser({ balance: 5000 });
  const rem = await send(sender, 'Jane  Doe');
  const taker = await env.makeUser();
  const r = await env.api('POST', '/api/remit/claim', { token: taker.token, body: { referenceCode: rem.referenceCode, recipientName: ' jane doe ' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.balanceOf(taker.id).g, 1000);
  const again = await env.api('POST', '/api/remit/claim', { token: taker.token, body: { referenceCode: rem.referenceCode, recipientName: 'Jane Doe' } });
  assert.equal(again.status, 400);
  assert.equal(env.balanceOf(taker.id).g, 1000);
});

test('parallel name guesses cannot exceed the per-transfer limit, and the transfer then locks', async () => {
  const sender = await env.makeUser({ balance: 5000 });
  const rem = await send(sender, 'Jane Doe');
  // Each guesser is a different account and IP, so only the per-transfer cap applies.
  const guessers = await Promise.all(Array.from({ length: 8 }, () => env.makeUser()));
  await Promise.all(
    guessers.map((g, i) => env.api('POST', '/api/remit/claim', { token: g.token, body: { referenceCode: rem.referenceCode, recipientName: `Wrong ${i}` } }))
  );
  const [row] = env.query(`SELECT claim_attempts FROM remittances WHERE id = '${rem.id}'`);
  assert.equal(row.claim_attempts, 5);

  const legit = await env.makeUser();
  const r = await env.api('POST', '/api/remit/claim', { token: legit.token, body: { referenceCode: rem.referenceCode, recipientName: 'Jane Doe' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /locked/);
  assert.equal(env.balanceOf(legit.id).g, 0);

  const sent = await env.api('GET', '/api/remit/sent', { token: sender.token });
  assert.equal(sent.data.remittances.find((x) => x.id === rem.id).locked, true);
  // The sender can still cancel it for a full refund.
  const cancel = await env.api('POST', `/api/remit/${rem.id}/cancel`, { token: sender.token });
  assert.equal(cancel.status, 200);
  assert.equal(env.balanceOf(sender.id).g, 5000);
});

test('code lookups are rate limited per account', async () => {
  const u = await env.makeUser();
  let last;
  for (let i = 0; i < 21; i++) {
    last = await env.api('GET', `/api/remit/lookup?code=${10000000 + i}`, { token: u.token });
  }
  assert.equal(last.status, 429);
});

test('failed claims are rate limited per account', async () => {
  const u = await env.makeUser();
  let last;
  for (let i = 0; i < 11; i++) {
    last = await env.api('POST', '/api/remit/claim', { token: u.token, body: { referenceCode: String(20000000 + i), recipientName: 'Anyone' } });
  }
  assert.equal(last.status, 429);
});

test('GYD Direct sends are capped per account per hour (SMS-pumping protection)', async () => {
  const sender = await env.makeUser({ balance: 100000 });
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await env.api('POST', '/api/remit', { token: sender.token, body: { recipientName: 'Jo', recipientPhone: '+5926000000', amount: 1 } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
  assert.equal(statuses[10], 429);
});

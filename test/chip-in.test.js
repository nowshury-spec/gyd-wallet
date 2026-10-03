// Chip In (group money pots): money only leaves a pot when the goal is
// reached or the deadline passes (to the organizer) or on a refund (back to
// each person), never twice, and never appears or disappears along the way.
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

const PASSWORD = 'correct horse 1';

function guyanaDate(offsetDays) {
  const d = new Date(Date.now() - 4 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function newPot(organizer, { name = 'Kaieteur trip', goal = 1000, deadline = guyanaDate(14), emoji = '🏞️' } = {}) {
  const r = await env.api('POST', '/api/chip-in/pots', { token: organizer.token, body: { name, goal, deadline, emoji } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.pot;
}

const chipIn = (u, potId, amount) => env.api('POST', `/api/chip-in/pots/${potId}/contribute`, { token: u.token, body: { amount } });
const collect = (u, potId) => env.api('POST', `/api/chip-in/pots/${potId}/collect`, { token: u.token });
const refund = (u, potId) => env.api('POST', `/api/chip-in/pots/${potId}/refund`, { token: u.token });
const potRow = (id) => env.query(`SELECT balance::float AS balance, status FROM chip_in_pots WHERE id = '${id}'`)[0];
// Push a pot's deadline into the past, as if the days had gone by.
const expire = (id) => env.sql(`UPDATE chip_in_pots SET deadline = '${guyanaDate(-1)}' WHERE id = '${id}';`);

// All GYD in the given wallets plus the pot: must never change.
function totalMoney(users, potId) {
  return users.reduce((s, u) => s + env.balanceOf(u.id).g, 0) + potRow(potId).balance;
}

// Start `first`, and while it is still inside the database (writes to
// `table` are slowed down), start `second` — so the two genuinely overlap in
// a known order. Run both orders to cover each side's locking.
async function overlapped(table, first, second) {
  const undo = env.slowWrites(table, 0.4);
  try {
    const a = first();
    await new Promise((r) => setTimeout(r, 150));
    const b = second();
    return await Promise.all([a, b]);
  } finally {
    undo();
  }
}

async function twiceAtOnce(table, fns) {
  const undo = env.slowWrites(table);
  try {
    return await Promise.all(fns.map((f) => f()));
  } finally {
    undo();
  }
}

test('a pot needs a name, a goal and a deadline within the next year', async () => {
  const u = await env.makeUser();
  const bad = [
    { name: '', goal: 100, deadline: guyanaDate(5) },
    { name: 'x'.repeat(41), goal: 100, deadline: guyanaDate(5) },
    { name: 'Trip', goal: 0, deadline: guyanaDate(5) },
    { name: 'Trip', goal: 10.001, deadline: guyanaDate(5) },
    { name: 'Trip', goal: 100, deadline: guyanaDate(0) },
    { name: 'Trip', goal: 100, deadline: guyanaDate(400) },
    { name: 'Trip', goal: 100, deadline: 'next week' },
  ];
  for (const body of bad) {
    const r = await env.api('POST', '/api/chip-in/pots', { token: u.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const pot = await newPot(u, { emoji: 'not-allowed' });
  assert.equal(pot.emoji, '🎉');
  assert.equal(pot.isOrganizer, true);
  assert.equal(pot.balance, 0);
  const list = await env.api('GET', '/api/chip-in/pots', { token: u.token });
  assert.deepEqual(list.data.pots.map((p) => p.id), [pot.id]);
});

test('chipping in moves money from the wallet into the pot and is listed', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 500 });
  const pot = await newPot(org);
  const r = await chipIn(a, pot.id, 200);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(Number(r.data.user.gydBalance), 300);
  assert.equal(r.data.pot.balance, 200);
  assert.equal(r.data.pot.myTotal, 200);
  assert.equal(env.balanceOf(a.id).g, 300);
  assert.equal(potRow(pot.id).balance, 200);

  // Anyone with the link can see who chipped in.
  const detail = await env.api('GET', `/api/chip-in/pots/${pot.id}`, { token: org.token });
  assert.deepEqual(detail.data.contributions.map((c) => [c.username, c.amount]), [[a.username, 200]]);
  // It now shows in the contributor's own list too, and in their history.
  const list = await env.api('GET', '/api/chip-in/pots', { token: a.token });
  assert.deepEqual(list.data.pots.map((p) => p.id), [pot.id]);
  assert.equal(env.query(`SELECT 1 FROM transactions WHERE type = 'chip_in' AND from_user = '${a.id}' AND amount = 200`).length, 1);

  assert.equal((await chipIn(a, pot.id, 1000)).status, 400, 'more than the wallet holds');
  assert.equal((await chipIn(a, pot.id, 0)).status, 400);
  assert.equal(env.balanceOf(a.id).g, 300);
});

test('money is locked in the pot until the goal is reached', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 2000 });
  const pot = await newPot(org, { goal: 1000 });
  await chipIn(a, pot.id, 600);
  const early = await collect(org, pot.id);
  assert.equal(early.status, 400);
  assert.match(early.data.error, /locked/);
  assert.equal(potRow(pot.id).balance, 600);

  await chipIn(a, pot.id, 400);
  assert.equal((await collect(a, pot.id)).status, 403, 'only the organizer');
  const r = await collect(org, pot.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.collected, 1000);
  assert.equal(env.balanceOf(org.id).g, 1000);
  assert.deepEqual(potRow(pot.id), { balance: 0, status: 'collected' });
  assert.equal(env.query(`SELECT 1 FROM transactions WHERE type = 'chip_in_collect' AND to_user = '${org.id}' AND amount = 1000`).length, 1);

  assert.equal((await chipIn(a, pot.id, 50)).status, 400, 'closed pots take no money');
  assert.equal((await collect(org, pot.id)).status, 400, 'nothing left to collect twice');
});

test('after the deadline, a pot short of its goal can be collected, and stops taking money', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 1000 });
  const pot = await newPot(org, { goal: 5000 });
  await chipIn(a, pot.id, 700);
  expire(pot.id);
  assert.equal((await chipIn(a, pot.id, 100)).status, 400);
  const r = await collect(org, pot.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.balanceOf(org.id).g, 700);
  assert.equal(env.balanceOf(a.id).g, 300);
});

test('a refund gives each person back exactly what they put in', async () => {
  const org = await env.makeUser({ balance: 100 });
  const a = await env.makeUser({ balance: 1000 });
  const b = await env.makeUser({ balance: 1000 });
  const pot = await newPot(org, { goal: 5000 });
  await chipIn(a, pot.id, 250);
  await chipIn(a, pot.id, 150);
  await chipIn(b, pot.id, 300);
  await chipIn(org, pot.id, 100);
  assert.equal((await refund(a, pot.id)).status, 403, 'only the organizer');

  const r = await refund(org, pot.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refundedTotal, 800);
  assert.equal(r.data.people, 3);
  assert.equal(env.balanceOf(a.id).g, 1000);
  assert.equal(env.balanceOf(b.id).g, 1000);
  assert.equal(env.balanceOf(org.id).g, 100);
  assert.deepEqual(potRow(pot.id), { balance: 0, status: 'refunded' });
  assert.equal(env.query(`SELECT 1 FROM transactions WHERE type = 'chip_in_refund' AND to_user = '${a.id}' AND amount = 400`).length, 1);
  assert.equal((await refund(org, pot.id)).status, 400, 'already refunded');
  assert.equal((await collect(org, pot.id)).status, 400, 'and not collectable afterwards');
});

test('collecting twice at once pays out only once', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 1000 });
  const pot = await newPot(org, { goal: 500 });
  await chipIn(a, pot.id, 500);
  const results = await twiceAtOnce('chip_in_pots', [() => collect(org, pot.id), () => collect(org, pot.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(org.id).g, 500);
  assert.equal(potRow(pot.id).balance, 0);
});

test('a refund racing a collect: the money goes out exactly once', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 1000 });
  const pot = await newPot(org, { goal: 500 });
  await chipIn(a, pot.id, 500);
  const before = totalMoney([org, a], pot.id);
  const results = await twiceAtOnce('chip_in_pots', [() => collect(org, pot.id), () => refund(org, pot.id)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(totalMoney([org, a], pot.id), before);
  assert.equal(potRow(pot.id).balance, 0);
});

for (const order of ['chip-in first', 'refund first']) {
  test(`chipping in while the pot is being refunded (${order}): nothing is lost`, async () => {
    const org = await env.makeUser();
    const a = await env.makeUser({ balance: 1000 });
    const b = await env.makeUser({ balance: 1000 });
    const pot = await newPot(org, { goal: 5000 });
    await chipIn(a, pot.id, 300);
    const before = totalMoney([org, a, b], pot.id);
    const doRefund = () => refund(org, pot.id);
    const doChipIn = () => chipIn(b, pot.id, 200);
    if (order === 'chip-in first') await overlapped('chip_in_pots', doChipIn, doRefund);
    else await overlapped('chip_in_pots', doRefund, doChipIn);
    // Whichever order they landed in, every GYD is back in someone's wallet.
    assert.equal(totalMoney([org, a, b], pot.id), before);
    assert.equal(potRow(pot.id).balance, 0);
    assert.equal(env.balanceOf(a.id).g, 1000);
    assert.equal(env.balanceOf(b.id).g, 1000);
  });
}

for (const order of ['chip-in first', 'collect first']) {
  test(`chipping in while the pot is being collected (${order}): nothing is lost`, async () => {
    const org = await env.makeUser();
    const a = await env.makeUser({ balance: 1000 });
    const b = await env.makeUser({ balance: 1000 });
    const pot = await newPot(org, { goal: 300 });
    await chipIn(a, pot.id, 300);
    const before = totalMoney([org, a, b], pot.id);
    const doCollect = () => collect(org, pot.id);
    const doChipIn = () => chipIn(b, pot.id, 200);
    if (order === 'chip-in first') await overlapped('chip_in_pots', doChipIn, doCollect);
    else await overlapped('chip_in_pots', doCollect, doChipIn);
    assert.equal(totalMoney([org, a, b], pot.id), before);
    assert.equal(potRow(pot.id).status, 'collected');
    assert.equal(potRow(pot.id).balance, 0);
    // Chip-in first: it lands before the pot closes, so the organizer collects it too.
    // Collect first: the late chip-in is refused and the money never leaves b's wallet.
    const expected = order === 'chip-in first' ? { org: 500, b: 800 } : { org: 300, b: 1000 };
    assert.equal(env.balanceOf(org.id).g, expected.org);
    assert.equal(env.balanceOf(b.id).g, expected.b);
  });
}

test('two people chipping in at once both count, and a wallet cannot be overdrawn', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 100 });
  const pot = await newPot(org, { goal: 5000 });
  const results = await twiceAtOnce('users', [() => chipIn(a, pot.id, 100), () => chipIn(a, pot.id, 100)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(env.balanceOf(a.id).g, 0);
  assert.equal(potRow(pot.id).balance, 100);
});

test('an account cannot be deleted while it runs an open pot or has money in one', async () => {
  const org = await env.makeUser();
  const a = await env.makeUser({ balance: 100 });
  const pot = await newPot(org);
  await chipIn(a, pot.id, 100);
  const delOrg = await env.api('POST', '/api/account/delete', { token: org.token, body: { password: PASSWORD } });
  assert.equal(delOrg.status, 400);
  assert.match(delOrg.data.error, /Chip In pot that is still open/);
  const delA = await env.api('POST', '/api/account/delete', { token: a.token, body: { password: PASSWORD } });
  assert.equal(delA.status, 400);
  assert.match(delA.data.error, /chipped in/);

  await refund(org, pot.id);
  env.sql(`UPDATE users SET gyd_balance = 0 WHERE id = '${a.id}';`);
  assert.equal((await env.api('POST', '/api/account/delete', { token: a.token, body: { password: PASSWORD } })).status, 200);
  assert.equal((await env.api('POST', '/api/account/delete', { token: org.token, body: { password: PASSWORD } })).status, 200);
});

test('a pot can be opened by link but other pots stay out of your list', async () => {
  const org = await env.makeUser();
  const stranger = await env.makeUser();
  const pot = await newPot(org);
  const viaLink = await env.api('GET', `/api/chip-in/pots/${pot.id}`, { token: stranger.token });
  assert.equal(viaLink.status, 200);
  assert.equal(viaLink.data.pot.isOrganizer, false);
  assert.equal(viaLink.data.pot.organizer, org.username);
  const list = await env.api('GET', '/api/chip-in/pots', { token: stranger.token });
  assert.deepEqual(list.data.pots, []);
  assert.equal((await env.api('GET', '/api/chip-in/pots/not-a-real-id', { token: stranger.token })).status, 404);
  assert.equal((await env.api('GET', `/api/chip-in/pots/${pot.id}`)).status, 401);
});

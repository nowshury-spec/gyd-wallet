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

for (const role of ['anon', 'authenticated']) {
  test(`exec_query cannot be called as ${role} (the public/publishable key)`, () => {
    const r = env.sql(`SELECT public.exec_query('SELECT 1 AS x', '[]'::jsonb);`, { role });
    assert.equal(r.ok, false);
    assert.match(r.err, /permission denied/);
  });
}

test('exec_query works as service_role (the secret key)', () => {
  const r = env.sql(`SELECT public.exec_query('SELECT 1 AS x', '[]'::jsonb);`, { role: 'service_role' });
  assert.ok(r.ok, r.err);
  assert.equal(JSON.parse(r.out).rows[0].x, 1);
});

test('business-photos bucket: only service_role may write or delete', () => {
  const rows = env.query(
    `SELECT policyname, cmd, roles::text AS roles FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'gyd_wallet_business_photos_%' ORDER BY policyname`
  );
  const byName = Object.fromEntries(rows.map((r) => [r.policyname, r]));
  assert.equal(byName.gyd_wallet_business_photos_write.roles, '{service_role}');
  assert.equal(byName.gyd_wallet_business_photos_delete.roles, '{service_role}');
});

test('every table has row-level security on, so the public key can read nothing', () => {
  const off = env.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`);
  assert.deepEqual(off, []);
  for (const role of ['anon', 'authenticated']) {
    const r = env.sql(`SELECT count(*) FROM public.users;`, { role });
    assert.ok(r.ok, r.err);
    assert.equal(r.out.trim(), '0', `${role} must see no users`);
  }
});

test("the app's own database functions cannot be called with the public key", () => {
  const rows = env.query(`SELECT p.proname,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' ORDER BY 1`);
  const names = rows.map((r) => r.proname);
  for (const fn of ['close_user_account', 'revoke_courier', 'purchase_event_tickets', 'cancel_event_with_refunds', 'exec_query']) {
    assert.ok(names.includes(fn), `${fn} exists`);
  }
  const open = rows.filter((r) => r.anon || r.authed).map((r) => r.proname);
  assert.deepEqual(open, []);
});

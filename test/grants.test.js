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

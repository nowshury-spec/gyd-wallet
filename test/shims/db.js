// Test-only stand-in for the real db.js (which talks to Supabase over its
// REST API). Same surface server.js uses — prepare().get/all/run, raw,
// atomicTransfer, storageUpload/storageDelete — but every query goes through
// the REAL public.exec_query function in a local Postgres, called as the
// service_role role, so tests exercise the actual schema, the actual
// placeholder substitution, and the actual grants.
const { spawnSync } = require('child_process');

const PSQL = process.env.TEST_PSQL || 'psql';
const HOST = process.env.TEST_PG_HOST;
const PORT = process.env.TEST_PG_PORT;

function execQuery(sql, params) {
  const r = spawnSync(
    PSQL,
    ['-h', HOST, '-p', PORT, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
     '-v', `q=${sql}`, '-v', `p=${JSON.stringify(params)}`],
    { input: "SET ROLE service_role;\nSELECT public.exec_query(:'q', :'p'::jsonb);\n", encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  if (out.error) throw new Error(`${out.error} (${out.code})`);
  return out.rows;
}

// server.js writes SQLite-style `?` placeholders in prepare(); convert them
// to $1, $2, ... the same way the real db.js does.
function toDollar(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function prepare(sql) {
  const pg = toDollar(sql);
  return {
    async get(...args) { return execQuery(pg, args)[0]; },
    async all(...args) { return execQuery(pg, args); },
    async run(...args) { execQuery(pg, args); return {}; },
  };
}

async function raw(sql, params = []) {
  return execQuery(sql, params);
}

async function atomicTransfer(fromId, amount, toId, toBusiness) {
  const col = toBusiness ? 'business_gyd_balance' : 'gyd_balance';
  const rows = execQuery(
    `WITH debit AS (
       UPDATE users SET gyd_balance = gyd_balance - $2 WHERE id = $1 AND gyd_balance >= $2 RETURNING gyd_balance
     ), credit AS (
       UPDATE users SET ${col} = ${col} + $2 WHERE id = $3 AND EXISTS (SELECT 1 FROM debit) RETURNING 1
     )
     SELECT gyd_balance FROM debit`,
    [fromId, amount, toId]
  );
  return rows.length ? rows[0].gyd_balance : null;
}

async function storageUpload(bucket, path) {
  return `https://storage.test/${bucket}/${path}`;
}
async function storageDelete() {}

module.exports = { prepare, raw, atomicTransfer, storageUpload, storageDelete };

// Postgres persistence via Supabase's PostgREST RPC interface, reached with
// Node's built-in fetch() — no npm dependency needed (see README's "Why no
// npm packages" and "Deploying this" sections for the full story).
//
// This used to be local SQLite via node:sqlite (see the git history / the
// "Why no npm packages" README section for that era), but Render's free
// plan has no persistent disk — the SQLite file reset on every deploy or
// restart. Moving the data to a free Supabase Postgres project fixes that
// without paying for a Render disk.
//
// Rather than adding the `pg` npm package (which needs the project's
// database password, and would still be a dependency), every query here
// goes through ONE Postgres function — exec_query — reached over Supabase's
// REST API (PostgREST). exec_query takes the raw SQL text plus a JSON array
// of parameters, substitutes the parameters in safely (using Postgres's own
// quote_literal(), not string concatenation), and returns the resulting
// rows as JSON. That keeps almost all of the SQL text in server.js
// unchanged from the SQLite version — only `?` placeholders become `$1,
// $2, ...`, which this file does automatically (see toPgPlaceholders).
//
// The exec_query function itself is SECURITY DEFINER, owned by the
// database's postgres role, so it can read/write every table regardless of
// what the calling API key's own role is allowed to touch directly — the
// anon key used below is only ever used server-side (never sent to the
// browser) specifically so it can be trusted with that.
//
// See supabase/schema.sql for the table definitions and the exec_query
// function, both applied directly to the Supabase project via its
// migration tooling.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_KEY environment variables are required (see README.md\'s "Deploying this" section).'
  );
}

const RPC_URL = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/exec_query`;

// Every real query in this app goes through here. query uses Postgres-style
// $1, $2, ... placeholders (see toPgPlaceholders below) — params is a plain
// array in the same order.
async function rawQuery(query, params = []) {
  let res;
  try {
    res = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, params }),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach the database: ${networkErr.message}`);
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // fall through — body stays null, handled below
  }

  if (!res.ok) {
    throw new Error((body && (body.message || body.error)) || `Database request failed (HTTP ${res.status})`);
  }
  if (body && body.error) {
    const err = new Error(body.error);
    err.pgCode = body.code;
    throw err;
  }
  return (body && body.rows) || [];
}

// Converts the SQLite-style `?` placeholders used throughout server.js into
// Postgres's `$1, $2, ...` — both are purely positional, so this is a
// straight one-to-one substitution with no reordering needed.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Mirrors the shape of node:sqlite's DatabaseSync#prepare(sql) enough that
// nearly every call site elsewhere in this app is unchanged apart from
// adding `await` — get/all/run are now async (a real network call happens
// underneath) where they used to be synchronous.
function prepare(sql) {
  const pgSql = toPgPlaceholders(sql);
  return {
    async get(...params) {
      const rows = await rawQuery(pgSql, params);
      return rows[0];
    },
    async all(...params) {
      return rawQuery(pgSql, params);
    },
    async run(...params) {
      const rows = await rawQuery(pgSql, params);
      return { changes: rows.length, rows };
    },
  };
}

// Atomically moves `amount` of GYD from one user's personal gyd_balance to
// another user's balance (their business_gyd_balance if creditBusinessWallet
// is true, otherwise their personal gyd_balance too) as ONE Postgres
// statement. This matters now in a way it didn't under the old synchronous
// SQLite code: every query here is its own network round trip, so two
// requests really can interleave between a "do they have enough?" check and
// the update that spends it. Wrapping both the check and both balance
// changes in one statement (a debit CTE guarded by `gyd_balance >= amount`,
// and a credit CTE that only runs `EXISTS`-guarded on the debit having
// produced a row) makes the whole transfer atomic and race-proof: either
// both balances move together, or neither does. Returns the sender's new
// balance, or null if the debit didn't happen (not enough GYD, or the
// sender doesn't exist).
async function atomicTransfer(fromId, amount, toId, creditBusinessWallet) {
  const creditColumn = creditBusinessWallet ? 'business_gyd_balance' : 'gyd_balance';
  const rows = await rawQuery(
    `WITH debit AS (
       UPDATE users SET gyd_balance = gyd_balance - $1 WHERE id = $2 AND gyd_balance >= $1 RETURNING gyd_balance
     ), credit AS (
       UPDATE users SET ${creditColumn} = ${creditColumn} + $1 WHERE id = $3 AND EXISTS (SELECT 1 FROM debit) RETURNING 1
     )
     SELECT gyd_balance FROM debit`,
    [amount, fromId, toId]
  );
  return rows[0] ? rows[0].gyd_balance : null;
}

module.exports = {
  prepare,
  raw: rawQuery,
  atomicTransfer,
};

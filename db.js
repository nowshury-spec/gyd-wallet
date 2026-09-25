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
// quote_literal(), in a single pass over the query — see the comment on
// exec_query in schema.sql for why a single pass matters), and returns the
// resulting rows as JSON. That keeps almost all of the SQL text in server.js
// unchanged from the SQLite version — only `?` placeholders become `$1,
// $2, ...`, which this file does automatically (see toPgPlaceholders).
//
// The exec_query function itself is SECURITY DEFINER, owned by the
// database's postgres role, so it can read/write every table. That's why
// it's granted ONLY to service_role: SUPABASE_KEY must be the project's
// service_role key, never the public anon/publishable key (see README's
// "How the database works").
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

const BASE_URL = SUPABASE_URL.replace(/\/$/, '');
const RPC_URL = `${BASE_URL}/rest/v1/rpc/exec_query`;
const DB_TIMEOUT_MS = 15000;
const STORAGE_TIMEOUT_MS = 30000;

// Supabase has two kinds of API key, and they must be sent differently:
//   * legacy keys (anon / service_role) are JWTs ("eyJ..."): send them in
//     both the apikey and Authorization: Bearer headers;
//   * the newer opaque keys (sb_publishable_... / sb_secret_...) must go in
//     the apikey header ONLY — Supabase rejects them in Authorization:
//     Bearer ("Invalid JWT"), so sending them there breaks every request.
const KEY_IS_JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(SUPABASE_KEY);
function authHeaders() {
  return KEY_IS_JWT ? { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } : { apikey: SUPABASE_KEY };
}

// Loudly flag the one misconfiguration that would take the app down after
// schema.sql is re-run: using the PUBLIC key, which can no longer call
// exec_query (and must never be able to).
(function warnIfPublicKey() {
  let role = null;
  if (SUPABASE_KEY.startsWith('sb_publishable_')) role = 'anon';
  else if (KEY_IS_JWT) {
    try {
      role = JSON.parse(Buffer.from(SUPABASE_KEY.split('.')[1], 'base64url').toString()).role || null;
    } catch {}
  }
  if (role === 'anon') {
    console.error(
      'ERROR: SUPABASE_KEY is the public anon/publishable key. The database only accepts the service_role key ' +
        '(Supabase dashboard → Project Settings → API Keys). See README "How the database works".'
    );
  }
})();

// Every real query in this app goes through here. query uses Postgres-style
// $1, $2, ... placeholders (see toPgPlaceholders below) — params is a plain
// array in the same order.
async function rawQuery(query, params = []) {
  let res;
  try {
    res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, params }),
      // Without a timeout, a stalled connection would hang the request (and
      // anything waiting on it) forever.
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
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

// ---------- Supabase Storage (business photos) ----------
//
// server.js has always called these for the business photo gallery, but
// they were missing from this file — so every photo upload failed with
// "db.storageUpload is not a function". Objects go into a public bucket
// (see business-photos in schema.sql), so the returned URL works directly
// in an <img> tag; writes and deletes need the service_role key.

function objectUrl(bucket, objectPath) {
  const encoded = String(objectPath).split('/').map(encodeURIComponent).join('/');
  return `${BASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

// Uploads `body` (a Buffer) and returns its public URL. Throws on failure.
async function storageUpload(bucket, objectPath, body, contentType) {
  let res;
  try {
    res = await fetch(objectUrl(bucket, objectPath), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': contentType, 'x-upsert': 'false' },
      body,
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach storage: ${networkErr.message}`);
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(`Storage upload failed (HTTP ${res.status})${detail && detail.message ? `: ${detail.message}` : ''}`);
  }
  const encoded = String(objectPath).split('/').map(encodeURIComponent).join('/');
  return `${BASE_URL}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encoded}`;
}

// Deletes one object. An object that's already gone counts as success.
async function storageDelete(bucket, objectPath) {
  let res;
  try {
    res = await fetch(objectUrl(bucket, objectPath), {
      method: 'DELETE',
      headers: authHeaders(),
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach storage: ${networkErr.message}`);
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`Storage delete failed (HTTP ${res.status})`);
  }
}

module.exports = {
  prepare,
  raw: rawQuery,
  atomicTransfer,
  storageUpload,
  storageDelete,
};

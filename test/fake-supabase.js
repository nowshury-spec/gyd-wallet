// Test-only: a tiny stand-in for the two Supabase HTTP APIs the real db.js
// talks to, so the tests can run the app's ACTUAL db.js unchanged:
//
//   POST /rest/v1/rpc/exec_query       (PostgREST RPC)  -> the real public.exec_query in local Postgres
//   POST/DELETE /storage/v1/object/...  (Storage API)    -> an in-memory bucket
//   GET  /storage/v1/object/public/...                  -> serves public objects
//
// The API key decides the database role, like Supabase does: the secret key
// runs as service_role, the anon key as anon. Every RPC call runs in its own
// psql process, asynchronously, so concurrent requests really do hit
// Postgres at the same time (race tests depend on this).
const http = require('http');
const { spawn } = require('child_process');

// Real Supabase rejects an opaque key (sb_secret_/sb_publishable_) sent as
// "Authorization: Bearer ..." with "Invalid JWT" — only JWT-shaped legacy keys
// may go there. The fake enforces the same rule so db.js's header handling is
// actually tested.
const JWT_SHAPE = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;

function startFakeSupabase({ psql, host, port, secretKey, anonKey, legacyServiceKey }) {
  const objects = new Map(); // "bucket/path" -> { body, contentType }
  // How many exec_query calls were running at the same moment, at most — lets
  // race tests prove their requests really overlapped inside Postgres.
  const stats = { inFlight: 0, maxInFlight: 0 };
  const publicBuckets = new Set(['business-photos']);

  function roleFor(req) {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (bearer && !JWT_SHAPE.test(bearer)) return 'invalid_jwt';
    const key = req.headers.apikey || bearer;
    if (key === secretKey || (legacyServiceKey && key === legacyServiceKey)) return 'service_role';
    if (key === anonKey) return 'anon';
    return null;
  }

  function runExecQuery(role, query, params) {
    return new Promise((resolve) => {
      const child = spawn(
        psql,
        ['-h', host, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
         '-v', `q=${query}`, '-v', `p=${JSON.stringify(params)}`],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.end(`SET ROLE ${role};\nSELECT public.exec_query(:'q', :'p'::jsonb);\n`);
    });
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  function json(res, status, obj) {
    const data = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);

    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/exec_query') {
      const role = roleFor(req);
      if (role === 'invalid_jwt') return json(res, 401, { message: 'Invalid JWT' });
      if (!role) return json(res, 401, { message: 'Invalid API key' });
      const { query, params } = JSON.parse(body.toString() || '{}');
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const r = await runExecQuery(role, query, params || []).finally(() => (stats.inFlight -= 1));
      if (r.code !== 0) {
        // e.g. "permission denied for function exec_query" — PostgREST reports
        // that as 401 for anon, 403 otherwise.
        return json(res, role === 'anon' ? 401 : 403, { code: '42501', message: r.err.trim() });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(r.out.trim());
    }

    const pub = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && pub) {
      const [, bucket, key] = pub;
      const obj = publicBuckets.has(bucket) && objects.get(`${bucket}/${decodeURIComponent(key)}`);
      if (!obj) return json(res, 404, { message: 'Object not found' });
      res.writeHead(200, { 'Content-Type': obj.contentType });
      return res.end(obj.body);
    }

    const m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m && (req.method === 'POST' || req.method === 'DELETE')) {
      // Only the secret key may write/delete (the bucket's storage policies
      // are granted to service_role only — see supabase/schema.sql).
      if (roleFor(req) !== 'service_role') return json(res, 403, { message: 'new row violates row-level security policy' });
      const [, bucket, key] = m;
      const id = `${bucket}/${decodeURIComponent(key)}`;
      if (req.method === 'DELETE') {
        if (!objects.delete(id)) return json(res, 404, { message: 'Object not found' });
        return json(res, 200, { message: 'Successfully deleted' });
      }
      if (objects.has(id) && req.headers['x-upsert'] !== 'true') return json(res, 409, { message: 'The resource already exists' });
      objects.set(id, { body, contentType: req.headers['content-type'] || 'application/octet-stream' });
      return json(res, 200, { Key: id });
    }

    json(res, 404, { message: 'Not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        objects,
        stats,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeSupabase };

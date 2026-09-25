// Integration-test harness: a throwaway local Postgres loaded with the real
// supabase/schema.sql, plus the real server.js running against it through
// test-only stand-ins for the modules it requires (see test/shims/).
//
// Needs PostgreSQL 15+ server binaries (initdb, pg_ctl, psql) installed
// locally. Set PG_BIN to their directory if they aren't found automatically.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const others = require('./shims/others');

function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    if (fs.existsSync(path.join(dir, 'initdb'))) return dir;
  } catch {}
  const base = '/usr/lib/postgresql';
  if (fs.existsSync(base)) {
    const versions = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const dir = path.join(base, v, 'bin');
      if (fs.existsSync(path.join(dir, 'initdb'))) return dir;
    }
  }
  throw new Error('PostgreSQL server binaries not found — install PostgreSQL 15+ or set PG_BIN.');
}

// initdb/pg_ctl refuse to run as root, so when the suite runs as root (e.g.
// in a container) they're run as the `postgres` OS user instead.
function runPg(bin, args) {
  const isRoot = process.getuid && process.getuid() === 0;
  const r = isRoot
    ? spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', [bin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')], { encoding: 'utf8' })
    : spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} failed: ${r.stderr || r.stdout}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Run SQL as the superuser (test setup/inspection only — the app itself
// always goes through exec_query as service_role).
function sqlFileOn(env, file) {
  const r = spawnSync(env.psql, ['-h', env.sockDir, '-p', String(env.pgPort), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`SQL file ${file} failed: ${r.stderr}`);
}

function sqlOn(env, query, { role } = {}) {
  const input = (role ? `SET ROLE ${role};\n` : '') + query + '\n';
  const r = spawnSync(env.psql, ['-h', env.sockDir, '-p', String(env.pgPort), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

// JSON rows for a SELECT, as superuser.
function queryOn(env, query) {
  const r = sqlOn(env, `SELECT COALESCE(json_agg(t), '[]') FROM (${query}) t;`);
  if (!r.ok) throw new Error(r.err);
  return JSON.parse(r.out);
}

async function startServer(env, extraEnv = {}) {
  await stopServer(env);
  fs.writeFileSync(env.mailbox, '');
  env.port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: env.appDir,
    env: {
      ...process.env,
      PORT: String(env.port),
      TEST_PSQL: env.psql,
      TEST_PG_HOST: env.sockDir,
      TEST_PG_PORT: String(env.pgPort),
      TEST_MAILBOX: env.mailbox,
      TRUSTED_PROXY_HOPS: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  env.serverLog = '';
  child.stdout.on('data', (d) => (env.serverLog += d));
  child.stderr.on('data', (d) => (env.serverLog += d));
  env.server = child;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${env.port}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`server did not start:\n${env.serverLog}`);
}

async function stopServer(env) {
  if (!env.server) return;
  const child = env.server;
  env.server = null;
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

async function stopEnv(env) {
  await stopServer(env);
  try {
    runPg(path.join(env.bin, 'pg_ctl'), ['-D', env.dataDir, '-m', 'immediate', 'stop']);
  } catch {}
  fs.rmSync(env.dir, { recursive: true, force: true });
}

// Every request gets its own random client IP by default (via the trusted
// X-Forwarded-For hop) so unrelated tests don't share rate-limit buckets.
async function api(env, method, urlPath, { body, token, ip } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `10.${rnd()}.${rnd()}.${rnd()}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${env.port}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
function rnd() {
  return crypto.randomInt(1, 255);
}

function mail(env) {
  const raw = fs.existsSync(env.mailbox) ? fs.readFileSync(env.mailbox, 'utf8') : '';
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let counter = 0;
function uniqueName(prefix = 'u') {
  counter += 1;
  return `${prefix}${process.pid}_${counter}_${crypto.randomInt(1e6)}`.slice(0, 20);
}

// Register a user and give them a balance directly (deposits are simulated
// anyway). Returns { id, username, token, email }.
async function makeUser(env, { balance = 0, business = false, username, email } = {}) {
  username = username || uniqueName();
  email = email || `${username}@example.test`;
  const r = await api(env, 'POST', '/api/register', {
    body: { username, email, password: 'correct horse 1', isBusiness: business, businessName: business ? `${username} Shop` : undefined },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  if (balance) sqlOn(env, `UPDATE users SET gyd_balance = ${Number(balance)} WHERE id = '${r.data.user.id}';`);
  return { id: r.data.user.id, username, email, token: r.data.token };
}

function balanceOf(env, userId) {
  const [row] = queryOn(env, `SELECT gyd_balance::float AS g, business_gyd_balance::float AS b, courier_gyd_balance::float AS c FROM users WHERE id = '${userId}'`);
  return row;
}

function attach(env) {
  env.sqlFile = (file) => sqlFileOn(env, file);
  env.sql = (q, opts) => sqlOn(env, q, opts);
  env.query = (q) => queryOn(env, q);
  env.api = (method, p, opts) => api(env, method, p, opts);
  env.mail = () => mail(env);
  env.startServer = (e) => startServer(env, e);
  env.makeUser = (o) => makeUser(env, o);
  env.balanceOf = (id) => balanceOf(env, id);
  return env;
}

async function setup(serverEnv = {}) {
  const env = await startEnv();
  await env.startServer(serverEnv);
  return env;
}

async function startEnv() {
  const bin = findPgBin();
  const env = attach({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyd-test-'));
  fs.chmodSync(dir, 0o777);
  Object.assign(env, { dir, bin, psql: path.join(bin, 'psql'), dataDir: path.join(dir, 'pgdata'), sockDir: path.join(dir, 'sock'), mailbox: path.join(dir, 'mailbox.jsonl') });
  fs.mkdirSync(env.sockDir);
  fs.chmodSync(env.sockDir, 0o777);
  if (process.getuid && process.getuid() === 0) spawnSync('chown', ['postgres', dir, env.sockDir]);
  env.pgPort = await freePort();
  runPg(path.join(bin, 'initdb'), ['-A', 'trust', '-U', 'postgres', '-D', env.dataDir]);
  runPg(path.join(bin, 'pg_ctl'), ['-D', env.dataDir, '-l', path.join(dir, 'pg.log'), '-w', '-o', `-k ${env.sockDir} -p ${env.pgPort} -c listen_addresses=`, 'start']);

  env.sqlFile(path.join(__dirname, 'prelude.sql'));
  env.sqlFile(path.join(ROOT, 'supabase', 'schema.sql'));
  env.sqlFile(path.join(ROOT, 'supabase', 'schema.sql')); // must be re-runnable

  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir);
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(appDir, 'server.js'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(appDir, 'public'), { recursive: true });
  for (const m of ['db', 'auth', 'email']) fs.copyFileSync(path.join(__dirname, 'shims', `${m}.js`), path.join(appDir, `${m}.js`));
  for (const m of ['sms', 'dropshipping', 'oauth', 'ludo']) fs.writeFileSync(path.join(appDir, `${m}.js`), others[m]);
  env.appDir = appDir;
  env.stop = () => stopEnv(env);
  return env;
}

module.exports = { setup, uniqueName };

// Profile picture (public, shown next to a person's name) and app wallpaper
// (private to its owner): uploads are validated, files land in the right
// bucket, replaced/removed files are cleaned up, and nobody else can read a
// wallpaper.
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

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const png = `data:image/png;base64,${PNG}`;
// Smallest valid-looking JPEG header bytes (the app only checks the signature).
const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`;
const keys = (bucket) => [...env.supabase.objects.keys()].filter((k) => k.startsWith(`${bucket}/`));
const setAvatar = (u, imageData) => env.api('POST', '/api/profile/avatar', { token: u.token, body: { imageData } });
const setWall = (u, imageData) => env.api('POST', '/api/profile/wallpaper/photo', { token: u.token, body: { imageData } });
const wallSettings = (u, body) => env.api('POST', '/api/profile/wallpaper/settings', { token: u.token, body });

test('a new account has no picture and no wallpaper', async () => {
  const u = await env.makeUser();
  const me = (await env.api('GET', '/api/me', { token: u.token })).data.user;
  assert.equal(me.avatarUrl, null);
  assert.deepEqual(me.wallpaper, { kind: 'none', preset: null, version: null, dim: 28, blur: 0 });
});

test('profile picture: uploads to the public bucket, is visible to others, and replacing it deletes the old file', async () => {
  const a = await env.makeUser();
  const b = await env.makeUser();
  const r1 = await setAvatar(a, png);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const url1 = r1.data.user.avatarUrl;
  assert.ok(url1.startsWith(`${env.supabase.url}/storage/v1/object/public/profile-pictures/${a.id}/`), url1);
  assert.equal((await fetch(url1)).status, 200);

  // Another person sees it in search and on the user lookup.
  const search = await env.api('GET', `/api/users?q=${a.username}`, { token: b.token });
  assert.equal(search.data.users.find((x) => x.username === a.username).avatarUrl, url1);
  const lookup = await env.api('GET', `/api/users/${a.username}`, { token: b.token });
  assert.equal(lookup.data.avatarUrl, url1);

  const r2 = await setAvatar(a, jpg);
  assert.equal(r2.status, 200);
  assert.notEqual(r2.data.user.avatarUrl, url1);
  assert.equal((await fetch(url1)).status, 404, 'old picture file removed');
  assert.equal(keys('profile-pictures').filter((k) => k.includes(a.id)).length, 1);

  const del = await env.api('DELETE', '/api/profile/avatar', { token: a.token });
  assert.equal(del.status, 200);
  assert.equal(del.data.user.avatarUrl, null);
  assert.equal(keys('profile-pictures').filter((k) => k.includes(a.id)).length, 0);
});

test('uploads are validated: type, size, and real picture bytes', async () => {
  const u = await env.makeUser();
  assert.equal((await setAvatar(u, 'hello')).status, 400);
  assert.equal((await setAvatar(u, 'data:image/svg+xml;base64,PHN2Zy8+')).status, 400);
  assert.equal((await setAvatar(u, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')).status, 400);
  // Labelled PNG but not a PNG.
  assert.equal((await setAvatar(u, `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`)).status, 400);
  // Too large.
  assert.equal((await setAvatar(u, `data:image/png;base64,${'A'.repeat(2_300_000)}`)).status, 400);
  assert.equal((await setWall(u, 'nope')).status, 400);
  assert.equal(keys('profile-pictures').filter((k) => k.includes(u.id)).length, 0);
  assert.equal(keys('wallpapers').filter((k) => k.includes(u.id)).length, 0);
});

test('every profile route needs a signed-in user', async () => {
  for (const [m, p] of [['POST', '/api/profile/avatar'], ['DELETE', '/api/profile/avatar'], ['POST', '/api/profile/wallpaper/photo'],
    ['POST', '/api/profile/wallpaper/settings'], ['DELETE', '/api/profile/wallpaper'], ['GET', '/api/profile/wallpaper/image']]) {
    assert.equal((await env.api(m, p, m === 'GET' ? {} : { body: {} })).status, 401, `${m} ${p}`);
  }
});

test('wallpaper photo: private bucket, only the owner can read it, replace/remove clean up files', async () => {
  const a = await env.makeUser();
  const b = await env.makeUser();
  const r = await setWall(a, png);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.wallpaper.kind, 'photo');
  assert.ok(r.data.user.wallpaper.version);
  assert.equal(JSON.stringify(r.data.user).includes('wallpapers/'), false, 'no storage path leaks to the client');
  const [first] = keys('wallpapers').filter((k) => k.includes(a.id));

  // Not reachable through the public storage URL.
  assert.equal((await fetch(`${env.supabase.url}/storage/v1/object/public/${first}`)).status, 404);
  // The owner gets it back through the app...
  const img = await fetch(`http://127.0.0.1:${env.port}/api/profile/wallpaper/image`, { headers: { Authorization: `Bearer ${a.token}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(PNG, 'base64'));
  // ...someone else has no wallpaper to read, and never sees a's.
  assert.equal((await env.api('GET', '/api/profile/wallpaper/image', { token: b.token })).status, 404);
  const lookup = await env.api('GET', `/api/users/${a.username}`, { token: b.token });
  assert.equal(JSON.stringify(lookup.data).includes('wallpaper'), false);

  // Replace: the old file goes away.
  const r2 = await setWall(a, jpg);
  assert.equal(r2.status, 200);
  const now = keys('wallpapers').filter((k) => k.includes(a.id));
  assert.equal(now.length, 1);
  assert.notEqual(now[0], first);

  // Remove.
  const del = await env.api('DELETE', '/api/profile/wallpaper', { token: a.token });
  assert.equal(del.data.user.wallpaper.kind, 'none');
  assert.equal(keys('wallpapers').filter((k) => k.includes(a.id)).length, 0);
  assert.equal((await env.api('GET', '/api/profile/wallpaper/image', { token: a.token })).status, 404);
});

test('wallpaper settings: presets, dim and blur are validated; a preset replaces a photo', async () => {
  const u = await env.makeUser();
  assert.equal((await wallSettings(u, { preset: 'ocean' })).data.user.wallpaper.preset, 'ocean');
  assert.equal((await wallSettings(u, { dim: 50, blur: 6 })).data.user.wallpaper.dim, 50);
  const w = (await env.api('GET', '/api/me', { token: u.token })).data.user.wallpaper;
  assert.deepEqual([w.kind, w.preset, w.dim, w.blur], ['preset', 'ocean', 50, 6]);

  for (const bad of [{ dim: 71 }, { dim: -1 }, { dim: 1.5 }, { dim: 'x' }, { blur: 15 }, { blur: -1 }, { preset: 'hacker' }, {}]) {
    assert.equal((await wallSettings(u, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(env.query(`SELECT wallpaper_dim FROM users WHERE id = '${u.id}'`)[0].wallpaper_dim, 50);

  // A photo replaces the preset; choosing a preset again deletes the photo file.
  assert.equal((await setWall(u, png)).data.user.wallpaper.preset, null);
  assert.equal(keys('wallpapers').filter((k) => k.includes(u.id)).length, 1);
  const back = await wallSettings(u, { preset: 'gold' });
  assert.deepEqual([back.data.user.wallpaper.kind, back.data.user.wallpaper.preset], ['preset', 'gold']);
  assert.equal(keys('wallpapers').filter((k) => k.includes(u.id)).length, 0);
  // Turning it off.
  assert.equal((await wallSettings(u, { preset: null })).data.user.wallpaper.kind, 'none');
});

test('the database itself refuses out-of-range dim/blur and a preset together with a photo', () => {
  const u = env.query(`SELECT id FROM users LIMIT 1`)[0].id;
  assert.equal(env.sql(`UPDATE users SET wallpaper_dim = 99 WHERE id = '${u}';`).ok, false);
  assert.equal(env.sql(`UPDATE users SET wallpaper_blur = 99 WHERE id = '${u}';`).ok, false);
  assert.equal(env.sql(`UPDATE users SET wallpaper_preset = 'sunset', wallpaper_path = 'x/y' WHERE id = '${u}';`).ok, false);
});

test('profile buckets: pictures public-read, wallpapers have no public read, writes service_role only', () => {
  const rows = env.query(`SELECT policyname, cmd, roles::text AS roles FROM pg_policies WHERE schemaname = 'storage' AND (policyname LIKE 'gyd_wallet_profile_pictures_%' OR policyname LIKE 'gyd_wallet_wallpapers_%')`);
  const by = Object.fromEntries(rows.map((r) => [r.policyname, r.roles]));
  assert.equal(by.gyd_wallet_profile_pictures_read, '{anon}');
  assert.equal(by.gyd_wallet_profile_pictures_write, '{service_role}');
  assert.equal(by.gyd_wallet_profile_pictures_delete, '{service_role}');
  assert.equal(by.gyd_wallet_wallpapers_read, '{service_role}');
  assert.equal(by.gyd_wallet_wallpapers_write, '{service_role}');
  assert.equal(by.gyd_wallet_wallpapers_delete, '{service_role}');
  assert.equal(rows.some((r) => r.policyname.startsWith('gyd_wallet_wallpapers') && r.roles.includes('anon')), false);
  const buckets = Object.fromEntries(env.query(`SELECT id, public FROM storage.buckets`).map((b) => [b.id, b.public]));
  assert.equal(buckets['profile-pictures'], true);
  assert.equal(buckets.wallpapers, false);
});

test('pictures show up next to names: activity, chat, requests, Chip In', async () => {
  const a = await env.makeUser({ balance: 500 });
  const b = await env.makeUser({ balance: 500 });
  const urlB = (await setAvatar(b, png)).data.user.avatarUrl;

  // Payment: a sends to b -> a's activity names b with b's picture.
  assert.equal((await env.api('POST', '/api/transfer', { token: a.token, body: { toUsername: b.username, amount: 10 } })).status, 200);
  const tx = (await env.api('GET', '/api/wallet/transactions', { token: a.token })).data.transactions[0];
  assert.equal(tx.other_username, b.username);
  assert.equal(tx.other_avatar_url, urlB);
  // ...and b's activity names a (no picture).
  const txB = (await env.api('GET', '/api/wallet/transactions', { token: b.token })).data.transactions[0];
  assert.equal(txB.other_username, a.username);
  assert.equal(txB.other_avatar_url, null);

  // Chat.
  assert.equal((await env.api('POST', '/api/messages', { token: a.token, body: { toUsername: b.username, body: 'hi' } })).status, 201);
  const threads = (await env.api('GET', '/api/messages/threads', { token: a.token })).data.threads;
  assert.equal(threads[0].avatarUrl, urlB);
  const thread = (await env.api('GET', `/api/messages/thread/${b.username}`, { token: a.token })).data;
  assert.equal(thread.other.avatarUrl, urlB);

  // Chip In: organizer picture and contributor pictures.
  const pot = (await env.api('POST', '/api/chip-in/pots', { token: b.token, body: { name: 'Trip', goal: 100, deadline: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), emoji: '🏞️' } })).data.pot;
  assert.equal(pot.organizerAvatarUrl, urlB);
  assert.equal((await env.api('POST', `/api/chip-in/pots/${pot.id}/contribute`, { token: a.token, body: { amount: 5 } })).status, 200);
  const detail = (await env.api('GET', `/api/chip-in/pots/${pot.id}`, { token: a.token })).data;
  assert.equal(detail.pot.organizerAvatarUrl, urlB);
  assert.equal(detail.contributions[0].avatarUrl, null);
  assert.equal((await setAvatar(a, png)).status, 200);
  const detail2 = (await env.api('GET', `/api/chip-in/pots/${pot.id}`, { token: b.token })).data;
  assert.ok(detail2.contributions[0].avatarUrl.includes('/profile-pictures/'));
});

test('deleting an account removes its picture and wallpaper files', async () => {
  const u = await env.makeUser();
  await setAvatar(u, png);
  await setWall(u, png);
  assert.equal(keys('profile-pictures').filter((k) => k.includes(u.id)).length, 1);
  assert.equal(keys('wallpapers').filter((k) => k.includes(u.id)).length, 1);
  const del = await env.api('POST', '/api/account/delete', { token: u.token, body: { password: 'correct horse 1' } });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(keys('profile-pictures').filter((k) => k.includes(u.id)).length, 0);
  assert.equal(keys('wallpapers').filter((k) => k.includes(u.id)).length, 0);
  const row = env.query(`SELECT avatar_url, wallpaper_path, wallpaper_preset FROM users WHERE id = '${u.id}'`)[0];
  assert.deepEqual(row, { avatar_url: null, wallpaper_path: null, wallpaper_preset: null });
});

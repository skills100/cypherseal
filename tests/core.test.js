/** Node tests for crypto v4 + the PHP release service (needs `php` with pdo_sqlite).  node tests/core.test.js */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { spawn, execFileSync } = require('child_process'), os = require('os');
const { webcrypto } = require('crypto');

const win = { crypto: webcrypto, TextEncoder, TextDecoder, performance, atob, btoa, Blob, Response, DecompressionStream, console };
win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/crypto.js'), 'utf8'), win);
const C = win.CSCrypto;

let pass = 0, failN = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { failN++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } }
const rejects = async (p, code) => { try { await p; } catch (e) { if (code) assert.strictEqual(e.code, code, 'got ' + e.code + ' ' + e.message); return; } assert.fail('expected rejection'); };

(async () => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const DB = path.join(os.tmpdir(), 'cs-test-' + process.pid + '.sqlite');
  const env = Object.assign({}, process.env, { CS_DB_PATH: DB, PHP_CLI_SERVER_WORKERS: '8' });
  const srv = spawn('php', ['-S', '127.0.0.1:' + port, '-t', path.join(__dirname, '..')], { env, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/index.html'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  const sql = q => execFileSync('php', ['-r', '$p=new PDO("sqlite:' + DB + '");' + q], { env });
  // Node-side equivalent of js/release.js
  const post = async (op, b) => { const r = await fetch(base + '/api/release.php', { method: 'POST', body: JSON.stringify(Object.assign({ op }, b)) }); return { status: r.status, body: await r.json() }; };
  const APP = 'Mozilla/5.0 (Linux; Android 14) CipherSealApp/1';
  // mirrors js/release.js register(itemId, auth, share, ttl, extra)
  const release = { register: async (id, a, s, ttl, extra) => { const r = await post('register', Object.assign({ itemId: id, auth: a, share: s, ttl }, extra || {})); if (r.status !== 200) throw new Error('register ' + r.status); } };
  const PW = 'correct horse battery staple 42!';
  const enc = o => C.encrypt(Object.assign({ text: 'secret exam paper', password: PW, sensitivity: 'public', release }, o));

  console.log('\nSeparate modes');
  await t('standard item round-trips with no server', async () => {
    const r = await enc({ policy: {} }); assert.strictEqual(r.serverShare, false);
    assert.strictEqual((await C.decrypt(r.bytes, PW)).text, 'secret exam paper');
  });
  await t('protected-only item needs no server share and round-trips', async () => {
    const r = await enc({ policy: { protected: true } }); assert.strictEqual(r.mode, 1); assert.strictEqual(r.serverShare, false);
    assert.strictEqual((await C.decrypt(r.bytes, PW)).meta.policy.protected, true);
  });
  await t('view-once item CANNOT be opened without the release service share', async () => {
    const r = await enc({ policy: { protected: true, viewOnce: true } }); assert.strictEqual(r.serverShare, true);
    await rejects(C.decrypt(r.bytes, PW), 'NEEDS_SHARE');
  });
  await t('encrypt refuses view-once when release service is missing', async () => {
    await rejects(C.encrypt({ text: 'x', password: PW, sensitivity: 'public', policy: { protected: true, viewOnce: true } }), 'NO_RELEASE');
  });
  await t('stripping view-once (mode -> protected only) is rejected by the header check', async () => {
    const a = await enc({ policy: { protected: true, viewOnce: true } });
    const f = a.bytes.slice(); f[6] = 1;
    await rejects(C.prepare(f, PW), 'BAD_INPUT');
  });
  await t('relabelling view-once as self-destruct fails authentication (mode is in AAD + HKDF info)', async () => {
    const a = await enc({ policy: { protected: true, viewOnce: true } });
    const f = a.bytes.slice(); f[6] = 1 | 4;
    const p = await C.prepare(f, PW);
    const c = await post('claim', { itemId: a.itemId, auth: p.auth });    // server would not know the difference...
    await rejects(C.open(p, c.body.share), 'BAD_KEY');                     // ...but the data cannot be opened
  });

  console.log('\nOne-time release (the cross-device guarantee)');
  const mk = async pol => { const r = await enc({ policy: pol }); const p = await C.prepare(r.bytes, PW); return { r, p }; };
  await t('first claim opens the item', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    await post('verify', { itemId: r.itemId, auth: p.auth });
    const c = await post('claim', { itemId: r.itemId, auth: p.auth }); assert.strictEqual(c.status, 200);
    assert.strictEqual((await C.open(p, c.body.share)).text, 'secret exam paper');
  });
  await t('second claim (another device, correct password) is refused with 410', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 200);
    const p2 = await C.prepare(r.bytes, PW);                     // "device B": same file, same password
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p2.auth })).status, 410);
    assert.strictEqual((await post('verify', { itemId: r.itemId, auth: p2.auth })).status, 410);
  });
  await t('two devices claiming SIMULTANEOUSLY: exactly one wins', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    const rs = await Promise.all(Array.from({ length: 12 }, () => post('claim', { itemId: r.itemId, auth: p.auth })));
    assert.strictEqual(rs.filter(x => x.status === 200).length, 1);
    assert.strictEqual(rs.filter(x => x.status === 410).length, 11);
  });
  await t('self-destruct items are also one-time across devices', async () => {
    const { r, p } = await mk({ protected: true, viewSeconds: 30 });
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 200);
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 410);
  });
  await t('verify does not consume (camera/phone check can fail safely before claim)', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    for (let i = 0; i < 5; i++) assert.strictEqual((await post('verify', { itemId: r.itemId, auth: p.auth })).status, 200);
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 200);
  });

  console.log('\nWrong passwords (global lockout)');
  await t('3 wrong passwords lock the item on the server for every device', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    const bad = await C.prepare(r.bytes, 'wrong password number one');
    assert.strictEqual((await post('verify', { itemId: r.itemId, auth: bad.auth })).body.left, 2);
    assert.strictEqual((await post('verify', { itemId: r.itemId, auth: bad.auth })).body.left, 1);
    assert.strictEqual((await post('verify', { itemId: r.itemId, auth: bad.auth })).status, 423);
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 423);   // even the RIGHT password now
  });
  await t('someone with only the file cannot burn the item (needs password proof)', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: 'ab'.repeat(32) })).status, 403);
    assert.strictEqual((await post('claim', { itemId: r.itemId, auth: p.auth })).status, 200);
  });
  await t('register is create-only (cannot overwrite a share)', async () => {
    const { r } = await mk({ protected: true, viewOnce: true });
    assert.strictEqual((await post('register', { itemId: r.itemId, auth: 'cd'.repeat(32), share: Buffer.alloc(32).toString('base64') })).status, 409);
  });

  console.log('\nTamper / legacy');
  await t('flipping a header byte fails authentication', async () => {
    const { r } = await mk({ protected: true, viewOnce: true });
    const b = r.bytes.slice(); b[30] ^= 1;                        // salt byte
    const p = await C.prepare(b, PW);
    await rejects(C.open(p, Buffer.alloc(32).toString('base64')), 'BAD_KEY');
  });
  await t('release share alone (wrong password) cannot decrypt', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    const share = (await post('claim', { itemId: r.itemId, auth: p.auth })).body.share;
    await rejects(C.open(await C.prepare(r.bytes, 'some other password!!'), share), 'BAD_KEY');
  });

  console.log('\nSecure-app-only items (Android wrapper)');
  const mkApp = async pol => { const r = await enc({ policy: pol, appOnly: true }); return { r, p: await C.prepare(r.bytes, PW) }; };
  const post2 = async (op, b, ua) => { const r = await fetch(base + '/api/release.php', { method: 'POST', headers: ua ? { 'User-Agent': ua } : {}, body: JSON.stringify(Object.assign({ op }, b)) }); return { status: r.status, body: await r.json() }; };
  await t('app-only flag is in the authenticated header; protected+app-only needs the release service', async () => {
    const { r, p } = await mkApp({ protected: true });
    assert.strictEqual(r.appOnly, true); assert.strictEqual(r.oneTime, false); assert.strictEqual(p.header.appOnly, true); assert.strictEqual(p.header.needsShare, true);
    await rejects(C.decrypt(r.bytes, PW), 'NEEDS_SHARE');
  });
  await t('clearing the app-only or share bit in the header is rejected', async () => {
    const { r } = await mkApp({ protected: true });
    const a = r.bytes.slice(); a[5] &= ~0x04; await rejects(C.prepare(a, PW), 'BAD_INPUT');   // share still set, app-only gone, no one-time mode
    const b = r.bytes.slice(); b[5] &= ~0x02; await rejects(C.prepare(b, PW), 'BAD_INPUT');   // app-only set but share bit gone
  });
  await t('ordinary browser (no app marker) is refused and nothing is used up or counted', async () => {
    const { r, p } = await mkApp({ protected: true, viewOnce: true });
    for (let i = 0; i < 5; i++) { const v = await post2('claim', { itemId: r.itemId, auth: p.auth }, 'Mozilla/5.0 Chrome/120'); assert.strictEqual(v.status, 403); assert.strictEqual(v.body.error, 'apponly'); }
    const bad = await post2('verify', { itemId: r.itemId, auth: 'ee'.repeat(32) }, 'Mozilla/5.0 Chrome/120');   // wrong password from a browser must not count a strike
    assert.strictEqual(bad.body.error, 'apponly');
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, APP)).status, 200);          // still fully intact for the app
  });
  await t('app + view-once: opens once only, even inside the app', async () => {
    const { r, p } = await mkApp({ protected: true, viewOnce: true });
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, APP)).status, 200);
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, APP)).status, 410);
  });
  await t('app + protected-only is reusable inside the app, and a refused browser cannot read it', async () => {
    const { r, p } = await mkApp({ protected: true });
    const first = await post2('claim', { itemId: r.itemId, auth: p.auth }, APP);
    const second = await post2('claim', { itemId: r.itemId, auth: p.auth }, APP);
    assert.strictEqual(first.status, 200); assert.strictEqual(second.status, 200);
    assert.strictEqual((await C.open(await C.prepare(r.bytes, PW), second.body.share)).text, 'secret exam paper');
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, 'Mozilla/5.0')).status, 403);
  });
  await t('wrong passwords in the app still lock a reusable item for everyone', async () => {
    const { r, p } = await mkApp({ protected: true });
    for (let i = 0; i < 3; i++) await post2('verify', { itemId: r.itemId, auth: 'dd'.repeat(32) }, APP);
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, APP)).status, 423);
  });
  await t('items that are NOT app-only open from any browser (regression)', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    assert.strictEqual((await post2('claim', { itemId: r.itemId, auth: p.auth }, 'Mozilla/5.0 Chrome')).status, 200);
  });

  console.log('\nExpiry, cleanup, hardening');
  await t('item not opened before its expiry can never be opened (key deleted)', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    sql('$p->exec("UPDATE items SET expires=" . (time()-5) . " WHERE item_id=\'' + r.itemId + '\'");');
    const c = await post('claim', { itemId: r.itemId, auth: p.auth });
    assert.strictEqual(c.status, 410); assert.strictEqual(c.body.error, 'expired');
    assert.strictEqual(sql('echo $p->query("SELECT share IS NULL FROM items WHERE item_id=\'' + r.itemId + '\'")->fetchColumn();').toString(), '1');
  });
  await t('sender-chosen expiry is stored and capped (ttl 99 years -> 1 year)', async () => {
    const reg = await post('register', { itemId: 'a1'.repeat(16), auth: 'b2'.repeat(32), share: Buffer.alloc(32, 7).toString('base64'), ttl: 99 * 365 * 86400 });
    assert(reg.body.expires - Math.floor(Date.now() / 1000) <= 31536000 + 5);
  });
  await t('long-dead rows are purged on later registrations', async () => {
    const { r } = await mk({ protected: true, viewOnce: true });
    sql('$p->exec("UPDATE items SET state=\'burned\', died=1 WHERE item_id=\'' + r.itemId + '\'");');
    await mk({ protected: true, viewOnce: true });                                   // triggers purge
    assert.strictEqual(sql('echo $p->query("SELECT COUNT(*) FROM items WHERE item_id=\'' + r.itemId + '\'")->fetchColumn();').toString(), '0');
  });
  await t('malformed / oversized / wrong-method requests are rejected', async () => {
    assert.strictEqual((await fetch(base + '/api/release.php')).status, 405);
    assert.strictEqual((await post('claim', { itemId: 'zz', auth: 'x' })).status, 400);
    assert.strictEqual((await post('drop', { itemId: 'a'.repeat(32), auth: 'a'.repeat(64) })).status, 400);
    assert.strictEqual((await fetch(base + '/api/release.php', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  });
  await t('server never stores the password proof in clear (only its SHA-256)', async () => {
    const { r, p } = await mk({ protected: true, viewOnce: true });
    const stored = sql('echo $p->query("SELECT auth_hash FROM items WHERE item_id=\'' + r.itemId + '\'")->fetchColumn();').toString();
    assert.notStrictEqual(stored, p.auth); assert.strictEqual(stored.length, 64);
  });

  srv.kill(); try { fs.unlinkSync(DB); } catch (e) { /* ignore */ }
  console.log('\n' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN ? 1 : 0);
})();

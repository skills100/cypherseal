// Tests for js/native.js: how files are saved in the app and in a browser.
const assert = require('assert');
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

function freshWindow(extra = {}) {
  const clicks = [];
  const doc = { body: { appendChild() {} }, createElement() { return { click() { clicks.push(this.download); }, remove() {} }; } };
  const win = { btoa: (s) => Buffer.from(s, 'binary').toString('base64'), URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, document: doc, navigator: {}, ...extra };
  win.window = win; return { win, clicks };
}
function load(win) {
  delete require.cache[require.resolve('../js/native.js')];
  const keep = { window: global.window, Blob: global.Blob };
  global.window = win; global.File = global.File || class { constructor(p, n, o) { this.name = n; } };
  require('../js/native.js'); const out = win.CSNative; global.window = keep.window; return out;
}

(async () => {
  await t('browser: falls back to an ordinary download link', async () => {
    const { win, clicks } = freshWindow(); const N = load(win);
    const r = await N.saveBytes('a.cenc', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    assert.strictEqual(r, 'downloaded'); assert.deepStrictEqual(clicks, ['a.cenc']);
  });
  await t('app: writes the file to cache and opens the share sheet', async () => {
    const calls = [];
    const Capacitor = { isNativePlatform: () => true, Plugins: {
      Filesystem: { writeFile: async (o) => { calls.push(['write', o.path, o.directory, o.data]); return { uri: 'file:///cache/' + o.path }; } },
      Share: { share: async (o) => { calls.push(['share', o.url]); } } } };
    const { win, clicks } = freshWindow({ Capacitor }); const N = load(win);
    const r = await N.saveBytes('ho/me.cenc', new Uint8Array([1, 2, 3]));
    assert.strictEqual(r, 'shared'); assert.strictEqual(clicks.length, 0);
    assert.deepStrictEqual(calls[0], ['write', 'ho_me.cenc', 'CACHE', 'AQID']); assert.deepStrictEqual(calls[1], ['share', 'file:///cache/ho_me.cenc']);
  });
  await t('app: a cancelled share sheet is not an error and does not download', async () => {
    const Capacitor = { isNativePlatform: () => true, Plugins: { Filesystem: { writeFile: async () => ({ uri: 'file:///x' }) }, Share: { share: async () => { throw new Error('Share canceled'); } } } };
    const { win, clicks } = freshWindow({ Capacitor }); const N = load(win);
    assert.strictEqual(await N.saveBytes('b.bin', new Uint8Array([9])), 'cancelled'); assert.strictEqual(clicks.length, 0);
  });
  await t('app without plugins still ends in a normal download attempt', async () => {
    const { win, clicks } = freshWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } }); const N = load(win);
    assert.strictEqual(await N.saveBytes('c.bin', new Uint8Array([7])), 'downloaded'); assert.deepStrictEqual(clicks, ['c.bin']);
  });
  await t('setSecure posts to the iPhone message handler and is silent elsewhere', async () => {
    const sent = []; const { win } = freshWindow({ webkit: { messageHandlers: { csSecure: { postMessage: (v) => sent.push(v) } } } }); const N = load(win);
    N.setSecure(true); N.setSecure(false); assert.deepStrictEqual(sent, [true, false]);
    const { win: w2 } = freshWindow(); load(w2).setSecure(true);   // must not throw
  });
  console.log('native tests: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });

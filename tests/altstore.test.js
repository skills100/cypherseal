'use strict';
const assert = require('assert'); const { buildSource } = require('../native/make-altstore-json');
const s = buildSource('https://Vault.example.com/', 123456, '1.0', '2026-10-30');
let n = 0; const t = (m, f) => { f(); n++; console.log('  ok   ' + m); };
t('absolute https URLs from the domain', () => { assert.strictEqual(s.sourceURL, 'https://Vault.example.com/downloads/altstore.json'); assert.strictEqual(s.apps[0].downloadURL, 'https://Vault.example.com/downloads/CipherSeal.ipa'); assert(s.apps[0].iconURL.startsWith('https://')); });
t('bundle id matches the Capacitor appId', () => assert.strictEqual(s.apps[0].bundleIdentifier, require('../native/capacitor.config.json').appId));
t('size and required AltStore fields present', () => { const a = s.apps[0]; ['name','bundleIdentifier','developerName','version','versionDate','downloadURL','iconURL','localizedDescription'].forEach(k => assert(a[k], k)); assert.strictEqual(a.size, 123456); });
console.log('\n' + n + ' passed, 0 failed');

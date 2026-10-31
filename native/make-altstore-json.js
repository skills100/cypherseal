#!/usr/bin/env node
/**
 * Writes the AltStore "source" file that lets AltStore on an iPhone add and install CipherSeal with a tap.
 *   node make-altstore-json.js <domain> <path-to-ipa> [version]  >  altstore.json
 * Upload altstore.json and CipherSeal.ipa to public_html/downloads/ on your hosting.
 */
'use strict';
const fs = require('fs');

function buildSource(domain, size, version, date) {
  const base = 'https://' + domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return {
    name: 'CipherSeal',
    identifier: 'com.cipherseal.source',
    sourceURL: base + '/downloads/altstore.json',
    apps: [{
      name: 'CipherSeal Vault',
      bundleIdentifier: 'com.cipherseal.vault',
      developerName: 'CipherSeal project',
      subtitle: 'Protected viewing',
      localizedDescription: 'Opens protected, view-once and self-destruct CipherSeal items with a camera guard and screen-capture blanking.',
      version, versionDate: date, versionDescription: 'Project build',
      downloadURL: base + '/downloads/CipherSeal.ipa',
      iconURL: base + '/assets/img/app-icon.png',
      tintColor: 'D4AF37',
      size,
      screenshotURLs: []
    }],
    news: []
  };
}
module.exports = { buildSource };

if (require.main === module) {
  const [domain, ipa, version] = process.argv.slice(2);
  if (!domain || !ipa) { console.error('usage: make-altstore-json.js <domain> <ipa> [version]'); process.exit(1); }
  const size = fs.statSync(ipa).size;
  process.stdout.write(JSON.stringify(buildSource(domain, size, version || '1.0', new Date().toISOString().slice(0, 10)), null, 2) + '\n');
}

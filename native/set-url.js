#!/usr/bin/env node
/**
 * Points the app at your site. Accepts a bare domain, a domain with a folder, or a full URL:
 *   node set-url.js ndlapprenticeschool.com/CYPHER
 *   node set-url.js https://ndlapprenticeschool.com/CYPHER/
 * Writes server.url (with trailing slash) and allowNavigation (host only) into capacitor.config.json.
 */
'use strict';
const fs = require('fs'), path = require('path');

function parse(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Give your site address, e.g. ndlapprenticeschool.com/CYPHER');
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (u.protocol !== 'https:') throw new Error('The site must use https://');
  const folder = u.pathname.replace(/\/+$/, '');               // '' or '/CYPHER'
  return { base: u.origin + folder, url: u.origin + folder + '/', host: u.hostname };
}
module.exports = { parse };

if (require.main === module) {
  try {
    const s = parse(process.argv[2]);
    const file = path.join(__dirname, 'capacitor.config.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.server = Object.assign({}, c.server, { url: s.url, cleartext: false, allowNavigation: [s.host] });
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
    console.log('App will load: ' + s.url);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}

/**
 * release.js — browser client for the CipherSeal release service.
 * Only ever sends: item ID, a password PROOF (not the password) and, at
 * registration, the random key share. Same-origin only (CSP connect-src 'self').
 */
(function (global) {
  'use strict';

  async function post(path, body) {
    let r;
    try {
      r = await fetch('api/release.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ op: path }, body)), cache: 'no-store' });
    } catch (e) {
      const err = new Error('The release service could not be reached. View-once and self-destruct items need an internet connection.');
      err.code = 'OFFLINE'; throw err;
    }
    let j = {};
    try { j = await r.json(); } catch (e) { /* non-JSON error page */ }
    return { status: r.status, body: j };
  }

  function fail(res, fallback) {
    const err = new Error((res.body && res.body.message) || fallback);
    err.code = (res.body && res.body.error) || 'SERVER';
    err.left = res.body && res.body.left;
    err.fails = res.body && res.body.fails;
    err.status = res.status;
    return err;
  }

  global.CSRelease = {
    async register(itemId, auth, share, ttl, extra) {
      const res = await post('register', Object.assign({ itemId, auth, share, ttl }, extra || {}));
      if (res.status !== 200) throw fail(res, 'Could not register this item with the release service.');
    },
    /** Checks the password proof; does NOT consume the item. Wrong proofs are counted on the server. */
    async verify(itemId, auth) {
      const res = await post('verify', { itemId, auth });
      if (res.status !== 200) throw fail(res, 'The release service refused this request.');
    },
    /** Releases the key share. Works exactly once for the lifetime of the item, on any device. */
    async claim(itemId, auth) {
      const res = await post('claim', { itemId, auth });
      if (res.status !== 200 || !res.body.share) throw fail(res, 'The release service refused this request.');
      return res.body.share;
    }
  };
})(window);

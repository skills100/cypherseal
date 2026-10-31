/**
 * guard.js — CipherSeal Vault attempt guard
 * Tracks, per encrypted item (by its random item ID), on THIS browser:
 *   - wrong-password attempts: 1st = warning 1, 2nd = final warning,
 *     3rd = the item is locked ("damaged") and can no longer be decrypted
 *   - view-once items that have already been decrypted once
 * The item ID sits inside the authenticated header of the container, so
 * changing it to reset the counter makes decryption fail.
 *
 * Honest scope: with no server, this state lives in this browser's local
 * storage. It stops casual and repeated guessing through the interface.
 * It cannot stop someone who copies the file and attacks it offline with
 * their own tools — that is what the long random password and the
 * dynamic PBKDF2 work factor are for.
 */
(function (global) {
  'use strict';

  const STORE_KEY = 'cipherseal_guard_v1';
  const MAX_FAILS = 3;
  let memory = {};          // fallback when storage is unavailable

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return memory; }
  }
  function save(data) {
    memory = data;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ }
  }
  function entry(data, id) { return data[id] || { fails: 0, state: 'ok', at: 0 }; }

  /** @returns {{state:'ok'|'locked'|'burned', fails:number}} */
  function status(itemId) {
    const e = entry(load(), itemId);
    return { state: e.state, fails: e.fails };
  }

  /** Register a wrong password. @returns {{fails:number, level:'warn1'|'warn2'|'locked'}} */
  function recordFail(itemId) {
    const data = load();
    const e = entry(data, itemId);
    if (e.state !== 'ok') return { fails: e.fails, level: e.state === 'locked' ? 'locked' : 'burned' };
    e.fails += 1;
    e.at = Date.now();
    if (e.fails >= MAX_FAILS) e.state = 'locked';
    data[itemId] = e;
    save(data);
    return { fails: e.fails, level: e.fails === 1 ? 'warn1' : (e.fails === 2 ? 'warn2' : 'locked') };
  }

  function clearFails(itemId) {
    const data = load();
    const e = entry(data, itemId);
    if (e.state === 'ok') { e.fails = 0; data[itemId] = e; save(data); }
  }

  function markBurned(itemId) {
    const data = load();
    const e = entry(data, itemId);
    e.state = 'burned'; e.at = Date.now();
    data[itemId] = e;
    save(data);
  }

  global.CSGuard = { status, recordFail, clearFails, markBurned, MAX_FAILS };
})(window);

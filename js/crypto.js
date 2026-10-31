/**
 * crypto.js — CipherSeal Vault core cryptography
 * -----------------------------------------------------------------------
 * Everything here runs in the visitor's browser through the native Web
 * Cryptography API. Nothing is uploaded; there is no server component.
 *
 *  - AES-256-GCM authenticated encryption
 *  - PBKDF2-HMAC-SHA-256 with a DYNAMIC iteration count: the work factor
 *    is chosen per encryption from the record sensitivity level (public ...
 *    restricted) and a quick on-device speed probe (Computational
 *    Resource Index, CRI). The count is stored in the container header.
 *  - SHA-256 integrity digest of the encrypted content (checked on decrypt)
 *  - The whole container header is bound to the ciphertext as GCM
 *    "additional authenticated data" (AAD), so changing the item ID, salt,
 *    iteration count or recovery blob makes decryption fail.
 *  - Optional RSA-OAEP (2048, SHA-256) owner-recovery wrapping of the password
 *
 * Container v4 layout (little-endian). v3 ("CSV3", no mode byte, 56-byte
 * fixed header, no server share) is still readable.
 *   0..3    "CSV4"            magic
 *   4       version (4)
 *   5       flags (bit0 = owner-recovery blob, bit1 = key needs server share, bit2 = secure-app only)
 *   6       mode  (bit0 = protected, bit1 = view-once, bit2 = self-destruct)
 *   7..22   item ID (16 random bytes)
 *   23..38  PBKDF2 salt (16)
 *   39..50  AES-GCM IV (12)
 *   51..54  PBKDF2 iterations (uint32)
 *   55..56  recovery blob length (uint16)
 *   57..    recovery blob (RSA-OAEP wrapped password), if flagged
 *   ...     AES-256-GCM ciphertext (+16-byte tag)
 *
 * KEY SCHEDULE (v4)
 *   pw   = PBKDF2-HMAC-SHA-256(password, salt, iterations)           256 bit
 *   enc  = HKDF(ikm=pw, salt=SHARE, info="cipherseal/v4/enc/<MODE>/<itemId>")
 *   auth = HKDF(ikm=pw, salt=SHARE?, info="cipherseal/v4/auth/<itemId>") -> "right password?" proof for the release service
 * SHARE is a random 256-bit value held ONLY by the release service for
 * view-once / self-destruct items and handed out exactly once. <MODE> is a
 * per-mode label, so a protected item, a view-once item and a self-destruct
 * item never share key material even with the same password.
 * -----------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const MAGIC = new Uint8Array([0x43, 0x53, 0x56, 0x34]); // "CSV4"
  const MAGIC3 = new Uint8Array([0x43, 0x53, 0x56, 0x33]); // legacy "CSV3"
  const VERSION = 4;
  const FLAG_RECOVERY = 0x01;
  const FLAG_SHARE = 0x02;
  const FLAG_APPONLY = 0x04;
  const MODE_PROTECTED = 1, MODE_ONCE = 2, MODE_TIMER = 4;
  const HEADER_FIXED = 57;
  const HEADER_FIXED_V3 = 56;

  const BASE_ITERS = 250000;      // floor for the lowest sensitivity level
  const MIN_ITERS = 250000;       // never derive below this
  const MAX_ITERS = 2000000;      // reject larger values on open (DoS guard)
  const RSA_OAEP_MAX_BYTES = 190; // 2048-bit key, SHA-256 OAEP overhead

  const SENSITIVITY = {
    public:       { label: 'Public',       mult: 1.0, hint: 'Course handout, syllabus' },
    internal:     { label: 'Internal',     mult: 1.4, hint: 'Draft coursework, notes' },
    confidential: { label: 'Confidential', mult: 2.0, hint: 'Result sheet, grade report' },
    restricted:   { label: 'Restricted',   mult: 2.8, hint: 'Official transcript, exam script' }
  };

  class CSError extends Error {
    constructor(code, message) { super(message); this.name = 'CSError'; this.code = code; }
  }

  // ---------------------------------------------------------------- bytes
  function concat(...arrs) {
    let total = 0;
    arrs.forEach(a => { total += a.length; });
    const out = new Uint8Array(total);
    let off = 0;
    arrs.forEach(a => { out.set(a, off); off += a.length; });
    return out;
  }
  const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  const r16 = (b, o) => b[o] | (b[o + 1] << 8);
  const r32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  function toHex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '');
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
      throw new CSError('BAD_INPUT', 'That does not look like encrypted text.');
    }
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function sha256Hex(bytes) {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }

  // ------------------------------------------------- dynamic key derivation
  let criCache = null;

  /** Computational Resource Index (0..1): faster device -> higher value. */
  async function deviceIndex() {
    if (criCache) return criCache;
    const base = await crypto.subtle.importKey('raw', enc.encode('cipherseal-probe'), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array(16);
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 2000, hash: 'SHA-256' }, base, 256); // warm-up
    const t0 = performance.now();
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 20000, hash: 'SHA-256' }, base, 256);
    const ms = performance.now() - t0;
    const cri = Math.max(0, Math.min(1, (120 - ms) / 110));
    criCache = { ms: Number(ms.toFixed(1)), cri: Number(cri.toFixed(3)) };
    return criCache;
  }

  /** iterations = BASE x sensitivity multiplier x (0.85 .. 1.15 by CRI), clamped. */
  function planIterations(sensitivityKey, cri) {
    const s = SENSITIVITY[sensitivityKey] || SENSITIVITY.internal;
    const raw = BASE_ITERS * s.mult * (0.85 + 0.30 * cri);
    const rounded = Math.round(raw / 1000) * 1000;
    return Math.max(MIN_ITERS, Math.min(MAX_ITERS, rounded));
  }

  /** Slow, password-only stage. Result never leaves memory. */
  async function stretch(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256));
  }
  async function deriveKey(password, salt, iterations) {     // legacy v3
    const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function modeLabel(mode) {
    const l = (mode & MODE_PROTECTED ? 'P' : '') + (mode & MODE_ONCE ? 'O' : '') + (mode & MODE_TIMER ? 'T' : '');
    return l || 'STD';
  }
  async function hkdf(ikm, salt, info, bits) {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, bits));
  }
  async function authToken(pw, itemIdHex) { return toHex(await hkdf(pw, new Uint8Array(0), 'cipherseal/v4/auth/' + itemIdHex, 256)); }
  async function encKey(pw, share, mode, itemIdHex) {
    const raw = await hkdf(pw, share || new Uint8Array(0), 'cipherseal/v4/enc/' + modeLabel(mode) + '/' + itemIdHex, 256);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    raw.fill(0);
    return key;
  }

  // ------------------------------------------------------------- policy
  function normalisePolicy(p) {
    p = p || {};
    let secs = Math.floor(Number(p.viewSeconds) || 0);
    if (secs < 0) secs = 0;
    if (secs > 0) secs = Math.max(3, Math.min(86400, secs));
    return { viewSeconds: secs, viewOnce: !!p.viewOnce, protected: !!p.protected };
  }

  // --------------------------------------------------------------- header
  function parseHeader(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_FIXED_V3 + 28) {
      throw new CSError('BAD_INPUT', 'This is not a CipherSeal item (too short).');
    }
    const is4 = MAGIC.every((m, i) => bytes[i] === m);
    const is3 = MAGIC3.every((m, i) => bytes[i] === m);
    if (!is4 && !is3) throw new CSError('BAD_INPUT', 'This is not a CipherSeal item (unknown format).');
    const o = is4 ? 1 : 0;                       // v4 has one extra byte (mode) after flags
    if (bytes[4] !== (is4 ? 4 : 3)) throw new CSError('BAD_INPUT', 'Unsupported CipherSeal version.');
    if (is4 && bytes.length < HEADER_FIXED + 28) throw new CSError('BAD_INPUT', 'This is not a CipherSeal item (too short).');
    const flags = bytes[5];
    const mode = is4 ? bytes[6] : 0;
    const iterations = r32(bytes, 50 + o);
    if (iterations < MIN_ITERS || iterations > MAX_ITERS) {
      throw new CSError('BAD_INPUT', 'This item declares an unsafe key-derivation setting and was refused.');
    }
    const recLen = r16(bytes, 54 + o);
    const hasRecovery = (flags & FLAG_RECOVERY) !== 0;
    const needsShare = is4 && (flags & FLAG_SHARE) !== 0;
    const appOnly = is4 && (flags & FLAG_APPONLY) !== 0;
    if (!hasRecovery && recLen !== 0) throw new CSError('BAD_INPUT', 'Corrupted header.');
    if (is4 && needsShare !== (!!(mode & (MODE_ONCE | MODE_TIMER)) || appOnly)) throw new CSError('BAD_INPUT', 'Corrupted header.');
    const fixed = HEADER_FIXED_V3 + o;
    const headerEnd = fixed + recLen;
    if (bytes.length < headerEnd + 17) throw new CSError('BAD_INPUT', 'This item is truncated.');
    return {
      version: bytes[4], legacy: !is4, flags, mode, needsShare, appOnly, hasRecovery,
      itemId: toHex(bytes.subarray(6 + o, 22 + o)),
      salt: bytes.slice(22 + o, 38 + o),
      iv: bytes.slice(38 + o, 50 + o),
      iterations,
      recoveryBlob: hasRecovery ? bytes.slice(fixed, headerEnd) : null,
      headerEnd
    };
  }

  /** Accepts Base64 text or raw bytes and returns validated bytes. */
  function toCipherBytes(input) {
    const bytes = typeof input === 'string' ? base64ToBytes(input) : input;
    parseHeader(bytes);
    return bytes;
  }

  // -------------------------------------------------------------- encrypt
  /**
   * opts.release = { register(itemIdHex, authHex, shareB64, ttlSeconds) } is REQUIRED for
   * view-once / self-destruct items. The share is registered BEFORE the item
   * is returned; if the release service is unreachable, encryption fails
   * instead of producing an item that could be opened unlimited times.
   */
  async function encrypt(opts) {
    const password = opts.password;
    if (!password || password.length < 8) throw new CSError('BAD_INPUT', 'A password is required.');
    const textBytes = enc.encode(opts.text || '');
    const file = opts.file || null;
    const fileBytes = file ? file.bytes : new Uint8Array(0);
    if (!textBytes.length && !fileBytes.length) throw new CSError('BAD_INPUT', 'Add a message or a file to encrypt.');

    const sensitivity = SENSITIVITY[opts.sensitivity] ? opts.sensitivity : 'internal';
    const policy = normalisePolicy(opts.policy);
    const mode = (policy.protected ? MODE_PROTECTED : 0) | (policy.viewOnce ? MODE_ONCE : 0) | (policy.viewSeconds ? MODE_TIMER : 0);
    const appOnly = !!opts.appOnly && mode !== 0;
    const oneTime = !!(mode & (MODE_ONCE | MODE_TIMER));
    const needsShare = oneTime || appOnly;
    if (needsShare && !(opts.release && opts.release.register)) {
      throw new CSError('NO_RELEASE', 'View-once and self-destruct items need the release service, which is not available.');
    }
    const probe = await deviceIndex();
    const iterations = planIterations(sensitivity, probe.cri);

    const meta = {
      v: 4,
      createdAt: new Date().toISOString(),
      sensitivity,
      policy,
      text: { len: textBytes.length },
      file: file ? { name: String(file.name).slice(0, 255), type: file.type || 'application/octet-stream', len: fileBytes.length } : null,
      sha256: await sha256Hex(concat(textBytes, fileBytes))
    };
    const metaBytes = enc.encode(JSON.stringify(meta));
    const plain = concat(u32(metaBytes.length), metaBytes, textBytes, fileBytes);

    let flags = 0;
    let recoveryBlob = new Uint8Array(0);
    if (opts.recoveryJwk) {
      const pwBytes = enc.encode(password.normalize('NFC'));
      if (pwBytes.length > RSA_OAEP_MAX_BYTES) throw new CSError('BAD_INPUT', 'Password is too long for owner recovery.');
      const pub = await crypto.subtle.importKey('jwk', publicJwk(opts.recoveryJwk), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      recoveryBlob = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, pwBytes));
      flags |= FLAG_RECOVERY;
    }
    if (needsShare) flags |= FLAG_SHARE;
    if (appOnly) flags |= FLAG_APPONLY;

    const itemId = rand(16), itemHex = toHex(itemId);
    const salt = rand(16);
    const iv = rand(12);
    const header = concat(MAGIC, new Uint8Array([VERSION, flags, mode]), itemId, salt, iv, u32(iterations), u16(recoveryBlob.length), recoveryBlob);

    const pw = await stretch(password, salt, iterations);
    const share = needsShare ? rand(32) : null;
    const key = await encKey(pw, share, mode, itemHex);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, plain));
    plain.fill(0);
    if (needsShare) {
      await opts.release.register(itemHex, await authToken(pw, itemHex), bytesToBase64(share), opts.expirySeconds, { appOnly, reusable: appOnly && !oneTime });
      share.fill(0);
    }
    pw.fill(0);

    const bytes = concat(header, ct);
    return {
      bytes,
      itemId: itemHex,
      iterations,
      sensitivity,
      policy,
      mode,
      serverShare: needsShare,
      appOnly,
      oneTime,
      cri: probe.cri,
      probeMs: probe.ms,
      recovery: (flags & FLAG_RECOVERY) !== 0,
      fingerprint: await sha256Hex(bytes)
    };
  }

  // -------------------------------------------------------------- decrypt
  /**
   * Stage 1 (slow, local): parse the header and stretch the password.
   * Returns { header, auth } where auth is the proof the release service checks.
   * No camera, no server and no content is touched yet.
   */
  async function prepare(input, password) {
    const bytes = toCipherBytes(input);
    const h = parseHeader(bytes);
    const prep = { bytes, header: h, pw: null, auth: null, legacyKey: null };
    if (h.legacy) prep.legacyKey = await deriveKey(password || '', h.salt, h.iterations);
    else {
      prep.pw = await stretch(password || '', h.salt, h.iterations);
      prep.auth = await authToken(prep.pw, h.itemId);
    }
    return prep;
  }

  /** Stage 2: decrypt. `shareB64` is required iff header.needsShare. */
  async function open(prep, shareB64) {
    const { bytes, header: h } = prep;
    if (h.needsShare && !shareB64) throw new CSError('NEEDS_SHARE', 'This item can only be opened through the release service.');
    const aad = bytes.subarray(0, h.headerEnd);
    let key;
    if (h.legacy) key = prep.legacyKey;
    else {
      const share = h.needsShare ? base64ToBytes(shareB64) : null;
      key = await encKey(prep.pw, share, h.mode, h.itemId);
      if (share) share.fill(0);
    }
    prep.pw && prep.pw.fill(0);
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: h.iv, additionalData: aad }, key, bytes.subarray(h.headerEnd)));
    } catch (e) {
      throw new CSError('BAD_KEY', 'Wrong password, or the item was altered.');
    }
    try {
      const metaLen = r32(plain, 0);
      if (metaLen > plain.length - 4) throw new Error('meta');
      const meta = JSON.parse(dec.decode(plain.subarray(4, 4 + metaLen)));
      const tl = meta.text && meta.text.len ? meta.text.len : 0;
      const fl = meta.file && meta.file.len ? meta.file.len : 0;
      const body = plain.subarray(4 + metaLen);
      if (body.length !== tl + fl) throw new Error('len');
      if ((await sha256Hex(body)) !== meta.sha256) throw new Error('sha');
      meta.policy = normalisePolicy(meta.policy);
      if (!h.legacy) {
        const m = (meta.policy.protected ? MODE_PROTECTED : 0) | (meta.policy.viewOnce ? MODE_ONCE : 0) | (meta.policy.viewSeconds ? MODE_TIMER : 0);
        if (m !== h.mode) throw new Error('mode');
      }
      return {
        itemId: h.itemId,
        meta,
        text: dec.decode(body.subarray(0, tl)),
        fileBytes: body.slice(tl, tl + fl)
      };
    } catch (e) {
      throw new CSError('CORRUPT', 'The item decrypted but its contents failed the integrity check.');
    } finally {
      plain.fill(0);
    }
  }

  /** Convenience for items that need no release service (standard / protected-only, legacy v3). */
  async function decrypt(input, password) {
    return open(await prepare(input, password), null);
  }

  // -------------------------------------------------------- owner recovery
  function publicJwk(j) { return { kty: j.kty, n: j.n, e: j.e, alg: j.alg, ext: true, key_ops: ['encrypt'] }; }

  async function recover(input, privateJwk) {
    const bytes = toCipherBytes(input);
    const h = parseHeader(bytes);
    if (!h.hasRecovery) throw new CSError('NO_RECOVERY', 'This item was encrypted without owner recovery.');
    let priv;
    try {
      priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
      const pw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, h.recoveryBlob);
      return dec.decode(pw);
    } catch (e) {
      throw new CSError('BAD_KEY', 'Wrong private key, or this item was not encrypted for this owner.');
    }
  }

  // ===================================================================
  // Document text extraction for Protected View
  // DOCX and PDF are read far enough to pull out their plain text, using
  // only native browser APIs (DecompressionStream) — no bundled library,
  // no network fetch. This is intentionally best-effort: layout, tables,
  // images and exotic encodings are not reproduced. If extraction fails,
  // the caller shows a safe "cannot preview" message instead of ever
  // falling back to an unprotected download.
  // ===================================================================

  async function inflateRaw(bytes, format) {
    const ds = new DecompressionStream(format);
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Minimal ZIP central-directory reader: returns Map<name, Uint8Array bytes>. */
  async function readZipEntries(bytes, wantedNames) {
    const want = new Set(wantedNames);
    const out = new Map();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // find End Of Central Directory record (scan from the end; comment is usually short)
    let eocd = -1;
    const maxBack = Math.min(bytes.length, 66000);
    for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new CSError('BAD_INPUT', 'Not a valid ZIP-based document.');
    const entryCount = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < entryCount; i++) {
      if (dv.getUint32(cdOffset, true) !== 0x02014b50) break;
      const method = dv.getUint16(cdOffset + 10, true);
      const compSize = dv.getUint32(cdOffset + 20, true);
      const nameLen = dv.getUint16(cdOffset + 28, true);
      const extraLen = dv.getUint16(cdOffset + 30, true);
      const commentLen = dv.getUint16(cdOffset + 32, true);
      const localOffset = dv.getUint32(cdOffset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
      if (want.has(name)) {
        const lh = dv;
        const lNameLen = lh.getUint16(localOffset + 26, true);
        const lExtraLen = lh.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const raw = bytes.subarray(dataStart, dataStart + compSize);
        out.set(name, method === 0 ? raw : await inflateRaw(raw, 'deflate-raw'));
      }
      cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** DOCX -> plain text (paragraph and line-break aware, tags stripped). */
  async function extractDocxText(bytes) {
    const entries = await readZipEntries(bytes, ['word/document.xml']);
    const xml = entries.get('word/document.xml');
    if (!xml) throw new CSError('BAD_INPUT', 'This does not look like a Word (.docx) document.');
    let s = new TextDecoder().decode(xml);
    s = s.replace(/<w:tab[^>]*\/>/g, '\t')
         .replace(/<w:br[^>]*\/>/g, '\n')
         .replace(/<\/w:p>/g, '\n')
         .replace(/<[^>]+>/g, '');
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function decodePdfString(raw) {
    let out = '', i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if (n === 'n') { out += '\n'; i += 2; }
        else if (n === 'r') { out += '\n'; i += 2; }
        else if (n === 't') { out += '\t'; i += 2; }
        else if (n >= '0' && n <= '7') { const oct = raw.substr(i + 1, 3).match(/^[0-7]{1,3}/)[0]; out += String.fromCharCode(parseInt(oct, 8)); i += 1 + oct.length; }
        else { out += n; i += 2; }
      } else { out += c; i++; }
    }
    return out;
  }

  /** PDF -> best-effort plain text from FlateDecode content streams. */
  async function extractPdfText(bytes) {
    const latin1 = Array.from(bytes, b => String.fromCharCode(b)).join('');
    const re = /<<([^>]*?)>>\s*stream\r?\n/g;
    let m, chunks = [], found = false;
    while ((m = re.exec(latin1))) {
      const dict = m[1];
      if (!/\/Filter\s*[\/\[][^>]*FlateDecode/.test(dict)) continue;
      const start = m.index + m[0].length;
      const end = latin1.indexOf('endstream', start);
      if (end < 0) continue;
      let raw = bytes.subarray(start, end);
      while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.subarray(0, -1);
      let inflated;
      try { inflated = await inflateRaw(raw, 'deflate'); } catch (e) { continue; }
      found = true;
      const content = new TextDecoder('latin1').decode(inflated);
      const showRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\[\]]|\\.)*)\]\s*TJ|(T\*|Td|TD)/g;
      let sm, line = [];
      while ((sm = showRe.exec(content))) {
        if (sm[1] !== undefined) line.push(decodePdfString(sm[1]));
        else if (sm[2] !== undefined) {
          const parts = sm[2].match(/\(((?:[^()\\]|\\.)*)\)/g) || [];
          parts.forEach(p => line.push(decodePdfString(p.slice(1, -1))));
        } else if (line.length) { chunks.push(line.join('')); line = []; }
      }
      if (line.length) chunks.push(line.join(''));
      chunks.push('');
    }
    if (!found) throw new CSError('BAD_INPUT', 'This PDF has no extractable (FlateDecode) text streams.');
    const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new CSError('BAD_INPUT', 'No readable text could be extracted from this PDF.');
    return text;
  }

  /** Dispatch by MIME/extension. Returns { text } or throws CSError. */
  async function extractDocumentText(fileBytes, mimeType, fileName) {
    const name = (fileName || '').toLowerCase();
    if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return { text: await extractPdfText(fileBytes) };
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) {
      return { text: await extractDocxText(fileBytes) };
    }
    throw new CSError('UNSUPPORTED', 'Unsupported document type for protected preview.');
  }

  global.CSCrypto = {
    CSError, SENSITIVITY, MIN_ITERS, MAX_ITERS, RSA_OAEP_MAX_BYTES,
    deviceIndex, planIterations, parseHeader, toCipherBytes,
    encrypt, decrypt, prepare, open, recover, extractDocumentText, MODE_PROTECTED, MODE_ONCE, MODE_TIMER,
    sha256Hex, toHex, bytesToBase64, base64ToBytes
  };
})(window);

/**
 * password.js — CipherSeal Vault password generator
 * Generates very strong, unbiased random passwords with the browser's
 * cryptographically secure random source (crypto.getRandomValues) and
 * rejection sampling, so no character is more likely than another.
 * Ambiguous characters (0 O 1 l I) are left out so the password can be
 * read back or typed by a recipient without mistakes.
 */
(function (global) {
  'use strict';

  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // 24
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';  // 25
  const DIGIT = '23456789';                   // 8
  const SYMBOL = '!@#$%^&*-_=+?';             // 13
  const ALL = UPPER + LOWER + DIGIT + SYMBOL; // 70

  const DEFAULT_LENGTH = 40;
  const MIN_CUSTOM_BITS = 80;
  const MIN_CUSTOM_LENGTH = 14;

  /** Uniform random integer in [0, max) with no modulo bias. */
  function randInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }

  function pick(set) { return set[randInt(set.length)]; }

  function generate(length) {
    const len = Math.max(24, Math.min(64, length || DEFAULT_LENGTH));
    const chars = [pick(UPPER), pick(UPPER), pick(LOWER), pick(LOWER), pick(DIGIT), pick(DIGIT), pick(SYMBOL), pick(SYMBOL)];
    while (chars.length < len) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {      // Fisher–Yates shuffle
      const j = randInt(i + 1);
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    return chars.join('');
  }

  /** Entropy (bits) of a generated password of the given length. */
  function generatedBits(length) { return length * Math.log2(ALL.length); }

  const COMMON = ['password', 'qwerty', 'letmein', '123456', 'iloveyou', 'admin', 'welcome', 'abc123', 'southwestern', 'cipherseal'];

  /** Conservative estimate for a user-typed password. */
  function estimate(pw) {
    if (!pw) return { bits: 0, score: 0, label: 'Empty', ok: false };
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
    let bits = pw.length * Math.log2(Math.max(pool, 2));
    const unique = new Set(pw).size;
    bits *= Math.min(1, unique / Math.max(8, pw.length * 0.6));      // penalise repetition
    if (/(.)\1{2,}/.test(pw)) bits *= 0.7;                          // aaa, 111
    if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(pw)) bits *= 0.6;
    const lower = pw.toLowerCase();
    if (COMMON.some(w => lower.includes(w))) bits *= 0.5;
    bits = Math.round(bits);
    const ok = pw.length >= MIN_CUSTOM_LENGTH && bits >= MIN_CUSTOM_BITS;
    let label = 'Weak';
    if (bits >= 200) label = 'Extreme';
    else if (bits >= 128) label = 'Very strong';
    else if (bits >= MIN_CUSTOM_BITS) label = 'Strong';
    else if (bits >= 56) label = 'Fair';
    return { bits, score: Math.min(1, bits / 160), label, ok };
  }

  global.CSPassword = { generate, generatedBits, estimate, DEFAULT_LENGTH, MIN_CUSTOM_BITS, MIN_CUSTOM_LENGTH };
})(window);

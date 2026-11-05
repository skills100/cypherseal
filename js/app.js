/**
 * app.js — CipherSeal Vault interface logic
 * Guest-only: there is no account and no network call except loading the
 * owner's PUBLIC recovery key from data/recovery-public-key.json.
 * User-supplied text is only ever written with textContent (never innerHTML).
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const C = window.CSCrypto, P = window.CSPassword, G = window.CSGuard, V = window.CSViewer, R = window.CSRelease;
  const MAX_FILE = 50 * 1024 * 1024;
  const MAX_TEXT_OUTPUT = 1.5 * 1024 * 1024;

  const state = {
    encryptFile: null, decryptFile: null, recFile: null, recKey: null,
    password: '', ownPassword: false, copied: false,
    recoveryJwk: null, encryptedBytes: null, encryptedName: 'encrypted.cenc'
  };

  // ------------------------------------------------------------ helpers
  function show(el, text) { el.textContent = text; el.classList.add('show'); }
  function clear(...els) { els.forEach(e => { e.textContent = ''; e.classList.remove('show'); }); }
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function shortId(hex) { return hex.slice(0, 8).toUpperCase() + '-' + hex.slice(8, 12).toUpperCase(); }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'offscreen';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function flashButton(btn, text) {
    const old = btn.textContent; btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }
  function setupDrop(zone, input, onFile) {
    zone.addEventListener('click', () => input.click());
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', e => { if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
  }
  const readBytes = async f => new Uint8Array(await f.arrayBuffer());

  // --------------------------------------------------------------- logo
  (function logo() {
    const img = new Image();
    img.onload = () => {
      const slot = $('logoSlot'); slot.textContent = ''; slot.classList.add('has-img');
      img.alt = 'Logo'; slot.appendChild(img);
    };
    img.src = 'assets/img/logo.png';
  })();

  // --------------------------------------------------------------- tabs
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'view-' + btn.dataset.tab));
  }));

  // 3D tilt for technology badges
  document.querySelectorAll('.tech-badge').forEach(b => {
    b.addEventListener('pointermove', e => {
      const r = b.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      b.style.transform = 'rotateX(' + (-y * 16).toFixed(1) + 'deg) rotateY(' + (x * 16).toFixed(1) + 'deg) translateY(-4px) scale(1.03)';
    });
    b.addEventListener('pointerleave', () => { b.style.transform = ''; });
  });

  window.CSPadlock.init('lockStage');

  // --------------------------------------------- recovery public key JSON
  fetch('data/recovery-public-key.json', { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('missing'); return r.json(); })
    .then(j => { state.recoveryJwk = j; })
    .catch(() => {
      $('optRecovery').disabled = true;
      $('recoveryNote').textContent = 'Owner recovery is unavailable: the recovery key file could not be loaded (host the folder on a web server rather than opening index.html from disk).';
    });

  // ---------------------------------------------------- dynamic KDF preview
  async function refreshIterPreview() {
    try {
      const probe = await C.deviceIndex();
      const key = $('encryptSensitivity').value;
      const n = C.planIterations(key, probe.cri);
      $('iterPreview').textContent = 'PBKDF2 will use ' + n.toLocaleString() + ' iterations on this device (' + C.SENSITIVITY[key].label + ')';
    } catch (e) { $('iterPreview').textContent = 'PBKDF2 work factor is set automatically'; }
  }
  $('encryptSensitivity').addEventListener('change', refreshIterPreview);
  refreshIterPreview();

  // ------------------------------------------------------- password panel
  function renderPassword() {
    const pw = state.password;
    $('pwField').value = pw;
    let est;
    if (state.ownPassword) est = P.estimate(pw);
    else { const bits = Math.round(P.generatedBits(pw.length)); est = { bits, score: Math.min(1, bits / 160), label: bits >= 200 ? 'Extreme' : 'Very strong', ok: true }; }
    const fill = $('pwMeter');
    fill.style.width = Math.max(4, Math.round(est.score * 100)) + '%';
    fill.style.background = est.ok ? (est.bits >= 128 ? '#43c98a' : '#d4af37') : '#e2554a';
    $('pwMeterText').textContent = est.label + ' \u00B7 about ' + est.bits + ' bits of entropy' +
      (state.ownPassword && !est.ok ? ' \u2014 too weak: use at least ' + P.MIN_CUSTOM_LENGTH + ' characters mixing letters, numbers and symbols' : '');
    state.copied = false;
  }
  function newPassword() { state.password = P.generate(P.DEFAULT_LENGTH); renderPassword(); }
  newPassword();

  $('pwNew').addEventListener('click', () => {
    if (state.ownPassword) { $('pwField').value = ''; state.password = ''; renderPassword(); $('pwField').focus(); return; }
    newPassword();
  });
  $('pwShow').addEventListener('click', () => {
    const f = $('pwField'); const hide = f.type === 'text';
    f.type = hide ? 'password' : 'text'; $('pwShow').textContent = hide ? 'SHOW' : 'HIDE';
  });
  $('pwCopy').addEventListener('click', async () => {
    flashButton($('pwCopy'), (await copyText(state.password)) ? 'COPIED' : 'FAILED');
  });
  $('pwModeBtn').addEventListener('click', () => {
    state.ownPassword = !state.ownPassword;
    const f = $('pwField');
    if (state.ownPassword) {
      f.readOnly = false; f.type = 'text'; $('pwShow').textContent = 'HIDE';
      state.password = ''; $('pwTitle').textContent = 'Your own password'; $('pwModeBtn').textContent = 'Use an auto-generated password instead';
      $('pwNew').textContent = 'CLEAR'; renderPassword(); f.focus();
    } else {
      f.readOnly = true; $('pwTitle').textContent = 'Auto-generated very strong password';
      $('pwModeBtn').textContent = 'Use my own password instead'; $('pwNew').textContent = 'NEW'; newPassword();
    }
  });
  $('pwField').addEventListener('input', () => {
    if (!state.ownPassword) return;
    state.password = $('pwField').value; renderPassword();
  });

  // ---------------------------------------------- encrypt: file handling
  // Protected view supports text, Word (.docx), PDF and images — anything
  // else can still be encrypted/decrypted normally, just not previewed
  // in the anti-copy canvas viewer (see js/viewer.js + extractDocumentText
  // in js/crypto.js for how each type is turned into safe-to-paint content).
  const PROTECTABLE_RE = /^(image\/(png|jpe?g|gif|webp|bmp)|text\/.*|application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
  const protectedOk = f => PROTECTABLE_RE.test(f.type) || /\.(txt|md|docx|pdf)$/i.test(f.name);
  setupDrop($('encryptDrop'), $('encryptFile'), f => {
    clear($('encryptErr'), $('encryptWarn'));
    if (f.size > MAX_FILE) { show($('encryptErr'), 'That file is larger than 50 MB.'); return; }
    state.encryptFile = f; $('encryptChipName').textContent = f.name + ' (' + humanSize(f.size) + ')'; $('encryptChip').hidden = false;
  });
  $('encryptChipClear').addEventListener('click', () => { state.encryptFile = null; $('encryptFile').value = ''; $('encryptChip').hidden = true; });
  // Modes are encrypted separately unless the user explicitly combines them.
  const MODE_IDS = ['optProtected', 'optOnce', 'optTimer'];
  // Expiry applies to every item that uses the release service: one-time items, and app-only protected items.
  const syncExpiry = () => { $('expiryRow').hidden = !(($('optOnce').checked || $('optTimer').checked) || (window.CS_CONFIG.requireApp && MODE_IDS.some(id => $(id).checked))); };
  MODE_IDS.forEach(id => $(id).addEventListener('change', () => {
    if (!$('optCombine').checked && $(id).checked) MODE_IDS.forEach(o => { if (o !== id) $(o).checked = false; });
    $('timerSub').hidden = !$('optTimer').checked;
    syncExpiry();
  }));
  $('optCombine').addEventListener('change', () => {
    if ($('optCombine').checked) return;
    let kept = false;
    MODE_IDS.forEach(o => { if ($(o).checked) { if (kept) $(o).checked = false; kept = true; } });
    $('timerSub').hidden = !$('optTimer').checked;
    syncExpiry();
  });

  // -------------------------------------------------- encrypt: validation
  function validateEncrypt() {
    clear($('encryptErr'), $('encryptWarn'));
    const text = $('encryptMessage').value;
    if (!text.trim() && !state.encryptFile) { show($('encryptErr'), 'Add a message or attach a file to encrypt.'); return false; }
    const guarded = $('optProtected').checked || $('optOnce').checked || $('optTimer').checked;
    if (guarded && state.encryptFile && !protectedOk(state.encryptFile)) {
      show($('encryptErr'), 'Protected, view-once and self-destruct items can only show text, Word (.docx), PDF and image files. Choose a supported file, or turn the modes off.'); return false;
    }
    if (guarded && state.encryptFile && state.encryptFile.size > 15 * 1024 * 1024) {
      show($('encryptErr'), 'Protected, view-once and self-destruct items support files up to 15 MB.'); return false;
    }
    if ($('optTimer').checked) {
      const s = Number($('optSeconds').value);
      if (!Number.isFinite(s) || s < 3 || s > 86400) { show($('encryptErr'), 'Self-destruct seconds must be between 3 and 86400.'); return false; }
    }
    if (!state.password) { show($('encryptErr'), 'A password is required.'); return false; }
    if (state.ownPassword && !P.estimate(state.password).ok) { show($('encryptErr'), 'Your own password is too weak. Use the auto-generated one, or make yours longer and more varied.'); return false; }
    if ($('optRecovery').checked && new TextEncoder().encode(state.password).length > C.RSA_OAEP_MAX_BYTES) {
      show($('encryptErr'), 'That password is too long for owner recovery.'); return false;
    }
    return true;
  }

  // ------------------------------------------- encrypt: copy-password gate
  let gateCopied = false;
  function openPasswordGate() {
    gateCopied = false;
    $('pwModalValue').textContent = state.password;
    $('pwCopyState').textContent = 'Click \u201CCopy password\u201D to continue.'; $('pwCopyState').className = 'copystate';
    $('pwModalGo').disabled = true; $('pwManualRow').hidden = true;
    $('pwModal').hidden = false; $('pwModalCopy').focus();
  }
  function gateOk(msg) {
    gateCopied = true; $('pwModalGo').disabled = false;
    $('pwCopyState').textContent = msg; $('pwCopyState').className = 'copystate ok';
  }
  $('pwModalCopy').addEventListener('click', async () => {
    if (await copyText(state.password)) gateOk('Copied to your clipboard. Paste it somewhere safe now.');
    else { $('pwCopyState').textContent = 'Automatic copy was blocked by your browser. Select the password above and copy it by hand.'; $('pwManualRow').hidden = false; }
  });
  $('pwManualBtn').addEventListener('click', () => gateOk('Confirmed: you copied it by hand.'));
  $('pwModalCancel').addEventListener('click', () => { $('pwModal').hidden = true; $('pwModalValue').textContent = ''; });
  $('encryptBtn').addEventListener('click', () => { if (validateEncrypt()) openPasswordGate(); });
  $('pwModalGo').addEventListener('click', async () => { if (gateCopied) { $('pwModal').hidden = true; $('pwModalValue').textContent = ''; await doEncrypt(); } });

  // ----------------------------------------------------------- encrypt run
  async function doEncrypt() {
    const btn = $('encryptBtn'); btn.disabled = true; btn.textContent = 'Deriving key and encrypting…';
    $('encryptOut').hidden = true;
    try {
      const file = state.encryptFile ? { name: state.encryptFile.name, type: state.encryptFile.type, bytes: await readBytes(state.encryptFile) } : null;
      const res = await C.encrypt({
        text: $('encryptMessage').value, file, password: state.password,
        sensitivity: $('encryptSensitivity').value,
        policy: { viewSeconds: $('optTimer').checked ? Number($('optSeconds').value) : 0, viewOnce: $('optOnce').checked, protected: $('optProtected').checked },
        recoveryJwk: $('optRecovery').checked ? state.recoveryJwk : null,
        release: R,
        appOnly: window.CS_CONFIG.requireApp,      // every guarded mode is app-only (crypto ignores it for standard items)
        expirySeconds: Number($('optExpiry').value)
      });
      state.encryptedBytes = res.bytes;
      state.encryptedName = (file ? file.name.replace(/\.[^.]+$/, '') : 'message') + '.cenc';
      renderEncryptOutput(res);
    } catch (e) {
      show($('encryptErr'), e && e.message ? e.message : 'Encryption failed.');
    } finally { btn.disabled = false; btn.textContent = 'Encrypt it'; }
  }

  function renderEncryptOutput(res) {
    const sum = $('encryptSummary'); sum.textContent = '';
    const add = (k, v) => { const d = document.createElement('div'); d.textContent = k; const b = document.createElement('b'); b.textContent = v; d.appendChild(b); sum.appendChild(d); };
    add('Item ID', shortId(res.itemId));
    add('PBKDF2 iterations (dynamic)', res.iterations.toLocaleString() + ' \u00B7 ' + C.SENSITIVITY[res.sensitivity].label);
    add('Cipher', 'AES-256-GCM');
    add('Self-destruct', res.policy.viewSeconds ? res.policy.viewSeconds + ' s after decrypting' : 'off');
    add('View once', res.policy.viewOnce ? 'yes' : 'no');
    add('Protected view', res.policy.protected ? 'yes' : 'no');
    add('Key release', res.oneTime ? 'one-time (share held by release service)' : res.serverShare ? 'reusable, only via the CipherSeal app' : 'none, opens offline');
    add('Opens in', res.appOnly ? 'CipherSeal app only (screenshots/recording blocked)' : 'any browser');
    add('Owner recovery', res.recovery ? 'enabled' : 'off');
    add('SHA-256 of encrypted item', res.fingerprint.slice(0, 32) + '\u2026');
    const tb = $('encryptTextBlock');
    if (res.bytes.length <= MAX_TEXT_OUTPUT) { $('encryptedText').value = C.bytesToBase64(res.bytes); tb.hidden = false; }
    else { $('encryptedText').value = ''; tb.hidden = true; }
    $('encryptOut').hidden = false;
    $('encryptOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('encryptCopy').addEventListener('click', async () => flashButton($('encryptCopy'), (await copyText($('encryptedText').value)) ? 'COPIED' : 'FAILED'));
  $('encryptDownload').addEventListener('click', async () => {
    if (!state.encryptedBytes) return;
    // In the Android / iPhone app this opens the share sheet ("Save to Files"); in a browser it downloads.
    try { await CSNative.saveBytes(state.encryptedName, state.encryptedBytes, 'application/octet-stream'); }
    catch (e) { show($('encryptErr'), 'The file could not be saved: ' + (e && e.message ? e.message : e)); }
  });

  // ------------------------------------------------------------ decrypt tab
  async function currentDecryptBytes() {
    if (state.decryptFile) return new Uint8Array(await state.decryptFile.arrayBuffer());
    const t = $('decryptText').value.trim();
    if (!t) return null;
    return C.base64ToBytes(t);
  }

  async function inspectDecrypt(opts) {
    const resetMessages = !(opts && opts.keepMessages);
    const info = $('decryptInfo');
    if (resetMessages) clear($('decryptErr'), $('decryptWarn'), $('decryptOk'));
    $('appGate').hidden = true;
    info.className = 'itemcard'; info.textContent = '';
    let bytes;
    try { bytes = await currentDecryptBytes(); } catch (e) { info.hidden = true; return; }
    if (!bytes) { info.hidden = true; return; }
    let h;
    try { h = C.parseHeader(bytes); } catch (e) { info.hidden = false; info.textContent = e.message; return; }
    if (h.appOnly && !window.CS_IN_APP) window.CSPlatform.renderInstallPanel($('appGate'));
    const st = h.needsShare ? { state: 'ok', fails: 0 } : G.status(h.itemId);     // one-time items are judged by the release service
    info.hidden = false;
    const line = document.createElement('div');
    line.textContent = 'Encrypted item ';
    const id = document.createElement('b'); id.textContent = shortId(h.itemId); line.appendChild(id);
    line.appendChild(document.createTextNode(' \u00B7 PBKDF2 '));
    const it = document.createElement('b'); it.textContent = h.iterations.toLocaleString(); line.appendChild(it);
    line.appendChild(document.createTextNode(' iterations \u00B7 owner recovery ' + (h.hasRecovery ? 'enabled' : 'off') + (h.needsShare ? (h.mode & (C.MODE_ONCE | C.MODE_TIMER) ? ' \u00B7 one-time release' : ' \u00B7 key held by release service') : '') + (h.appOnly ? ' \u00B7 secure app only' : '')));
    info.appendChild(line);
    if (st.state === 'locked') { info.classList.add('dead'); info.appendChild(document.createTextNode('This item is LOCKED and damaged after too many wrong passwords. Ask the sender to encrypt and send a fresh one.')); }
    else if (st.state === 'burned') { info.classList.add('dead'); info.appendChild(document.createTextNode('This view-once item has already been decrypted on this device and can no longer be opened.')); }
    else if (st.fails > 0) { info.appendChild(document.createTextNode(' \u00B7 ' + st.fails + ' wrong attempt' + (st.fails > 1 ? 's' : '') + ' so far')); }
  }
  $('decryptText').addEventListener('input', inspectDecrypt);
  setupDrop($('decryptDrop'), $('decryptFile'), f => {
    if (f.size > MAX_FILE + 1048576) { show($('decryptErr'), 'That file is too large.'); return; }
    state.decryptFile = f; $('decryptChipName').textContent = f.name + ' (' + humanSize(f.size) + ')'; $('decryptChip').hidden = false; inspectDecrypt();
  });
  $('decryptChipClear').addEventListener('click', () => { state.decryptFile = null; $('decryptFile').value = ''; $('decryptChip').hidden = true; inspectDecrypt(); });
  $('decryptShow').addEventListener('click', () => {
    const f = $('decryptPassword'); const hide = f.type === 'text';
    f.type = hide ? 'password' : 'text'; $('decryptShow').textContent = hide ? 'SHOW' : 'HIDE';
  });

  function wipeDecryptInputs() {
    state.decryptFile = null; $('decryptFile').value = ''; $('decryptChip').hidden = true;
    $('decryptText').value = ''; $('decryptPassword').value = '';
  }

  $('decryptBtn').addEventListener('click', async () => {
    clear($('decryptErr'), $('decryptWarn'), $('decryptOk'));
    let bytes, header;
    try {
      bytes = await currentDecryptBytes();
      if (!bytes) { show($('decryptErr'), 'Paste the encrypted text or choose the encrypted file first.'); return; }
      header = C.parseHeader(bytes);
    } catch (e) { show($('decryptErr'), e.message || 'That is not a valid encrypted item.'); return; }

    if (header.appOnly && !window.CS_IN_APP) { window.CSPlatform.renderInstallPanel($('appGate')); $('appGate').scrollIntoView({ block: 'nearest' }); return; }
    if (header.appOnly && window.CS_SCREEN_CAPTURED) { show($('decryptErr'), 'Screen recording or screen mirroring is active. Stop it and try again. Nothing was used up.'); return; }
    const st = header.needsShare ? { state: 'ok' } : G.status(header.itemId);
    if (st.state === 'locked') { show($('decryptErr'), 'Locked: this item was damaged after 3 wrong passwords. Only a fresh item from the sender can be decrypted.'); return; }
    if (st.state === 'burned') { show($('decryptErr'), 'This view-once item has already been decrypted on this device.'); return; }
    const pw = $('decryptPassword').value;
    if (!pw) { show($('decryptErr'), 'Enter the password.'); return; }

    const btn = $('decryptBtn'); btn.disabled = true; btn.textContent = 'Verifying…';
    const onEnd = () => { clear($('decryptOk')); inspectDecrypt(); };
    const damaged = msg => {
      wipeDecryptInputs();
      const dmg = $('decryptErr'); dmg.classList.add('destroyed', 'damage');
      show(dmg, msg); setTimeout(() => dmg.classList.remove('damage'), 1000);
    };
    // Server-side verdicts (one-time items): wrong password count, lock, already opened, offline.
    const serverFail = e => {
      if (e.code === 'wrong') {
        if (e.left === 1) { $('decryptWarn').classList.add('final'); show($('decryptWarn'), 'Final warning 2 of 2. One more wrong password and this item will be locked for good on every device.'); }
        else show($('decryptWarn'), 'Wrong password \u2014 warning 1 of 2. Repeated guessing will damage this item on every device.');
      } else if (e.code === 'locked') damaged('Item damaged. Three wrong passwords locked it permanently, on every device. Ask the sender to encrypt and send you a fresh one.');
      else if (e.code === 'expired') show($('decryptErr'), 'This item has expired. The key was deleted and it can no longer be opened. Ask the sender for a fresh one.');
      else if (e.code === 'burned') show($('decryptErr'), 'This item has already been opened once, on this or another device, and can never be opened again.');
      else show($('decryptErr'), e.message || 'The release service refused this request.');
    };
    try {
      const prep = await C.prepare(bytes, pw);
      $('decryptPassword').value = '';
      let res, shown;
      if (header.needsShare) {
        // 1) password proof (does not use up the item)  2) camera + phone check  3) one-time key release  4) decrypt + show
        btn.textContent = 'Checking password\u2026';
        try { await R.verify(header.itemId, prep.auth); } catch (e) { serverFail(e); return; }
        btn.textContent = 'Camera check\u2026';
        if (!await V.begin(onEnd)) { show($('decryptWarn'), 'Cancelled before opening. Nothing was used up; you can try again.'); return; }
        let share;
        try { share = await R.claim(header.itemId, prep.auth); } catch (e) { V.close(); serverFail(e); return; }
        res = await C.open(prep, share);
        show($('decryptOk'), res.meta.policy.viewOnce || res.meta.policy.viewSeconds ? 'Opened. This item has now been used up and cannot be opened again on any device.' : 'Opened inside the secure app.');
        shown = await V.show({ meta: res.meta, text: res.text, fileBytes: res.fileBytes, itemId: res.itemId, onEnd });
      } else {
        res = await C.open(prep, null);
        G.clearFails(res.itemId);
        show($('decryptOk'), 'Decrypted and verified (AES-GCM tag and SHA-256 digest). Protected items need camera approval before display.');
        inspectDecrypt({ keepMessages: true });
        shown = await V.show({ meta: res.meta, text: res.text, fileBytes: res.fileBytes, itemId: res.itemId, onEnd });
        if (shown && header.legacy && res.meta.policy.viewOnce) {          // old v3 items: this-device-only burn
          G.markBurned(res.itemId);
          show($('decryptOk'), 'Displayed once. This item can no longer be decrypted on this device.');
        }
      }
      inspectDecrypt({ keepMessages: true });
    } catch (e) {
      if (e && e.code === 'BAD_KEY' && !header.needsShare) {
        const r = G.recordFail(header.itemId);
        if (r.level === 'warn1') show($('decryptWarn'), 'Wrong password \u2014 warning 1 of 2. Repeated guessing will damage this item.');
        else if (r.level === 'warn2') { $('decryptWarn').classList.add('final'); show($('decryptWarn'), 'Final warning 2 of 2. One more wrong password and this item will be locked and damaged for good.'); }
        else damaged('Item damaged. Three wrong passwords locked it permanently on this device. Ask the sender to encrypt and send you a fresh one.');
        inspectDecrypt({ keepMessages: true });
      } else {
        show($('decryptErr'), e && e.message ? e.message : 'Could not decrypt this item.');
      }
    } finally { btn.disabled = false; btn.textContent = 'Decrypt'; $('decryptPassword').value = ''; }
  });

  // ---------------------------------------------------------- recover tab
  setupDrop($('recDrop'), $('recFile'), f => { state.recFile = f; $('recChipName').textContent = f.name + ' (' + humanSize(f.size) + ')'; $('recChip').hidden = false; });
  $('recChipClear').addEventListener('click', () => { state.recFile = null; $('recFile').value = ''; $('recChip').hidden = true; });
  $('recKey').addEventListener('change', async () => {
    clear($('recErr')); state.recKey = null;
    const f = $('recKey').files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); if (!j.d) throw new Error('not private'); state.recKey = j; }
    catch (e) { show($('recErr'), 'That file is not a valid private recovery key.'); }
  });
  $('recBtn').addEventListener('click', async () => {
    clear($('recErr'), $('recOk')); $('recOut').hidden = true;
    if (!state.recKey) { show($('recErr'), 'Choose your private recovery key (.json) first.'); return; }
    let input;
    try {
      if (state.recFile) input = new Uint8Array(await state.recFile.arrayBuffer());
      else if ($('recText').value.trim()) input = $('recText').value.trim();
      else { show($('recErr'), 'Paste the encrypted text, or choose the encrypted file.'); return; }
      const pw = await C.recover(input, state.recKey);
      $('recPw').value = pw; $('recOut').hidden = false;
      show($('recOk'), 'Password recovered. Share it back through a different channel from the encrypted item.');
    } catch (e) { show($('recErr'), e && e.message ? e.message : 'Could not recover a password.'); }
  });
  $('recCopy').addEventListener('click', async () => flashButton($('recCopy'), (await copyText($('recPw').value)) ? 'COPIED' : 'FAILED'));
})();

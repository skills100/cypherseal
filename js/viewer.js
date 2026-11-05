/**
 * viewer.js — CipherSeal Vault content viewer
 *
 * Normal view:  text in a read-only box, file as a download card.
 * Protected view (set by the sender, stored inside the encrypted item):
 *   - text and images are painted onto a <canvas>, so there is no text in
 *     the page to select, copy, search or drag
 *   - copy / cut / save / print / select-all / right-click are blocked
 *   - the content is hidden whenever the window loses focus or the tab is
 *     hidden (typical when a screenshot or screen-share tool takes over)
 *   - PrintScreen and snipping shortcuts blank the content, try to clear the
 *     clipboard, and three attempts end the session
 *   - opening the browser DevTools (a common route to reading canvas pixels
 *     or intercepting memory) is heuristically detected and treated the
 *     same way as a capture attempt
 *   - a moving watermark with a random session tag is drawn over the content
 *   - every policy (view-once, timer, protected) is consumed by exactly one
 *     decryption action: a view-once item cannot be decrypted again on this
 *     device, and a detected cheat attempt ends that single viewing for good
 *     rather than merely re-prompting
 *
 * Honest scope: a web page cannot truly stop screen recording (an OS-level
 * capture tool, a second camera pointed at the screen, or hardware frame
 * grabbing can always copy pixels the operating system itself renders).
 * These are strong deterrents that defeat casual copying, common capture
 * shortcuts and in-browser inspection — and the burned-in, moving per-session
 * watermark makes any capture that does get through traceable back to this
 * specific decryption.
 */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const CAPTURE_LIMIT = 3;
  let session = null;

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function badge(text, cls) {
    const s = document.createElement('span');
    s.className = 'vbadge ' + cls;
    s.textContent = text;
    return s;
  }

  // ------------------------------------------------------ canvas painting
  function wrapLines(ctx, text, maxWidth) {
    const out = [];
    String(text).split('\n').forEach(par => {
      if (par === '') { out.push(''); return; }
      let line = '';
      par.split(/(\s+)/).forEach(tok => {
        const test = line + tok;
        if (ctx.measureText(test).width > maxWidth && line.trim() !== '') { out.push(line.trimEnd()); line = tok.trimStart(); }
        else line = test;
        while (ctx.measureText(line).width > maxWidth && line.length > 1) {   // very long words
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
          out.push(line.slice(0, cut)); line = line.slice(cut);
        }
      });
      out.push(line.trimEnd());
    });
    return out;
  }

  async function buildContentCanvas(s, width, dpr) {
    const pad = 22;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '18px Georgia, "Times New Roman", serif';
    const lines = s.text ? wrapLines(probe, s.text, width - pad * 2) : [];
    const lineH = 28;
    let bitmap = null;
    if (s.imageBytes) {
      try { bitmap = await createImageBitmap(new Blob([s.imageBytes], { type: s.imageType })); } catch (e) { bitmap = null; }
    }
    const textH = lines.length ? lines.length * lineH + pad * 2 : 0;
    let imgW = 0, imgH = 0;
    if (bitmap) {
      imgW = Math.min(width - pad * 2, bitmap.width);
      imgH = Math.round(bitmap.height * (imgW / bitmap.width));
    }
    const imgBlock = bitmap ? imgH + pad * 2 : 0;
    const height = Math.max(160, Math.min(4000, textH + imgBlock));
    const c = document.createElement('canvas');
    c.width = Math.round(width * dpr); c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0d1020'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#eef0f8'; ctx.font = '18px Georgia, "Times New Roman", serif'; ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, pad, pad + i * lineH));
    if (bitmap) ctx.drawImage(bitmap, pad, textH + pad, imgW, imgH);
    if (bitmap && bitmap.close) bitmap.close();
    return { canvas: c, width, height };
  }

  function paint(s) {
    const { canvas, ctx, content, tag } = s;
    const w = content.width, h = content.height, dpr = s.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    if (s.hidden || s.camSuspect || s.blankUntil > Date.now()) {
      ctx.fillStyle = '#0a0c14'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9aa0b8'; ctx.font = '16px system-ui, sans-serif'; ctx.textAlign = 'center';
      const msg = s.camSuspect
        ? ({ phone: 'Phone detected — content hidden', multiface: 'Second person detected — content hidden', blocked: 'Camera covered — content hidden', absent: 'Face the camera to continue', hold: 'Checking the camera view — content returns shortly' }[s.camWhy] || 'Camera guard — content hidden')
        : (s.blankUntil > Date.now() ? 'Capture attempt detected — content hidden' : 'Content hidden — return to this window');
      ctx.fillText(msg, w / 2, Math.min(h / 2, 120));
      ctx.textAlign = 'start';
      return;
    }
    ctx.drawImage(content.canvas, 0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = 0.10; ctx.fillStyle = '#ffffff'; ctx.font = '600 13px system-ui, sans-serif';
    ctx.rotate(-0.42);
    const stamp = new Date().toLocaleTimeString();
    const label = 'CIPHERSEAL \u2022 ' + tag + ' \u2022 ' + stamp;
    const off = (Date.now() / 90) % 260;
    for (let y = -h; y < h * 1.6; y += 64) {
      for (let x = -w - 260 + off; x < w * 1.6; x += 260) ctx.fillText(label, x, y);
    }
    ctx.restore();
  }

  // ------------------------------------------------------- camera guard
  // Detection logic lives in js/camguard.js (phone, second face, covered lens,
  // nobody present). This section only handles permission, UI and consequences.
  function stopCamera(s) {
    if (s.guard) { s.guard.stop(); s.guard = null; }
    if (s.cameraStream) s.cameraStream.getTracks().forEach(track => track.stop());
    s.cameraStream = null;
    ['cameraPreview', 'guardThumb'].forEach(id => { const v = $(id); if (v) v.srcObject = null; });
    const chip = $('guardChip'); if (chip) chip.hidden = true;
  }

  function startCameraGate(s) {
    const gate = $('cameraGate'), card = document.querySelector('.viewer-card');
    const video = $('cameraPreview'), start = $('cameraStart'), cancel = $('cameraCancel');
    const status = $('cameraStatus');
    gate.hidden = false; card.hidden = true;
    status.textContent = 'Your camera stays off until you choose to enable it.';
    start.disabled = false;
    return new Promise(resolve => {
      let done = false;
      const finish = allowed => {
        if (done) return;
        done = true;
        start.removeEventListener('click', onStart);
        cancel.removeEventListener('click', onCancel);
        resolve(allowed);
      };
      const onCancel = () => finish(false);
      const onStart = async () => {
        start.disabled = true;
        status.textContent = 'Requesting camera permission…';
        try {
          if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Camera access requires HTTPS (or localhost) and a browser that supports camera access.');
          }
          const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
          if (done || s.destroyed) { stream.getTracks().forEach(track => track.stop()); return; }
          s.cameraStream = stream;
          video.srcObject = stream;
          await video.play();
          const pre = await window.CSCamGuard.preflight(video, t => { status.textContent = t; });
          if (!pre.ok) throw new Error(pre.reason);
          const thumb = $('guardThumb'); thumb.srcObject = stream; thumb.play().catch(() => {});
          $('guardChip').hidden = false;
          s.guard = window.CSCamGuard.run(video, pre.baseline, {
            onSuspect: (on, why, strikes, max) => {
              s.camSuspect = on; s.camWhy = why; paint(s);
              const note = $('viewerNote');
              if (note) note.textContent = strikes ? 'Camera warning ' + strikes + ' of ' + max + ': the content was hidden because the camera saw a problem.' : '';
            },
            onEnd: (why, msg) => { if (!s.destroyed) destroy(msg); }
          });
          stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
            if (!s.destroyed) destroy('Camera access ended. This viewing session has ended.');
          }, { once: true }));
          gate.hidden = true; card.hidden = false;
          finish(true);
        } catch (e) {
          stopCamera(s);
          status.textContent = e && e.name === 'NotAllowedError'
            ? 'Camera permission was denied. It is required to view this item.'
            : (e && e.message ? e.message : 'Could not start the camera. Check permission and try again.');
          start.disabled = false;
        }
      };
      start.addEventListener('click', onStart);
      cancel.addEventListener('click', onCancel);
      start.focus();
    });
  }

  // --------------------------------------------------------- protections
  function attachGuards(s) {
    const L = [];
    const on = (target, ev, fn, opts) => { target.addEventListener(ev, fn, opts); L.push([target, ev, fn, opts]); };
    const stop = e => { e.preventDefault(); e.stopPropagation(); };

    const refreshHidden = () => {
      s.hidden = document.visibilityState === 'hidden' || !document.hasFocus();
      paint(s);
    };
    on(document, 'visibilitychange', refreshHidden);
    on(window, 'blur', refreshHidden);
    on(window, 'focus', refreshHidden);
    on(window, 'beforeprint', () => { s.hidden = true; paint(s); });
    on(window, 'afterprint', refreshHidden);
    ['contextmenu', 'copy', 'cut', 'dragstart', 'selectstart'].forEach(ev => on(document, ev, stop, true));

    const capture = why => {
      s.captureAttempts += 1;
      s.blankUntil = Date.now() + 4000;
      try { navigator.clipboard.writeText(' '); } catch (e) { /* clipboard blocked */ }
      paint(s);
      const note = $('viewerNote');
      if (note) note.textContent = 'Screen-capture attempt (' + why + ') ' + s.captureAttempts + ' of ' + CAPTURE_LIMIT + '.';
      if (s.captureAttempts >= CAPTURE_LIMIT) destroy('Session ended after repeated screen-capture attempts. Contents wiped.');
    };
    // PrintScreen fires no reliable keydown in most browsers, so it is
    // counted once on keyup only; everything else is judged on keydown.
    // A one-press guard stops a stray duplicate event from double-counting.
    let pscArmed = true;
    on(document, 'keydown', e => {
      const k = (e.key || '').toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (k === 'printscreen') { stop(e); return; }
      if ((e.metaKey && e.shiftKey && k === 's') || (e.ctrlKey && e.shiftKey && k === 's')) { stop(e); if (pscArmed) { pscArmed = false; capture('Snipping shortcut'); } return; }
      if (ctrl && ['c', 'x', 's', 'p', 'a', 'u'].includes(k)) {
        stop(e);
        const note = $('viewerNote');
        if (note) note.textContent = 'Copy, save, print and select-all are disabled for this protected item.';
      }
    }, true);
    on(document, 'keyup', e => {
      if ((e.key || '').toLowerCase() !== 'printscreen') return;
      stop(e);
      if (pscArmed) { pscArmed = false; capture('PrintScreen'); setTimeout(() => { pscArmed = true; }, 50); }
    }, true);

    // Heuristic DevTools-open detector: a docked or undocked DevTools panel
    // widens the gap between the outer window and the inner viewport well
    // beyond ordinary browser chrome. Not foolproof, but catches the common
    // case of someone opening DevTools to read canvas pixels or script state
    // while a protected item is on screen.
    let devtoolsOpen = false;
    s.devtoolsTimer = setInterval(() => {
      const gapW = window.outerWidth - window.innerWidth;
      const gapH = window.outerHeight - window.innerHeight;
      const likelyOpen = gapW > 160 || gapH > 160;
      if (likelyOpen && !devtoolsOpen) { devtoolsOpen = true; capture('DevTools opened'); }
      else if (!likelyOpen) { devtoolsOpen = false; }
    }, 900);

    s.listeners = L;
    document.body.classList.add('protected-mode');
  }

  function detachGuards(s) {
    (s.listeners || []).forEach(([t, ev, fn, o]) => t.removeEventListener(ev, fn, o));
    s.listeners = [];
    clearInterval(s.devtoolsTimer);
    document.body.classList.remove('protected-mode');
  }

  // ------------------------------------------------------------- lifecycle
  function destroy(reason) {
    const s = session;
    if (!s || s.destroyed) return;
    s.destroyed = true;
    clearInterval(s.timer); clearInterval(s.paintTimer);
    stopCamera(s);
    detachGuards(s);
    s.urls.forEach(u => URL.revokeObjectURL(u));
    if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; }
    if (s.content && s.content.canvas) { s.content.canvas.width = 0; s.content.canvas.height = 0; }
    if (s.imageBytes) s.imageBytes.fill(0);
    s.text = '';
    const body = $('viewerBody');
    body.textContent = '';
    const gone = document.createElement('div');
    gone.className = 'vgone';
    const icon = document.createElement('div'); icon.className = 'vgone-icon'; icon.textContent = '\u2715';
    const msg = document.createElement('p'); msg.textContent = reason;
    gone.append(icon, msg);
    body.appendChild(gone);
    $('viewerFoot').textContent = '';
    $('countdownRing').hidden = true;
    $('viewerClose').textContent = 'Done';
    if (typeof s.onEnd === 'function') s.onEnd(reason);
  }

  function close() {
    if (!session) return;
    if (!session.destroyed) destroy('Closed. The contents have been wiped from memory.');
    $('viewer').hidden = true;
    document.body.classList.remove('viewer-open'); if (global.CSNative) global.CSNative.setSecure(false);
    session = null;
  }

  function newSession(onEnd) {
    return {
      text: '', urls: [], hidden: false, blankUntil: 0, captureAttempts: 0, camSuspect: false,
      destroyed: false, gated: false, onEnd, dpr: Math.min(2, window.devicePixelRatio || 1),
      tag: Array.from(crypto.getRandomValues(new Uint8Array(3)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    };
  }

  /**
   * Step 1 of opening a protected item: open the overlay and pass the camera
   * check. Called BEFORE the release service is asked for the key share, so a
   * refused camera / phone in view never consumes a view-once item.
   */
  async function begin(onEnd) {
    if (session) { try { close(); } catch (e) { /* ignore */ } }
    const s = session = newSession(onEnd);
    $('viewerBody').textContent = '';
    $('viewer').hidden = false;
    $('viewerClose').textContent = 'Close';
    document.body.classList.add('viewer-open'); if (global.CSNative) global.CSNative.setSecure(true);
    if (!await startCameraGate(s)) { close(); return false; }
    s.gated = true;
    return !s.destroyed;
  }

  async function show(opts) {
    const meta = opts.meta;
    const policy = meta.policy;
    const needsCamera = !!(policy.protected || policy.viewOnce || policy.viewSeconds);
    let s;
    if (session && session.gated && !session.destroyed) { s = session; s.onEnd = opts.onEnd; }
    else {
      if (session) { try { close(); } catch (e) { /* ignore */ } }
      s = session = newSession(opts.onEnd);
      $('viewerBody').textContent = '';
      $('viewer').hidden = false;
      $('viewerClose').textContent = 'Close';
      document.body.classList.add('viewer-open'); if (global.CSNative) global.CSNative.setSecure(true);
      if (needsCamera && !await startCameraGate(s)) { close(); return false; }
      s.gated = true;
    }
    if (s.destroyed) return false;
    s.text = opts.text;

    const badges = $('viewerBadges');
    badges.textContent = '';
    if (policy.viewOnce) badges.appendChild(badge('VIEW ONCE', 'b-once'));
    if (policy.protected) badges.appendChild(badge('PROTECTED VIEW', 'b-prot'));
    if (policy.viewSeconds) badges.appendChild(badge('SELF-DESTRUCT ' + policy.viewSeconds + 's', 'b-time'));
    if (!badges.childNodes.length) badges.appendChild(badge('DECRYPTED', 'b-open'));
    $('viewerNote').textContent = '';
    const body = $('viewerBody');
    body.textContent = '';

    const isImage = meta.file && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(meta.file.type);
    const isTextFile = meta.file && (/^text\//i.test(meta.file.type) || /\.(txt|md)$/i.test(meta.file.name));
    const isDocx = meta.file && (meta.file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(meta.file.name));
    const isPdf = meta.file && (meta.file.type === 'application/pdf' || /\.pdf$/i.test(meta.file.name));

    if (policy.protected || policy.viewOnce || policy.viewSeconds) {   // every guarded mode renders on the canvas
      let extractNote = '';
      if (meta.file && isTextFile && opts.fileBytes.length < 300000) {
        s.text = (s.text ? s.text + '\n\n' : '') + new TextDecoder().decode(opts.fileBytes);
      } else if (meta.file && isImage) {
        s.imageBytes = opts.fileBytes; s.imageType = meta.file.type;
      } else if (meta.file && (isDocx || isPdf)) {
        try {
          const extracted = await window.CSCrypto.extractDocumentText(opts.fileBytes, meta.file.type, meta.file.name);
          s.text = (s.text ? s.text + '\n\n' : '') + extracted.text;
          extractNote = isPdf ? 'Text extracted from the PDF for protected preview — exact layout, images and tables are not reproduced.'
                               : 'Text extracted from the Word document for protected preview — exact layout, images and tables are not reproduced.';
        } catch (e) {
          s.text = (s.text ? s.text + '\n\n' : '') + '[' + meta.file.name + ': ' + (e.message || 'this document could not be read for protected preview') + ']';
        }
      } else if (meta.file) {
        s.text = (s.text ? s.text + '\n\n' : '') + '[' + meta.file.name + ' cannot be shown in protected view]';
      }
      const wrap = document.createElement('div'); wrap.className = 'pwrap';
      body.appendChild(wrap);
      const width = Math.max(260, Math.min(760, wrap.clientWidth || 640));
      s.content = await buildContentCanvas(s, width, s.dpr);
      const canvas = document.createElement('canvas');
      canvas.className = 'pcanvas';
      canvas.width = Math.round(s.content.width * s.dpr); canvas.height = Math.round(s.content.height * s.dpr);
      canvas.setAttribute('aria-label', 'Protected content');
      wrap.appendChild(canvas);
      s.canvas = canvas; s.ctx = canvas.getContext('2d');
      attachGuards(s);
      s.hidden = document.visibilityState === 'hidden' || !document.hasFocus();
      paint(s);
      s.paintTimer = setInterval(() => paint(s), 1000);
      $('viewerFoot').textContent = extractNote || 'Copying, sharing, saving and screenshots are disabled for this item.';
    } else {
      if (s.text) {
        const ta = document.createElement('textarea');
        ta.readOnly = true; ta.value = s.text; ta.className = 'vtext'; ta.id = 'viewerText';
        body.appendChild(ta);
      }
      if (meta.file) {
        const url = URL.createObjectURL(new Blob([opts.fileBytes], { type: meta.file.type }));
        s.urls.push(url);
        if (isImage) {
          const img = document.createElement('img'); img.src = url; img.className = 'vimg'; img.alt = meta.file.name;
          body.appendChild(img);
        }
        const card = document.createElement('div'); card.className = 'vfile';
        const info = document.createElement('div');
        const nm = document.createElement('div'); nm.className = 'vfile-name'; nm.textContent = meta.file.name;
        const sz = document.createElement('div'); sz.className = 'vfile-size'; sz.textContent = fmtSize(meta.file.len);
        info.append(nm, sz);
        const a = document.createElement('a'); a.className = 'btn btn-gold'; a.href = url; a.download = meta.file.name; a.id = 'viewerDownload'; a.textContent = 'Download';
        // In the app a blob link cannot download, so use the share sheet instead.
        a.addEventListener('click', ev => { if (global.CSNative && global.CSNative.inApp()) { ev.preventDefault(); global.CSNative.saveBytes(meta.file.name, opts.fileBytes, meta.file.type); } });
        card.append(info, a);
        body.appendChild(card);
      }
      $('viewerFoot').textContent = policy.viewSeconds ? 'Download or copy now — this will disappear when the timer ends.' : '';
    }

    // countdown
    const ring = $('countdownRing');
    if (policy.viewSeconds) {
      ring.hidden = false;
      const total = policy.viewSeconds * 1000;
      const end = Date.now() + total;
      const arc = $('countdownArc'); const num = $('countdownNum');
      const circ = 2 * Math.PI * 20;
      arc.setAttribute('stroke-dasharray', String(circ));
      const tick = () => {
        const left = Math.max(0, end - Date.now());
        num.textContent = String(Math.ceil(left / 1000));
        arc.setAttribute('stroke-dashoffset', String(circ * (1 - left / total)));
        if (left <= 0) destroy('Time is up \u2014 this item has self-destructed.');
      };
      tick();
      s.timer = setInterval(tick, 200);
    } else {
      ring.hidden = true;
    }
    return true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('viewerClose');
    if (btn) btn.addEventListener('click', close);
  });

  // Called by the native Android/iOS wrapper when the OS reports a screenshot or screen recording.
  global.CSNativeAlert = why => { if (session && !session.destroyed) destroy('Screen capture detected (' + String(why).slice(0, 20) + '). This viewing session has ended and the content was wiped.'); };

  global.CSViewer = { begin, show, close, isOpen: () => !!session && !session.destroyed };
})(window);

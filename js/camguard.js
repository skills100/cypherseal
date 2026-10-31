/**
 * camguard.js — camera-based viewing guard for protected items.
 *
 * Runs on the viewer's own device. Frames never leave it and are never saved.
 * Detection uses the open-source "Human" library (TensorFlow.js) with two
 * small models bundled in /vendor/human (BlazeFace for faces, CenterNet/COCO
 * for objects incl. "cell phone"), so it works under a strict CSP with no CDN.
 *
 * It decides, every ~0.5 s, whether the viewer is alone and the camera is clear:
 *   phone      a "cell phone" is seen in the frame (2 of the last 4 frames)
 *   multiface  a second face is looking at the screen (2 of the last 4)
 *   blocked    the lens is covered / frame is black or flat (3 frames in a row)
 *   absent     nobody is in front of the screen (hidden at 2 frames, end at 10 s)
 * PERSONAL VIEW: any suspicious frame hides the content at once. After a
 * confirmed violation the content stays hidden for 8 s of clear view, then
 * returns. Three separate confirmed violations end the session.
 *
 * HONEST LIMITS: this is a camera-side deterrent, not proof. It can only see
 * what the FRONT camera sees. A phone held behind the viewer's head, propped
 * outside the frame, or a hidden camera elsewhere will not be seen; a phone
 * can be missed in poor light or at odd angles; and a plain object may
 * sometimes be mistaken for a phone. Judge thresholds are in createJudge().
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    phoneConf: 0.35, faceConf: 0.5, window: 4, phoneNeed: 2, faceNeed: 2,
    darkNeed: 3, absentBlankFrames: 2, absentEndMs: 10000, intervalMs: 500,
    flickerHoldMs: 2000,   // a single suspicious frame hides the content this long
    holdMs: 8000,          // after a CONFIRMED violation, content stays hidden this long once the view is clear again
    maxStrikes: 3          // confirmed violations (separate episodes) allowed before the session ends
  };

  /**
   * Pure decision engine (no DOM) — unit-tested in tests/camguard.test.js
   *
   *   suspicious frame  -> hide immediately, back after flickerHoldMs of clean frames
   *   confirmed episode -> hide, strike +1, stay hidden holdMs after the view is clear, then return
   *   strike maxStrikes -> session ends
   *   nobody present    -> hidden at 2 frames, session ends after absentEndMs
   */
  function createJudge(over) {
    const cfg = Object.assign({}, DEFAULTS, over || {});
    const hist = [];
    let dark = 0, absentSince = 0, baseline = null;
    let holdUntil = 0, inEpisode = false, cleanRun = 0, strikes = 0, lastWhy = 'phone';
    return {
      cfg,
      setBaseline(l) { baseline = l; },
      get strikes() { return strikes; },
      push(f) {
        const phone = (f.objects || []).some(o => o.label === 'cell phone' && o.score >= cfg.phoneConf);
        const faces = (f.faces || []).filter(sc => sc >= cfg.faceConf).length;
        hist.push({ phone, faces });
        if (hist.length > cfg.window) hist.shift();
        const blocked = f.luma === null || f.luma === undefined ||
          (f.luma < 10 && (baseline == null || f.luma < baseline * 0.2)) || f.std < 3;
        dark = blocked ? dark + 1 : 0;
        if (faces === 0) { if (!absentSince) absentSince = f.t; } else absentSince = 0;

        const phoneHits = hist.filter(h => h.phone).length;
        const multiHits = hist.filter(h => h.faces >= 2).length;
        const recent = hist.slice(-cfg.absentBlankFrames);
        const absentNow = recent.length >= cfg.absentBlankFrames && recent.every(h => h.faces === 0);

        let confirmedWhy = null;
        if (dark >= cfg.darkNeed) confirmedWhy = 'blocked';
        else if (phoneHits >= cfg.phoneNeed) confirmedWhy = 'phone';
        else if (multiHits >= cfg.faceNeed) confirmedWhy = 'multiface';
        const raw = phone || faces >= 2 || blocked;       // any single suspicious frame
        const why = phone ? 'phone' : blocked ? 'blocked' : faces >= 2 ? 'multiface' : absentNow ? 'absent' : 'hold';

        let end = null;
        if (confirmedWhy) {
          lastWhy = confirmedWhy;
          if (!inEpisode) { inEpisode = true; strikes++; }
          cleanRun = 0;
          holdUntil = Math.max(holdUntil, f.t + cfg.holdMs);
          if (strikes >= cfg.maxStrikes) end = 'repeated';
        } else {
          cleanRun = raw ? 0 : cleanRun + 1;
          if (inEpisode && cleanRun >= 2) inEpisode = false;
          if (raw) holdUntil = Math.max(holdUntil, f.t + cfg.flickerHoldMs);
        }
        if (!end && absentSince && f.t - absentSince >= cfg.absentEndMs) end = 'absent';

        const suspect = raw || absentNow || confirmedWhy !== null || f.t < holdUntil;
        return { end, suspect, why: confirmedWhy || why, phone, faces, blocked, absent: absentNow, strikes, lastWhy };
      }
    };
  }

  const MESSAGES = {
    repeated: 'The camera guard found repeated violations (a phone, another person, or a covered camera). This viewing session has ended.',
    absent: 'No viewer was detected in front of the screen. This viewing session has ended.'
  };
  const PREFLIGHT_FIX = {
    phone: 'A phone was detected in the camera view. Put it out of sight and try again.',
    multiface: 'More than one face is visible. Only the person opening this item may be in view.',
    none: 'No face was found. Face the camera in good light and try again.',
    blocked: 'The camera view is too dark or covered. Uncover it and try again.'
  };

  // ------------------------------------------------------------- detector
  let humanPromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src; el.onload = res; el.onerror = () => rej(new Error('Could not load the camera detector.'));
      document.head.appendChild(el);
    });
  }
  function humanConfig(backend) {
    const off = { enabled: false };
    return {
      backend, modelBasePath: 'vendor/human/models/', debug: false, async: true, warmup: 'none',
      cacheSensitivity: 0, filter: { enabled: false }, gesture: off, hand: off, body: off, segmentation: off,
      face: {
        enabled: true, mesh: off, iris: off, description: off, emotion: off, antispoof: off, liveness: off, attention: off,
        detector: { modelPath: 'blazeface.json', rotation: false, maxDetected: 4, minConfidence: 0.4, return: false }
      },
      object: { enabled: true, modelPath: 'centernet.json', minConfidence: 0.3, iouThreshold: 0.4, maxDetected: 10, skipFrames: 0 }
    };
  }
  function getHuman() {
    if (!humanPromise) {
      humanPromise = (async () => {
        if (!global.Human) await loadScript('vendor/human/human.js');
        const Ctor = global.Human.Human || global.Human;
        let lastErr;
        for (const backend of ['webgl', 'cpu']) {
          try { const h = new Ctor(humanConfig(backend)); await h.load(); await h.init(); return h; }
          catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('The camera detector could not start on this device.');
      })().catch(e => { humanPromise = null; throw e; });
    }
    return humanPromise;
  }

  function frameStats(video) {
    if (!video.videoWidth || !video.videoHeight) return { luma: null, std: 0 };
    const c = document.createElement('canvas'); c.width = 32; c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const n = px.length / 4; let sum = 0, sq = 0;
    for (let i = 0; i < px.length; i += 4) { const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; sum += y; sq += y * y; }
    const mean = sum / n;
    return { luma: mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  }

  async function sample(human, video) {
    const st = frameStats(video);
    let res = { face: [], object: [] };
    try { res = await human.detect(video); } catch (e) { /* treated as an empty frame */ }
    return {
      t: Date.now(), luma: st.luma, std: st.std,
      faces: (res.face || []).map(f => f.score || f.boxScore || 0),
      objects: (res.object || []).map(o => ({ label: o.label, score: o.score }))
    };
  }

  /**
   * Preflight (nothing consumed): ~3 s of frames. Need a single face, no phone, lens clear.
   * @returns {Promise<{ok:boolean, reason?:string, baseline?:number}>}
   */
  async function preflight(video, onStatus) {
    onStatus && onStatus('Loading the on-device detector (first time only)…');
    const human = await getHuman();
    onStatus && onStatus('Checking the camera view…');
    const judge = createJudge();
    let good = 0, phone = 0, multi = 0, none = 0, dark = 0, lumaSum = 0, lumaN = 0;
    const FRAMES = 6;
    for (let i = 0; i < FRAMES; i++) {
      const f = await sample(human, video);
      const v = judge.push(f);
      if (f.luma !== null) { lumaSum += f.luma; lumaN++; }
      if (v.blocked) dark++; else if (v.phone) phone++; else if (v.faces >= 2) multi++; else if (v.faces === 0) none++; else good++;
      await new Promise(r => setTimeout(r, 250));
    }
    if (phone >= 2) return { ok: false, reason: PREFLIGHT_FIX.phone };
    if (multi >= 2) return { ok: false, reason: PREFLIGHT_FIX.multiface };
    if (dark >= 3) return { ok: false, reason: PREFLIGHT_FIX.blocked };
    if (good < 4) return { ok: false, reason: PREFLIGHT_FIX.none };
    return { ok: true, baseline: lumaN ? lumaSum / lumaN : 0 };
  }

  /**
   * Continuous guard. Calls onSuspect(bool, why) as the scene changes and
   * onEnd(reasonCode, message) once on a confirmed violation. Returns { stop }.
   */
  function run(video, baseline, cb) {
    const judge = createJudge(); judge.setBaseline(baseline);
    let stopped = false, wasSuspect = false, lastStrikes = 0;
    (async () => {
      const human = await getHuman();
      while (!stopped) {
        const t0 = Date.now();
        const v = judge.push(await sample(human, video));
        if (stopped) return;
        if (v.end) { stopped = true; cb.onEnd(v.end, MESSAGES[v.end]); return; }
        if (v.suspect !== wasSuspect || v.strikes !== lastStrikes) { wasSuspect = v.suspect; lastStrikes = v.strikes; cb.onSuspect(v.suspect, v.why, v.strikes, judge.cfg.maxStrikes); }
        await new Promise(r => setTimeout(r, Math.max(50, judge.cfg.intervalMs - (Date.now() - t0))));
      }
    })().catch(() => { if (!stopped) { stopped = true; cb.onEnd('error', 'The camera guard stopped working. This viewing session has ended.'); } });
    return { stop() { stopped = true; } };
  }

  global.CSCamGuard = { createJudge, preflight, run, MESSAGES, DEFAULTS };
  if (typeof module !== 'undefined') module.exports = global.CSCamGuard;
})(typeof window !== 'undefined' ? window : globalThis);

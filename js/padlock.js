/**
 * padlock.js — CipherSeal Vault interactive 3D padlock
 *
 * A real CSS-3D object (stacked layers give the body and shackle depth).
 * One loop: the lock turns to show its side, the key slides into the
 * keyhole, turns, the shackle lifts and swings open, then everything runs
 * in reverse to lock it again.
 *
 *   - move the pointer over it to tilt the padlock in 3D
 *   - click / tap (or press Enter / Space) to pause and resume
 *   - window.CSPadlock.renderAt(t) draws any frame, t in [0,1)
 *     (used to export assets/img/padlock.gif)
 */
(function (global) {
  'use strict';

  const LOOP_MS = 9000;
  const BODY_W = 128, BODY_H = 100, BODY_Z = 18;
  const SHACKLE_W = 84, SHACKLE_H = 96;
  const KEY_LEN = 46;

  let stage, lock, shackle, key, glow, caption, scene;
  let paused = false, startAt = 0, pausedT = 0;
  let tiltX = 0, tiltY = 0, curX = 0, curY = 0, raf = 0, reduced = false;

  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
  const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const seg = (t, a, b) => ease((t - a) / (b - a));
  const lerp = (a, b, k) => a + (b - a) * k;

  function el(cls, parent, tag) {
    const e = document.createElement(tag || 'div');
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function build() {
    stage.textContent = '';
    scene = el('lock-scene', stage);
    glow = el('lock-glow', scene);
    lock = el('lock', scene);

    // body: stacked layers = thickness
    const body = el('lbody', lock);
    for (let z = -BODY_Z; z <= BODY_Z; z += 3) {
      const l = el('lb-layer', body);
      const t = (z + BODY_Z) / (BODY_Z * 2);          // 0 back .. 1 front
      l.style.setProperty('--l', (30 + t * 24).toFixed(1) + '%');
      l.style.transform = 'translateZ(' + z + 'px)';
    }
    const front = el('lb-front', body);
    front.style.transform = 'translateZ(' + (BODY_Z + 0.6) + 'px)';
    const brand = el('lb-brand', front); brand.textContent = 'CIPHERSEAL';
    const plate = el('lb-plate', body); plate.style.transform = 'translateZ(' + (BODY_Z + 1.4) + 'px)';
    const hole = el('lb-hole', body); hole.style.transform = 'translateZ(' + (BODY_Z + 2.2) + 'px)';
    const slot = el('lb-slot', body); slot.style.transform = 'translateZ(' + (BODY_Z + 2.2) + 'px)';

    // shackle (long right leg, short left leg)
    shackle = el('shackle', lock);
    for (let z = -6; z <= 6; z += 2) {
      const l = el('sh-layer', shackle);
      const t = (z + 6) / 12;
      l.style.setProperty('--l', (46 + t * 36).toFixed(1) + '%');
      l.style.transform = 'translateZ(' + z + 'px)';
    }

    // key: shaft runs along +Z (toward the viewer), bow at the far end
    key = el('key', lock);
    const shaftA = el('key-plane', key);
    const shaftB = el('key-plane key-plane-b', key);
    [shaftA, shaftB].forEach(p => {
      const teeth = el('key-teeth', p);
      teeth.appendChild(el('key-tooth t1'));
      teeth.appendChild(el('key-tooth t2'));
      teeth.appendChild(el('key-tooth t3'));
    });
    const collar = el('key-collar', key); collar.style.transform = 'translateZ(' + (KEY_LEN - 4) + 'px)';
    const bow = el('key-bow', key); bow.style.transform = 'translateZ(' + KEY_LEN + 'px)';
    el('key-bow-tab', bow);
    el('key-bow-shine', bow);

    caption = el('lock-caption', stage);
    caption.setAttribute('aria-live', 'off');
  }

  /** Animation state for loop position t in [0,1). */
  function stateAt(t) {
    const side = seg(t, 0.04, 0.12) - seg(t, 0.86, 0.95);
    const keyIn = seg(t, 0.12, 0.30) - seg(t, 0.82, 0.90);
    const turn = seg(t, 0.30, 0.38) - seg(t, 0.74, 0.81);
    const lift = seg(t, 0.38, 0.43) - seg(t, 0.69, 0.73);
    const swing = seg(t, 0.43, 0.57) - seg(t, 0.62, 0.69);
    const open = Math.max(lift * 0.4, swing);
    let label = 'LOCKED \u00B7 sealed with AES-256-GCM';
    if (keyIn > 0.02 && turn < 0.05 && swing < 0.05 && t < 0.5) label = 'KEY ACCEPTED \u00B7 deriving the key\u2026';
    if (turn >= 0.05 && swing < 0.05 && t < 0.5) label = 'KEY TURNING \u00B7 checking the GCM tag\u2026';
    if (swing >= 0.05 && t < 0.66) label = 'UNLOCKED \u00B7 integrity verified \u2713';
    if (t >= 0.62 && t < 0.86) label = 'RE-SEALING \u00B7 key turns back\u2026';
    if (t >= 0.86 && keyIn > 0.02) label = 'KEY REMOVED \u00B7 locked again';
    return { side, keyIn, turn, lift, swing, open, label };
  }

  function apply(t) {
    const s = stateAt(t);
    const drift = Math.sin(t * Math.PI * 2);
    const yaw = -20 - 36 * s.side + drift * 3 + curY;
    const pitch = -9 + Math.sin(t * Math.PI * 4) * 2 + curX;
    lock.style.transform = 'rotateX(' + pitch.toFixed(2) + 'deg) rotateY(' + yaw.toFixed(2) + 'deg)';

    const lift = s.lift * 16;
    const swing = -s.swing * 152;
    shackle.style.transform = 'translateY(' + (-lift).toFixed(2) + 'px) rotateY(' + swing.toFixed(2) + 'deg)';

    const kz = lerp(110, -4, s.keyIn);
    const kx = lerp(54, 0, s.keyIn);
    const ky = lerp(40, 0, s.keyIn);
    key.style.transform = 'translate3d(' + kx.toFixed(2) + 'px,' + (8 + ky).toFixed(2) + 'px,' + (BODY_Z + kz).toFixed(2) + 'px) rotateZ(' + (s.turn * 90).toFixed(2) + 'deg)';
    key.style.opacity = s.keyIn > 0.005 ? '1' : '0';

    const hue = lerp(2, 140, s.open);
    glow.style.setProperty('--glow', 'hsl(' + hue.toFixed(0) + ' 78% 52%)');
    glow.style.opacity = (0.55 + 0.35 * s.open).toFixed(2);
    if (caption.textContent !== s.label) caption.textContent = s.label;
    stage.classList.toggle('is-open', s.open > 0.5);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    curX += (tiltX - curX) * 0.12;
    curY += (tiltY - curY) * 0.12;
    const t = paused ? pausedT : (((now - startAt) % LOOP_MS) / LOOP_MS);
    apply(t);
  }

  function init(id) {
    stage = document.getElementById(id || 'lockStage');
    if (!stage) return;
    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    build();
    startAt = performance.now();
    pausedT = 0.0;
    if (reduced) { paused = true; pausedT = 0.0; }
    stage.addEventListener('pointermove', e => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      tiltY = x * 34; tiltX = -y * 22;
    });
    stage.addEventListener('pointerleave', () => { tiltX = 0; tiltY = 0; });
    const toggle = () => {
      if (paused) { startAt = performance.now() - pausedT * LOOP_MS; paused = false; }
      else { pausedT = ((performance.now() - startAt) % LOOP_MS) / LOOP_MS; paused = true; }
      stage.classList.toggle('is-paused', paused);
    };
    stage.addEventListener('click', toggle);
    stage.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    raf = requestAnimationFrame(frame);
  }

  /** Freeze and draw frame t (0..1). Used for exporting the GIF. */
  function renderAt(t) {
    paused = true; pausedT = t; tiltX = tiltY = curX = curY = 0;
    apply(t);
  }

  global.CSPadlock = { init, renderAt, LOOP_MS };
})(window);

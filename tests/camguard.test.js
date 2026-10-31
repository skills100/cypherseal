/** Unit tests for the camera decision engine:  node tests/camguard.test.js */
'use strict';
const assert = require('assert');
const { createJudge } = require('../js/camguard');
let n = 0, bad = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok   ' + name); } catch (e) { bad++; console.log('  FAIL ' + name + '\n       ' + e.message); } };
const face = (s = 0.9) => s;
const frame = (t, o = {}) => Object.assign({ t, luma: 110, std: 30, faces: [face()], objects: [] }, o);
const PHONE = [{ label: 'cell phone', score: 0.6 }];
const run = (judge, frames) => frames.map((f, i) => judge.push(Object.assign({ t: i * 500 }, f.t === undefined ? {} : {}, frame(i * 500, f))));

const clear = (j, t0, count) => { let v; for (let i = 0; i < count; i++) v = j.push(frame(t0 + i * 500)); return v; };

t('one person, nothing else: never hidden, never ends', () => {
  const j = createJudge(); j.setBaseline(110);
  for (let i = 0; i < 60; i++) { const v = j.push(frame(i * 500)); assert(!v.suspect && !v.end); }
});
t('phone appears: hidden on the very first frame, not ended', () => {
  const j = createJudge(); j.setBaseline(110); j.push(frame(0));
  const a = j.push(frame(500, { objects: PHONE })); assert(a.suspect && !a.end && a.strikes === 0);
  const b = j.push(frame(1000, { objects: PHONE })); assert(b.suspect && !b.end && b.strikes === 1);
});
t('after the phone is gone the content stays hidden ~8 s, THEN returns by itself', () => {
  const j = createJudge(); j.setBaseline(110); j.push(frame(0));
  j.push(frame(500, { objects: PHONE })); j.push(frame(1000, { objects: PHONE }));   // confirmed at t=1000 -> hold until 9000
  let v, firstVisible = null;
  for (let t = 1500; t <= 12000; t += 500) { v = j.push(frame(t)); assert(!v.end); if (!v.suspect && firstVisible === null) firstVisible = t; }
  assert(firstVisible >= 9000 && firstVisible <= 10500, 'returned at ' + firstVisible + ' ms, expected ~10000');
  assert(!v.suspect, 'stays visible afterwards');
});
t('single false-positive frame hides briefly (2 s), costs no strike, returns', () => {
  const j = createJudge(); j.setBaseline(110); j.push(frame(0));
  const a = j.push(frame(500, { objects: PHONE })); assert(a.suspect && a.strikes === 0);
  assert(j.push(frame(1000)).suspect);
  assert(!j.push(frame(3000)).suspect);
  assert.strictEqual(j.strikes, 0);
});
t('three separate confirmed violations end the session', () => {
  const j = createJudge(); j.setBaseline(110); let t = 0, v;
  for (let k = 1; k <= 3; k++) {
    v = j.push(frame(t += 500, { objects: PHONE })); v = j.push(frame(t += 500, { objects: PHONE }));
    if (k < 3) { assert(!v.end && v.strikes === k); for (let i = 0; i < 6; i++) j.push(frame(t += 500)); }   // clears fully
  }
  assert.strictEqual(v.end, 'repeated'); assert.strictEqual(v.strikes, 3);
});
t('one long violation counts as ONE strike, not many', () => {
  const j = createJudge(); j.setBaseline(110); let v;
  for (let i = 0; i < 20; i++) v = j.push(frame(i * 500, { objects: PHONE }));
  assert.strictEqual(v.strikes, 1); assert(!v.end);
});
t('low-confidence phone (0.2) and other objects (cup, book) are ignored', () => {
  const j = createJudge();
  for (let i = 0; i < 8; i++) assert(!j.push(frame(i * 500, { objects: [{ label: 'cell phone', score: 0.2 }, { label: 'cup', score: 0.9 }, { label: 'book', score: 0.9 }] })).suspect);
});
t('second person: hidden at once, then after they leave it returns following the hold', () => {
  const j = createJudge(); j.push(frame(0));
  assert(j.push(frame(500, { faces: [0.9, 0.8] })).suspect);
  const c = j.push(frame(1000, { faces: [0.9, 0.8] })); assert(c.suspect && c.strikes === 1 && !c.end);
  let v, firstVisible = null;
  for (let t = 1500; t <= 12000; t += 500) { v = j.push(frame(t)); if (!v.suspect && firstVisible === null) firstVisible = t; }
  assert(firstVisible >= 9000 && firstVisible <= 10500, 'returned at ' + firstVisible);
});
t('covering the lens (dark): hidden, strike after 3 frames, can recover when uncovered', () => {
  const j = createJudge(); j.setBaseline(110);
  const dark = { luma: 3, std: 1, faces: [] };
  assert(j.push(frame(0, dark)).suspect); j.push(frame(500, dark));
  const v = j.push(frame(1000, dark)); assert(v.strikes === 1 && v.suspect && !v.end);
  let v2; for (let t = 1500; t <= 12000; t += 500) v2 = j.push(frame(t));
  assert(!v2.suspect && !v2.end);
});
t('finger over lens in a bright room (flat, not dark) is also caught', () => {
  const j = createJudge(); j.setBaseline(110);
  const flat = { luma: 120, std: 1.5, faces: [] };
  j.push(frame(0, flat)); j.push(frame(500, flat));
  assert.strictEqual(j.push(frame(1000, flat)).strikes, 1);
});
t('leaving the seat: hidden at 2 frames, session ends at 10 s; returning earlier recovers', () => {
  const j = createJudge(); j.push(frame(0));
  assert(!j.push(frame(500, { faces: [] })).suspect);
  assert(j.push(frame(1000, { faces: [] })).suspect);
  for (let t = 1500; t < 10500; t += 500) assert(!j.push(frame(t, { faces: [] })).end, 'ended early at ' + t);
  assert.strictEqual(j.push(frame(11000, { faces: [] })).end, 'absent');
  const k = createJudge(); k.push(frame(0));
  for (let t = 500; t <= 5000; t += 500) k.push(frame(t, { faces: [] }));
  assert(!k.push(frame(5500)).suspect);
  for (let t = 6000; t <= 14000; t += 500) assert(!k.push(frame(t, { faces: [] })).end);
});
console.log('\n' + n + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);

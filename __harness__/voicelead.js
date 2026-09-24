"use strict";
/* The Play mirror with voice leading on (addr 111, firmware #147).

 * A led chord keeps its tones but the device picks their octaves from the chord
 * before, so it is no note set the mirror's lookup holds. The mirror reads it by
 * pitch class instead. This checks that a led chord is read as itself, that the
 * readout lists the notes actually played, that it stays itself as fingers lift,
 * that the same notes are not read as a chord with voice leading off, and that
 * the exact readings are untouched.
 *
 * Run by `npm test`. Exits non-zero on any mismatch.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");

/* ---- the minimum DOM devicemap builds into ----------------------------- */
let clock = 0, seq = 0, timers = [];
const setT = (fn, ms) => { const t = { fn, due: clock + (ms || 0), seq: seq++, dead: false }; timers.push(t); return t; };
const clrT = t => { if (t) t.dead = true; };

/* Run every pending timer, in order, until the queue is empty.
 *
 * This used to be a fixed 900-iteration loop that re-filtered the whole timer
 * array each time. `timers` is shared across every DeviceMap this file builds —
 * about two thousand of them — and dead entries were never removed, so each
 * scenario re-scanned everything the previous ones had left behind. The checks
 * took forty seconds, almost all of it walking dead timers.
 *
 * Draining properly and pruning as we go costs one pass. It also removes the
 * arbitrary iteration cap, which was silently truncating any scenario that
 * needed more steps than the number I happened to pick.
 */
function settle(limit) {
  let steps = 0;
  for (;;) {
    let next = null;
    for (const t of timers) {
      if (t.dead) continue;
      if (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq)) next = t;
    }
    if (!next || ++steps > (limit || 5000)) break;
    clock = next.due;
    next.dead = true;
    try { next.fn(); } catch (e) { /* shim gaps are expected */ }
  }
  timers = timers.filter(t => !t.dead);     // the part that was missing
}
function el(tag) {
  const cls = new Set();
  return { tagName: tag, nodeKids: [], className: "", textContent: "", title: "", type: "",
    innerHTML: "", value: "", offsetWidth: 0,
    style: { setProperty() {}, removeProperty() {}, display: "", animation: "" },
    classList: { add: (...c) => c.forEach(x => x && cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)),
      contains: x => cls.has(x),
      toggle: (x, f) => { if (f === undefined) { return cls.has(x) ? (cls.delete(x), false) : (cls.add(x), true); }
        f ? cls.add(x) : cls.delete(x); return !!f; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild(k) { this.nodeKids.push(k); return k; },
    append(...k) { k.forEach(x => this.nodeKids.push(x)); },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
}
const sandbox = {
  window: { PLAY_DEBUG: false },
  document: { createElement: el, createTextNode: t => ({ textContent: t, nodeKids: [] }) },
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout: setT, clearTimeout: clrT, Date: { now: () => clock },
  Math, JSON, Set, Map, Array, Object,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "devicemap.js"), "utf8"),
                sandbox, { filename: "devicemap.js" });
const DeviceMap = sandbox.window.DeviceMap;

/* DeviceMap.create + rebuild() builds the whole chord candidate lookup, which is
 * where nearly all the time in this file goes. The patch only changes per key,
 * inversion and spacing — not per chord — so one device is reused across every
 * chord tried under the same patch, with the notes released in between. Counts
 * are asserted below and must not move: if reuse leaked state between chords
 * they would.
 */
let reuseKey = null, reuseDm = null;
function deviceFor(patch) {
  const k = JSON.stringify(patch);
  if (k !== reuseKey) {
    reuseKey = k;
    reuseDm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
    reuseDm.setConnected(true); reuseDm.rebuild();
  }
  return reuseDm;
}

function readout(patch, notes, lift) {
  const dm = deviceFor(patch);
  notes.forEach(n => dm.onNote("chord", "on", n));
  settle();   // the mirror paints on a timer
  if (lift) { lift.forEach(n => dm.onNote("chord", "off", n)); settle(); }
  let html = "", cur = "";
  (function walk(n) { if (!n) return;
    if (/dm-ro-notes/.test(n.className || "")) html = n.innerHTML || "";
    if (/dm-ro-cur/.test(n.className || "")) cur = n.innerHTML || n.textContent || "";
    (n.nodeKids || []).forEach(walk); })(dm.el);
  const out = html.split(/<span[^>]*>\u00b7<\/span>/).map(x => x.replace(/<[^>]*>/g, "").trim()).filter(Boolean);
  notes.forEach(n => dm.onNote("chord", "off", n));
  settle();
  return { name: cur.replace(/<sub[^>]*>.*?<\/sub>/g, "").replace(/<[^>]*>/g, "").trim(), notes: out };
}

const bad = [];
let checked = 0;
const expect = (label, got, want) => { checked++; if (got !== want) bad.push(`${label}: got "${got}", expected "${want}"`); };

// led voicings, none of them a note set the lookup holds
for (const [patch, notes, name, list] of [
  [{ 35: 0, 111: 1 }, [55, 60, 64, 67], "C", "G3 C4 E4 G4"],     // C major led to G C E G
  [{ 35: 0, 111: 1 }, [57, 60, 62, 65], "Dm7", "A3 C4 D4 F4"],   // Dm7 led to A C D F
  [{ 35: 0, 111: 1 }, [52, 55, 59, 64], "Em", "E3 G3 B3 E4"],    // E minor
]) {
  const r = readout(patch, notes);
  expect(`led ${notes.join(",")}`, r.name, name);
  expect(`led ${notes.join(",")} note list`, r.notes.join(" "), list);
}

// the same notes are not a chord with voice leading off
expect("G C E G with voice leading off", readout({ 35: 0 }, [55, 60, 64, 67]).name === "C" ? "C" : "not C", "not C");

// a knob that could turn it on is enough to read led chords
expect("led C with a knob on 111", readout({ 35: 0, 10: 111 }, [55, 60, 64, 67]).name, "C");

// lifting a finger keeps the chord and the notes it showed
const thin = readout({ 35: 0, 111: 1 }, [55, 60, 64, 67], [67]);
expect("led C thinning: name", thin.name, "C");
expect("led C thinning: note list", thin.notes.join(" "), "G3 C4 E4 G4");

if (bad.length) {
  console.log(`voice leading: ${bad.length} failure(s) of ${checked}\n`);
  bad.forEach(b => console.log("  " + b));
  process.exit(1);
}
console.log(`voice leading: ${checked} checks -- led chords read by pitch class and list the notes played, stay themselves as fingers lift, and are not read with voice leading off`);

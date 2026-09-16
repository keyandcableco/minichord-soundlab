"use strict";
/* Drives the real rhythm lock detector (createRhythmSync in soundlab.js) with
 * the real chord identifier, to answer one question: does it lock onto the
 * device's rhythm engine and ONLY onto the rhythm engine?
 *
 * A lock starts the playhead, stops the chord lights and marks staff notes as
 * rhythm, so a lock on ordinary playing shows all three with rhythm mode off.
 *
 * For every library preset:
 *   - four ways of playing chords by hand, none of which may lock: a steady
 *     strum, irregular playing, quick changes, and strumming on the tempo
 *     slider's own beat
 *   - the firmware's rhythm engine, which must lock: its pattern at the slider
 *     tempo with the preset's shuffle, long and short steps alternating as the
 *     firmware's timer does, each step up to 8 ms late
 *
 * The detector takes the tempo from the slider, so a device tempo that differs
 * from it (tap tempo, MIDI clock, a knob on BPM) is not covered here.
 *
 * Run:  node __harness__/rhythmlock.js
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");

/* ---- the detector, taken from the app ------------------------------------ */
const src = fs.readFileSync(path.join(root, "soundlab.js"), "utf8");
const from = src.indexOf("  function createRhythmSync() {");
const to = src.indexOf("\n  // Overview is a special domain", from);
if (from < 0 || to < 0) throw new Error("createRhythmSync not found in soundlab.js — has it been renamed or moved?");
const detectorSrc = src.slice(from, to);

/* ---- presets and the chord identifier ------------------------------------ */
const quiet = { log() {}, warn() {}, error() {}, info() {} };
const lib = { window: {}, console: quiet, document: { createElement: () => ({}) }, atob: s => Buffer.from(s, "base64").toString("binary") };
vm.createContext(lib);
vm.runInContext(fs.readFileSync(path.join(root, "params.js"), "utf8"), lib, { filename: "params.js" });
vm.runInContext(fs.readFileSync(path.join(root, "presets.js"), "utf8"), lib, { filename: "presets.js" });
const PM = lib.window.PresetMatch;

function el(tag) {
  const cl = new Set();
  return {
    tagName: tag, nodeKids: [], className: "", textContent: "", title: "", innerHTML: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add: (...c) => c.forEach(x => cl.add(x)), remove: (...c) => c.forEach(x => cl.delete(x)), contains: x => cl.has(x), toggle: x => (cl.has(x) ? (cl.delete(x), false) : (cl.add(x), true)) },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild(c) { this.nodeKids.push(c); return c; }, append(...cs) { cs.forEach(c => this.nodeKids.push(c)); },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
const dmSandbox = { window: {}, document: { createElement: el, createTextNode: t => ({ textContent: t, nodeKids: [] }) }, console: quiet, setTimeout: () => 0, clearTimeout() {}, Date, Math, JSON, Set, Map, Array, Object };
vm.createContext(dmSandbox);
vm.runInContext(fs.readFileSync(path.join(root, "devicemap.js"), "utf8"), dmSandbox, { filename: "devicemap.js" });
const DeviceMap = dmSandbox.window.DeviceMap;

/* ---- one detector on a clock we control ---------------------------------- */
function detector(patch) {
  let clock = 0, seq = 0, timers = [];
  const setT = (fn, ms) => { const t = { fn, due: clock + (ms || 0), seq: seq++, dead: false }; timers.push(t); return t; };
  const clrT = t => { if (t) t.dead = true; };
  const advance = ms => {
    const stop = clock + ms;
    for (;;) {
      let next = null;
      for (const t of timers) if (!t.dead && t.due <= stop && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
      if (!next) break;
      clock = next.due; next.dead = true; next.fn();
    }
    clock = stop; timers = timers.filter(t => !t.dead);
  };
  const seen = { lockedAt: null };
  const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
  const sb = {
    Date: { now: () => clock }, setTimeout: setT, clearTimeout: clrT, Math, Set, Map, Array, Object,
    controller: { isConnected: () => true }, patch,
    RHYTHM_BASE: 220, RHYTHM_STEPS: 16, RHYTHM_ROWS: 7,
    playRhythmSetHead: null, staffView: null,
    deviceMap: {
      setRhythmActive(on) { if (on && seen.lockedAt == null) seen.lockedAt = clock; },
      showRhythmChord() {},
      identifyChord: (onsets, prev) => dm.identifyChord(onsets, prev),
    },
  };
  vm.createContext(sb);
  vm.runInContext(detectorSrc + "\nthis.rs = createRhythmSync();", sb, { filename: "soundlab.js (createRhythmSync)" });
  sb.rs.start();
  const burst = notes => notes.forEach(n => sb.rs.onChordNote("on", n));
  return { burst, advance, seen };
}

/* ---- deterministic randomness -------------------------------------------- */
let seed = Number(process.env.SEED) || 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const CHORDS = [[48, 52, 55, 60], [53, 57, 60, 65], [55, 59, 62, 67], [57, 60, 64, 69], [50, 53, 57, 62]];
const SEVEN = [48, 52, 55, 60, 62, 65, 69];

function played(patch, gaps) {
  const d = detector(patch);
  gaps.forEach((gap, i) => { d.burst(CHORDS[Math.floor(i / 4) % CHORDS.length]); d.advance(gap); });
  d.advance(4000);
  return d.seen.lockedAt;
}

const bad = [], lockTimes = [];
const presets = PM.all.map(p => ({ name: p.name, vals: PM.decode(p.value) }));
presets.forEach(p => {
  const patch = p.vals.slice();
  patch[190] = (patch[190] == null ? 100 : patch[190]) / 100;   // the app holds shuffle as a real value
  const bpm = Math.max(30, Math.min(300, patch[187] || 80)), step = 30000 / bpm;
  const cyc = Math.max(1, Math.min(16, patch[188] || 16));

  const byHand = {
    "a steady strum": Array.from({ length: 32 }, () => 667 + (rnd() - 0.5) * 40),
    "irregular playing": Array.from({ length: 20 }, () => 400 + rnd() * 2100),
    "quick changes": Array.from({ length: 8 }, () => 200 + rnd() * 300),
    "strumming on the slider beat": Array.from({ length: 32 }, () => 2 * step + (rnd() - 0.5) * 40),
  };
  Object.entries(byHand).forEach(([how, gaps]) => {
    const t = played(patch, gaps);
    if (t != null) bad.push(`"${p.name}" locked on ${how} at ${Math.round(t)} ms`);
  });

  const d = detector(patch);
  const long = patch[190] * step, short = 2 * step - long;
  let useLong = false;   // the firmware's timer starts on the short period, then alternates
  for (let k = 0; k < cyc * 3; k++) {
    const mask = patch[220 + (k % cyc)] || 0, late = rnd() * 8;
    d.advance(late);
    d.burst(SEVEN.filter((_, v) => mask & (1 << v)));
    d.advance((useLong ? long : short) - late);
    useLong = !useLong;
  }
  if (d.seen.lockedAt == null) bad.push(`"${p.name}" never locked on its own rhythm (${bpm} BPM, shuffle ${patch[190]})`);
  else lockTimes.push(d.seen.lockedAt);
});

if (bad.length) {
  console.error(`rhythm lock: ${bad.length} failure(s)\n`);
  bad.slice(0, 20).forEach(b => console.error("  " + b));
  process.exit(1);
}
lockTimes.sort((a, b) => a - b);
console.log(`rhythm lock: ${presets.length} presets lock on their own rhythm (median ${Math.round(lockTimes[lockTimes.length >> 1])} ms) and never on chords played by hand`);

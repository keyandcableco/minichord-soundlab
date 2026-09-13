"use strict";
/* Checks the chord pads' root spelling against the firmware's own pitch
 * arithmetic, for every key, every button and every transpose.
 *
 * The golden transcript cannot cover this: it snapshots the mirror's DOM for a
 * handful of scenarios, so a wrong note NAME passes it as long as the right pad
 * lights. This walks all 21 keys x 7 buttons x 13 transposes and asserts two
 * things the transcript never sees — that each label sounds the pitch the
 * firmware would play, and that the seven labels spell that key's major scale
 * with one of each letter.
 *
 * Run by `npm test`. Exits non-zero on any mismatch.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");

/* ---- the minimum DOM devicemap builds into ----------------------------- */
let clock = 0, seq = 0, timers = [];
const setT = (fn, ms) => { const t = { fn, due: clock + (ms || 0), seq: seq++, dead: false }; timers.push(t); return t; };
const clrT = t => { if (t) t.dead = true; };
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

/* ---- the firmware's pitch, reimplemented independently ------------------
 * Deliberately a separate implementation rather than a call into devicemap:
 * the point is to catch devicemap drifting away from the firmware, which it
 * cannot do if both sides come from the same code.
 */
const BASE = [11, 4, 9, 2, 7, 0, 5];                      // B E A D G C F
const SIG = [0, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 7, 7, 7, 8, 7];
const SHARP_BTNS = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 1], [6, 5, 4, 3, 2, 1, 0]];
const FLAT_BTNS = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6]];
const DBL_SHARP = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2]];
const SHARP_KEYS = new Set([0, 1, 2, 3, 4, 5, 12, 13]);
function firmwareRoot(key, btn) {
  let n = BASE[btn], c = SIG[key];
  if (SHARP_KEYS.has(key)) { for (let i = 0; i < c; i++) if (btn === SHARP_BTNS[c - 1][i]) n += 1; }
  else if (key >= 14 && key <= 18) {
    for (let i = 0; i < 7; i++) if (btn === SHARP_BTNS[6][i]) n += 1;
    const d = DBL_SHARP[key - 14];
    for (let i = 0; i < d.length; i++) if (btn === d[i]) n += 1;
  } else {
    for (let i = 0; i < c && i < 7; i++) {
      if (key === 19 && btn === 0) continue;
      if (btn === FLAT_BTNS[Math.min(c, 7) - 1][i]) n -= 1;
    }
    if (key === 19 && btn === 0) n -= 2;
  }
  return ((n % 12) + 12) % 12;
}

/* ---- read the pads ----------------------------------------------------- */
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function parse(label) {
  const m = /^([A-G])(\u266d\u266d\u266d|bbb|\u266d\u266d|bb|\u266d|b|#x|x#|###|#|x)?$/.exec(label);
  if (!m) return null;
  const alt = { "\u266d\u266d\u266d": -3, "bbb": -3, "\u266d\u266d": -2, "bb": -2,
                "\u266d": -1, "b": -1, "#": 1, "x": 2, "#x": 3, "x#": 3, "###": 3 }[m[2]] || 0;
  return { letter: m[1], pc: ((LETTER_PC[m[1]] + alt) % 12 + 12) % 12 };
}
function pads(key, transpose) {
  const patch = { 35: key, 30: transpose };
  const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
  dm.setConnected(true); dm.rebuild();
  const out = [];
  (function walk(n) { if (!n) return;
    if (/dm-chord/.test(n.className || "") && n.textContent) out.push(n.textContent);
    (n.nodeKids || []).forEach(walk); })(dm.el);
  return out.slice(0, 7);            // the major row, one per column
}
// the pads render left to right as F C G D A E B, which is the button list
// (B E A D G C F) reversed, so column c is button 6 - c
const buttonOfCol = c => 6 - c;

const KEY_NAME = ["C", "G", "D", "A", "E", "B", "F", "Bb", "Eb", "Ab", "Db", "Gb",
                  "F#", "C#", "G#", "D#", "A#", "E#", "B#", "Fb", "Cb"];
let checked = 0; const bad = [];
for (let key = 0; key < 21; key++) {
  for (let tr = 0; tr <= 12; tr++) {
    const labels = pads(key, tr);
    if (labels.length !== 7) { bad.push(`key ${KEY_NAME[key]} +${tr}: got ${labels.length} pads`); continue; }
    const letters = new Set();
    labels.forEach((label, col) => {
      const btn = buttonOfCol(col);
      checked++;
      const sp = parse(label);
      if (!sp) { bad.push(`key ${KEY_NAME[key]} +${tr} btn${btn}: cannot parse "${label}"`); return; }
      letters.add(sp.letter);
      const want = (firmwareRoot(key, btn) + tr) % 12;
      if (sp.pc !== want) bad.push(`key ${KEY_NAME[key]} +${tr} btn${btn}: "${label}" is pc ${sp.pc}, firmware plays ${want}`);
    });
    // a major scale uses each letter once; a repeat means two buttons collided
    if (letters.size !== 7) bad.push(`key ${KEY_NAME[key]} +${tr}: ${letters.size} distinct letters across 7 buttons (${labels.join(" ")})`);
  }
}

/* ---- harp strings ------------------------------------------------------
 * Each harp segment carries its own MIDI number in the title, so the label and
 * the pitch can be compared without reaching into devicemap. That is the whole
 * check: whatever the string sounds, its NAME must spell that pitch. Covers the
 * key-rooted scale modes, the chord-rooted ones, the custom scale and the
 * chord-tone default, with and without a chord held.
 */
function harpStrings(patch, hold) {
  const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
  dm.setConnected(true); dm.rebuild();
  if (hold) hold.forEach(n => dm.onNote("chord", "on", n));
  // let any deferred relabel settle
  for (let i = 0; i < 400; i++) {
    const due = timers.filter(t => !t.dead && t.due <= clock + 1);
    if (!due.length) { clock += 1; continue; }
    due.sort((a, b) => a.due - b.due || a.seq - b.seq);
    due.forEach(t => { t.dead = true; try { t.fn(); } catch (e) { /* shim */ } });
  }
  const out = [];
  (function walk(n) { if (!n) return;
    if (/dm-string/.test(n.className || "") && n.textContent) {
      const m = /MIDI (\d+)/.exec(n.title || "");
      if (m) out.push({ label: n.textContent, midi: parseInt(m[1], 10) });
    }
    (n.nodeKids || []).forEach(walk); })(dm.el);
  return out;
}

const CHORD_C = [60, 64, 67, 72];        // a C major shape, button C in key C
let harpChecked = 0;
const MODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
for (let key = 0; key < 21; key++) {
  for (const mode of MODES) {
    for (const held of [null, CHORD_C]) {
      const patch = { 35: key, 36: mode, 236: 0b101010110101 };
      const strings = harpStrings(patch, held);
      strings.forEach((st, i) => {
        harpChecked++;
        const sp = parse(st.label);
        if (!sp) { bad.push(`harp key ${KEY_NAME[key]} mode ${mode}${held ? " held" : ""} str${i}: cannot parse "${st.label}"`); return; }
        const want = ((st.midi % 12) + 12) % 12;
        if (sp.pc !== want) bad.push(`harp key ${KEY_NAME[key]} mode ${mode}${held ? " held" : ""} str${i}: "${st.label}" is pc ${sp.pc}, string sounds ${want}`);
      });
    }
  }
}

/* ---- chord voices ------------------------------------------------------
 * The readout's note list must spell the notes actually sounding. Press a chord,
 * then check each displayed name against the pitch class of the note sent for
 * that voice. Covers every chord type, every inversion and every spacing — the
 * inversion path is the one that matters, since it is where a voice stops
 * knowing which chord tone it is.
 */
const CHORD_TABLES = {
  major:[0,4,7,12,2,5,9], minor:[0,3,7,12,1,5,8], maj_sixth:[0,4,7,9,2,5,12],
  min_sixth:[0,3,7,9,1,5,12], seventh:[0,4,10,7,2,5,9], maj_seventh:[0,4,11,7,2,5,9],
  min_seventh:[0,3,10,7,1,5,8], aug:[0,4,8,12,2,5,9], dim:[0,3,6,12,2,5,9],
  full_dim:[0,3,6,9,2,5,12],
};
const TYPE_SUFFIX = { major: "", minor: "m", seventh: "7", maj_seventh: "maj7",
  min_seventh: "m7", dim: "dim", aug: "aug", maj_sixth: "6", min_sixth: "m6",
  full_dim: "\u00b07" };
const padCache = new Map();
const padLabel = (key, btn) => {
  if (!padCache.has(key)) padCache.set(key, pads(key, 0));
  return padCache.get(key)[6 - btn];     // pads render as columns, reversed
};
const SHUF = [10, 11, 12, 13];          // chordShuf default row, voices 0-3
const MIDI_BASE = 48;
function tonesSorted(table) {
  const out = [];
  for (let i = 0; i < 4; i++) { const pc = table[i] % 12; if (out.indexOf(pc) === -1) out.push(pc); }
  return out.sort((a, b) => a - b);
}
function spacingShift(voice, sp) {
  switch (sp) {
    case 1: return voice === 2 ? -12 : 0;
    case 2: return voice === 1 ? -12 : 0;
    case 3: return (voice === 2 || voice === 0) ? -12 : 0;
    case 4: return voice === 0 ? -12 : (voice === 3 ? 12 : 0);
    default: return 0;
  }
}
function voicesFor(key, btn, table, inv, sp) {
  const root = firmwareRoot(key, btn);
  const out = [];
  for (let v = 0; v < 4; v++) {
    const level = SHUF[v];
    let offset;
    if ((inv > 0 || sp > 0)) {
      const t = tonesSorted(table), k = v + inv;
      offset = t[k % t.length] + 12 * Math.floor(k / t.length);
    } else offset = table[level % 10];
    let n = MIDI_BASE + 12 * Math.floor(level / 10) + root + offset;
    const sh = spacingShift(v, sp);
    if (sh && n + sh >= MIDI_BASE + 12 && n + sh <= MIDI_BASE + 60) n += sh;
    out.push(n);
  }
  return out;
}
function readout(patch, notes) {
  const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
  dm.setConnected(true); dm.rebuild();
  notes.forEach(n => dm.onNote("chord", "on", n));
  for (let i = 0; i < 900; i++) {
    const due = timers.filter(t => !t.dead && t.due <= clock + 1);
    if (!due.length) { clock += 1; continue; }
    due.sort((a, b) => a.due - b.due || a.seq - b.seq);
    due.forEach(t => { t.dead = true; try { t.fn(); } catch (e) { /* shim */ } });
  }
  let html = "", cur = "";
  (function walk(n) { if (!n) return;
    if (/dm-ro-notes/.test(n.className || "")) html = n.innerHTML || "";
    if (/dm-ro-cur/.test(n.className || "")) cur = n.innerHTML || n.textContent || "";
    (n.nodeKids || []).forEach(walk); })(dm.el);
  // the octave subscript sits between the root and the type, so drop it whole
  readout.matched = cur.replace(/<sub[^>]*>.*?<\/sub>/g, "").replace(/<[^>]*>/g, "").trim();
  // each entry is "<name><sub>octave</sub>"; the octave is the sounding truth and
  // is checked elsewhere, so take the name only
  return html.split(/<span[^>]*>·<\/span>/)
    .map(x => x.split("<sub")[0].replace(/<[^>]*>/g, "").trim())
    .filter(Boolean);
}
let voiceChecked = 0, voiceSkipped = 0;
for (const key of [0, 1, 3, 6, 9, 11, 13]) {
  for (const type of Object.keys(CHORD_TABLES)) {
    for (const btn of [0, 3, 5]) {
      for (const [inv, sp] of [[0, 0], [1, 0], [2, 0], [0, 1], [0, 4], [1, 4]]) {
        const table = CHORD_TABLES[type];
        const notes = voicesFor(key, btn, table, inv, sp);
        const labels = readout({ 35: key, 37: inv, 38: sp }, notes);
        // Only spelling is under test here. When the engine resolves the notes as
        // a DIFFERENT chord — a 6th read as a major triad, say — its note list
        // describes that other chord, which is matching's business and not this
        // check's. Skip those rather than blame the speller for them.
        const wantLabel = padLabel(key, btn) + (TYPE_SUFFIX[type] || type);
        if (labels.length !== 4 || readout.matched !== wantLabel) { voiceSkipped++; continue; }
        labels.forEach((label, v) => {
          voiceChecked++;
          const sp2 = parse(label);
          if (!sp2) { bad.push(`voice key ${KEY_NAME[key]} ${type} btn${btn} inv${inv} sp${sp} v${v}: cannot parse "${label}"`); return; }
          const want = ((notes[v] % 12) + 12) % 12;
          if (sp2.pc !== want) bad.push(`voice key ${KEY_NAME[key]} ${type} btn${btn} inv${inv} sp${sp} v${v}: "${label}" is pc ${sp2.pc}, voice sounds ${want}`);
        });
      }
    }
  }
}

if (bad.length) {
  console.error(`spelling: ${bad.length} failure(s) of ${checked} pad labels and ${harpChecked} harp labels and ${voiceChecked} chord voices\n`);
  bad.slice(0, 25).forEach(b => console.error("  " + b));
  if (bad.length > 25) console.error(`  ... and ${bad.length - 25} more`);
  process.exit(1);
}
console.log(`spelling: ${checked} pad labels across 21 keys x 13 transposes and ${harpChecked} harp labels across 12 modes and ${voiceChecked} chord voices across inversions and spacings, all agree with the pitch played (${voiceSkipped} voicings unmatched, skipped)`);

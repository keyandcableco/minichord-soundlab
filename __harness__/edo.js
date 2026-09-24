"use strict";
/* The Play mirror in 19- and 31-EDO, against the firmware.

 * In the divided octaves the device builds every note in steps and rounds to
 * the nearest semitone only on the way out to MIDI, so the mirror sees a
 * rounded shadow of each chord and has to reason back from it. This checks the
 * two things that can go wrong there:
 *
 *  - identification: every chord the buttons can play, standard and alternate
 *    layout, in 12, 19 and 31, is read back as itself from the MIDI the device
 *    would send;
 *  - spelling: every note the readout names is the exact step that sounds, not
 *    just the right semitone after rounding. In 31 E half-flat and E
 *    three-quarter-flat round to the same MIDI note and are different notes.
 *
 * The reference is firmware-edo.json, a snapshot of the firmware's own tables
 * (see extract-edo.py), not devicemap's copy of them, so a port that drifts
 * from the firmware fails here. The spot checks at the end pin the degree-
 * literal spelling of the just chords by hand.
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

const FW = JSON.parse(fs.readFileSync(path.join(__dirname, "firmware-edo.json"), "utf8"));
const TEMPERAMENT = [0, 10, 11];            // addr 237 for 12, 19 and 31
const BTN_NAME = ["B", "E", "A", "D", "G", "C", "F"];
const LETTERS = "CDEFGAB";
const LETTER_STEPS = [[0, 2, 4, 5, 7, 9, 11], [0, 3, 6, 8, 11, 14, 17], [0, 5, 10, 13, 18, 23, 28]];
const TYPE_NAME = { major: "", minor: "m", seventh: "7", maj_seventh: "maj7", min_seventh: "m7", dim: "dim", aug: "aug",
  maj_sixth: "6", min_sixth: "m6", full_dim: "\u00b07", half_dim: "m7\u266d5", sus_fourth: "sus4", sus_second: "sus2",
  seventh_sus: "7sus4", major_ninth: "maj9", minor_ninth: "m9", added_ninth: "add9", six_nine: "6/9",
  neutral: "neut", harmonic_7th: "h7", subminor: "sub", supermajor: "sup", subminor_seventh: "sub7",
  utonal_tetrad: "ut", harmonic_ninth: "h9", neutral_seventh: "neut7", otonal_hexad: "hex",
  just_augmented: "jaug", supermajor_seventh: "sup7" };
// the standard layout's seven row combinations
const STANDARD = ["major", "minor", "seventh", "maj_seventh", "min_seventh", "dim", "aug"];

// the firmware's pitch, independently: key C, no frame shift, the default
// voicing row (voices 0-3 at octave one), so a voice is EDO + root + table[i]
function chordSteps(e, button, type) {
  const n = FW.steps[e], root = FW.base_notes[e][button], t = FW.chords[type][e];
  return [0, 1, 2, 3].map(i => n + root + t[i]);
}
const toMidi = (e, steps) => 48 + Math.round(steps * 12 / FW.steps[e]);

// "E" "E#" "E\u266d\u266d" and the quarter-tone signs, to an alteration in sharps
const ALT = [["\u266d\u266d\ud834\udd33", -2.5], ["\u266d\ud834\udd33", -1.5], ["x\ud834\udd32", 2.5], ["#\ud834\udd32", 1.5],
  ["\ud834\udd33", -0.5], ["\ud834\udd32", 0.5], ["\u266d\u266d\u266d", -3], ["\u266d\u266d", -2], ["\u266d", -1],
  ["#x", 3], ["x", 2], ["#", 1], ["", 0]];
function parseNote(label) {
  const letter = LETTERS.indexOf(label[0]);
  if (letter < 0) return null;
  const rest = label.slice(1);
  for (const [txt, alt] of ALT) if (rest === txt) return { letter, alt };
  return null;
}
const stepOf = (e, sp) => ((LETTER_STEPS[e][sp.letter] + sp.alt * FW.sharp[e]) % FW.steps[e] + FW.steps[e]) % FW.steps[e];

function readout(patch, notes) {
  const dm = deviceFor(patch);
  notes.forEach(n => dm.onNote("chord", "on", n));
  settle();
  let html = "", cur = "";
  (function walk(n) { if (!n) return;
    if (/dm-ro-notes/.test(n.className || "")) html = n.innerHTML || "";
    if (/dm-ro-cur/.test(n.className || "")) cur = n.innerHTML || n.textContent || "";
    (n.nodeKids || []).forEach(walk); })(dm.el);
  readout.matched = cur.replace(/<sub[^>]*>.*?<\/sub>/g, "").replace(/<[^>]*>/g, "").trim();
  const out = html.split(/<span[^>]*>\u00b7<\/span>/)
    .map(x => x.split("<sub")[0].replace(/<[^>]*>/g, "").trim()).filter(Boolean);
  notes.forEach(n => dm.onNote("chord", "off", n));
  settle();
  return out;
}

const bad = [];
let idChecked = 0, spellChecked = 0;
const EDO_NAME = ["12", "19", "31"];

/* Rounding can make two chords send the same MIDI. In 19, B maj7's 17-step
 * seventh and B7's 16-step one both round to the same semitone over that root,
 * so nothing in the note numbers can tell them apart and either reading is
 * right. The standard layout's chords, and their sharped roots, are the only
 * ones the buttons can reach together, so those are the rivals: a chord that
 * reads as a rival with the SAME notes passes, and its spelling is then checked
 * against the rival's own steps. */
const midiKey = (e, steps) => steps.map(x => toMidi(e, x)).sort((a, b) => a - b).join(",");
function rivals(e) {
  const out = new Map();   // label -> steps
  for (let b = 0; b < 7; b++) for (const type of STANDARD) for (const sharp of [0, 1]) {
    const steps = chordSteps(e, b, type).map((x, i) => x + sharp * FW.sharp[e]);
    out.set(BTN_NAME[b] + (sharp ? "#" : "") + TYPE_NAME[type], steps);
  }
  return out;
}
const RIVALS = [0, 1, 2].map(rivals);
let ambiguous = 0;
const ambiguousPairs = [];

function check(e, patch, button, type) {
  let steps = chordSteps(e, button, type);
  const labels = readout(patch, steps.map(x => toMidi(e, x)));
  const want = BTN_NAME[button] + TYPE_NAME[type];
  const where = `${EDO_NAME[e]}-EDO ${want}`;
  idChecked++;
  if (readout.matched !== want) {
    const rival = patch[39] ? null : RIVALS[e].get(readout.matched);
    if (!rival || midiKey(e, rival) !== midiKey(e, steps)) { bad.push(`${where}: read as "${readout.matched}"`); return; }
    ambiguous++;
    ambiguousPairs.push(`${EDO_NAME[e]}: ${want} = ${readout.matched}`);
    steps = rival;
  }
  const got = labels.map(parseNote);
  if (got.some(x => !x)) { bad.push(`${where}: cannot parse "${labels.join(" ")}"`); return; }
  const n = FW.steps[e];
  const wantSteps = steps.map(x => x % n).sort((a, b) => a - b).join(",");
  const gotSteps = got.map(sp => stepOf(e, sp)).sort((a, b) => a - b).join(",");
  spellChecked += got.length;
  if (wantSteps !== gotSteps) bad.push(`${where}: spelled "${labels.join(" ")}" = steps ${gotSteps}, sounds ${wantSteps}`);
}

for (let e = 0; e < 3; e++) {
  // the standard layout
  for (let button = 0; button < 7; button++) {
    for (const type of STANDARD) check(e, { 35: 0, 237: TEMPERAMENT[e] }, button, type);
  }
  // every catalogue entry, on the major button's alternate slot (202)
  FW.catalogue.forEach((type, i) => {
    for (let button = 0; button < 7; button++) check(e, { 35: 0, 237: TEMPERAMENT[e], 39: 1, 202: i + 1 }, button, type);
  });
}

/* ---- MPE: the bends settle what the rounding merged ----------------------
 * With MPE output (addr 110) each voice goes out on its own member channel,
 * chord voices on 2 to 5, with a bend sent before its note-on that holds the
 * exact pitch: 48 + steps * 12 / EDO, less the note number. Sent that way,
 * every chord must read as itself -- no identical-MIDI rival accepted.
 */
function mpeRead(e, patch, steps) {
  const dm = deviceFor(patch);
  const n = FW.steps[e];
  const voices = steps.map((x, i) => {
    const note = toMidi(e, x), exact = 48 + x * 12 / n;
    return { ch: 2 + i, note, value: Math.round((exact - note) * 8192 / 48) + 8192 };
  });
  voices.forEach(v => { dm.onBend("chord", v.ch, v.value); dm.onNote("chord", "on", v.note, 100, v.ch); });
  settle();
  let cur = "";
  (function walk(x) { if (!x) return;
    if (/dm-ro-cur/.test(x.className || "")) cur = x.innerHTML || x.textContent || "";
    (x.nodeKids || []).forEach(walk); })(dm.el);
  voices.forEach(v => dm.onNote("chord", "off", v.note, 0, v.ch));
  settle();
  return cur.replace(/<sub[^>]*>.*?<\/sub>/g, "").replace(/<[^>]*>/g, "").trim();
}
let mpeChecked = 0;
for (let e = 0; e < 3; e++) {
  for (let button = 0; button < 7; button++) for (const type of STANDARD) {
    mpeChecked++;
    const got = mpeRead(e, { 35: 0, 237: TEMPERAMENT[e], 110: 1 }, chordSteps(e, button, type));
    const want = BTN_NAME[button] + TYPE_NAME[type];
    if (got !== want) bad.push(`${EDO_NAME[e]}-EDO MPE ${want}: read as "${got}"`);
  }
  FW.catalogue.forEach((type, i) => {
    for (let button = 0; button < 7; button++) {
      mpeChecked++;
      const got = mpeRead(e, { 35: 0, 237: TEMPERAMENT[e], 110: 1, 39: 1, 202: i + 1 }, chordSteps(e, button, type));
      const want = BTN_NAME[button] + TYPE_NAME[type];
      if (got !== want) bad.push(`${EDO_NAME[e]}-EDO MPE ${want}: read as "${got}"`);
    }
  });
}

/* ---- the pads, every key and transpose ----------------------------------
 * A pad names its button's root. The device moves the audio by
 * transpose_steps, (semitones * EDO + 6) / 12, which in 19 and 31 is a
 * diatonic semitone for one semitone up: C goes to D-flat and never to C#.
 * So the root a pad names must land exactly on base + accidentals + that.
 */
const SIG = [0, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 7, 7, 7, 8, 7];
const SHARP_BTNS = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 1], [6, 5, 4, 3, 2, 1, 0]];
const FLAT_BTNS = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6]];
const DBL_SHARP = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2]];
const SHARP_KEYS = new Set([0, 1, 2, 3, 4, 5, 12, 13]);
function rootSteps(e, key, btn) {
  const sh = FW.sharp[e];
  let n = FW.base_notes[e][btn], c = SIG[key];
  if (SHARP_KEYS.has(key)) { for (let i = 0; i < c; i++) if (btn === SHARP_BTNS[c - 1][i]) n += sh; }
  else if (key >= 14 && key <= 18) {
    for (let i = 0; i < 7; i++) if (btn === SHARP_BTNS[6][i]) n += sh;
    for (const d of DBL_SHARP[key - 14]) if (btn === d) n += sh;
  } else {
    for (let i = 0; i < c && i < 7; i++) {
      if (key === 19 && btn === 0) continue;
      if (btn === FLAT_BTNS[Math.min(c, 7) - 1][i]) n -= sh;
    }
    if (key === 19 && btn === 0) n -= 2 * sh;
  }
  return n;
}
let padChecked = 0;
for (let e = 1; e < 3; e++) {
  const n = FW.steps[e];
  for (let key = 0; key < 21; key++) for (let tr = 0; tr <= 12; tr++) {
    const patch = { 35: key, 30: tr, 237: TEMPERAMENT[e] };
    const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
    dm.setConnected(true); dm.rebuild();
    const labels = [];
    (function walk(x) { if (!x) return;
      if (/dm-chord/.test(x.className || "") && x.textContent) labels.push(x.textContent);
      (x.nodeKids || []).forEach(walk); })(dm.el);
    const lift = Math.trunc((tr * n + 6) / 12);
    labels.slice(0, 7).forEach((label, col) => {
      const btn = 6 - col;
      padChecked++;
      const sp = parseNote(label);
      const want = (((rootSteps(e, key, btn) + lift) % n) + n) % n;
      if (!sp) bad.push(`${EDO_NAME[e]}-EDO pad key ${key} +${tr} btn${btn}: cannot parse "${label}"`);
      else if (stepOf(e, sp) !== want) bad.push(`${EDO_NAME[e]}-EDO pad key ${key} +${tr} btn${btn}: "${label}" is step ${stepOf(e, sp)}, sounds ${want}`);
    });
  }
}

/* ---- harp strings --------------------------------------------------------
 * The key-rooted scale modes (1-7) exactly against the firmware's own scales;
 * every other mode, chord held and not, by the weaker test that each name
 * rounds to the semitone the string sends.
 */
let harpChecked = 0;
for (let e = 1; e < 3; e++) {
  const n = FW.steps[e];
  for (const key of [0, 1, 6, 13, 19]) for (let mode = 0; mode < 12; mode++) for (const held of [false, true]) {
    const patch = { 35: key, 36: mode, 236: 0b101010110101, 237: TEMPERAMENT[e] };
    const dm = deviceFor(patch);
    const chord = chordSteps(e, 5, "major").map(x => toMidi(e, x));
    if (held) chord.forEach(m => dm.onNote("chord", "on", m));
    settle();
    const strings = [];
    (function walk(x) { if (!x) return;
      if (/dm-string/.test(x.className || "") && x.textContent) {
        const m = /MIDI (\d+)/.exec(x.title || "");
        if (m) strings.push({ label: x.textContent, midi: parseInt(m[1], 10) });
      }
      (x.nodeKids || []).forEach(walk); })(dm.el);
    if (held) { chord.forEach(m => dm.onNote("chord", "off", m)); settle(); }
    strings.forEach((st, i) => {
      harpChecked++;
      const where = `${EDO_NAME[e]}-EDO harp key ${key} mode ${mode}${held ? " held" : ""} str${i}`;
      const sp = parseNote(st.label);
      if (!sp) { bad.push(`${where}: cannot parse "${st.label}"`); return; }
      const step = stepOf(e, sp);
      if (Math.round(step * 12 / n) % 12 !== st.midi % 12) {
        bad.push(`${where}: "${st.label}" is step ${step}, which is not the semitone it sends (MIDI ${st.midi})`);
        return;
      }
      if (mode >= 1 && mode <= 7) {
        const scale = FW.scale_intervals[e][mode - 1];
        let root = FW.scale_root_offsets[e][key];
        if (mode >= 5) root = (root + n - [3, 5, 8][e]) % n;
        const string = 11 - i;   // the strip is drawn top string first
        const want = (root + scale[string % scale.length]) % n;
        if (step !== want) bad.push(`${where}: "${st.label}" is step ${step}, the firmware plays ${want}`);
      }
    });
  }
}

/* ---- the degree-literal spellings, by hand -------------------------------
 * Each chord tone keeps its degree's letter, and the alteration is whatever
 * lands it on the sounding step: in 19 a sharp is one step, in 31 two, and a
 * single step in 31 is a quarter-tone sign. Worked out on paper from the step
 * tables, over C (the C button, key C).
 */
const HAND = [
  [1, "harmonic_7th", "C E G B\u266d\u266d"],       // 7/4 is 15 of 19: two below B
  [1, "subminor",     "C E\u266d\u266d G C"],       // 7/6 is 4: two below E
  [1, "supermajor",   "C E# G C"],                  // 9/7 is 7: one above E
  [1, "neutral",      "C E G C"],                   // no neutral third in 19: it is the major
  [2, "harmonic_7th", "C E G B\u266d\ud834\udd33"], // 25 of 31: three below B, a flat and a half
  [2, "subminor",     "C E\u266d\ud834\udd33 G C"], // 7: three below E
  [2, "supermajor",   "C E\ud834\udd32 G C"],       // 11: one above E, a half sharp
  [2, "neutral",      "C E\ud834\udd33 G C"],       // 9: one below E, a half flat
  [2, "major",        "C E G C"],
  [2, "seventh",      "C E G B\u266d"],
  // the named diminished and augmented tones, which 31 keeps apart from their
  // enharmonics: G-flat is 16 steps and F-sharp 15, B-double-flat 24 and A 23
  [2, "dim",          "C E\u266d G\u266d C"],
  [2, "full_dim",     "C E\u266d G\u266d B\u266d\u266d"],
  [2, "aug",          "C E G# C"],
  [1, "full_dim",     "C E\u266d G\u266d B\u266d\u266d"],
];
let handChecked = 0;
for (const [e, type, want] of HAND) {
  const i = FW.catalogue.indexOf(type);
  const labels = readout({ 35: 0, 237: TEMPERAMENT[e], 39: 1, 202: i + 1 }, chordSteps(e, 5, type).map(x => toMidi(e, x)));
  handChecked++;
  const got = labels.slice().sort().join(" "), exp = want.split(" ").sort().join(" ");
  if (got !== exp) bad.push(`${EDO_NAME[e]}-EDO C${TYPE_NAME[type]} by hand: "${labels.join(" ")}", expected "${want}"`);
}

if (bad.length) {
  console.log(`edo: ${bad.length} failure(s) of ${idChecked} chords, ${mpeChecked} over MPE, ${spellChecked} spelled notes, ${padChecked} pads, ${harpChecked} harp strings and ${handChecked} hand spellings\n`);
  bad.slice(0, 40).forEach(b => console.log("  " + b));
  if (bad.length > 40) console.log(`  ... and ${bad.length - 40} more`);
  process.exit(1);
}
console.log(`edo: ${idChecked} chords in 12, 19 and 31 read back as themselves (${ambiguous} as a chord sending identical MIDI: ${ambiguousPairs.join(", ")}; over MPE all ${mpeChecked} read exactly as themselves), their ${spellChecked} notes spell the step that sounds, as do ${padChecked} pad roots across every key and transpose and ${harpChecked} harp strings, and ${handChecked} chords spell as worked by hand`);

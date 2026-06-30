/* Headless regression harness for devicemap.js.
 *
 * Loads devicemap.js in a vm context with a DOM shim + a VIRTUAL CLOCK (deterministic
 * setTimeout/Date.now), replays fixed chord/harp/rhythm event scripts, and emits a transcript of:
 *   - every [Play] console line the engine logs (PLAY_DEBUG on)
 *   - a lit/slash snapshot of the grid + harp (walked from the shimmed DOM) after each step
 *   - the identifyChord() return for rhythm steps
 * The transcript is deterministic: any diff against golden.txt is a behaviour change.
 * Usage: node run.js > out.txt && diff out.txt golden.txt   (see README.md)
 */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DEVICEMAP = process.env.DM || path.join(__dirname, "..", "devicemap.js");

/* ---- virtual clock + fake timers (deterministic) ------------------------ */
let vclock = 0;
let timerSeq = 0;
let timers = [];
function fakeSetTimeout(fn, ms) { const t = { fn, due: vclock + (ms || 0), seq: timerSeq++, dead: false }; timers.push(t); return t; }
function fakeClearTimeout(t) { if (t) t.dead = true; }
function advance(ms) {
  const target = vclock + ms;
  for (;;) {
    let next = null;
    for (const t of timers) if (!t.dead && t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
    if (!next) break;
    vclock = next.due; next.dead = true;
    try { next.fn(); } catch (e) { lines.push("TIMER-ERR " + e.message); }
  }
  vclock = target;
  timers = timers.filter(t => !t.dead);
}

/* ---- console capture ----------------------------------------------------- */
let lines = [];
const cap = (...a) => lines.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
const fakeConsole = { log: cap, info: cap, warn: cap, error: cap };

/* ---- minimal DOM shim ---------------------------------------------------- */
function makeStyle() { return { setProperty() {}, removeProperty() {}, display: "", animation: "" }; }
function makeEl(tag) {
  const classes = new Set();
  return {
    tagName: tag, nodeKids: [],
    className: "", textContent: "", title: "", type: "", innerHTML: "", value: "",
    offsetWidth: 0, style: makeStyle(),
    classList: {
      add: (...c) => c.forEach(x => x && classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: x => classes.has(x),
      toggle: x => (classes.has(x) ? (classes.delete(x), false) : (classes.add(x), true)),
      _classes: classes,
    },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild(c) { this.nodeKids.push(c); return c; },
    append(...cs) { cs.forEach(c => this.nodeKids.push(c)); },
    remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
const document = { createElement: makeEl, createTextNode: t => ({ textContent: t, nodeKids: [] }) };

/* walk the shimmed tree, collect lit/slash elements as `tag.classes:text` (DOM order = deterministic) */
function litSnapshot(root) {
  const out = [];
  (function walk(el) {
    if (!el || !el.classList) { (el && el.nodeKids || []).forEach(walk); return; }
    const cl = el.classList._classes;
    if (cl && (cl.has("lit") || cl.has("slash"))) {
      const tags = [...cl].filter(c => c === "lit" || c === "slash").sort().join("+");
      out.push(`${el.tagName}.${tags}:${(el.textContent || el.innerHTML || "").trim()}`);
    }
    (el.nodeKids || []).forEach(walk);
  })(root);
  return out;
}

/* does the harp panel (.dm-harp) currently carry the detection-glow class? */
function harpPanelHit(root) {
  let hit = false;
  (function walk(el) { if (!el) return; if (el.className === "dm-harp" && el.classList && el.classList._classes.has("dm-hit")) hit = true; (el.nodeKids || []).forEach(walk); })(root);
  return hit;
}

/* ---- load devicemap.js in a sandbox ------------------------------------- */
const window = { PLAY_DEBUG: true };
const sandbox = { window, document, console: fakeConsole, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, Date: { now: () => vclock }, Math, JSON, Set, Map, Array, Object };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(DEVICEMAP, "utf8"), sandbox, { filename: "devicemap.js" });
const DeviceMap = window.DeviceMap;

/* ---- firmware-formula port (INPUT generation only — mirrors devicemap) --- */
const BASE_NOTES = [11, 4, 9, 2, 7, 0, 5];
const MUSICAL_INDEX = [6, 2, 5, 1, 4, 0, 3];
const KEY_SIGNATURES = [0, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6];
const SHARP_BTNS = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 1]];
const FLAT_BTNS = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5]];
const CHORD_SHUF = [[0, 1, 2, 3, 4, 5, 6], [10, 11, 12, 13, 14, 15, 16], [10, 11, 12, 13, 0, 2, 3], [10, 11, 12, 13, 2, 5, 6], [10, 11, 12, 13, 2, 15, 16], [20, 21, 22, 23, 24, 25, 26]];
const CHORD = {
  major: [0, 4, 7, 12, 2, 5, 9], minor: [0, 3, 7, 12, 1, 5, 8], maj_sixth: [0, 4, 7, 9, 2, 5, 12], min_sixth: [0, 3, 7, 9, 1, 5, 12],
  seventh: [0, 4, 10, 7, 2, 5, 9], maj_seventh: [0, 4, 11, 7, 2, 5, 9], min_seventh: [0, 3, 10, 7, 1, 5, 8], aug: [0, 4, 8, 12, 2, 5, 9], dim: [0, 3, 6, 12, 2, 5, 9], full_dim: [0, 3, 6, 9, 2, 5, 12],
};
const MIDI_BASE = 48;
const resolveTable = (type, barry) => (!barry ? type : type === "major" ? "maj_sixth" : type === "minor" ? "min_sixth" : type === "dim" ? "full_dim" : type);
function settingsOf(p) {
  const g = (a, d) => (p[a] == null ? d : p[a] | 0);
  return { key: Math.min(11, Math.max(0, g(35, 0))), transpose: g(30, 0), shift: Math.min(6, Math.max(0, g(34, 0))), barry: !!g(33, 0), flat: !!g(31, 0), chordShuf: Math.min(5, Math.max(0, g(120, 2))), slashLevel: Math.min(2, Math.max(0, g(23, 0))) };
}
function rootBtn(s, button) {
  let note = BASE_NOTES[button];
  if (MUSICAL_INDEX[button] < s.shift) note += 12;
  const n = KEY_SIGNATURES[s.key];
  if (s.key <= 5) { for (let i = 0; i < n; i++) if (button === SHARP_BTNS[n - 1][i]) note += 1; }
  else { for (let i = 0; i < n; i++) if (button === FLAT_BTNS[n - 1][i]) note -= 1; }
  return note;
}
// the 4 chord-press voices (0..3) for (button,type) under patch p, optional slash/sharp
function chordNotes(button, type, p, opts) {
  opts = opts || {};
  const s = settingsOf(p);
  const table = CHORD[resolveTable(type, s.barry)];
  const slash = opts.slashButton != null ? { button: opts.slashButton } : null;
  const sh = opts.sharp ? (s.flat ? -1 : 1) : 0;
  const out = [];
  for (let v = 0; v < 4; v++) {
    const level = CHORD_SHUF[s.chordShuf][v];
    let n;
    if (slash && (level % 10) === s.slashLevel) n = MIDI_BASE + s.transpose + 12 * Math.floor(level / 10) + rootBtn(s, slash.button);
    else n = MIDI_BASE + s.transpose + 12 * Math.floor(level / 10) + rootBtn(s, button) + table[level % 10];
    out.push(n + sh);
  }
  return out;
}
/* ---- scenario driver ----------------------------------------------------- */
let dm, ctx;
function step(label) { lines.push(`  · ${label} | lit: ${litSnapshot(dm.el).join("  ") || "—"}`); }
function pressChord(notes, hold) { notes.forEach(n => dm.onNote("chord", "on", n)); advance(hold == null ? 20 : hold); }
function releaseChord(notes, after) { notes.forEach(n => dm.onNote("chord", "off", n)); advance(after == null ? 200 : after); }
function harpOn(seq, gap) { seq.forEach(n => { dm.onNote("harp", "on", n); advance(gap == null ? 12 : gap); }); }
function harpOff(seq) { seq.forEach(n => dm.onNote("harp", "off", n)); advance(50); }

const scenarios = [
  ["S1 connect + resting seed (default patch)", () => {
    dm.rebuild(); dm.setConnected(true); dm.rebuild(); step("after connect");
  }],
  ["S2 C major press/release (col5/button5, default)", () => {
    const C = chordNotes(5, "major", ctx.patch); lines.push("  input C major = " + C);
    pressChord(C); step("held"); releaseChord(C); step("released+faded");
  }],
  ["S3 C -> F transition", () => {
    const C = chordNotes(5, "major", ctx.patch), F = chordNotes(6, "major", ctx.patch);
    lines.push("  input C=" + C + " F=" + F);
    pressChord(C); step("C held"); F.forEach(n => dm.onNote("chord", "on", n)); C.forEach(n => dm.onNote("chord", "off", n)); advance(30); step("F taken over"); releaseChord(F);
  }],
  ["S4 C/E slash (doubled bass multiset)", () => {
    const CE = chordNotes(5, "major", ctx.patch, { slashButton: 1 }); lines.push("  input C/E = " + CE);
    pressChord(CE, 60); step("held"); releaseChord(CE);
  }],
  ["S5 combo: C maj+7th -> maj_seventh", () => {
    const m7 = chordNotes(5, "maj_seventh", ctx.patch); lines.push("  input Cmaj7 = " + m7);
    pressChord(m7, 60); step("held"); releaseChord(m7);
  }],
  ["S6 sharp chord then natural (E#/F gate)", () => {
    const Fs = chordNotes(6, "major", ctx.patch, { sharp: true }); const F = chordNotes(6, "major", ctx.patch);
    lines.push("  input F#=" + Fs + " F=" + F);
    pressChord(Fs, 40); step("F# held"); releaseChord(Fs); pressChord(F, 40); step("F held"); releaseChord(F);
  }],
  ["S7 barry: major press reads as 6th", () => {
    ctx.patch[33] = 1; dm.rebuild();
    const C6 = chordNotes(5, "major", ctx.patch); lines.push("  input (barry C major emits) = " + C6);
    pressChord(C6, 40); step("held"); releaseChord(C6); ctx.patch[33] = 0; dm.rebuild();
  }],
  ["S8 harp octaves strum (real capture, default)", () => {
    const strum = [53, 57, 60, 65, 65, 69, 72, 77, 77, 81, 84, 89];
    harpOn(strum, 10); step("after strum"); harpOff(strum); step("released");
  }],
  ["S9 rhythm arpeggio identifyChord (C major, default)", () => {
    const C = chordNotes(5, "major", ctx.patch);
    let prev = null;
    [[C[0]], [C[0], C[1]], [C[0], C[1], C[2]], C].forEach((pit, i) => {
      const r = dm.identifyChord(pit, prev); prev = r;
      lines.push(`  rhythm step${i} pitches=${pit} -> ${r ? `${r.button}/${r.type} d${r.transposeOffset} slash${r.slashButton} notes${r.notes}` : "null"}`);
      advance(40);
    });
  }],
  ["S10 rhythm with harp corroboration", () => {
    const C = chordNotes(5, "major", ctx.patch);
    harpOn([60, 64, 67], 10); // seed harp PCs
    let prev = null;
    [[C[0]], [C[0], C[2]]].forEach((pit, i) => {
      const r = dm.identifyChord(pit, prev); prev = r;
      lines.push(`  rhythm+harp step${i} pitches=${pit} -> ${r ? `${r.button}/${r.type} d${r.transposeOffset}` : "null"}`);
      advance(40);
    });
  }],
  ["S11 pot-on-120 chord voicing (Underwater-style)", () => {
    // mod pot drives addr 120 (chord voicing); dump stores chordShuf=2 but device emits at voicing 5
    ctx.patch[14] = 120; ctx.patch[120] = 2; dm.rebuild();
    const Cv5 = chordNotes(5, "major", { ...ctx.patch, 120: 5 }); lines.push("  input C@voicing5 = " + Cv5);
    pressChord(Cv5, 40); step("grid: voicing recovered?"); releaseChord(Cv5);
    let prev = null; const r = dm.identifyChord(Cv5, prev);
    lines.push(`  rhythm @voicing5 -> ${r ? `${r.button}/${r.type} notes${r.notes}` : "null"}`);
    ctx.patch[14] = 0; delete ctx.patch[120]; dm.rebuild();
  }],
  ["S12 transpose +3 nudge while holding", () => {
    const C = chordNotes(5, "major", ctx.patch);
    pressChord(C, 30); step("C held @t0");
    ctx.patch[30] = 3; dm.rebuild(); step("transpose=3 while held (matching frozen, labels live)");
    releaseChord(C); ctx.patch[30] = 0; dm.rebuild();
  }],
  ["S14 barry chord HELD + rhythm identify (pressedChord authority + barry type)", () => {
    ctx.patch[33] = 1; dm.rebuild();
    const C6 = chordNotes(5, "major", ctx.patch); lines.push("  barry C (emits 6th) = " + C6);
    pressChord(C6, 30); step("barry C held");
    let prev = null;
    [[C6[0]], [C6[0], C6[1]], C6].forEach((pit, i) => {
      const r = dm.identifyChord(pit, prev); prev = r;
      lines.push(`  barry rhythm step${i} pitches=${pit} -> ${r ? `${r.button}/${r.type} d${r.transposeOffset}` : "null"}`);
      advance(40);
    });
    releaseChord(C6); ctx.patch[33] = 0; dm.rebuild();
  }],
  ["S15 plain chord HELD + rhythm lone-root (held/dropped fusion)", () => {
    const C = chordNotes(5, "major", ctx.patch);
    pressChord(C, 30); step("C held");
    const r = dm.identifyChord([C[0]], null);
    lines.push(`  held+rhythm lone-root pitches=${C[0]} -> ${r ? `${r.button}/${r.type} d${r.transposeOffset}` : "null"}`);
    releaseChord(C);
  }],
  ["S16 watchdog releases a stuck note + unblocks new chord", () => {
    const C = chordNotes(5, "major", ctx.patch);
    C.forEach(n => dm.onNote("chord", "on", n)); advance(30); step("C held (no note-off sent)");
    advance(9000);                                    // past HELD_TTL (8000) — missed note-offs age out
    step("after watchdog (should be clear)");
    const F = chordNotes(6, "major", ctx.patch);
    pressChord(F, 30); step("new F lights (was blocked by phantom)"); releaseChord(F);
  }],
  ["S17 harp fallback: out-of-range note still lights a string + panel glows", () => {
    dm.onNote("harp", "on", 30);                       // far below the harp's range — no string carries it
    lines.push("  out-of-range harp 30 -> lit: " + (litSnapshot(dm.el).join(" ") || "—") + " | panel glow: " + harpPanelHit(dm.el));
    dm.onNote("harp", "off", 30);
  }],
  ["S18 rhythm: a bass note only in the bucket does NOT make a split", () => {
    const C = chordNotes(5, "major", ctx.patch);       // {60,64,67,72}
    dm.onNote("chord", "on", 62); advance(10);         // a D held on the port (in the bucket, NOT a played onset)
    const r = dm.identifyChord([C[0], C[1], C[2]], null);   // caller onsets = a plain C-major triad
    lines.push("  C triad onsets + D in bucket -> " + (r ? `${r.button}/${r.type} slash=${r.slashButton}` : "null"));
    dm.onNote("chord", "off", 62);
  }],
  ["S19 DIAG rhythm with held-note accumulation across a chord change", () => {
    const C = chordNotes(5, "major", ctx.patch);   // {60,64,67,72}
    let prev = null, recent = [];
    C.forEach(n => { dm.onNote("chord", "on", n); recent.push(n); const r = dm.identifyChord(recent.slice(-6), prev); prev = r; lines.push(`  C voice ${n} -> ${r ? `${r.button}/${r.type}` : "null"}`); advance(200); });
    const F = chordNotes(6, "major", ctx.patch);   // {65,69,72,77} — C notes NOT released (still in heldNotes)
    recent = []; prev = null;
    F.forEach(n => { dm.onNote("chord", "on", n); recent.push(n); const r = dm.identifyChord(recent.slice(-6), prev); prev = r; lines.push(`  F voice ${n} (C still held) -> ${r ? `${r.button}/${r.type}` : "null"}`); advance(200); });
  }],
  ["S20 DIAG Cm rhythm (should read minor, not dim)", () => {
    const Cm = chordNotes(5, "minor", ctx.patch);   // {60,63,67,72} = C,Eb,G,C
    lines.push("  Cm voices = " + Cm);
    let prev = null, recent = [];
    Cm.forEach(n => { dm.onNote("chord", "on", n); dm.onNote("chord", "off", n); recent.push(n); const r = dm.identifyChord(recent.slice(-6), prev); prev = r; lines.push(`  Cm onset ${n} -> ${r ? `${r.button}/${r.type}` : "null"}`); advance(200); });
  }],
  ["S21 pattern disambiguation: {F,A} → F when the ROOT voice fires (not Dm)", () => {
    // {F,A} is shared by F (root 65 + 3rd 69) and Dm (3rd 65 + 5th 69) — a bare coverage tie. The step
    // pattern firing the ROOT voice (vs=[0]) at F's onset pins F: its root is played, Dm's (D) isn't.
    const withPat = dm.identifyChord([{ p: 65, vs: [0] }, { p: 69, vs: [1] }], null);
    lines.push("  {F,A} root+3rd voices fired -> " + (withPat ? `${withPat.button}/${withPat.type}` : "null") + "  (want 6/major = F)");
    const bare = dm.identifyChord([{ p: 65, vs: [] }, { p: 69, vs: [] }], null);
    lines.push("  {F,A} no pattern (bare tie)   -> " + (bare ? `${bare.button}/${bare.type}` : "null") + "  (ambiguous)");
  }],
  ["S22 pattern: Cm with root+3rd+5th voices fired stays minor (seq agrees, not dim)", () => {
    const r = dm.identifyChord([{ p: 60, vs: [0] }, { p: 63, vs: [1] }, { p: 67, vs: [2] }], null);
    lines.push("  Cm root/3rd/5th fired -> " + (r ? `${r.button}/${r.type}` : "null") + "  (want 5/minor)");
  }],
  // GATE invariant (S23/S24): a COLORED type is only named once its diagnostic tone has sounded. The
  // existing coverage+press+seq already avoids the trap for these bare inputs (a sweep of all 2–4-note
  // onset sets shows r54≡r55), so the gate is a defensive GUARANTEE, not an outcome-changer here — it
  // holds the line if future scoring tweaks would otherwise expose the Cm→Cdim trap.
  ["S23 GATE: natural 5th, no ♭5 → minor (the gate guarantees dim can never appear)", () => {
    const r = dm.identifyChord([60, 63, 67], null);   // {C4, Eb4, G4} — a clean Cm triad, ♭5 (Gb) absent
    lines.push("  {C4,Eb4,G4} (P5, no ♭5) -> " + (r ? `${r.button}/${r.type}` : "null") + "  (want 5/minor, never 5/dim)");
  }],
  ["S24 GATE: the ♭5 (Gb) IS heard → dim is correctly named", () => {
    const r = dm.identifyChord([60, 63, 66], null);   // {C4, Eb4, Gb4} — the ♭5 sounded
    lines.push("  {C4,Eb4,Gb4} (♭5 heard) -> " + (r ? `${r.button}/${r.type}` : "null") + "  (want 5/dim)");
  }],
  ["S25 GATE: ♭7 (Bb) gates dominant vs triad", () => {
    const triad = dm.identifyChord([60, 64, 67], null);          // {C,E,G} — no ♭7
    const dom = dm.identifyChord([60, 64, 67, 70], null);        // {C,E,G,Bb} — ♭7 sounded
    lines.push("  {C,E,G} no ♭7 -> " + (triad ? `${triad.button}/${triad.type}` : "null") + "  (want major, never seventh)");
    lines.push("  {C,E,G,Bb} ♭7 -> " + (dom ? `${dom.button}/${dom.type}` : "null") + "  (want 5/seventh)");
  }],
  ["S26 GATE grid: a held set missing the ♭5 can never match dim (containment already enforces it)", () => {
    const Cm = chordNotes(5, "minor", ctx.patch);     // {60,63,67,72} = C,Eb,G,C — no Gb anywhere
    pressChord(Cm, 30);
    lines.push("  held Cm (no ♭5) lit: " + (litSnapshot(dm.el).join(" ") || "—") + "  (want a minor cell, never dim)");
    releaseChord(Cm);
  }],
  ["S27 POSITIONAL rhythm: a marginal fired ♭7 voice flips D6→D7 where fuzzy stickiness can't", () => {
    // barry preset: D presses voice as D6 (maj_sixth) — the cheap default. The step pattern fires chord
    // VOICE indices (vs); index 2 is the 5th (A) in D6 but the ♭7 (C) in D7. With D6 already current, a
    // sparse burst {root, v2=C} gives D7 only a +1 coverage/seq edge — STICK_MARGIN swallows that in the
    // fuzzy path, but in POSITIONAL mode position is authoritative so it flips. D root = 62.
    ctx.patch[33] = 1; dm.rebuild();
    const lbl = r => r ? `${["B","E","A","D","G","C","F"][r.button]}/${r.type}` : "null";
    const d6 = dm.identifyChord([{ p: 62, vs: [0] }, { p: 66, vs: [1] }, { p: 69, vs: [2] }], null);  // D,F#,A@v2 → D6
    const pos = dm.identifyChord([{ p: 62, vs: [0] }, { p: 72, vs: [2] }], d6);   // {root, ♭7@v2} WITH vs → positional
    const fuz = dm.identifyChord([62, 72], d6);                                   // SAME notes, no vs → fuzzy path
    const back = dm.identifyChord([{ p: 62, vs: [0] }, { p: 69, vs: [2] }], pos); // v2=A again, positional → demote D6
    lines.push("  D6 established              -> " + lbl(d6) + "  (want 3/maj_sixth)");
    lines.push("  +♭7 on v2 (POSITIONAL)      -> " + lbl(pos) + "  (want 3/seventh = D7 — position decides)");
    lines.push("  +♭7 same notes (FUZZY)      -> " + lbl(fuz) + "  (want 3/seventh — dominance: D6 can't place the C, no vs needed)");
    lines.push("  v2=A again (POSITIONAL)     -> " + lbl(back) + "  (want 3/maj_sixth = D6 — momentary demote)");
    ctx.patch[33] = 0; dm.rebuild();
  }],
  ["S28 SETTLE harp: an ambiguous B-C-D run no longer flips the context", () => {
    dm.setConnected(true); dm.rebuild();
    const run = [95, 84, 86, 83, 72, 74, 71, 60, 62, 59, 48]; // B6,C6,D6,B5,C5,D5,B4,C4,D4,B3,C3
    const before = lines.length;
    harpOn(run, 60);
    const switches = lines.slice(before).filter(l => /harp ctx →/.test(l)).length;
    lines.push(`  harp ctx switches during the B-C-D run: ${switches}  (want few — settled, not flipping)`);
    harpOff(run);
  }],
  ["S29 SETTLE harp: A7 strum then a D/G swipe — slash contexts are first-class (log2 shape)", () => {
    dm.setConnected(true); dm.rebuild();
    // an A7 fragment (root, 3rd, ♭7 — the ♭7 G satisfies the diagnostic gate), then a clean D/G
    // row-0 swipe string #11→#0 (the log2 capture). The settle must hold A7 through the first two
    // swipe notes (suffix < HARP_SUFFIX_MIN) then hand the read to D/G — the old margin never
    // could, because D/G only exists as a slash candidate and slash ran post-hoc on the winner.
    const a7 = [57, 61, 67];                                       // A3,C#4,G4
    const dg = [93, 90, 91, 81, 78, 79, 69, 66, 67, 57, 54, 55];   // A6,F#6,G6 … G3 = D/G #11→#0
    const before = lines.length;
    harpOn(a7, 50);
    advance(2500);                                                 // > SEG_MS — a new gesture
    harpOn(dg, 50);
    const sw = lines.slice(before).filter(l => /harp ctx →/.test(l));
    lines.push(`  ctx switches: ${sw.length}  (want 3: a 1-note cold read, A7 on its suffix, D/G on the swipe — then silence)`);
    lines.push(`  final read: ${sw.length ? sw[sw.length - 1].replace(/.*harp ctx → /, "").replace(/ — .*/, "") : "—"}  (want D/G row 0(normal))`);
    harpOff(a7); harpOff(dg);
  }],
  ["S30 DOMINANCE fuzzy rhythm: the ONE distinguishing onset flips D6↔D7 with no voice info", () => {
    // barry preset: D6 {D,F#,A,B} and D7 {D,F#,C,A} differ in exactly one octave-exact pitch (B vs
    // C). The sticky margin used to swallow that single onset (the read stuck on whichever chord
    // came first — the on-device complaint); dominance flips it: a chord that can't place the
    // newest onset has no sticky claim on the read. The reverse flip needs no dominance at all —
    // once the ♭7 leaves the window the diagnostic gate demotes D7 by itself.
    ctx.patch[33] = 1; dm.rebuild();
    const lbl = r => r ? `${["B","E","A","D","G","C","F"][r.button]}/${r.type}` : "null";
    const d6 = dm.identifyChord([62, 66, 69], null);     // {D,F#,A} — barry default reading
    const d7 = dm.identifyChord([62, 66, 72], d6);       // C5 arrives: D6 can't place it
    const back = dm.identifyChord([62, 66, 71], d7);     // B4 arrives: ♭7 left the window
    lines.push("  {D,F#,A} bare                -> " + lbl(d6) + "  (want 3/maj_sixth)");
    lines.push("  {D,F#,C} prev=D6 (FUZZY)     -> " + lbl(d7) + "  (want 3/seventh — D6 can't place the C)");
    lines.push("  {D,F#,B} prev=D7 (FUZZY)     -> " + lbl(back) + "  (want 3/maj_sixth — gate demotes the stale 7th)");
    ctx.patch[33] = 0; dm.rebuild();
  }],
  ["S31 SETTLE harp: two full G/C swipes (the log5 §1 capture) — one read, zero flips", () => {
    dm.setConnected(true); dm.rebuild();
    // the strum that used to oscillate Bm↔Cmaj7 five times is EXACTLY a G/C row-0 swipe #11→#0,
    // then back up. One early cold read is fine; once the 3-note suffix lands on G/C nothing may
    // flip again — the second swipe must be silent (every note already fits the settled layout).
    const down = [98, 95, 84, 86, 83, 72, 74, 71, 60, 62, 59, 48];
    const before = lines.length;
    harpOn(down, 80); harpOff(down);
    advance(2400);                                                 // separate gesture (the real gap)
    harpOn(down.slice().reverse(), 80); harpOff(down);
    const sw = lines.slice(before).filter(l => /harp ctx →/.test(l)).length;
    lines.push(`  ctx switches over both swipes: ${sw}  (want 2: one cold read + G/C — never Cmaj7, no flipping)`);
  }],
  ["S32 MULTISET rhythm: a doubled voice separates C6/G from C6 (log6 shape)", () => {
    // voicing 4 puts the slash bass ON a chord tone: C6/G = {G4×2,E4,A4,G3,F4,C5} vs plain
    // C6 = {C4,E4,G4,A4,G3,F4,C5} — same pitch-classes, but C6/G doubles G4 and never sounds C4.
    // Set-based matching saw no difference (C6/G ⊂ C6). The burst multiplicity (m) is the
    // fingerprint: a G4 sounded by TWO voices at once is impossible for plain C6 → adopt the
    // slash; a C4 onset is impossible for C6/G → back to plain.
    ctx.patch[33] = 1; ctx.patch[120] = 4; dm.rebuild();
    const lbl = r => r ? `${["B","E","A","D","G","C","F"][r.button]}/${r.type}${r.slashButton != null ? "/" + ["B","E","A","D","G","C","F"][r.slashButton] : ""}` : "null";
    const c6 = dm.identifyChord([60, 64, 67], null);                                 // plain C6 established
    const dbl = dm.identifyChord([{ p: 72, m: 1 }, { p: 64, m: 1 }, { p: 69, m: 1 }, { p: 67, m: 2 }, { p: 67, m: 2 }], c6);
    const back = dm.identifyChord([{ p: 69, m: 1 }, { p: 67, m: 1 }, { p: 60, m: 1 }], dbl);
    lines.push("  {C4,E4,G4}                  -> " + lbl(c6) + "  (want 5/maj_sixth — plain C6)");
    lines.push("  {C5,E4,A4,G4×2} prev=C6     -> " + lbl(dbl) + "  (want 5/maj_sixth/G — a doubled G4 is impossible for plain C6)");
    lines.push("  {A4,G4,C4} prev=C6/G        -> " + lbl(back) + "  (want 5/maj_sixth — C6/G can never sound a C4)");
    ctx.patch[33] = 0; delete ctx.patch[120]; dm.rebuild();
  }],
  ["S33 HARP momentum: duplicate strings follow the finger (heat-map lighting)", () => {
    // C/G carries G on string #0 (the slash bass) AND #2 (the 5th) — same MIDI 55 — and again on
    // #3/#5 (67). Sweeping up from #0, a re-plucked G3 used to TIE on nearest distance from #1 and
    // snap back to #0 against the motion; momentum picks the string AHEAD of the travel. After an
    // octave-double lights two plates, the front must sit on the FAR plate so the sweep continues;
    // after a pause (> HARP_DIR_MS) the choice falls back to plain nearest.
    const CG = chordNotes(5, "major", ctx.patch, { slashButton: 4 });   // [67,64,67,72] — doubled 67
    pressChord(CG, 80); step("C/G held");                        // > COMPLEX_HOLD so the slash applies
    dm.onNote("harp", "on", 55); advance(80);                    // → #0 (cold start, lowest twin)
    dm.onNote("harp", "off", 55); advance(20);
    dm.onNote("harp", "on", 52); advance(80);                    // → #1, travel = UP
    dm.onNote("harp", "on", 55); advance(80);                    // G3 again: #0/#2 tie — want #2 (ahead)
    dm.onNote("harp", "on", 67); advance(80);                    // → #3 (ahead)
    dm.onNote("harp", "on", 64); advance(80);                    // → #4
    dm.onNote("harp", "on", 67); advance(80);                    // 2nd G4 voice: #3+#5 lit, front → #5
    step("upward sweep with re-plucked twins");
    [55, 52, 67, 64, 67].forEach(n => dm.onNote("harp", "off", n));
    advance(700);                                                // momentum expires (> HARP_DIR_MS)
    dm.onNote("harp", "on", 67); advance(80);                    // from #5, no fresh dir → nearest = #5
    step("after pause: nearest again");
    dm.onNote("harp", "off", 67); releaseChord(CG);
  }],
  ["S34 DESYNC badge: the port plays F while the harp plays Fmaj7 (firmware race mirror)", () => {
    dm.setConnected(true); dm.rebuild();
    // litSnapshot only collects .lit/.slash — read the badge node directly
    const badge = (() => { let b = null; (function walk(el) { if (!el) return;
      if (el.className === "dm-harp-desync") b = el; (el.nodeKids || []).forEach(walk); })(dm.el); return b; })();
    const showBadge = () => `badge: ${badge && badge.style.display !== "none" ? `"${badge.textContent}"` : "hidden"}`;
    const F = chordNotes(6, "major", ctx.patch);             // [65,69,72,77] — the queued F voices
    pressChord(F, 30); step("F held on the chord port");
    lines.push("  " + showBadge() + "  (want hidden — nothing diverged yet)");
    // Fmaj7 row-0 strings #0..#5 = [53,57,64,65,69,76]; 64=E4 is the first miss under F-major
    // (F's #2 is 60). Suffix [53,57,64] = len 3 ≥ HARP_SUFFIX_MIN; gate: the E pc arrives via the
    // 64 itself. NOTE: Dm/E explains the suffix with an IDENTICAL score — Fmaj7 wins only because
    // plains enumerate before slash variants (pass 0 first). A tie-order change breaks this line.
    const strum = [53, 57, 64, 65, 69, 76];
    harpOn(strum, 12); step("Fmaj7 strum over held F (grid must stay F)");
    lines.push("  " + showBadge() + "  (want hidden — context adopted instantly, badge waits out the min play time)");
    advance(1100);                                           // > HARP_DESYNC_MS — the divergence persisted
    lines.push("  " + showBadge() + '  (want "Fmaj7" — shown once the desync has lasted)');
    harpOff(strum);
    releaseChord(F); step("F released (device harp keeps Fmaj7)");
    lines.push("  " + showBadge() + '  (want "Fmaj7" still — desync persists through release)');
    advance(2500);                                           // > SEG_MS and past LOOKBACK
    const M7 = chordNotes(6, "maj_seventh", ctx.patch);      // a real Fmaj7 trigger resyncs the device
    pressChord(M7, 60); step("Fmaj7 pressed for real — applyChord resync");   // 60 > COMPLEX_HOLD (combo)
    lines.push("  " + showBadge() + "  (want hidden — held adopted Fmaj7, badge cleared)");
    releaseChord(M7);
  }],
  ["S35 MOMENTUM row ID: a pot-driven row resolves at the finger's expected spot", () => {
    ctx.patch[14] = 40; dm.rebuild();                        // mod pot can drive addr 40 → row is fuzzy
    const C = chordNotes(5, "major", ctx.patch);             // [60,64,67,72]
    pressChord(C, 30);
    // A) knob turn mid-swipe: rows 0 → 5. Strum row-0 strings #0..#2 (C3,E3,G3) building upward
    //    momentum, then the finger lands on #3 which now sounds F3 (row 5's chromatic layout).
    //    Coverage TIES rows 2 and 5 (both place all four notes) and pathLen would pick the WRONG
    //    row 2 (path 4 < 5) — the momentum spot decides: row 5 carries the F3 exactly at the
    //    expected position #3 (spotDist 0) where row 2 has it at #0 (spotDist 3).
    [48, 52, 55, 53].forEach(n => { dm.onNote("harp", "on", n); advance(80); });
    step("knob row 0 → 5 mid-swipe");
    [48, 52, 55, 53].forEach(n => dm.onNote("harp", "off", n)); advance(900);   // momentum expires
    // B) octaves-row double: stored row 0 and row 4 share the SAME pitch set — only the repeat
    //    reveals the row. The second C4 (two strings sounding it at once) violates row 0's
    //    single-carry multiset and triggers re-inference; row 4 wins on coverage (5 vs 4 + overplay)
    //    and the momentum spot agrees (its second C4 sits at the expected #4).
    ctx.patch[14] = 0; dm.rebuild(); ctx.patch[14] = 40; dm.rebuild();          // reset row to the dump's 0
    [48, 52, 55, 60, 60, 64].forEach(n => { dm.onNote("harp", "on", n); advance(80); });
    step("octaves double resolves the row");
    [48, 52, 55, 60, 60, 64].forEach(n => dm.onNote("harp", "off", n));
    releaseChord(C);
    ctx.patch[14] = 0; dm.rebuild();
  }],
  ["S36 DESYNC suppressed while the rhythm drives the context", () => {
    dm.setConnected(true); dm.rebuild();
    // while the rhythm playhead is locked the "held" chord-port notes are the arpeggio's own
    // voices — a strum over the running pattern must not fork the harp onto a divergent context
    // (the rhythm fusion already owns held/tint). Same Fmaj7 evidence as S34, zero adoptions.
    const F = chordNotes(6, "major", ctx.patch);
    pressChord(F, 30);
    dm.setRhythmActive(true);
    const before = lines.length;
    harpOn([53, 57, 64, 65], 12);
    advance(1200);
    const forked = lines.slice(before).some(l => /desynced/.test(l));
    lines.push(`  desync adopted during rhythm: ${forked}  (want false — the settle rival is suppressed)`);
    harpOff([53, 57, 64, 65]);
    dm.setRhythmActive(false);
    releaseChord(F);
  }],
  ["S37 HELD-COLUMN sharp: F held, # added → F# on the SAME column (sharp lit)", () => {
    // adding # while holding the chord button retriggers the sharp voicing; the
    // old gate (sharp only right after a sharp chord) made enharmonic collisions
    // relabel to the neighbor natural column. Default mode: E+# ≡ F is the trap;
    // the held column must win. Plain F→F# has no collision but pins the lit cell.
    const F = chordNotes(6, "major", ctx.patch), Fs = chordNotes(6, "major", ctx.patch, { sharp: true });
    lines.push("  input F=" + F + " F#=" + Fs);
    pressChord(F, 40); step("F held");
    Fs.forEach(n => dm.onNote("chord", "on", n)); F.forEach(n => dm.onNote("chord", "off", n)); advance(30);
    step("# added (want col F + sharp)");
    releaseChord(Fs);
    const E = chordNotes(1, "major", ctx.patch), Es = chordNotes(1, "major", ctx.patch, { sharp: true });
    lines.push("  input E=" + E + " E#=" + Es + "  (E# ≡ F natural — the collision)");
    pressChord(E, 40); step("E held");
    Es.forEach(n => dm.onNote("chord", "on", n)); E.forEach(n => dm.onNote("chord", "off", n)); advance(30);
    step("# added (want col E + sharp, NOT F natural)");
    releaseChord(Es);
  }],
  ["S38 HELD-COLUMN flat mode: F held, # added → F♭ keeps column F (never E)", () => {
    ctx.patch[31] = 1; dm.rebuild();   // sharp button subtracts: F+# = F♭ ≡ E natural
    const F = chordNotes(6, "major", ctx.patch), Fb = chordNotes(6, "major", ctx.patch, { sharp: true });
    lines.push("  input F=" + F + " Fb=" + Fb + "  (F♭ ≡ E natural — the collision)");
    pressChord(F, 40); step("F held");
    Fb.forEach(n => dm.onNote("chord", "on", n)); F.forEach(n => dm.onNote("chord", "off", n)); advance(30);
    step("# added in flat mode (want col F + sharp, NOT E)");
    releaseChord(Fb);
    ctx.patch[31] = 0; dm.rebuild();
  }],
  ["S13 disconnect clears", () => { dm.setConnected(false); step("disconnected"); }],
];

/* run all scenarios on a fresh deviceMap each time for isolation */
for (const [name, fn] of scenarios) {
  vclock += 1000; // gap between scenarios
  timers = [];    // drop any pending timers (e.g. held-note watchdogs) from the previous scenario
  ctx = { patch: {} };
  dm = DeviceMap.create({ getPatch: () => ctx.patch, getHue: () => 210 });
  lines.push("================ " + name + " ================");
  try { fn(); } catch (e) { lines.push("SCENARIO-ERR " + e.stack); }
}

lines.push("\n[devicemap VERSION] " + (DeviceMap.version || "?"));
process.stdout.write(lines.join("\n") + "\n");

/* Replay a real PLAY_DEBUG capture (log.txt) through identifyChord to SEE the rhythm detection.
 * Parses the MIDI lines, rebuilds the rhythm fingerprint loop the controller runs (burst grouping +
 * accumulating `recent` + outsider reset), and prints what identifyChord decides each burst.
 * Usage: node replay.js [logfile]   (default ../__harness__/log.txt)
 */
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const LOG = process.argv[2] || path.join(__dirname, "log.txt");
const DEVICEMAP = process.env.DM || path.join(__dirname, "..", "devicemap.js");

/* ---- DOM shim + load devicemap (PLAY_DEBUG off so its own logs stay quiet) ---- */
function makeEl() { const c = new Set(); return { className: "", style: { setProperty() {}, removeProperty() {}, display: "", animation: "" }, classList: { add() {}, remove() {}, contains() { return false; }, _classes: c }, textContent: "", title: "", type: "", innerHTML: "", offsetWidth: 0, addEventListener() {}, appendChild(x) { return x; }, nodeKids: [] }; }
const clog = [];   // capture devicemap's [Play] console lines (PLAY_DEBUG on) so we can see reinfer decisions
const sandbox = { window: { PLAY_DEBUG: true }, document: { createElement: makeEl }, console: { log: (...a) => clog.push(a.map(String).join(" ")), info() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, Date: { now: () => vclock }, Math, JSON, Set, Map, Array, Object };
let vclock = 0;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(DEVICEMAP, "utf8"), sandbox, { filename: "devicemap.js" });
const DeviceMap = sandbox.window.DeviceMap;

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const lbl = n => NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

/* ---- parse the log into MIDI events ---- */
const re = /MIDI\s+(chord|harp)\s+(ON|OFF)\s+(\d+)\s+\S+\s+\(\+(\d+)ms\)/;
const events = [];
for (const line of fs.readFileSync(LOG, "utf8").split(/\r?\n/)) {
  const m = re.exec(line);
  if (!m) continue;
  // Chrome's console collapses identical consecutive lines into one with an "N" prefix
  // ("2devicemap.js:153 …") — that hides a pitch sounding on TWO voices at once (C6/G doubles
  // G4), which is exactly the multiset evidence the engine needs. Re-expand the repeats.
  const rep = /^(\d+)\D/.exec(line);
  const times = rep ? Math.max(1, +rep[1]) : 1;
  events.push({ role: m[1], type: m[2] === "ON" ? "on" : "off", note: +m[3], dt: +m[4] });
  for (let i = 1; i < times; i++) events.push({ role: m[1], type: m[2] === "ON" ? "on" : "off", note: +m[3], dt: 0 });
}

/* ---- settings parsed from the log's "effective:" line (so the replay matches the real preset) ---- */
const eff = (fs.readFileSync(LOG, "utf8").match(/effective:.*/) || [""])[0];
const num = (re, d) => { const m = re.exec(eff); return m ? +m[1] : d; };
const patch = {};
patch[40] = num(/harpShuf=(\d+)/, 0);   // harp shuffling row
patch[35] = num(/key=(\d+)/, 0);
patch[30] = num(/transpose=(-?\d+)/, 0);
patch[34] = num(/frameShift=(\d+)/, 0);
patch[33] = num(/barry=(\d+)/, 0);
patch[98] = num(/chromatic=(\d+)/, 0);
patch[23] = +(process.env.P23 || num(/slashLevel=(\d+)/, 0));     // slash level (older logs omit it; override: P23=2 node replay.js …)
patch[120] = +(process.env.P120 || num(/chordShuf=(\d+)/, 2));    // chord voicing row — older logs omit it and replay GUESSES the
                                                                  // default 2; rhythm reads of such logs can flag false outsiders
                                                                  // (a row-4 sixth chord owns its oct1 octave voice). P120=4 to test.
process.stderr.write("settings: " + JSON.stringify(patch) + "\n");
const dm = DeviceMap.create({ getPatch: () => patch, getHue: () => 210 });
dm.setConnected(true); dm.rebuild();

/* ---- replicate the controller's fingerprint loop (soundlab createRhythmSync) ---- */
let recent = [], voices = null, outsider = 0, burst = [];
const out = [];
function fingerprint() {
  const onsets = recent.slice(-6).map(r => ({ p: r.p, vs: [], m: r.m || 1 }));   // vs:[] = bare (no live phase to derive voices)
  const v = dm.identifyChord(onsets, voices);
  if (v) voices = v;
  return v;
}
function onBurst(notes) {
  const t = vclock;
  // multiset, like the controller: a pitch played MORE times than the chord has voices carrying
  // it (C6/G doubles G4) is an outsider even though the pitch itself is known
  const cnt = new Map();
  for (const p of notes) cnt.set(p, (cnt.get(p) || 0) + 1);
  const capIn = (arr, p) => { let c = 0; for (const n of arr) if (n === p) c++; return c; };
  const fits = () => voices && [...cnt].every(([p, m]) => m <= capIn(voices.notes, p));
  let anyOutsider = false;
  if (voices) {
    anyOutsider = !fits();
    if (anyOutsider) { if (++outsider >= 2) { recent = []; voices = null; outsider = 0; anyOutsider = false; } }
    else outsider = 0;
  }
  notes.forEach(p => recent.push({ p, t, m: cnt.get(p) }));
  while (recent.length > 12) recent.shift();
  // mirror the controller (createRhythmSync.onBurst): identify when there's no fingerprint yet, when
  // no burst note maps to a current voice (mask 0), or when an OUTSIDER arrived — a chord change can
  // share voices with the old chord (D6→D7 keep root/3rd/5th), so waiting for a clean mask=0 never fires
  let ran = false;
  if (!voices) { fingerprint(); ran = true; }
  else if (anyOutsider || !notes.some(p => voices.notes.includes(p))) {
    // outsiders are judged against the OLD chord — once the updated guess places the whole burst,
    // the streak is over (mirrors the controller)
    if (fingerprint() && fits()) outsider = 0;
    ran = true;
  }
  const v = voices;
  const chord = v ? `${["B","E","A","D","G","C","F"][v.button]}${({major:"",minor:"m",seventh:"7",maj_seventh:"maj7",min_seventh:"m7",dim:"dim",aug:"aug",maj_sixth:"6",min_sixth:"m6",full_dim:"°7"})[v.type]}${v.slashButton!=null?"/"+["B","E","A","D","G","C","F"][v.slashButton]:""}` : "—";
  out.push(`burst {${notes.map(lbl).join(",")}}  ->  ${chord}${ran ? "" : "  (held)"}`);
}

/* feed events; group chord-ONs into bursts (a note >40ms after the previous flushes the burst) */
let lastOnT = -1e9;
for (const e of events) {
  vclock += e.dt;
  if (e.role === "harp") { dm.onNote("harp", e.type, e.note); continue; }
  dm.onNote("chord", e.type, e.note);            // feed the live mirror too (keeps held/dropped realistic)
  if (e.type === "on") {
    if (vclock - lastOnT > 40 && burst.length) { onBurst(burst); burst = []; }
    burst.push(e.note); lastOnT = vclock;
  }
}
if (burst.length) onBurst(burst);

const harpLines = clog.filter(l => /harp ctx|harp settle|-> string#/.test(l));
process.stdout.write(
  (out.length ? "RHYTHM bursts:\n" + out.join("\n") + "\n\n" : "") +
  (harpLines.length ? "HARP (reinfer decisions + string lights):\n" + harpLines.join("\n") + "\n\n" : "") +
  "version: " + DeviceMap.version + "\n");

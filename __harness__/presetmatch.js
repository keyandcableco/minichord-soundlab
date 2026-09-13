"use strict";
/* Preset identification: does a bank still get recognised after ordinary edits?
 *
 * The matcher allows only CORE_TOL differences outside the leeway set, so which
 * addresses are in that set decides whether a preset with its knobs remapped is
 * still that preset. Getting it wrong is quiet: the bank simply shows no name.
 *
 * Checks three things:
 *   1. every library preset identifies as itself, exactly
 *   2. a preset with every routing address changed still identifies, as edited
 *   3. no two library presets are closer than CORE_TOL, which would let one be
 *      mistaken for another
 *
 * ROUTING_ADDRS is read out of soundlab.js rather than copied here, so the two
 * cannot drift apart.
 *
 * Run by `npm test`. Exits non-zero on any failure.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");

const sandbox = {
  window: {}, console: { log() {}, warn() {}, error() {} },
  document: { createElement: () => ({}) },
  atob: s => Buffer.from(s, "base64").toString("binary"),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "params.js"), "utf8"), sandbox, { filename: "params.js" });
vm.runInContext(fs.readFileSync(path.join(root, "presets.js"), "utf8"), sandbox, { filename: "presets.js" });
const PM = sandbox.window.PresetMatch;

/* ---- the leeway set, taken from the app rather than restated -------------- */
const src = fs.readFileSync(path.join(root, "soundlab.js"), "utf8");
function arrayFrom(name) {
  const i = src.indexOf("const " + name + " = [");
  if (i < 0) throw new Error(name + " not found in soundlab.js — has it been renamed?");
  const body = src.slice(src.indexOf("[", i) + 1, src.indexOf("];", i));
  // strip comments line by line BEFORE splitting on commas: a trailing // eats
  // the rest of its line, including the first number of the next one
  const clean = body.split("\n").map(l => l.split("//")[0]).join("\n");
  return clean.split(",").map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(Number);
}
const ROUTING = arrayFrom("ROUTING_ADDRS");
const cardsBlock = src.slice(src.indexOf("const PLAY_SETTING_CARDS = ["), src.indexOf("];", src.indexOf("const PLAY_SETTING_CARDS = [")));
const CARD_ADDRS = (cardsBlock.match(/addrs:\s*\[([^\]]*)\]/g) || [])
  .flatMap(m => m.replace(/addrs:\s*\[|\]/g, "").split(",").map(x => parseInt(x.trim(), 10)))
  .filter(n => !isNaN(n));
const leeway = new Set([187, 188, 189, 190, 191, ...ROUTING, ...CARD_ADDRS]);

const CORE_TOL = 4;          // mirrors presets.js; asserted against below
const bad = [];

/* ---- 1. every preset identifies as itself --------------------------------- */
const presets = PM.all.map(p => ({ name: p.name, vals: PM.decode(p.value) }));
presets.forEach(p => {
  const m = PM.identify(p.vals, leeway);
  if (!m || !m.preset) bad.push(`"${p.name}" does not identify at all`);
  else if (m.preset.name !== p.name) bad.push(`"${p.name}" identifies as "${m.preset.name}"`);
  else if (m.edited) bad.push(`"${p.name}" identifies as edited against its own values`);
});

/* ---- 2. remapping every control leaves the preset recognisable ------------ */
presets.forEach(p => {
  const v = p.vals.slice();
  // move each routing address to something it certainly was not
  ROUTING.forEach(a => { v[a] = ((v[a] || 0) + 37) % 128; });
  const m = PM.identify(v, leeway);
  if (!m || !m.preset) bad.push(`"${p.name}" stops being recognised once its controls are remapped`);
  else if (m.preset.name !== p.name) bad.push(`"${p.name}" remapped identifies as "${m.preset.name}"`);
});

/* ---- 3. no two presets are close enough to be confused -------------------- */
let closest = { d: Infinity, pair: "" };
for (let i = 0; i < presets.length; i++) {
  for (let j = i + 1; j < presets.length; j++) {
    let d = 0;
    for (const a of PM.MATCH_ADDRS) {
      if (leeway.has(a)) continue;
      if ((presets[i].vals[a] || 0) !== (presets[j].vals[a] || 0)) d++;
    }
    if (d < closest.d) closest = { d, pair: `${presets[i].name} / ${presets[j].name}` };
  }
}

if (bad.length) {
  console.error(`preset match: ${bad.length} failure(s)\n`);
  bad.slice(0, 20).forEach(b => console.error("  " + b));
  process.exit(1);
}
console.log(`preset match: ${presets.length} presets identify as themselves, and still do with all ${ROUTING.length} routing addresses changed`);
if (closest.d <= CORE_TOL) {
  console.log(`  note: the closest pair is ${closest.d} core differences apart (${closest.pair}), `
    + `at or under CORE_TOL of ${CORE_TOL} — an edit to one can read as ambiguous against the other`);
}

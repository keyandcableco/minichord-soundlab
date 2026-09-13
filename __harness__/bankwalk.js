"use strict";
/* Drives the real readBank against a simulated minichord, to answer one
 * question: can a twelve-bank walk return the wrong bank's data?
 *
 * The simulation mirrors what the firmware actually does:
 *   - loadBank(b)          -> switches bank, then reports a dump on its own,
 *                             because load_config ends with control_command(0,0)
 *   - requestCurrentData() -> reports a dump of whatever bank is current
 * Both after a latency, which is the only thing varied.
 *
 * Run:  node __harness__/bankwalk.js
 */
const fs = require("fs"), vm = require("vm"), path = require("path");

/* ---- a clock we control -------------------------------------------------- */
let clock = 0, seq = 0, timers = [];
const setT = (fn, ms) => { const t = { fn, due: clock + (ms || 0), seq: seq++, dead: false }; timers.push(t); return t; };
const clrT = t => { if (t) t.dead = true; };
function run(untilMs) {
  const stop = clock + untilMs;
  let guard = 0;
  for (;;) {
    if (++guard > 20000) throw new Error("timer loop did not settle");
    let next = null;
    for (const t of timers) if (!t.dead && t.due <= stop && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
    if (!next) break;
    clock = next.due; next.dead = true;
    try { next.fn(); } catch (e) { console.error("timer threw:", e.message); }
  }
  clock = stop;
  timers = timers.filter(t => !t.dead);
}

/* ---- load the real controller ------------------------------------------- */
const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} },
                  setTimeout: setT, clearTimeout: clrT, navigator: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "minichordcontroller.js"), "utf8"),
                sandbox, { filename: "minichordcontroller.js" });
const Controller = sandbox.window.MiniChordController;

/* ---- the simulated device ------------------------------------------------ */
const SIZE = 256;
function makeDevice(ctrl, { loadLatency, reqLatency }) {
  let current = 0;
  // each bank holds a value that identifies it, so a mis-read is unmistakable
  const banks = Array.from({ length: 12 }, (_, b) =>
    Array.from({ length: SIZE }, (_, a) => (a === 1 ? b : (a === 0 ? 0 : 1000 + b))));
  // address 7 is the firmware version and is checked, so keep it plausible
  banks.forEach(bk => { bk[7] = 200; });

  const emit = bank => {
    const d = [0xF0];
    for (let a = 0; a < SIZE; a++) { const v = banks[bank][a]; d.push(v % 128, Math.floor(v / 128)); }
    d.push(0xF7);
    ctrl.routeMessage("chord", { data: d });
  };
  return {
    banks,
    send(bytes) {
      // A command and a parameter write share the same six-byte shape; only
      // address 0 (bytes 1 and 2) marks a command. Parameter writes are stored,
      // as the device would, and answered by nothing.
      if (bytes[1] !== 0 || bytes[2] !== 0) {
        const addr = bytes[1] + bytes[2] * 128;
        banks[current][addr] = bytes[3] + bytes[4] * 128;
        return;
      }
      const cmd = bytes[3];
      if (cmd === 4) { current = bytes[4]; setT(() => emit(current), loadLatency); }   // loadBank
      else if (cmd === 0) { const b = current; setT(() => emit(b), reqLatency); }      // requestCurrentData
    },
  };
}

/* ---- walk the banks the way readAllBanks does ---------------------------- */
async function walk(opts) {
  const ctrl = new Controller();
  ctrl.device = makeDevice(ctrl, opts);
  const got = [];
  for (let b = 0; b < 12; b++) {
    let done = null;
    ctrl.readBank(b, 3000, true).then(
      vals => { done = { asked: b, returned: vals && vals[10] != null ? vals[10] - 1000 : null }; },
      () => { done = { asked: b, returned: "timeout" }; });
    // Step the clock finely and stop the moment the read settles. Coarse slices
    // would drain every pending dump before the next read begins, which is
    // exactly the race being tested: the previous read's second dump is still in
    // flight when the next read installs its handler.
    for (let t = 0; t < 1200 && !done; t++) { run(5); await null; }
    got.push(done || { asked: b, returned: "never settled" });
  }
  return got;
}

(async () => {
  const scenarios = [
    { name: "device answers promptly",        loadLatency: 20,  reqLatency: 20 },
    { name: "flash read is slow",             loadLatency: 300, reqLatency: 20 },
    { name: "slow, and the request lags too", loadLatency: 300, reqLatency: 200 },
    { name: "very slow flash",                loadLatency: 950, reqLatency: 40 },
  ];
  let anyWrong = false;
  for (const sc of scenarios) {
    clock = 0; timers = [];
    const got = await walk(sc);
    const wrong = got.filter(g => g.returned !== g.asked);
    const dupes = {};
    got.forEach(g => { dupes[g.returned] = (dupes[g.returned] || 0) + 1; });
    const collapsed = Object.entries(dupes).filter(([, n]) => n > 1);
    console.log(`\n${sc.name}  (load ${sc.loadLatency}ms, request ${sc.reqLatency}ms)`);
    console.log("  asked   : " + got.map(g => String(g.asked).padStart(2)).join(" "));
    console.log("  returned: " + got.map(g => String(g.returned).padStart(2)).join(" "));
    if (!wrong.length) console.log("  -> every read returned the bank it asked for");
    else {
      anyWrong = true;
      console.log(`  -> ${wrong.length} of 12 reads returned the WRONG bank`);
      collapsed.forEach(([bank, n]) => console.log(`     bank ${bank} returned ${n} times — ${n} slots would hold it`));
    }
  }
  if (anyWrong) {
    console.error("\nFAIL: a bank walk returned the wrong bank's data.");
    process.exit(1);
  }
  console.log("\nbank walk: 48 reads across 4 timing profiles, each returned the bank it asked for");
})();

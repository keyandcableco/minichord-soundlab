/* ============================================================================
 * triggers.js: user-defined triggers engine (WHEN event → DO action)
 *
 * Pure data + matching, no DOM. soundlab.js injects the action executor and
 * feeds events in (chord/pluck from the device mirror, steps from the rhythm
 * playhead, keyboard via hotkeys.js's dynamic table); the ⚡ arm toggle on the
 * Play screen gates ALL firing and always starts OFF on page load.
 *
 * Trigger shape (pref "triggers", overrides-free, the list IS the data):
 *   { id, on, doPick?, limit?,
 *     when: [event, …]   : ANY event fires the trigger (OR). Events:
 *           {kind:"key", combo} | {kind:"chord", col, type, sharp, strength, slashCol?}
 *         | {kind:"pluck", string} | {kind:"steps", every, altOn?, altOff?}
 *         | {kind:"seconds", every, altOn?, altOff?},
 *     do:   [action, …]  : ALL actions run on fire, in order. Actions:
 *           {kind:"set", addr, value} | {kind:"preset", name}
 *   (bare when/do objects from earlier shapes are migrated to 1-lists)     }
 *
 * Extras: doPick "one" runs a single random action per fire instead of all;
 * limit N auto-disables the trigger after its Nth fire (re-enabling resets);
 * chord slashCol pins the WHEN to an exact slash bass (undefined = any,
 * null = explicitly plain); timer altOn/altOff fire y consecutive intervals
 * then rest x ("16 ticks on, 16 ticks off").
 *
 * Semantics: chord events fire on shape ENTER only. The edge is on the OR of
 * a trigger's chord events, so leaving every matching shape re-arms it;
 * plucks fire per note-on; steps count playhead advances (frozen while the
 * head is dark); seconds count from arming. Every fire passes a per-ACTION
 * cooldown so a strummed chord can't machine-gun preset loads.
 * ========================================================================== */

window.Triggers = (function () {
  "use strict";

  const COOL = { set: 150, preset: 800 };   // min refire interval (ms) by action kind

  const CHORD_TYPES = ["major", "minor", "seventh", "maj_seventh", "min_seventh", "dim", "aug"];
  // timer alternation: fire altOn consecutive intervals, rest altOff (both opt.)
  const altOk = w => (w.altOn === undefined || (Number.isInteger(w.altOn) && w.altOn >= 1 && w.altOn <= 999))
                  && (w.altOff === undefined || (Number.isInteger(w.altOff) && w.altOff >= 1 && w.altOff <= 999));
  const WHEN_OK = {
    key: w => typeof w.combo === "string" && !!w.combo,
    chord: w => Number.isInteger(w.col) && w.col >= 0 && w.col <= 6
             && CHORD_TYPES.includes(w.type) && typeof w.sharp === "boolean"
             && (w.strength === "strong" || w.strength === "any")
             // undefined = any slash, null = explicitly plain, 0-6 = that bass column
             && (w.slashCol === undefined || w.slashCol === null
                 || (Number.isInteger(w.slashCol) && w.slashCol >= 0 && w.slashCol <= 6)),
    pluck: w => Number.isInteger(w.string) && w.string >= 0 && w.string <= 11,
    steps: w => Number.isInteger(w.every) && w.every >= 1 && w.every <= 3600
             && (w.once === undefined || typeof w.once === "boolean") && altOk(w),
    seconds: w => Number.isInteger(w.every) && w.every >= 1 && w.every <= 3600
             && (w.once === undefined || typeof w.once === "boolean") && altOk(w),
  };
  const DO_OK = {
    // mode "fix" (default) jumps to `value`; mode "inc" steps by `by` (abs
    // units or % of the range) with an edge policy: clamp / wrap / bounce;
    // mode "alt" flips between `a` and `b` each fire; mode "rand" rolls a
    // fresh in-range value each fire. Optional lo/hi confine inc travel or
    // the rand range to a sub-range.
    set: d => Number.isInteger(d.addr) && (d.mode === "inc"
      ? (typeof d.by === "number" && isFinite(d.by) && d.by !== 0
         && (d.unit === "abs" || d.unit === "pct")
         && ["clamp", "wrap", "bounce"].includes(d.edge)
         && (d.lo === undefined || (typeof d.lo === "number" && isFinite(d.lo)))
         && (d.hi === undefined || (typeof d.hi === "number" && isFinite(d.hi))))
      : d.mode === "alt"
      ? (typeof d.a === "number" && isFinite(d.a) && typeof d.b === "number" && isFinite(d.b))
      : d.mode === "rand"
      ? ((d.lo === undefined || (typeof d.lo === "number" && isFinite(d.lo)))
         && (d.hi === undefined || (typeof d.hi === "number" && isFinite(d.hi))))
      : (typeof d.value === "number" && isFinite(d.value))),
    // single `name` (legacy) or a `names` list: one loads every fire; several
    // cycle in order per fire (pick "walk", default) or roll one ("rand")
    preset: d => ((typeof d.name === "string" && !!d.name)
      || (Array.isArray(d.names) && d.names.length > 0 && d.names.every(n => typeof n === "string" && !!n)))
      && (d.pick === undefined || d.pick === "walk" || d.pick === "rand"),
  };
  const evOk = w => !!(w && WHEN_OK[w.kind] && WHEN_OK[w.kind](w));
  const actOk = d => !!(d && DO_OK[d.kind] && DO_OK[d.kind](d));
  const listOk = (v, ok) => Array.isArray(v) ? (v.length > 0 && v.every(ok)) : ok(v);
  const valid = t => !!(t && t.when && t.do) && listOk(t.when, evOk) && listOk(t.do, actOk)
    && (t.doPick === undefined || t.doPick === "all" || t.doPick === "one")
    && (t.limit === undefined || (Number.isInteger(t.limit) && t.limit >= 1 && t.limit <= 9999));

  // malformed entries are SKIPPED, not deleted: same forgiveness as pins.
  // earlier shapes stored single when/do objects; normalise both to LISTS.
  function load() {
    return (Prefs.get("triggers") || []).filter(valid)
      .map(t => Object.assign({}, t, {
        when: Array.isArray(t.when) ? t.when : [t.when],
        do: Array.isArray(t.do) ? t.do : [t.do],
      }));
  }

  let list = load();
  let armed = false;          // memory-only: every page load starts disarmed
  let suspended = false;      // editor open: capture gestures must not fire siblings
  let runAction = null;       // injected: (doSpec, trigger) => bool (true = applied)

  const fireSubs = new Set(), armSubs = new Set(), changeSubs = new Set();
  let capturePending = null, captureProgressCb = null;   // chord capture accumulator
  const inShape = new Map();   // trigger id -> currently inside its chord shape
  const lastFire = new Map();  // trigger id -> last fire time (cooldown)
  const stepCount = new Map(), secCount = new Map();
  const doneOnce = new Set();  // "id:i" of once-timers that already fired (resets on arm)
  const altPos = new Map();    // "id:i" -> position in the timer's fire/rest cycle
  const fireCount = new Map(); // trigger id -> fires since enabled (for `limit`)
  let captureCb = null, captureKind = null;
  let secTimer = null;
  const limitSubs = new Set();

  function fire(t) {
    if (!armed || suspended || !t.on || !runAction) return;
    const now = Date.now();
    const cool = t.do.some(a => a.kind === "preset") ? COOL.preset : COOL.set;
    if (now - (lastFire.get(t.id) || 0) < cool) return;
    lastFire.set(t.id, now);
    // doPick "one": a single randomly-chosen action instead of the whole list
    const acts = t.doPick === "one" && t.do.length > 1
      ? [t.do[Math.floor(Math.random() * t.do.length)]]
      : t.do;
    let any = false;
    acts.forEach(a => { if (runAction(a, t)) any = true; });   // actions run in order
    if (any) fireSubs.forEach(fn => fn(t));
    if (t.limit) {   // stop-after-x: the xth fire turns the trigger off (pill re-enables + resets)
      const n = (fireCount.get(t.id) || 0) + 1;
      fireCount.set(t.id, n);
      if (n >= t.limit) { setEnabled(t.id, false); limitSubs.forEach(fn => fn(t)); }
    }
  }

  // remaining fires before the limit disables this trigger (null = no limit)
  function firesLeft(id) {
    const t = list.find(x => x.id === id);
    if (!t || !t.limit) return null;
    return Math.max(0, t.limit - (fireCount.get(id) || 0));
  }

  /* ---- event feeds ---------------------------------------------------------
   * Each feed first offers the event to an active capture (the editor's
   * "play it now" flow), which consumes it. The captured gesture never fires
   * existing triggers. Chord events arrive on context CHANGES only (the
   * mirror debounces), ev = {col, type, sharp, strength} or null on release. */
  function feedChord(ev) {
    if (captureCb && captureKind === "chord") {
      // chord capture ACCUMULATES: combo presses arrive as a series of shapes
      // (major, then maj_seventh…), so keep the latest and let the editor
      // confirm it (button or settle timer) instead of taking the first one.
      // A release/deselect (ev = null) KEEPS the pending shape (deselecting
      // notes must never cancel what's been built) and is reported as null
      // so the editor can restart its settle timer instead of locking in.
      if (ev) capturePending = { col: ev.col, type: ev.type, sharp: !!ev.sharp,
        slashCol: ev.slashCol == null ? null : ev.slashCol };
      if (captureProgressCb) captureProgressCb(ev ? capturePending : null);
      return;
    }
    list.forEach(t => {
      const evs = t.when.filter(w => w.kind === "chord");
      if (!evs.length) return;
      // edge on the OR: inside while ANY chord event matches the current shape.
      // slashCol: undefined = match any slash (pre-slash saves keep working),
      // null = explicitly plain, 0-6 = exactly that bass column
      const m = !!ev && evs.some(w => ev.col === w.col && ev.type === w.type
        && !!ev.sharp === !!w.sharp && (w.strength === "any" || ev.strength === "strong")
        && (w.slashCol === undefined
            || (w.slashCol == null ? ev.slashCol == null : w.slashCol === ev.slashCol)));
      const was = inShape.get(t.id) || false;
      inShape.set(t.id, m);
      if (m && !was) fire(t);   // rising edge only
    });
  }

  function feedPluck(strings) {
    if (captureCb && captureKind === "pluck" && strings && strings.length) {
      const cb = takeCapture();
      cb(strings[0]);
      return;
    }
    if (!armed) return;
    list.forEach(t => {
      if (t.when.some(w => w.kind === "pluck" && strings.indexOf(w.string) >= 0)) fire(t);
    });
  }

  // timer counters are keyed per (trigger, event index): a trigger may carry
  // several timers ("every 4 steps OR every 60 seconds")

  // alternation gate: fire altOn consecutive intervals, rest altOff, repeat.
  // Advances the cycle every completed interval; true = this one fires.
  function altGate(w, key) {
    if (w.altOn === undefined && w.altOff === undefined) return true;
    const y = Math.max(1, w.altOn || 1), x = Math.max(1, w.altOff || 1);
    const pos = altPos.get(key) || 0;
    altPos.set(key, (pos + 1) % (y + x));
    return pos < y;
  }
  // is the CURRENT interval a resting one? (read-only, for the countdown pill)
  function altResting(w, key) {
    if (w.altOn === undefined && w.altOff === undefined) return false;
    const y = Math.max(1, w.altOn || 1);
    return (altPos.get(key) || 0) >= y;
  }

  function feedStep(s) {
    if (s < 0) return;   // playhead dark/paused: counters hold
    list.forEach(t => t.when.forEach((w, i) => {
      if (w.kind !== "steps") return;
      const key = t.id + ":" + i;
      if (doneOnce.has(key)) return;   // a once-timer that already fired waits for re-arm
      const n = (stepCount.get(key) || 0) + 1;
      if (n >= w.every) { if (w.once) doneOnce.add(key); stepCount.set(key, 0); if (altGate(w, key)) fire(t); }
      else stepCount.set(key, n);
    }));
  }

  function tickSeconds() {
    list.forEach(t => t.when.forEach((w, i) => {
      if (w.kind !== "seconds") return;
      const key = t.id + ":" + i;
      if (doneOnce.has(key)) return;
      const n = (secCount.get(key) || 0) + 1;
      if (n >= w.every) { if (w.once) doneOnce.add(key); secCount.set(key, 0); if (altGate(w, key)) fire(t); }
      else secCount.set(key, n);
    }));
  }
  function syncSecTimer() {
    const want = armed && list.some(t => t.on && t.when.some(w => w.kind === "seconds"));
    if (want && !secTimer) secTimer = setInterval(tickSeconds, 1000);
    else if (!want && secTimer) { clearInterval(secTimer); secTimer = null; }
  }

  /* ---- keyboard: published into hotkeys.js's dynamic table -----------------
   * Disarmed → empty table, so trigger keys aren't even preventDefault'ed.
   * The nav registry is consulted first in dispatch: nav always wins.      */
  function syncKeys() {
    if (!window.Hotkeys || !window.Hotkeys.setDynamic) return;
    const dyn = [];
    if (armed) list.forEach(t => {
      if (!t.on) return;
      t.when.forEach(w => { if (w.kind === "key" && w.combo) dyn.push({ combo: w.combo, run: () => fire(t) }); });
    });
    window.Hotkeys.setDynamic(dyn);
  }

  /* ---- arming --------------------------------------------------------------
   * Arming resets every counter and edge so behaviour is deterministic from
   * the moment of the toggle ("every 16 steps" means 16 steps from now).    */
  function setArmed(on) {
    armed = !!on;
    inShape.clear(); lastFire.clear(); stepCount.clear(); secCount.clear(); doneOnce.clear(); altPos.clear();
    syncKeys();
    syncSecTimer();
    armSubs.forEach(fn => fn(armed));
  }

  function setSuspended(v) { suspended = !!v; }

  // live countdown info for the UI: one entry per timer EVENT on enabled triggers
  function timerInfo() {
    const out = [];
    list.forEach(t => t.when.forEach((w, i) => {
      if ((w.kind !== "steps" && w.kind !== "seconds") || !t.on) return;
      const key = t.id + ":" + i;
      out.push({
        id: t.id, kind: w.kind, every: w.every, once: !!w.once,
        done: doneOnce.has(key),
        resting: altResting(w, key),   // alternation: this interval completes but won't fire
        left: w.every - ((w.kind === "steps" ? stepCount : secCount).get(key) || 0),
      });
    }));
    return out;
  }

  /* ---- store (the pref is the source of truth; always write fresh arrays) */
  function reload() {
    list = load();
    doneOnce.clear(); stepCount.clear(); secCount.clear(); altPos.clear();   // event indices may have shifted
    syncKeys();
    syncSecTimer();
    changeSubs.forEach(fn => fn());
  }
  function save(next) { Prefs.set("triggers", next); }   // subscribe() below reloads us

  function newId() { return "t-" + Math.random().toString(36).slice(2, 8); }
  function add(entry) {
    const t = Object.assign({ id: newId(), on: true }, entry);
    if (!valid(t)) return null;
    save((Prefs.get("triggers") || []).concat([t]));
    return t.id;
  }
  function update(id, patch) {
    const raw = Prefs.get("triggers") || [];
    const next = raw.map(t => {
      if (!t || t.id !== id) return t;
      const merged = Object.assign({}, t, patch);
      return valid(merged) ? merged : t;   // refuse updates that would corrupt the entry
    });
    save(next);
  }
  function remove(id) { save((Prefs.get("triggers") || []).filter(t => !t || t.id !== id)); }
  function setEnabled(id, on) {
    if (on) fireCount.delete(id);   // re-enabling restarts the stop-after-x countdown
    update(id, { on: !!on });
  }

  // bulk import (the sheet's Import… button): validate each entry, normalise
  // when/do to lists, and ALWAYS mint fresh ids: imported files may collide
  // with existing triggers (or contain the same file twice). Returns the count.
  function importTriggers(arr) {
    const good = (Array.isArray(arr) ? arr : []).filter(valid).map(t => Object.assign({}, t, {
      id: newId(),
      on: typeof t.on === "boolean" ? t.on : true,
      when: Array.isArray(t.when) ? t.when : [t.when],
      do: Array.isArray(t.do) ? t.do : [t.do],
    }));
    if (good.length) save((Prefs.get("triggers") || []).concat(good));
    return good.length;
  }

  /* ---- capture ("play/pluck it now" in the editor) -------------------------
   * pluck capture takes the first note; chord capture keeps the LATEST shape
   * in capturePending (combos build up) until confirmCapture() locks it in. */
  function takeCapture() {
    const cb = captureCb;
    captureCb = null; captureKind = null; capturePending = null; captureProgressCb = null;
    return cb;
  }
  function captureNext(kind, cb, onProgress) {
    captureCb = cb; captureKind = kind;
    capturePending = null; captureProgressCb = onProgress || null;
  }
  function cancelCapture() { captureCb = null; captureKind = null; capturePending = null; captureProgressCb = null; }
  function confirmCapture() {
    if (!captureCb || !capturePending) return false;
    const pending = capturePending;
    const cb = takeCapture();
    cb(pending);
    return true;
  }
  function isCapturing() { return !!captureCb; }

  Prefs.subscribe("triggers", reload);

  return {
    init: opts => { runAction = (opts && opts.runAction) || null; },
    list: () => list.map(t => JSON.parse(JSON.stringify(t))),
    add, update, remove, setEnabled, importTriggers,
    setArmed, isArmed: () => armed,
    activeCount: () => list.filter(t => t.on).length,
    timerInfo, firesLeft,
    onLimit: fn => { limitSubs.add(fn); return () => limitSubs.delete(fn); },
    onArmChange: fn => { armSubs.add(fn); return () => armSubs.delete(fn); },
    onFire: fn => { fireSubs.add(fn); return () => fireSubs.delete(fn); },
    onChange: fn => { changeSubs.add(fn); return () => changeSubs.delete(fn); },
    feedChord, feedPluck, feedStep,
    captureNext, cancelCapture, confirmCapture, isCapturing,
    setSuspended,
    CHORD_TYPES,
  };
})();

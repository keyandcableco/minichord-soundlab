/* ============================================================================
 * prefs.js: tiny persistent preferences store (localStorage)
 *
 * One versioned key holds a single JSON blob, validated field-by-field against
 * SCHEMA on load (unknown/invalid fields fall back to their default, so a
 * future schema change can just bump the key suffix). Storage access can throw
 * (file://, privacy modes). Every touch is guarded and the in-memory copy
 * keeps working for the session.
 * ========================================================================== */

window.Prefs = (function () {
  "use strict";

  const KEY = "minichord.soundlab.prefs.v1";

  const SCHEMA = {
    theme:     { def: "dark",    ok: v => ["dark", "light", "auto"].includes(v) },   // auto = follow the OS scheme
    density:   { def: "compact", ok: v => v === "compact" || v === "verbose" },
    glossary:  { def: true,      ok: v => typeof v === "boolean" },
    startView: { def: "play",    ok: v => ["play", "customize", "last"].includes(v) },
    bankAccent: { def: "play",   ok: v => ["none", "play", "all"].includes(v) },
    accentHue: { def: 245,       ok: v => Number.isFinite(v) && v >= 0 && v <= 360 },
    potWarnings: { def: true,    ok: v => typeof v === "boolean" },
    welcome:   { def: true,      ok: v => typeof v === "boolean" },
    lastView:  { def: "play",    ok: v => typeof v === "string" },
    pins:      { def: [],        ok: v => Array.isArray(v) && v.every(Number.isInteger) },
    locks:     { def: [],        ok: v => Array.isArray(v) && v.every(Number.isInteger) },   // addrs shielded from randomize
    rhythmLock: { def: true,     ok: v => typeof v === "boolean" },   // ONE lock for the whole rhythm section (pattern + settings), on by default
    deviceCollapsed: { def: false, ok: v => typeof v === "boolean" },   // hide the left (device/presets/profile) panel to give the other columns room
    randomStyle: { def: "safe",  ok: v => v === "safe" || v === "true" },   // safe = preset-weighted rolls, true = uniform full-range
    /* accessibility (the ♿ popup): defaults reproduce the standard rendering */
    textScale: { def: "m",       ok: v => ["s", "m", "l", "xl"].includes(v) },
    motion:    { def: "auto",    ok: v => ["auto", "on", "off"].includes(v) },
    contrast:  { def: "normal",  ok: v => v === "normal" || v === "high" },
    bigControls: { def: false,   ok: v => typeof v === "boolean" },
    /* hotkey OVERRIDES only ({actionId: combo}, "" = disabled): defaults live
       in the hotkeys.js registry, so new actions need no schema change */
    hotkeys:   { def: {},        ok: v => !!v && typeof v === "object" && !Array.isArray(v)
                                       && Object.values(v).every(x => typeof x === "string") },
    /* user-defined triggers (WHEN events → DO actions). Shallow shape check
       here; triggers.js validates each entry deeply, skips bad ones and
       migrates earlier single-object when/do forms to lists */
    triggers:  { def: [],        ok: v => {
                                   const part = x => !!x && (typeof x.kind === "string"
                                     || (Array.isArray(x) && x.length > 0 && x.every(e => !!e && typeof e.kind === "string")));
                                   return Array.isArray(v) && v.every(t => !!t && typeof t === "object"
                                     && typeof t.id === "string" && typeof t.on === "boolean"
                                     && part(t.when) && part(t.do));
                                 } },
  };

  const subs = {};   // key -> Set<fn>

  function defaults() {
    const out = {};
    Object.keys(SCHEMA).forEach(k => { out[k] = SCHEMA[k].def; });
    return out;
  }

  function load() {
    const out = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const blob = JSON.parse(raw);
        Object.keys(SCHEMA).forEach(k => {
          if (k in blob && SCHEMA[k].ok(blob[k])) out[k] = blob[k];
        });
      }
    } catch (e) { /* unreadable storage, defaults win */ }
    return out;
  }

  const state = load();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* unwritable storage, keep the in-memory copy */ }
  }

  function get(key) { return state[key]; }

  function set(key, value) {
    if (!(key in SCHEMA) || !SCHEMA[key].ok(value)) return false;
    if (state[key] === value && !Array.isArray(value)) return true;   // arrays always notify (contents may differ)
    state[key] = Array.isArray(value) ? value.slice() : value;
    save();
    (subs[key] || []).forEach(fn => fn(state[key]));
    return true;
  }

  function subscribe(key, fn) {
    (subs[key] = subs[key] || new Set()).add(fn);
    return () => subs[key].delete(fn);
  }

  return { get, set, subscribe, SCHEMA };
})();

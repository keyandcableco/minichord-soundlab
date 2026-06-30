/* ============================================================================
 * hotkeys.js: customizable keyboard shortcuts (engine only, no UI)
 *
 * soundlab.js registers the actions (id, group, label, default combo, run;
 * their handlers are closures inside its module) and builds the ⌨ editor on
 * top of this API. Bindings persist in the "hotkeys" pref as OVERRIDES only
 * ({actionId: combo}, "" = disabled), so defaults can evolve without touching
 * the schema. Dispatch is one document-level keydown, guarded while the user
 * is typing, while the welcome modal owns the keyboard, while a rebind
 * capture is in progress, or while suspended (the cheat-sheet overlay).
 * ========================================================================== */

window.Hotkeys = (function () {
  "use strict";

  const registry = [];           // [{id, group, label, def, run}] in display order
  let byCombo = {};              // serialized combo -> action
  let dynByCombo = {};           // combo -> run, for trigger-owned keys (triggers.js)
  let captureCb = null;          // active rebind capture callback, or null
  let suspended = false;         // cheat-sheet open: it handles its own keys
  let navSuspended = false;      // triggers armed: nav keys pause, trigger keys keep firing
  const changeSubs = new Set();  // editor refresh hooks, fired on any rebuild

  // never bindable, never dispatched: Escape closes things app-wide, the rest
  // drive native control behaviour (buttons, sliders, lists, focus order)
  const RESERVED = ["Escape", "Enter", "Tab", "Space",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

  /* serialize a keydown into a stable combo string ("Ctrl+Shift+K"). Shifted
   * punctuation keeps the PRODUCED character ("?", "{", "+") with no Shift
   * mod: the char is what the layout yields, so matching on it works on any
   * layout. Letters stay explicit ("Shift+S"). AltGr (Ctrl+Alt on Windows)
   * yielding a printable char also serializes as the bare char.             */
  function serialize(e) {
    let key = e.key;
    if (key === " ") key = "Space";
    const printable = key.length === 1;
    const altGr = e.ctrlKey && e.altKey && printable;
    const mods = [];
    if (e.ctrlKey && !altGr) mods.push("Ctrl");
    if (e.altKey && !altGr) mods.push("Alt");
    if (printable && /[a-z]/i.test(key)) { key = key.toUpperCase(); if (e.shiftKey) mods.push("Shift"); }
    else if (!printable && e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    return mods.concat(key).join("+");
  }

  // the action's live combo: its pref override if present, else its default
  function bindingFor(id) {
    const overrides = Prefs.get("hotkeys") || {};
    const act = registry.find(a => a.id === id);
    if (!act) return "";
    return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : act.def;
  }

  function rebuild() {
    byCombo = {};
    registry.forEach(a => {
      const combo = bindingFor(a.id);
      if (combo) byCombo[combo] = a;
    });
    changeSubs.forEach(fn => fn());
  }

  function register(actions) {
    actions.forEach(a => registry.push(a));
    rebuild();
  }

  // snapshot for UI: [{id, group, label, def, combo}]
  function actions() {
    return registry.map(a => ({ id: a.id, group: a.group, label: a.label, def: a.def, combo: bindingFor(a.id) }));
  }

  /* set (or clear, combo === "") one binding. Conflicts are REJECTED, not
   * stolen: returns {ok:false, conflict} so the editor can name the holder.
   * The pref is always written as a FRESH object: Prefs.set skips writes when
   * the value is identical by reference.                                    */
  function setBinding(id, combo) {
    if (combo) {
      if (RESERVED.includes(combo.split("+").pop())) return { ok: false, reason: "reserved" };
      const holder = registry.find(a => a.id !== id && bindingFor(a.id) === combo);
      if (holder) return { ok: false, reason: "conflict", conflict: { id: holder.id, label: holder.label } };
    }
    const fresh = Object.assign({}, Prefs.get("hotkeys"));
    const act = registry.find(a => a.id === id);
    if (act && combo === act.def) delete fresh[id];   // back to default = no override stored
    else fresh[id] = combo;
    Prefs.set("hotkeys", fresh);
    return { ok: true };
  }

  function resetAll() { Prefs.set("hotkeys", {}); }

  /* one-shot rebind capture. Capture-phase + stopImmediatePropagation so the
   * app's global Escape closers can't tear the editor popup down mid-rebind.
   * cb(null) = cancelled · cb({clear:true}) = Backspace/Delete cleared it ·
   * cb({combo}) = candidate combo (the caller decides via setBinding).      */
  function onCaptureKey(e) {
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;   // wait for a real key
    e.preventDefault();
    e.stopImmediatePropagation();
    const cb = captureCb;
    cancelCapture();
    if (e.key === "Escape") { cb(null); return; }
    if (e.key === "Backspace" || e.key === "Delete") { cb({ clear: true }); return; }
    const combo = serialize(e);
    // reserved keys report back (instead of cancelling silently) so editors
    // can tell the user WHY the press didn't take
    if (RESERVED.includes(combo.split("+").pop())) { cb({ reserved: combo }); return; }
    cb({ combo });
  }
  function capture(cb) {
    cancelCapture();
    captureCb = cb;
    document.addEventListener("keydown", onCaptureKey, true);
  }
  function cancelCapture() {
    if (!captureCb) return;
    captureCb = null;
    document.removeEventListener("keydown", onCaptureKey, true);
  }

  function setSuspended(v) { suspended = !!v; }
  function setNavSuspended(v) { navSuspended = !!v; }
  function onChange(fn) { changeSubs.add(fn); return () => changeSubs.delete(fn); }

  /* dynamic bindings: a second combo table owned by the triggers system,
   * republished wholesale whenever triggers or the armed state change. The
   * nav registry is consulted FIRST, so a nav binding always wins a clash,
   * except while triggers are ARMED (setNavSuspended): then the whole nav
   * table pauses so a performance can't navigate the app by accident. */
  function setDynamic(listIn) {
    dynByCombo = {};
    (listIn || []).forEach(d => { if (d && d.combo && !dynByCombo[d.combo]) dynByCombo[d.combo] = d.run; });
  }

  document.addEventListener("keydown", e => {
    if (captureCb || suspended || e.defaultPrevented) return;
    const t = e.target;
    // typing fields swallow hotkeys; range sliders don't (they keep focus after
    // a drag, and they take no text, only the RESERVED arrow keys, which are
    // never bindable, so e.g. Ctrl+Z must keep working right after a drag)
    if (t && t.closest && t.closest("input:not([type=\"range\"]), textarea, select, [contenteditable]")) return;
    if (document.querySelector(".welcome-overlay")) return;   // first-run modal owns the keyboard
    const combo = serialize(e);
    const act = navSuspended ? null : byCombo[combo];
    if (act) { e.preventDefault(); act.run(); return; }
    const dyn = dynByCombo[combo];
    if (dyn) { e.preventDefault(); dyn(); }
  });

  Prefs.subscribe("hotkeys", rebuild);

  return { register, serialize, bindingFor, setBinding, resetAll, actions, capture, cancelCapture, onChange, setSuspended, setNavSuspended, setDynamic };
})();

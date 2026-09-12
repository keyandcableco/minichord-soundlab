/* ============================================================================
 * soundlab.js: minichord Sound Lab application glue
 *
 * Renders the three-panel UI from the PARAM_GROUPS catalog (params.js), owns
 * the live patch state ({ sysex addr: value }), and wires the other modules
 * together: prefs, presets, profiler, graphs, glossary, the Play-tab device
 * mirror (devicemap.js) and Web MIDI device sync (minichordcontroller.js).
 *
 * Key invariant: controls[addr] is an ARRAY of silent UI setters, one value
 * can render in several places (home tab, Play tab, pinned card) and every
 * copy must follow patch changes without echoing back to the device.
 * ========================================================================== */

(function () {
  "use strict";

  // --- patch state: address -> real value (defaults from the catalog) ---
  const patch = {};
  const paramByAddr = {};
  PARAM_GROUPS.forEach(g => g.params.forEach(p => { patch[p.addr] = p.def; paramByAddr[p.addr] = p; }));
  const controls = {}; // addr -> setter(value) that updates the UI + patch silently
  const fwWarnings = {}; // addr -> firmware-warning ELEMENTS (one per rendered copy of the param)
  const cardFlags = {};  // "groupId card" -> { flag } "inert" warning chip on a sub-component card

  let activeGroupId = PARAM_GROUPS[0].id;
  const groupEls = {};   // groupId -> { mid, right, canvas }

  // Reference snapshot for comparison (starts at the defaults).
  const reference = {};
  Object.keys(patch).forEach(addr => { reference[addr] = patch[addr]; });
  let showGhost = true;
  const ghostToggles = [];

  function snapshotReference() {
    Object.keys(patch).forEach(addr => { reference[addr] = patch[addr]; });
  }
  function syncToolbars() {
    ghostToggles.forEach(b => {
      b.classList.toggle("active", showGhost);
      b.setAttribute("aria-pressed", showGhost ? "true" : "false");
    });
  }

  /* ---- slider <-> value mapping (curve-aware) ------------------------------ */
  const STEPS = 1000, EXP_K = 5;

  function posToValue(p, pos, steps) {
    const t = pos / (steps || STEPS);
    const norm = p.curve === "exponential"
      ? Math.expm1(EXP_K * t) / Math.expm1(EXP_K) : t;
    let v = p.min + (p.max - p.min) * norm;
    v = Math.min(p.max, Math.max(p.min, v));
    return p.type === "int" ? Math.round(v) : roundTo(v, p.step);
  }
  function valueToPos(p, v, steps) {
    const norm = (v - p.min) / (p.max - p.min);
    const t = p.curve === "exponential"
      ? Math.log1p(norm * Math.expm1(EXP_K)) / EXP_K : norm;
    return Math.round(Math.min(1, Math.max(0, t)) * (steps || STEPS));
  }
  // linear params whose value grid fits the track get ONE POSITION PER STEP:
  // each arrow press then moves exactly one unit (BPM: 270 positions, not a
  // 1000-position track where most presses round back to the same value)
  function stepsFor(p) {
    if (p.curve === "exponential" || !p.step) return STEPS;
    const n = Math.round((p.max - p.min) / p.step);
    return n >= 1 && n <= STEPS && Math.abs((p.max - p.min) / p.step - n) < 1e-9 ? n : STEPS;
  }
  function roundTo(v, step) {
    const decimals = (String(step).split(".")[1] || "").length;
    return Number(v.toFixed(decimals));
  }
  function formatValue(p, v) {
    // `display` lets a parameter show something other than its raw value, for
    // cases where the wire format is not what a player thinks in (master tuning
    // travels in tenths of a Hz, so 4400 reads as 440.0)
    const num = p.display ? p.display(v) : (p.type === "int" ? v : roundTo(v, p.step));
    const unit = p.unit ? `<span class="unit">${p.unit}</span>` : "";
    return `${num}${unit}`;
  }

  /* click-to-type: a numeric readout swaps to a number input on click/Enter,
   * exact values without pixel-hunting the slider. Enter/blur commits (clamped
   * to the range, rounded to the step), Esc cancels. `commit` routes through
   * the caller's normal change path, so undo/graphs/device all follow. */
  function attachValueEdit(p, el, getValue, commit) {
    if (p.options) return;   // enums pick their options directly
    el.classList.add("value-editable");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.title = "Click to type an exact value";
    const begin = () => {
      if (el.querySelector("input")) return;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "save-field param-value-edit";
      input.min = String(p.display ? p.display(p.min) : p.min);
      input.max = String(p.display ? p.display(p.max) : p.max);
      input.step = String(p.displayStep || p.step || "any");
      input.value = String(p.display ? p.display(getValue()) : getValue());
      input.setAttribute("aria-label", p.name);
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        const n0 = Number(input.value);
        const n = (isFinite(n0) && p.toRaw) ? p.toRaw(n0) : n0;
        if (ok && input.value !== "" && isFinite(n)) {
          let v = Math.min(p.max, Math.max(p.min, n));
          v = p.type === "int" ? Math.round(v) : roundTo(v, p.step);
          commit(v);   // the commit path repaints the readout
        } else {
          el.innerHTML = formatValue(p, getValue());
        }
        el.focus();
      };
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        // Esc cancels the EDIT only, never the popup/sheet above it
        else if (e.key === "Escape") { e.stopPropagation(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
      el.innerHTML = "";
      el.appendChild(input);
      input.focus();
      input.select();
    };
    el.addEventListener("click", begin);
    el.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && !el.querySelector("input")) { e.preventDefault(); begin(); }
    });
  }
  function describeValue(p, v) {
    if (p.optionNotes) return p.optionNotes[v] || "";
    if (p.bands) {
      for (const b of p.bands) if (v <= b.max) return b.text;
      return p.bands[p.bands.length - 1].text;
    }
    return "";
  }

  // "Low = dark. High = bright." -> a bulleted contrast list. Returns HTML.
  // Detects short single-word keys followed by " = " at a sentence boundary.
  function doesHtml(text) {
    const re = /(?:^|(?<=[.;]\s))([A-Za-z0-9][\w/+.-]*) = /g;
    const starts = [];
    let m;
    while ((m = re.exec(text))) starts.push({ idx: m.index, key: m[1], after: m.index + m[0].length });
    if (starts.length < 2) return `<p class="ex-does">${text}</p>`;

    const lead = text.slice(0, starts[0].idx).trim();
    const items = starts.map((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].idx : text.length;
      const val = text.slice(s.after, end).trim().replace(/[.;]\s*$/, "");
      return `<li><b>${s.key}:</b> ${val}</li>`;
    });
    return (lead ? `<p class="ex-does ex-does-lead">${lead}</p>` : "") +
      `<ul class="does-list">${items.join("")}</ul>`;
  }

  /* ---- DOM roots ----------------------------------------------------------- */
  const tabsRoot = document.getElementById("tabs");
  const middleRoot = document.getElementById("middle-content");
  const rightRoot = document.getElementById("right-content");
  const domainRoot = document.getElementById("domain-switch");
  const layoutEl = document.querySelector(".layout");
  let overviewCanvases = [];   // {canvas, draw} pairs for the Overview dashboard
  const overviewProfiles = []; // {el, voice} per-voice profile cards in the dashboard
  let deviceMap = null;        // live "Play" view (devicemap.js), mounted in render()
  let staffView = null;        // live notation under the mirror (staff.js)
  let playRhythmRefresh = null; // repaint fn for the Play tab's own rhythm grid copy
  let playRhythmSetHead = null; // setPlayhead(step|null) for the Play rhythm grid (live sync)
  const rhythmHelpUpdaters = []; // per-grid fns that re-word the play/pause help for live vs learning mode
  const refreshRhythmHelp = () => rhythmHelpUpdaters.forEach(f => f());
  let playRhythmWrap = null;    // the .play-rhythm-wrap element (for bank-hue + pot-note)
  let rhythmPotNote = null;     // the rhythm ⚠ chip (shown when a pot drives BPM/cycle/shuffle)
  let portNoticeEl = null;      // single-port notice over the mirror (with the switch button)

  // single-port mode (addr 108) breaks the mirror, grey it out and show the
  // notice + fix button instead of letting it mislabel notes
  function updatePortNotice() {
    if (!portNoticeEl) return;
    const single = patch[108] === 1;
    portNoticeEl.classList.toggle("on", single);
    if (deviceMap && deviceMap.el) deviceMap.el.classList.toggle("dm-disabled", single);

    // functionally disabled too, not just greyed: incoming notes are dropped
    // (see controller.onNoteEvent), the playhead halts, and anything lit clears
    if (single) {
      rhythmSync.stop();
      if (deviceMap) deviceMap.setConnected(false);   // the disconnect path clears all lit state
    } else if (activeViewId === "play") {
      rhythmSync.start();
      if (deviceMap) deviceMap.setConnected(!!(controller && controller.isConnected()));
    }
  }

  // note-affecting settings shown in the Play tab's right panel (synced with their home
  // tabs). Grouped into sub-component cards exactly like a component's detail panel.
  // Each entry is one .detail-card; titles match the params' home cards.
  // no single-setting cards: transpose lives with Scale & harmony, the chord
  // voicing with Chord behaviour
  const PLAY_SETTING_CARDS = [
    { title: "Scale & harmony", addrs: [30, 35, 34, 33, 31, 255] },
    { title: "Chord behaviour", addrs: [23, 21, 22, 120, 37, 38, 39] },
    { title: "Harp", addrs: [99, 40, 98, 36, 236] },
  ];

  // second-level navigation inside Customize: groups belong to a voice/section domain
  // Chord before Harp, matching the device layout (chords on the left, harp on the right)
  const DOMAINS = [
    { id: "overview", label: "Overview" },
    { id: "chord", label: "Chord voice" },
    { id: "harp", label: "Harp voice" },
    { id: "space", label: "Space" },
    { id: "midi", label: "MIDI" },
    { id: "knobs", label: "Knobs" },
  ];
  const domainOf = g => g.domain || "harp";
  const groupsInDomain = d => PARAM_GROUPS.filter(g => domainOf(g) === d);
  let activeDomain = domainOf(PARAM_GROUPS.find(g => g.id === activeGroupId) || PARAM_GROUPS[0]);
  let tabDice = null;   // section-wide randomize button at the end of the tab strip
  function syncTabDice() {
    if (!tabDice) return;
    const dm = DOMAINS.find(d => d.id === activeDomain);
    const scope = activeDomain === "overview" ? "every section" : `all of ${dm ? dm.label : activeDomain}`;
    setDiceScope(tabDice, `Randomize ${scope}`);
    tabDice.style.display = RANDOM_SKIP_DOMAINS.has(activeDomain) ? "none" : "";
  }

  function render() {
    PARAM_GROUPS.forEach(group => {
      tabsRoot.appendChild(renderTab(group));
      middleRoot.appendChild(renderMiddle(group));
      rightRoot.appendChild(renderRight(group));
    });
    // section-wide dice at the end of the tab strip, retargeted per domain
    // by syncTabDice (Overview = randomize everything)
    tabDice = diceButton("Randomize", () => {
      if (activeDomain === "overview") randomizeGroups(PARAM_GROUPS, "all sections");
      else {
        const dm = DOMAINS.find(d => d.id === activeDomain);
        randomizeGroups(groupsInDomain(activeDomain), dm ? dm.label : activeDomain);
      }
    });
    tabDice.classList.add("tab-dice");
    tabsRoot.appendChild(tabDice);
    syncTabDice();
    renderOverviewDash();
    if (deviceMap && deviceMap.el) {   // live "Play" view, under its section heading
      const mirrorHead = document.createElement("div");
      mirrorHead.className = "play-mirror-head";
      const mh = document.createElement("h2");
      mh.className = "panel-label";
      mh.textContent = "Chords & harp";
      mirrorHead.append(mh, midiRec.makeButton());   // the mirror's own caption explains the rest (it's state-aware)
      middleRoot.appendChild(mirrorHead);

      // single-port mode breaks the mirror (harp notes arrive on the chord
      // port). Disable it outright and offer the fix right here
      portNoticeEl = document.createElement("div");
      portNoticeEl.className = "play-port-notice";
      const pnText = document.createElement("p");
      pnText.textContent = "Single port mode is on, so harp notes arrive mixed into the chord port "
        + "and the mirror can't tell the harp from the chords.";
      const pnBtn = document.createElement("button");
      pnBtn.type = "button";
      pnBtn.className = "mini-btn primary";
      pnBtn.textContent = "Switch to separate ports";
      pnBtn.addEventListener("click", () => {
        const p108 = paramByAddr[108];
        if (!p108) return;
        (controls[108] || []).forEach(fn => fn(0));   // UI + patch (every synced copy)
        onPatchChange(p108, 0);                       // push to device + refresh
        updatePortNotice();
      });
      portNoticeEl.append(pnText, pnBtn);
      middleRoot.appendChild(portNoticeEl);
      middleRoot.appendChild(deviceMap.el);
      if (deviceMap.setHarpShape) deviceMap.setHarpShape(Prefs.get("harpShape"));      if (!staffView && window.Staff) staffView = window.Staff.create();
      if (staffView) {
        middleRoot.appendChild(staffView.el);
        staffView.setKey(patch[35] || 0);
        staffView.el.hidden = Prefs.get("staffShow") === "off";
        if (staffView.fit && !staffView.el.hidden) staffView.fit();
      }
      updatePortNotice();
    }
    buildPlayExtras();   // Play tab: rhythm grid under the keyboard + note settings on the right
    buildAboutPanel();   // About view: one prose panel, shown by .layout.about
    renderDomainSwitch();
    setActiveDomain("overview");      // initialise Customize's internals (tabs, sections)
    renderViewSwitch();
    setActiveView(initialView());     // land on Play (or the saved preference)
    routeReady = true;
    if (!applyRoute()) updateRoute(true);   // a shared/bookmarked #hash wins; else stamp the landing route
    renderOverallProfile();
    renderOverviewProfiles();

    updateGateFlags();
    glossify(rightRoot);    // explanations + value descriptors
    glossify(middleRoot);   // graph captions + component headers
  }

  // Play tab extras: a rhythm step-grid under the keyboard (middle) and the note-affecting
  // settings on the right. Both reuse the normal builders, so they stay in sync with their
  // home tabs via the multi-setter controls[] list.
  function buildPlayExtras() {
    const rhythmGroup = PARAM_GROUPS.find(g => g.rhythmGrid);
    if (rhythmGroup) {
      // separator between the live device mirror (above) and the rhythm section
      const sep = document.createElement("hr");
      sep.className = "play-sep";
      middleRoot.appendChild(sep);

      const wrap = document.createElement("div");
      wrap.className = "play-rhythm-wrap";
      playRhythmWrap = wrap;

      // header row: section label + the pot-warning chip (shown when a knob
      // drives BPM/cycle/shuffle; clicking it opens the shared popover)
      const headRow = document.createElement("div");
      headRow.className = "play-rhythm-head";
      const head = document.createElement("h2");
      head.className = "panel-label";
      head.textContent = rhythmGroup.title;
      headRow.appendChild(head);
      // ONE padlock for the whole rhythm section (pattern + settings, all or
      // nothing). Locked by default so rolls never touch a groove unasked
      const rLock = document.createElement("button");
      rLock.type = "button";
      rLock.className = "param-lock section-lock";
      const syncRLock = () => {
        const on = Prefs.get("rhythmLock");
        rLock.classList.toggle("locked", on);
        rLock.title = on
          ? "Rhythm locked. Randomize won't touch the pattern or its settings (click to unlock)"
          : "Rhythm unlocked. Randomize may roll the pattern and settings, though never while the rhythm is playing (click to lock)";
        rLock.setAttribute("aria-label", rLock.title);
        rLock.setAttribute("aria-pressed", on ? "true" : "false");
      };
      rLock.addEventListener("click", () => Prefs.set("rhythmLock", !Prefs.get("rhythmLock")));
      Prefs.subscribe("rhythmLock", syncRLock);
      syncRLock();
      rhythmPotNote = document.createElement("button");
      rhythmPotNote.type = "button";
      rhythmPotNote.className = "pot-warn";
      rhythmPotNote.textContent = "";   // the ! is DRAWN by .pot-warn::before/::after (a font glyph smears into a line at this size)
      rhythmPotNote.title = "A knob affects the rhythm. Click for details";
      rhythmPotNote.setAttribute("aria-label", "Knob warning: a knob affects the rhythm, click for details");
      rhythmPotNote.setAttribute("aria-haspopup", "dialog");
      rhythmPotNote.style.display = "none";
      headRow.appendChild(rhythmPotNote);
      headRow.appendChild(rLock);   // last: margin-left auto floats it to the corner
      wrap.appendChild(headRow);

      // step grid + its scalar settings (BPM, cycle…) side by side, TOP-aligned.
      // The settings condense to the grid's right instead of stacking below
      // it. The blurb spans the full width ABOVE the row, so both panels start
      // at the same edge whatever the prefs make of their heights.
      if (rhythmGroup.blurb) {
        const blurb = document.createElement("p");
        blurb.className = "group-blurb";
        blurb.innerHTML = rhythmGroup.blurb;
        wrap.appendChild(blurb);
      }
      const rrow = document.createElement("div");
      rrow.className = "play-rhythm-row";
      const rmain = document.createElement("div");
      rmain.className = "play-rhythm-main";
      const rg = buildRhythmGrid(rhythmGroup);
      rmain.appendChild(rg.el);
      rrow.appendChild(rmain);
      const rside = document.createElement("div");
      rside.className = "play-rhythm-side detail-card";
      const rsideTitle = document.createElement("h3");
      rsideTitle.className = "detail-card-title";
      rsideTitle.textContent = "Rhythm settings";
      rside.appendChild(rsideTitle);
      const rsideList = document.createElement("div");
      rsideList.className = "param-list";
      rhythmGroup.params.filter(p => !p.grid).forEach(p => rsideList.appendChild(renderParam(p, { compact: true })));
      rside.appendChild(rsideList);
      rrow.appendChild(rside);
      wrap.appendChild(rrow);
      playRhythmRefresh = rg.refresh;
      playRhythmSetHead = rg.setPlayhead;
      middleRoot.appendChild(wrap);
      setRhythmHue();
      updateRhythmPotNote();
    }
    const panel = document.createElement("div");
    panel.className = "play-settings";
    const heading = document.createElement("h2");
    heading.className = "panel-label";
    heading.textContent = "Note settings";
    panel.appendChild(heading);

    // two independent columns, cards dealt alternating left/right, each column
    // stacks and flexes to its own content height (no row alignment gaps)
    const colsWrap = document.createElement("div");
    colsWrap.className = "play-settings-cols";
    const playCols = [document.createElement("div"), document.createElement("div")];
    playCols.forEach(c => { c.className = "play-col"; colsWrap.appendChild(c); });
    let playColIdx = 0;
    const addPlayCard = card => { playCols[playColIdx++ % playCols.length].appendChild(card); };
    panel.appendChild(colsWrap);
    // one detail-card per sub-component, same markup as renderRight's detail panel
    PLAY_SETTING_CARDS.forEach(({ title, addrs }) => {
      const params = addrs.map(a => paramByAddr[a]).filter(Boolean);
      if (!params.length) return;
      const card = document.createElement("div");
      card.className = "detail-card";
      const h = document.createElement("h3");
      h.className = "detail-card-title";
      h.textContent = title;
      card.appendChild(h);
      const list = document.createElement("div");
      list.className = "param-list";
      params.forEach(p => list.appendChild(renderParam(p)));   // full form: tips + explanations + descriptions
      card.appendChild(list);
      addPlayCard(card);
    });
    // "Pinned controls": user-chosen params from Customize, below Note settings
    const pinCard = document.createElement("div");
    pinCard.className = "detail-card play-pinned";
    const pinHead = document.createElement("h3");
    pinHead.className = "detail-card-title";
    pinHead.textContent = "Pinned controls";
    pinCard.appendChild(pinHead);
    pinnedEmptyEl = document.createElement("p");
    pinnedEmptyEl.className = "empty-note pin-hint";
    pinnedEmptyEl.textContent = "Pin any control in Customize (📌) to keep it here.";
    pinCard.appendChild(pinnedEmptyEl);
    pinnedListEl = document.createElement("div");
    pinnedListEl.className = "param-list";
    pinCard.appendChild(pinnedListEl);
    addPlayCard(pinCard);
    // continuation card for the pinned-row split (hidden until rows spill over)
    const pinCardCont = document.createElement("div");
    pinCardCont.className = "detail-card play-pinned";
    pinCardCont.style.display = "none";
    const pinContHead = document.createElement("h3");
    pinContHead.className = "detail-card-title";
    pinContHead.textContent = "Pinned controls";
    pinCardCont.appendChild(pinContHead);
    pinListB = document.createElement("div");
    pinListB.className = "param-list";
    pinCardCont.appendChild(pinListB);
    playCols[(playColIdx) % playCols.length].appendChild(pinCardCont);
    playColsEls = playCols;
    pinCardA = pinCard;
    pinCardB = pinCardCont;
    renderPinnedCard();
    rightRoot.appendChild(panel);

    // "Triggers": its own PANEL below Note settings (h2 section + card). The
    // Edit… and ⚡ arm buttons ride the section label, the ACTIVE (enabled)
    // triggers are listed in the card (each row click-opens its editor), and
    // all editing lives in the popup.
    // Arming is deliberately NOT persisted: every visit starts with triggers off.
    const trigPanel = document.createElement("div");
    trigPanel.className = "play-triggers";
    const trigHeadRow = document.createElement("div");
    trigHeadRow.className = "play-trig-head";
    const trigLabel = document.createElement("h2");
    trigLabel.className = "panel-label";
    trigLabel.textContent = "Triggers";
    const trigActions = document.createElement("span");
    trigActions.className = "mirror-actions";
    // edit rides the label row beside ⚡ (the undo/redo-on-Device-header pattern)
    const trigEditBtn = document.createElement("button");
    trigEditBtn.type = "button";
    trigEditBtn.className = "mini-btn";
    trigEditBtn.textContent = "Edit triggers…";
    trigEditBtn.addEventListener("click", () => openTrigSheet());
    armBtnEl = document.createElement("button");
    armBtnEl.type = "button";
    armBtnEl.className = "mini-btn dm-arm";
    armBtnEl.addEventListener("click", () => window.Triggers.setArmed(!window.Triggers.isArmed()));
    syncArmBtn();
    trigActions.append(trigEditBtn, armBtnEl);
    trigHeadRow.append(trigLabel, trigActions);
    trigPanel.appendChild(trigHeadRow);
    const trigCard = document.createElement("div");
    trigCard.className = "detail-card play-trig-card";
    trigCardEl = trigCard;
    trigCardEmptyEl = document.createElement("p");
    trigCardEmptyEl.className = "empty-note trig-empty";
    trigCardEmptyEl.textContent = "Chord, string, key or timer rules that change settings or load presets. Add some in the editor.";
    trigCardListEl = document.createElement("div");
    trigCardListEl.className = "trig-active-list";
    trigCard.append(trigCardEmptyEl, trigCardListEl);
    trigPanel.appendChild(trigCard);
    rightRoot.appendChild(trigPanel);
    renderPlayTrigCard();
  }

  // tint the Play rhythm grid with the playing hue (same --dm-hue the chord grid/harp use)
  function setRhythmHue() {
    if (playRhythmWrap) playRhythmWrap.style.setProperty("--dm-hue", effectiveHue());
  }

  /* ---- bank-color accent scope (preferences: bankAccent) -------------------
   * "none": the bank color tints nothing; playing visuals use the default
   *          accent hue.  "play": playing visuals (device mirror, rhythm
   * grid) take the bank hue (the long-standing behaviour).  "all": every UI
   * accent (--accent/--accent-bg/--accent-line) is regenerated from the bank
   * hue too, in hex (graphs.js withAlpha parses hex only).                   */
  const ACCENT_HUE = 245;   // hue of the stylesheet's default lavender accent
  function effectiveHue() {
    return Prefs.get("bankAccent") === "none" ? Prefs.get("accentHue") : bankColor;
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = x => Math.round(x * 255).toString(16).padStart(2, "0");
    return "#" + to(f(0)) + to(f(8)) + to(f(4));
  }
  function applyBankAccent() {
    const root = document.documentElement;
    const mode = Prefs.get("bankAccent");

    // "all" re-hues to the live bank color; otherwise the user's accent pick
    // applies (the stylesheet default when it's still the stock lavender)
    const h = mode === "all" ? bankColor : Prefs.get("accentHue");
    if (mode === "all" || h !== ACCENT_HUE) {
      // same sat/lightness as the stylesheet's accent trio, re-hued
      const light = root.getAttribute("data-theme") === "light";
      root.style.setProperty("--accent", light ? hslToHex(h, 51, 44) : hslToHex(h, 71, 88));
      root.style.setProperty("--accent-bg", light ? hslToHex(h, 74, 94) : hslToHex(h, 47, 25));
      root.style.setProperty("--accent-line", light ? hslToHex(h, 60, 81) : hslToHex(h, 43, 50));
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-bg");
      root.style.removeProperty("--accent-line");
    }
    setRhythmHue();
    if (deviceMap && deviceMap.el) deviceMap.el.style.setProperty("--dm-hue", effectiveHue());
    // topbar badge tint: the bank color while a device is connected (unless bank
    // tinting is off), else the selected accent. Offline there is no bank yet
    const live = typeof controller !== "undefined" && controller && controller.isConnected();
    root.style.setProperty("--ui-hue", String(mode !== "none" && live ? bankColor : Prefs.get("accentHue")));
    drawActiveGraph();   // graph strokes read --accent at draw time
  }
  Prefs.subscribe("bankAccent", applyBankAccent);
  Prefs.subscribe("harpShape", v => { if (deviceMap && deviceMap.setHarpShape) deviceMap.setHarpShape(v); });  Prefs.subscribe("staffShow", v => {
    if (!staffView) return;
    staffView.el.hidden = v === "off";
    if (v !== "off" && staffView.fit) staffView.fit();
  });
  Prefs.subscribe("accentHue", applyBankAccent);
  // a knob can silently drive BPM/cycle/shuffle or a step (the dump then lies); note it, like the mirror does
  function updateRhythmPotNote() {
    if (!rhythmPotNote) return;
    const targets = new Set([patch[10], patch[12], patch[14], patch[16]]);
    const NAMES = { 187: "BPM", 188: "cycle length", 190: "shuffle" };
    const driven = [187, 188, 190].filter(a => targets.has(a)).map(a => NAMES[a]);
    for (let s = 0; s < RHYTHM_STEPS; s++) if (targets.has(RHYTHM_BASE + s)) { driven.push("step pattern"); break; }
    if (!driven.length) { rhythmPotNote.style.display = "none"; return; }
    const list = driven.length === 1 ? driven[0]
      : driven.slice(0, -1).join(", ") + " & " + driven[driven.length - 1];
    rhythmPotNote.dataset.note = "A knob can control the " + list + ". The playhead uses the slider"
      + " values; set them to match what you're hearing so it can lock on.";
    rhythmPotNote.style.display = "";
  }

  // ---- live rhythm playhead --------------------------------------------------
  // Sweeps the rhythm grid in time with playback. Connected: the device emits a burst of chord
  // notes per fired step (no MIDI clock), so we group bursts, derive the step interval from their
  // spacing (works even when a pot drives BPM/shuffle), and match each burst's voices to the pattern to
  // light the right column. Offline: a free-running BPM playhead previews the pattern.
  const rhythmSync = createRhythmSync();
  rhythmSync.onStep(s => window.Triggers.feedStep(s));   // "every N steps" triggers ride the playhead
  function createRhythmSync() {
    let active = false, locked = false, step = -1, paused = true;   // playhead starts paused by default
    let anchorT = 0, anchorStep = 0, haveAnchor = false, offT = 0, hits = 0, lastOnsetT = 0;
    let tickT = null, burst = null, burstT = null, voices = null, recent = [], outsiderCount = 0;
    const nowMs = () => Date.now();
    const connected = () => !!(controller && controller.isConnected());
    const bpm = () => Math.max(30, Math.min(300, patch[187] || 80));
    const stepMs = () => 30000 / bpm();   // tempo is the SLIDER value (patch[187]), never inferred
    const cyc = () => Math.max(1, Math.min(RHYTHM_STEPS, patch[188] || RHYTHM_STEPS));
    const maskAt = s => patch[RHYTHM_BASE + s] || 0;

    // onsets in one pattern cycle (each set bit fires one note). The evidence window must span a
    // FULL cycle: after one clean cycle the pattern has shown everything it will ever show (absent
    // the harp), so the guess is judged on all of it and holds. A shorter sliding window lets the
    // distinguishing notes scroll out and the read drift on a pattern that hasn't changed.
    function cycleOnsets() {
      const c = cyc(); let n = 0;
      for (let s = 0; s < c; s++) { let m = maskAt(s); while (m) { n += m & 1; m >>= 1; } }
      return Math.max(6, Math.min(24, n));
    }
    const stepSubs = [];   // playhead observers (trigger system's step counter)
    const setHead = s => { if (s !== step) { step = s; if (playRhythmSetHead) playRhythmSetHead(s); stepSubs.forEach(fn => fn(s)); } };

    // a note → voice mask (bit i = voice i), using the chord fingerprinted from the recent stream
    // (`voices` = {notes:[7 midi], button, type})
    function voiceMask(notes) {
      if (!voices) return 0;
      let m = 0;
      notes.forEach(n => { for (let i = 0; i < 7; i++) if (voices.notes[i] === n) { m |= 1 << i; break; } });
      return m;
    }
    // push the fingerprinted chord onto the chord grid as a soft "slash" tint (a little visual)
    function showChord() { if (deviceMap && deviceMap.showRhythmChord) deviceMap.showRhythmChord(voices ? voices.button : null, voices ? voices.type : null, voices ? voices.transposeOffset : 0, voices ? voices.slashButton : null, voices ? voices.sharp : false); }

    // a pot can silently drive a rhythm setting (BPM 187 / cycle 188 / shuffle 190, or a pattern step
    // 220-235); the dump then reports the stored value, not what's playing (see
    // MINICHORD-REFERENCE.md §6), so step→voice can't be trusted.
    function rhythmPotDriven() {
      const targets = new Set([patch[10], patch[12], patch[14], patch[16]]);
      if (targets.has(187) || targets.has(188) || targets.has(190)) return true;
      for (let s = 0; s < RHYTHM_STEPS; s++) if (targets.has(RHYTHM_BASE + s)) return true;
      return false;
    }

    // the VOICE indices the step pattern fires at the step an onset at time `t` falls on. Fed to
    // identifyChord so it can tell relative/dim chords apart by which voice each onset is. Empty when
    // the phase isn't anchored yet OR a pot drives a rhythm setting → identifyChord falls back to bare.
    function firedVoices(t) {
      if (!haveAnchor || rhythmPotDriven()) return [];
      const c = cyc(), st = (((anchorStep + Math.round((t - anchorT) / stepMs())) % c) + c) % c;
      const mask = maskAt(st), vs = [];
      for (let v = 0; v < RHYTHM_ROWS; v++) if (mask & (1 << v)) vs.push(v);
      return vs;
    }

    // (re)identify the chord from the recent note stream (rhythm plays one note at a time, so the mirror
    // can't detect a simultaneous chord). Each onset is tagged with its step's fired voices so
    // identifyChord can disambiguate by voice structure, not just the bare note set.
    function fingerprint() {
      const onsets = recent.slice(-cycleOnsets()).map(r => ({ p: r.p, vs: firedVoices(r.t), m: r.m || 1 }));
      const v = (deviceMap && deviceMap.identifyChord) ? deviceMap.identifyChord(onsets, voices) : null;
      if (v) { voices = v; if (locked) showChord(); }   // keep the grid tint following chord changes
      return !!v;
    }
    // first pattern step whose mask matches (exact, then superset), used to (re)anchor the phase
    function findStep(mask) {
      const c = cyc();
      for (let s = 0; s < c; s++) if (maskAt(s) === mask) return s;
      for (let s = 0; s < c; s++) { const v = maskAt(s); if (v && (v & mask) === mask) return s; }
      return -1;
    }

    // the step that UNIQUELY fires this voice (exactly one in the pattern), else -1. A distinctive
    // note pins the phase unambiguously where a repeating note can't.
    function uniqueStep(mask) {
      const c = cyc(); let found = -1, n = 0;
      for (let s = 0; s < c; s++) { const pm = maskAt(s); if (pm && (mask & pm) === mask) { found = s; n++; } }
      return n === 1 ? found : -1;
    }
    // popcount = voices firing on a step / distinct notes in a burst
    function popcount(m) { let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }
    // the step whose voice COUNT is unique in the pattern, else -1 — a phase pin that needs NO
    // chord id. A beat sounding a different NUMBER of notes than every other beat is distinctive
    // even when the chord can't be named from a sparse stream and voiceMask() comes back empty
    // (uniqueStep then can't see it). e.g. a lone root on every other step + one root+3rd beat:
    // that 2-note beat is the only count-2 step, so it pins the phase however the chord reads.
    function uniqueStepByCount(count) {
      if (count <= 0) return -1;
      const c = cyc(); let found = -1, n = 0;
      for (let s = 0; s < c; s++) { const pm = maskAt(s); if (pm && popcount(pm) === count) { found = s; n++; } }
      return n === 1 ? found : -1;
    }

    // the first step that fires anything, used to anchor when the chord is UNKNOWN (a sparse pattern
    // like a lone root gives one pitch-class, not enough to name a chord, but the playhead can still
    // lock from onset timing + which steps are active).
    function firstActiveStep() { const c = cyc(); for (let s = 0; s < c; s++) if (maskAt(s)) return s; return -1; }
    // the pattern's longest internal silence, in steps, so a rest beat never trips the stop
    function maxNoteGap() {
      const c = cyc(); const on = [];
      for (let s = 0; s < c; s++) if (maskAt(s)) on.push(s);
      if (on.length <= 1) return c;
      let g = 0;
      for (let i = 0; i < on.length; i++) { const d = (on[(i + 1) % on.length] - on[i] + c) % c; if (d > g) g = d; }
      return g || c;
    }

    // Each note → its voice (via the stream fingerprint). LIVENESS is timing only (any onset = still
    // playing), so a chord change (pitches change, beat doesn't) never drops the lock. PHASE is
    // pinned by DISTINCTIVE notes (a voice that fires at exactly one step); a note that breaks a
    // repeating pattern becomes the anchor. Rests are counted (the step index can jump by >1).
    function onBurst(notes) {
      if (!active || paused || !connected()) return;
      const t = nowMs();
      lastOnsetT = t;

      // a note that's for SURE not in the current best-guess chord MAY mean the chord changed, but a
      // single stray note (a shared tone of a relative chord, a passing note) shouldn't reset us, or
      // the reading flickers (e.g. Em↔Dm). Require TWO consecutive outsiders before dropping the guess.
      // MULTISET test: a burst may sound the same pitch on two voices at once (a slash voicing whose
      // bass collides with a chord tone, C6/G doubles G4); a pitch played MORE times than the chord
      // has voices carrying it is an outsider even though the pitch itself is known.
      const burstCnt = new Map();
      for (const p of notes) burstCnt.set(p, (burstCnt.get(p) || 0) + 1);
      const capIn = (arr, p) => { let c = 0; for (const n of arr) if (n === p) c++; return c; };
      const fitsVoices = () => voices && [...burstCnt].every(([p, m]) => m <= capIn(voices.notes, p));
      let anyOutsider = false;
      if (voices) {
        anyOutsider = !fitsVoices();
        if (anyOutsider) {
          if (++outsiderCount >= 2) { recent = []; voices = null; outsiderCount = 0; anyOutsider = false; }
        } else outsiderCount = 0;
      }
      notes.forEach(p => recent.push({ p, t, m: burstCnt.get(p) }));
      const cap = Math.max(12, cycleOnsets());
      while (recent.length > cap) recent.shift();
      if (!voices) fingerprint();
      let mask = voiceMask(notes);

      // re-identify on a chord change. An outsider note means the chord MAY have changed even while
      // the burst still shares voices with the old chord (D6→D7 keep root/3rd/5th, so the mask never
      // goes to 0 on its own). Re-fingerprint and let identifyChord's stickiness/dominance decide.
      // A shared-tone burst with no outsider keeps the current read.
      if ((!mask || anyOutsider) && fingerprint()) {
        mask = voiceMask(notes);

        // the outsider count accumulated against the previous chord, once the updated guess places
        // the whole burst, clear it (a D6→D7→D6 alternation must not add up to a hard reset)
        if (fitsVoices()) outsiderCount = 0;
      }

      // mask may stay 0 (chord unknown / sparse single-PC pattern). We DON'T bail. The playhead can
      // still lock on timing + step ACTIVITY: with mask 0, `(mask & pm) === mask` is true for any
      // active step, so onsets confirm against the pattern's onset grid regardless of pitch.
      const sm = stepMs(), c = cyc();
      // the step this burst DISTINCTIVELY marks: prefer the exact voice match, but ONLY for a
      // multi-voice stab (popcount >= 2) — a single note under a mis-identified chord can map to
      // the wrong voice bit and falsely "uniquely match" the distinguishing step, pinning every
      // bare root there. Otherwise fall back to note COUNT, which is chord-independent, so a
      // distinguishing beat still pins the phase when the chord can't be named from a sparse stream.
      const uniq = popcount(mask) >= 2 ? uniqueStep(mask) : -1;
      const pin = uniq >= 0 ? uniq : uniqueStepByCount(new Set(notes).size);
      const anchorFor = () => (mask ? findStep(mask) : firstActiveStep());   // mask 0 → first active step
      if (haveAnchor) {
        // A DISTINCTIVE burst falls on exactly one step, so it pins the phase ABSOLUTELY — trust it
        // OVER the timing guess. A repeating pattern that gains a distinguishing beat (or a mid-loop
        // connect that first anchored on a repeating note) then snaps to the right column instead of
        // confirming a stale phase. No-op when it already agrees; a corrective jump when it doesn't;
        // either way the lock streak keeps building and a live lock is kept (just re-phased).
        if (pin >= 0) {
          const predicted = (((anchorStep + Math.round((t - anchorT) / sm)) % c) + c) % c;
          anchorStep = pin; anchorT = t;
          hits = predicted === pin ? hits + 1 : Math.max(hits, 1);
          if (!locked && hits >= 3) { locked = true; if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(true); showChord(); }
          return;
        }
        // CONFIRM the phase by onset TIMING + step ACTIVITY (pitch-independent): does the predicted
        // step (±1, counting rests) actually fire a note? A voice match is preferred when the
        // fingerprint is reliable, but a note still confirms on timing alone, so a fingerprint
        // wobble during frequent pitch changes can't break the lock streak.
        const kFloat = (t - anchorT) / sm, k0 = Math.round(kFloat);
        let bestK = -1, bestD = Infinity, bestVoiceFit = false;
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          if (k < 1) continue;
          const pm = maskAt((((anchorStep + k) % c) + c) % c);
          if (!pm) continue;                                  // predicted step is a rest, skip
          const d = Math.abs(kFloat - k);
          const voiceFit = (mask & pm) === mask;              // does this note's voice live on that step?
          if (voiceFit && !bestVoiceFit) { bestVoiceFit = true; bestD = d; bestK = k; }
          else if (voiceFit === bestVoiceFit && d < bestD) { bestD = d; bestK = k; }
        }
        if (bestK >= 1 && bestD <= 0.6) {                      // fits → confirm + re-anchor (no jump)
          anchorStep = (((anchorStep + bestK) % c) + c) % c; anchorT = t; hits++;
          if (!locked && hits >= 3) { locked = true; if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(true); showChord(); }
          return;
        }
        if (locked) return;                                   // ambiguous mismatch while locked → ignore
        const s = anchorFor();                                // not locked → retry this note as anchor
        if (s >= 0) { anchorStep = s; anchorT = t; hits = 1; }
        return;
      }
      const s = pin >= 0 ? pin : anchorFor();                 // first anchor: prefer a distinctive beat
      if (s >= 0) { haveAnchor = true; anchorStep = s; anchorT = t; hits = 1; }
    }
    function unlock() {
      locked = false; haveAnchor = false; hits = 0; setHead(-1);
      if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(false);
    }
    function tick() {
      if (!active) return;

      // reconcile the chord-grid suppression every tick: it must be ON only while genuinely locked &
      // playing. Safety net: if any unlock/stop/pause path is ever missed, the rhythm tint
      // still can't get stuck on the grid (it clears on the next tick).
      if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(locked && !paused && connected());
      if (paused) { setHead(-1); tickT = setTimeout(tick, 30); return; }   // playhead off in both modes
      if (connected()) {
        if (locked) {
          const sm = stepMs(), c = cyc(), t = nowMs();
          const k = Math.round((t - anchorT) / sm);
          setHead((((anchorStep + k) % c) + c) % c);   // linear sweep from the phase anchor (no jumps)
          if (t - lastOnsetT > (maxNoteGap() + 2) * sm) unlock();   // onsets stopped → dark + chord lights back
        } else {
          setHead(-1);   // nothing detected yet → dark
        }
      } else {
        const sm = stepMs(), c = cyc();   // offline preview: free-run sweep at the slider bpm
        setHead(((Math.floor((nowMs() - offT) / sm) % c) + c) % c);
      }
      tickT = setTimeout(tick, 30);
    }
    return {
      start() {
        if (active) return;
        active = true; locked = false; haveAnchor = false; hits = 0; step = -1; lastOnsetT = nowMs(); offT = nowMs();
        voices = null; recent = []; outsiderCount = 0;
        clearTimeout(tickT); tick();
      },
      stop() {
        active = false; locked = false; haveAnchor = false; voices = null; recent = []; lastOnsetT = 0; outsiderCount = 0;
        clearTimeout(tickT); clearTimeout(burstT); burst = null;
        setHead(-1);
        if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(false);
      },
      onChordNote(type, note) {
        if (!active || paused || !connected() || type !== "on") return;

        // an ARRAY, not a Set: a slash voicing can sound the same pitch on TWO voices at once
        // (C6/G at voicing 4 doubles G4, the slash bass collides with the 5th), and that doubled
        // note is the only thing separating C6/G from C6. Duplicates are evidence.
        if (!burst) burst = [];
        burst.push(note);
        clearTimeout(burstT);
        burstT = setTimeout(() => { const b = burst; burst = null; onBurst(b); }, 40);
      },
      isPaused() { return paused; },
      // the device's rhythm engine is audibly stepping right now (playhead
      // locked onto real playback). Rolls re-voice a sound that's already going
      isLive() { return active && locked && !paused; },
      setPaused(p) {
        paused = !!p;
        if (paused) {   // pausing kills the playhead and releases the chord-grid suppression
          locked = false; haveAnchor = false; hits = 0; setHead(-1);
          if (deviceMap && deviceMap.setRhythmActive) deviceMap.setRhythmActive(false);
        } else {        // resuming: restart the offline free-run phase from now
          offT = nowMs(); lastOnsetT = nowMs();
        }
      },
      onStep(fn) { stepSubs.push(fn); },
    };
  }

  // Overview is a special domain (a side-by-side dashboard, no parameter groups);
  // voice/section domains with no groups are hidden.
  function renderDomainSwitch() {
    if (!domainRoot) return;
    domainRoot.innerHTML = "";   // (also drops the roll button, re-added below)
    DOMAINS.forEach(dom => {
      if (dom.id !== "overview" && !groupsInDomain(dom.id).length) return;
      const btn = document.createElement("button");
      btn.className = "domain-btn";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", "false");
      btn.dataset.domain = dom.id;
      btn.textContent = dom.label;
      btn.addEventListener("click", () => setActiveDomain(dom.id));
      domainRoot.appendChild(btn);
    });
    // roll-everything rides this row's right corner (Overview layout reveals it)
    const rollBtn = diceButton("Randomize every section", () => randomizeGroups(PARAM_GROUPS, "all sections"));
    rollBtn.textContent = "🎲 Roll everything";
    rollBtn.classList.add("overview-roll");
    domainRoot.appendChild(rollBtn);
  }

  // build the Overview dashboard: Harp and Chord voice summaries side by side
  function renderOverviewDash() {
    const dash = document.createElement("div");
    dash.className = "overview-dash";
    [["chord_overview", "Chord voice", "chord"], ["harp_overview", "Harp voice", "harp"]].forEach(([id, label, voice]) => {
      const col = document.createElement("div");
      col.className = "overview-col";
      const h = document.createElement("h3");
      h.className = "overview-col-title";
      h.textContent = label;
      col.appendChild(h);
      // per-voice sound profile (signature + tags + feel meters), filled by renderOverviewProfiles
      const prof = document.createElement("div");
      prof.className = "profile-card";
      col.appendChild(prof);
      overviewProfiles.push({ el: prof, voice });
      (window.Graphs ? window.Graphs.specsFor(id) : []).forEach(spec => {
        const card = document.createElement("div");
        card.className = "graph-card";
        if (spec.title) {
          const t = document.createElement("h3");
          t.className = "graph-title";
          t.textContent = spec.title;
          card.appendChild(t);
        }
        const canvas = document.createElement("canvas");
        canvas.className = "graph-canvas";
        const cap = document.createElement("p");
        cap.className = "graph-caption";
        cap.textContent = spec.caption || "";
        card.append(canvas, cap);
        col.appendChild(card);
        overviewCanvases.push({ canvas, draw: spec.draw });
      });
      dash.appendChild(col);
    });
    middleRoot.appendChild(dash);
  }

  function drawOverviewDash() {
    if (!window.Graphs) return;
    requestAnimationFrame(() =>
      overviewCanvases.forEach(c => window.Graphs.drawSpec(c.canvas, c.draw, patch, null)));
  }

  function setActiveDomain(dom) {
    const isOverview = dom === "overview";
    if (!isOverview && !groupsInDomain(dom).length) return;
    activeDomain = dom;
    syncTabDice();
    if (layoutEl) layoutEl.classList.toggle("overview", isOverview);
    if (domainRoot) domainRoot.querySelectorAll(".domain-btn")
      .forEach(b => {
        b.classList.toggle("active", b.dataset.domain === dom);
        b.setAttribute("aria-selected", b.dataset.domain === dom ? "true" : "false");
      });

    if (isOverview) {
      // no single group is active, deactivate tabs/sections and show the dashboard
      tabsRoot.querySelectorAll(".tab").forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      Object.values(groupEls).forEach(els => {
        if (els.mid) els.mid.classList.remove("active");
        if (els.right) els.right.classList.remove("active");
      });
      drawOverviewDash();
      updateRoute();
      return;
    }

    // show only this domain's tabs
    tabsRoot.querySelectorAll(".tab").forEach(t => {
      const g = PARAM_GROUPS.find(x => x.id === t.dataset.group);
      t.style.display = g && domainOf(g) === dom ? "" : "none";
    });
    // keep the current group if it's in this domain, else jump to the domain's first
    const cur = PARAM_GROUPS.find(x => x.id === activeGroupId);
    setActiveGroup(cur && domainOf(cur) === dom ? activeGroupId : groupsInDomain(dom)[0].id);
  }

  /* ---- top-level views: Play | Customize ----------------------------------
   * A lightweight registry: each view is {id, label, show, hide} plus a layout
   * class toggled by setActiveView. Everything stays pre-rendered in the three
   * panels; views just show/hide their slice. Adding a future view = one
   * descriptor here + its own root element(s) gated by a layout class.       */
  function showPlayView() {
    // Play owns the full devicemap slice: deactivate Customize's tabs/sections
    tabsRoot.querySelectorAll(".tab").forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
    Object.values(groupEls).forEach(els => {
      if (els.mid) els.mid.classList.remove("active");
      if (els.right) els.right.classList.remove("active");
    });
    if (!deviceMap) return;
    const live = !!(controller && controller.isConnected());
    deviceMap.setConnected(live);
    deviceMap.rebuild();
    if (playRhythmRefresh) playRhythmRefresh();
    setRhythmHue();
    updateRhythmPotNote();
    balancePinnedCards();   // panel just became visible, heights are measurable now
    rhythmSync.start();   // live playhead: follows the device when playing, BPM preview offline
    updatePortNotice();   // single-port mode re-disables the mirror + playhead on entry
    // re-sync `patch` with the device's live state: a hardware-side preset or
    // setting change isn't auto-reported, so the mirror could be labeling from a
    // stale patch (e.g. wrong harp shuffling row). The dump arrives async and
    // flows through loadFromDevice → applyParamArray → deviceMap.rebuild().
    if (live) controller.requestCurrentData();
  }
  function hidePlayView() {
    rhythmSync.stop();   // the playhead only runs while the Play view is up
  }

  // About view: the left panel keeps its device/preset content; the narrative
  // cards stack in the middle panel and the help/community cards fill the right
  // panel. Pre-rendered; .layout.about reveals both roots.
  function buildAboutPanel() {
    const card = (title, body) => '<div class="about-card"><h3>' + title + "</h3>" + body + "</div>";
    const REPO_URL = "https://github.com/MinichordDrawn/minichord-soundlab";
    const root = document.createElement("div");
    root.className = "about-root";
    root.innerHTML =
      '<h2 class="panel-label">About</h2>' +

      card("What is the minichord?",
        "<p>The minichord is a pocket-sized electronic instrument. One hand presses a chord on a small " +
        "button grid, the other strums a touch-sensitive harp strip. The strings always land on notes that " +
        "fit the chord, so you can't hit a wrong one. Under the buttons sits a full synthesizer: " +
        "oscillators, envelopes, filters, delay and reverb, a rhythm sequencer, and three assignable " +
        "knobs.</p>" +
        "<p>It's an open-source project by Benjamin Poilvé. The hardware, firmware and documentation are " +
        'all published at <a href="https://minichord.com/" target="_blank" rel="noopener">minichord.com</a>.</p>') +

      card("What is Sound Lab?",
        "<p>This app helps you explore, understand and customize the minichord's sound. Plug the device in " +
        "over USB and every setting inside it becomes visible, explained and editable. Graphs show what " +
        "you're shaping, and you hear every change on the instrument as you drag.</p>") +

      card("Want to keep a copy?",
        "<p>You're using Sound Lab in your browser right now. To keep a copy that runs offline, download " +
        'it from <a href="' + REPO_URL + '" target="_blank" rel="noopener">the project page</a> (use the ' +
        "green Code button, then Download ZIP) and open <b>index.html</b> in Chrome. Bookmark it for quick " +
        "access. There's nothing to install, and nothing you do ever leaves your computer.</p>") +

      card("Who is it for?",
        "<ul>" +
        "<li><b>New owners:</b> see what every setting actually does, in plain language. Click any " +
        "highlighted term for a definition, or switch explanations to Verbose in preferences (⚙) for the " +
        "full manual-style read.</li>" +
        "<li><b>Sound designers and tinkerers:</b> reach every parameter the firmware exposes, far beyond " +
        "what the knobs alone can do, and save the results.</li>" +
        "<li><b>The curious without a minichord:</b> no device needed. Everything works in learning mode, " +
        "offline.</li>" +
        "</ul>") +

      card("What can it do?",
        "<ul>" +
        "<li><b>Play:</b> a live mirror of the instrument. Buttons and strings light up as you play, with " +
        "a readout of the current chord and the rhythm pattern's playhead.</li>" +
        "<li><b>Customize:</b> every setting, grouped by section (chord voice, harp voice, space, MIDI, " +
        "knobs), each with an explanation and live graphs.</li>" +
        "<li><b>Presets:</b> browse, load and save complete sounds, straight into the device's banks.</li>" +
        "<li><b>Record MIDI:</b> the ● Record MIDI button above the Play mirror captures everything you " +
        "play, chords and harp as separate tracks, into a standard .mid file any DAW can open. It needs the " +
        "minichord connected. Press it again to stop and download.</li>" +
        "<li><b>Make it yours:</b> pin your favourite controls into the Play view, assign the physical " +
        "knobs, and tune the app itself in preferences.</li>" +
        "</ul>");
    middleRoot.appendChild(root);

    const side = document.createElement("div");
    side.className = "about-side";
    side.innerHTML =
      card("Official help &amp; resources",
        "<p>Sound Lab shapes the sound. For everything else, the official site is the place to go:</p>" +
        "<ul>" +
        '<li><a href="https://minichord.com/" target="_blank" rel="noopener">minichord.com</a>: the ' +
        "project's home and official documentation.</li>" +
        '<li><a href="https://minichord.com/user_manual/" target="_blank" rel="noopener">The user manual</a>: ' +
        "how to play, charge and care for the instrument.</li>" +
        '<li><a href="https://minichord.com/user_manual/#updating-the-firmware" target="_blank" rel="noopener">Updating ' +
        "the firmware</a>: how to install the newest features. Sound Lab tells you when a setting " +
        "needs a newer version.</li>" +
        '<li><a href="https://minichord.discourse.group/" target="_blank" rel="noopener">The community forum</a>: ' +
        "share music, presets and questions with other players.</li>" +
        "</ul>") +

      card("Hearing a buzz when plugged in?",
        "<p>If a steady buzz appears the moment you connect the minichord to a computer over USB, it's " +
        "almost always a ground loop, not a fault. The audio cable and the USB cable each tie the " +
        "instrument to ground. Two paths make a loop, and it leaks into the signal as mains hum. " +
        "Any of these breaks it:</p>" +
        "<ul>" +
        "<li><b>Isolate the audio:</b> a ground-loop isolator (a small, inexpensive transformer) on the " +
        "audio cable between the minichord and your speakers or mixer.</li>" +
        "<li><b>Isolate the USB:</b> a USB isolator between the computer and the minichord.</li>" +
        "<li><b>Cut the mains path:</b> run the laptop on battery while you play, or unplug USB and run " +
        "the minichord on its own battery once you're done editing.</li>" +
        "<li><b>Use headphones:</b> plugged straight into the minichord, there's no second ground path.</li>" +
        "</ul>") +

      card("Community-made, always free",
        "<p>Sound Lab is made by the minichord community, in the same spirit as the instrument itself. " +
        "It's free, and always will be: no account, no payment, nothing locked. It runs entirely in your " +
        "browser, and nothing you play or edit ever leaves your computer.</p>");
    rightRoot.appendChild(side);
  }
  function showAboutView() {
    // the About panel owns the middle slice: deactivate Customize's tabs/sections
    tabsRoot.querySelectorAll(".tab").forEach(t => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
    Object.values(groupEls).forEach(els => {
      if (els.mid) els.mid.classList.remove("active");
      if (els.right) els.right.classList.remove("active");
    });
  }

  const VIEWS = [
    { id: "play", label: "Play", show: showPlayView, hide: hidePlayView },
    { id: "customize", label: "Customize", show: () => setActiveDomain(activeDomain), hide: () => {} },
    { id: "about", label: "About", show: showAboutView, hide: () => {} },
  ];
  let activeViewId = null;

  function renderViewSwitch() {
    const root = document.getElementById("view-switch");
    if (!root) return;
    root.innerHTML = "";
    VIEWS.forEach(view => {
      const btn = document.createElement("button");
      btn.className = "view-btn";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", "false");
      btn.dataset.view = view.id;
      btn.textContent = view.label;
      btn.addEventListener("click", () => setActiveView(view.id));
      root.appendChild(btn);
    });
  }

  function setActiveView(id) {
    if (id === activeViewId) return;
    const prev = VIEWS.find(v => v.id === activeViewId);
    const next = VIEWS.find(v => v.id === id) || VIEWS[0];
    if (prev) prev.hide();
    activeViewId = next.id;
    if (layoutEl) {
      layoutEl.classList.toggle("devicemap", next.id === "play");
      layoutEl.classList.toggle("about", next.id === "about");
      if (next.id !== "customize") layoutEl.classList.remove("overview");   // customize's show() re-asserts it
    }
    applyDensity();   // verbose only applies inside Customize
    document.querySelectorAll("#view-switch .view-btn")
      .forEach(b => {
        b.classList.toggle("active", b.dataset.view === activeViewId);
        b.setAttribute("aria-selected", b.dataset.view === activeViewId ? "true" : "false");
      });
    next.show();
    Prefs.set("lastView", activeViewId);
    updateRoute();
  }

  // the view to land on: the saved start view, resolving "last" to the last used
  function initialView() {
    const start = Prefs.get("startView");
    const id = start === "last" ? Prefs.get("lastView") : start;
    return VIEWS.some(v => v.id === id) ? id : "play";
  }

  /* ---- hash routing: #play | #about | #customize/<domain>[/<group>] --------
   * The hash mirrors the active view/domain/tab so the browser's back/forward
   * walk the navigation history. Hash-only changes work on file:// too (a
   * pushState PATH change would throw there).                                */
  let applyingRoute = false, routeReady = false;
  function currentRoute() {
    if (activeViewId === "play" || activeViewId === "about") return activeViewId;
    return "customize/" + activeDomain + (activeDomain !== "overview" && activeGroupId ? "/" + activeGroupId : "");
  }
  function updateRoute(replace) {
    if (applyingRoute || !routeReady) return;
    const route = currentRoute();
    if (location.hash.slice(1) === route) return;
    if (replace) {
      try { history.replaceState(null, "", "#" + route); return; } catch (e) { /* fall through */ }
    }
    location.hash = route;
  }
  function applyRoute() {
    const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
    if (!parts.length) return false;
    applyingRoute = true;
    try {
      if (parts[0] === "play" || parts[0] === "about") setActiveView(parts[0]);
      else if (parts[0] === "customize") {
        setActiveView("customize");
        if (parts[1] && (parts[1] === "overview" || groupsInDomain(parts[1]).length)) setActiveDomain(parts[1]);
        if (parts[2] && PARAM_GROUPS.some(g => g.id === parts[2])) setActiveGroup(parts[2]);
      } else return false;
    } finally { applyingRoute = false; }
    return true;
  }
  window.addEventListener("hashchange", () => { if (!applyingRoute) applyRoute(); });

  function renderTab(group) {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.dataset.group = group.id;
    btn.textContent = group.title;
    btn.addEventListener("click", () => setActiveGroup(group.id));
    return btn;
  }

  // MIDDLE: component header, graphs, per-component profile
  function renderMiddle(group) {
    const sec = document.createElement("section");
    sec.className = "comp-mid";
    sec.dataset.group = group.id;

    const head = document.createElement("div");
    head.className = "group-head";
    const headText = document.createElement("div");
    headText.className = "group-head-text";
    headText.innerHTML = `<div class="group-title">${group.title}</div>
                          <div class="group-blurb">${group.blurb}</div>`;
    head.append(headText);

    // "Reset section" sits top-right, opposite the name/description; reverts this
    // section's controls to the preset. Skipped for param-less tabs (Overview).
    if (group.params.length) {
      const resetSec = document.createElement("button");
      resetSec.type = "button";
      resetSec.className = "mini-btn section-reset";
      resetSec.textContent = "Reset section";
      resetSec.title = "Revert this section's controls to the loaded preset";
      resetSec.addEventListener("click", () => resetToPreset(group.params.map(p => p.addr)));
      presetResetButtons.push(resetSec);
      head.append(resetSec);
    }

    // per-component profile / "character" (filled by the Sound Profiler)
    const prof = document.createElement("div");
    prof.className = "profile-card compact-profile";

    // order: header → character → graph(s) → primary control(s)
    sec.appendChild(head);
    sec.appendChild(prof);

    // graphs: a tab may register several (primary first). All graphs are
    // read-only visualisations; every control stays in the detail pane. The
    // primary graph carries the reference toolbar.
    const specs = window.Graphs ? window.Graphs.specsFor(group.id) : [];
    const canvases = [];
    const addGraph = (spec, withToolbar, parent) => {
      const card = document.createElement("div");
      card.className = "graph-card";
      if (spec.title) {
        const t = document.createElement("h3");
        t.className = "graph-title";
        t.textContent = spec.title;
        card.appendChild(t);
      }
      const canvas = document.createElement("canvas");
      canvas.className = "graph-canvas";
      const cap = document.createElement("p");
      cap.className = "graph-caption";
      cap.textContent = spec.caption || "";
      if (withToolbar) card.append(canvas, buildGraphToolbar(group), cap);
      else card.append(canvas, cap);
      (parent || sec).appendChild(card);
      canvases.push({ canvas, draw: spec.draw });
    };

    // optional explainer block for tabs without a graph (e.g. the knobs guide)
    if (group.middleNote) {
      const note = document.createElement("div");
      note.className = "group-note";
      note.innerHTML = group.middleNote;
      sec.appendChild(note);
    }

    // the primary graph (the clear main, carrying the reference toolbar) stays
    // full width; secondary graphs share a row in compact density (e.g. the
    // chord oscillator's three single-osc views under the combined stack)
    if (specs.length) addGraph(specs[0], true);
    if (specs.length > 1) {
      const graphRow = document.createElement("div");
      graphRow.className = "graph-row";
      sec.appendChild(graphRow);
      specs.slice(1).forEach(spec => addGraph(spec, false, graphRow));
    }

    // bespoke step-sequencer grid (rhythm), drawn in the middle as the centrepiece
    let rhythmRefresh = null;
    if (group.rhythmGrid) { const rg = buildRhythmGrid(group); sec.appendChild(rg.el); rhythmRefresh = rg.refresh; }

    groupEls[group.id] = Object.assign(groupEls[group.id] || {}, { mid: sec, canvases, prof, rhythmRefresh });
    return sec;
  }

  // 16-step × 7-row sequencer. Each step (addr 220-235) stores a 7-bit field:
  // bit k set = row k fires on that step. Cells beyond the cycle length dim.
  const RHYTHM_ROWS = 7, RHYTHM_STEPS = 16, RHYTHM_BASE = 220;

  // the 7 rhythm voices = the held chord's arpeggiator notes. `bit` is the voice's index in the
  // step mask (bit i = voice i sounds this step); rows are drawn high→low pitch (the voice pitch
  // order is constant across chord types: root < 2nd < 3rd < 4th < 5th < 6th < octave).
  const RHYTHM_VOICES = [
    { bit: 3, name: "8ve",  full: "octave" },
    { bit: 6, name: "6th",  full: "sixth" },
    { bit: 2, name: "5th",  full: "fifth" },
    { bit: 5, name: "4th",  full: "fourth" },
    { bit: 1, name: "3rd",  full: "third" },
    { bit: 4, name: "2nd",  full: "second" },
    { bit: 0, name: "Root", full: "root" },
  ];
  function buildRhythmGrid(group) {
    const wrap = document.createElement("div");
    wrap.className = "graph-card rhythm-grid";
    const head = document.createElement("div");
    head.className = "rhythm-head";
    const title = document.createElement("h3");
    title.className = "graph-title";
    title.textContent = "Step pattern";
    head.appendChild(title);
    // pause toggle (top-right), stops the playhead in both offline preview and live-synced modes
    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "rhythm-pause";
    const syncPauseBtn = () => {
      const paused = rhythmSync.isPaused();
      // the ⏸/▶ glyphs are DRAWN by .rhythm-pause::before. Font glyphs
      // don't centre in the small circle (same trick as the pot-warn "!")
      pauseBtn.title = paused
        ? "Start the playhead. Offline it previews the pattern at the set BPM; connected it locks onto the device's live rhythm."
        : "Stop the playhead (the grid keeps showing the stored pattern).";
      pauseBtn.setAttribute("aria-label", paused ? "Start the playhead" : "Stop the playhead");
      pauseBtn.classList.toggle("paused", paused);
    };
    pauseBtn.addEventListener("click", () => { rhythmSync.setPaused(!rhythmSync.isPaused()); syncPauseBtn(); });
    syncPauseBtn();
    head.appendChild(pauseBtn);
    wrap.appendChild(head);
    // play/pause instructions sit ABOVE the step box and reflect the current mode (live vs learning)
    const help = document.createElement("p");
    help.className = "rhythm-legend rhythm-help";
    const setHelp = () => {
      help.textContent = (controller && controller.isConnected())
        ? "Live mode: ▶ locks the playhead onto the device's playback as it plays. Paused, the grid just shows the stored pattern."
        : "Learning mode: ▶ runs a playhead that previews this pattern at the BPM you set. Paused, the grid just shows the stored pattern.";
    };
    setHelp();
    rhythmHelpUpdaters.push(setHelp);
    wrap.appendChild(help);

    const cells = [];   // cells[step][bit] = button (bit = voice index in the step mask)

    RHYTHM_VOICES.forEach(voice => {
      const bit = voice.bit;
      const rowEl = document.createElement("div");
      rowEl.className = "rhythm-row";
      const lbl = document.createElement("span");
      lbl.className = "rhythm-rowlabel";
      lbl.textContent = voice.name;
      lbl.title = `Voice ${bit + 1}: the chord's ${voice.full}`;
      rowEl.appendChild(lbl);
      for (let s = 0; s < RHYTHM_STEPS; s++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "rhythm-cell" + (s % 4 === 0 && s > 0 ? " beat-gap" : "");
        cell.title = `${voice.name} · step ${s + 1}`;
        cell.setAttribute("aria-label", `${voice.name}, step ${s + 1}`);
        cell.setAttribute("aria-pressed", "false");
        cell.addEventListener("click", () => toggle(s, bit));
        (cells[s] = cells[s] || [])[bit] = cell;
        rowEl.appendChild(cell);
      }
      wrap.appendChild(rowEl);
    });
    // step-number footer
    const foot = document.createElement("div");
    foot.className = "rhythm-row rhythm-foot";
    const pad = document.createElement("span"); pad.className = "rhythm-rowlabel"; foot.appendChild(pad);
    for (let s = 0; s < RHYTHM_STEPS; s++) {
      const n = document.createElement("span");
      n.className = "rhythm-stepnum" + (s % 4 === 0 ? " beat" : "") + (s % 4 === 0 && s > 0 ? " beat-gap" : "");
      n.textContent = s + 1;
      foot.appendChild(n);
    }
    wrap.appendChild(foot);

    const stepParam = s => paramByAddr[RHYTHM_BASE + s];
    function paint() {
      const cyc = patch[188] != null ? patch[188] : RHYTHM_STEPS;
      for (let s = 0; s < RHYTHM_STEPS; s++) {
        const val = patch[RHYTHM_BASE + s] || 0;
        const inLoop = s < cyc;
        for (let bit = 0; bit < RHYTHM_ROWS; bit++) {
          const cell = cells[s][bit];
          cell.classList.toggle("on", !!(val & (1 << bit)));
          cell.setAttribute("aria-pressed", (val & (1 << bit)) ? "true" : "false");
          cell.classList.toggle("outside", !inLoop);
        }
      }
    }
    function toggle(s, bit) {
      const p = stepParam(s);
      const val = (patch[RHYTHM_BASE + s] || 0) ^ (1 << bit);
      controls[RHYTHM_BASE + s].forEach(fn => fn(val));   // patch + repaint every grid copy
      onPatchChange(p, val);   // profiles/redraw + push to device
    }
    // register silent setters so dumps / preset loads update the grid
    for (let s = 0; s < RHYTHM_STEPS; s++) {
      (controls[RHYTHM_BASE + s] = controls[RHYTHM_BASE + s] || []).push(value => { patch[RHYTHM_BASE + s] = value; paint(); });
    }
    // playhead: highlight the currently-playing step's column (driven by the rhythm sync controller)
    let playhead = -1;
    function setPlayhead(step) {
      const s = (step == null || step < 0) ? -1 : ((step % RHYTHM_STEPS) + RHYTHM_STEPS) % RHYTHM_STEPS;
      if (s === playhead) return;
      const mark = (col, on) => { if (col >= 0 && cells[col]) for (let bit = 0; bit < RHYTHM_ROWS; bit++) cells[col][bit].classList.toggle("playhead", on); };
      mark(playhead, false);
      playhead = s;
      mark(playhead, true);
    }
    paint();
    return { el: wrap, refresh: paint, setPlayhead };
  }

  // RIGHT: the component's remaining params (full explanations)
  function renderRight(group) {
    const sec = document.createElement("section");
    sec.className = "comp-right";
    sec.dataset.group = group.id;

    const label = document.createElement("h2");
    label.className = "panel-label";
    label.textContent = `${group.title} details`;
    sec.appendChild(label);

    // every (non-grid) param lives here, split into sub-component cards.
    // `grid` params (rhythm steps) are drawn by the step grid in the middle.
    const details = group.params.filter(p => !p.grid);

    if (details.length && !RANDOM_SKIP_DOMAINS.has(domainOf(group))) {
      label.appendChild(diceButton(`Randomize ${group.title}`, () => randomizeGroups([group], group.title)));
    }

    if (details.length === 0) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = "A summary of the whole voice. The filled shape is its volume envelope, the line is how far the filter sweeps. Shape it from the other tabs.";
      sec.appendChild(note);
    } else {
      // two explicit columns, cards split by balanceDetailCols when the group
      // shows (multicol balancing underfilled the left column and crammed the
      // remainder into the right. User rule: the LEFT column fills first)
      const colsWrap = document.createElement("div");
      colsWrap.className = "detail-cols";
      const colA = document.createElement("div");
      const colB = document.createElement("div");
      colA.className = "detail-col";
      colB.className = "detail-col";
      colsWrap.append(colA, colB);
      sec.appendChild(colsWrap);
      // split the column into one card per sub-component. Params sharing a `card`
      // label group under that title (cards appear in first-seen order, so param
      // array order needn't be contiguous); untagged params fall into a single
      // untitled card (the common single-component case keeps its original feel).
      const cards = new Map();   // card title ("" = untitled) -> param[]
      details.forEach(p => {
        const key = p.card || "";
        if (!cards.has(key)) cards.set(key, []);
        cards.get(key).push(p);
      });
      const hasGate = (group.gates || []).reduce((s, g) => s.add(g.card || ""), new Set());
      cards.forEach((params, title) => {
        const card = document.createElement("div");
        card.className = "detail-card";
        // "inert" chip, lights up beside the title when a gating control
        // zeroes this whole card; clicking it opens the shared popover with
        // the message (via the delegated .pot-warn click handler). Its slot is
        // reserved (visibility, not display) so toggling never changes the
        // card's height. A height change mid-drag would reflow the column
        // and yank the slider out from under the pointer.
        let gateChip = null;
        if (hasGate.has(title)) {
          const flag = document.createElement("button");
          flag.type = "button";
          flag.className = "pot-warn gate-warn";
          flag.textContent = "";   // the ! is DRAWN by .pot-warn::before/::after
          flag.setAttribute("aria-haspopup", "dialog");
          flag.style.visibility = "hidden";
          gateChip = flag;
          cardFlags[group.id + " " + title] = { flag };
        }
        if (title) {
          const head = document.createElement("div");
          head.className = "detail-card-head";
          const h = document.createElement("h3");
          h.className = "detail-card-title";
          h.textContent = title;
          head.appendChild(h);
          if (gateChip) head.appendChild(gateChip);
          card.appendChild(head);
        } else if (gateChip) card.appendChild(gateChip);
        const list = document.createElement("div");
        list.className = "param-list";
        params.forEach(p => list.appendChild(renderParam(p, { pinnable: true })));
        card.appendChild(list);
        colA.appendChild(card);
      });
    }

    groupEls[group.id] = Object.assign(groupEls[group.id] || {}, { right: sec });
    return sec;
  }

  // A value bound to another parameter's target is meaningless as a number: once
  // the double tap points at Chord layout, what matters is Standard or Alternate,
  // not 0 or 1. Borrow the target's range and options so the control asks the
  // right question. The address stays its own.
  function effectiveParam(p) {
    if (p.followsTarget == null) return p;
    const target = paramByAddr[patch[p.followsTarget]];
    if (!target) return p;
    return Object.assign({}, p, {
      options: target.options, optionNotes: target.optionNotes,
      segmented: target.segmented,
      min: target.min, max: target.max, step: target.step,
      unit: target.unit, display: target.display, toRaw: target.toRaw,
      displayStep: target.displayStep,
    });
  }

  function renderParam(p, opts) {
    opts = opts || {};
    p = effectiveParam(p);
    const el = document.createElement("div");
    el.className = "param" + (opts.compact ? " compact" : "");

    const control = p.targetSelect ? selectControl(p, targetOptions(), { crumb: true })
      : p.type === "degrees" ? degreesControl(p)
      : p.options ? (segWorthy(p) ? segControl(p) : selectControl(p)) : sliderControl(p);

    const main = document.createElement("div");
    main.className = "param-main";

    const row = document.createElement("div");
    row.className = "param-row";

    const nameCell = document.createElement("div");
    nameCell.className = "param-name";
    const nameText = document.createElement("span");
    nameText.className = "param-name-text";
    nameText.textContent = p.name;
    nameCell.appendChild(nameText);

    // on-demand explanation: the name itself opens the param popover. Dotted
    // underline (same affordance as glossary terms) marks it clickable
    if (p.explain) {
      nameText.classList.add("has-info");
      nameText.title = "What is this?";
      nameText.setAttribute("aria-haspopup", "dialog");
      nameText.setAttribute("role", "button");
      nameText.tabIndex = 0;
      nameText.addEventListener("click", e => { e.stopPropagation(); toggleParamPop(p, nameText); });
      nameText.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleParamPop(p, nameText); }
      });
    }

    // pin-to-Play: Customize rows get a pin toggle; rows inside the Play
    // pinned card get an unpin × instead
    if (opts.pinnable) {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "param-pin";
      pin.textContent = "📌";
      pin.addEventListener("click", e => { e.stopPropagation(); togglePin(p.addr); });
      (pinButtons[p.addr] = pinButtons[p.addr] || []).push(pin);
      syncPinBtn(pin, isPinned(p.addr));
      nameCell.appendChild(pin);

      // lock-against-randomize lives beside the pin (Customize rows only)
      const lock = document.createElement("button");
      lock.type = "button";
      lock.className = "param-lock";   // padlock drawn in CSS (currentColor, emoji glyphs go black on dark themes)
      lock.addEventListener("click", e => { e.stopPropagation(); toggleLock(p.addr); });
      (lockButtons[p.addr] = lockButtons[p.addr] || []).push(lock);
      syncLockBtn(lock, isLocked(p.addr));
      nameCell.appendChild(lock);
    }
    if (opts.unpin) {
      const un = document.createElement("button");
      un.type = "button";
      un.className = "param-unpin";
      un.title = "Remove from Play";
      un.setAttribute("aria-label", "Remove from Play");
      un.textContent = "×";
      un.addEventListener("click", e => { e.stopPropagation(); togglePin(p.addr); });
      nameCell.appendChild(un);
    }

    const controlCell = document.createElement("div");
    controlCell.className = "param-control";
    controlCell.appendChild(control.el);

    const valueCell = document.createElement("div");
    valueCell.className = "param-value";
    valueCell.innerHTML = p.options ? "" : formatValue(p, patch[p.addr]);

    // enums and target pickers show no numeric value, give the control the
    // value column's space instead of a blank strip (or a raw address number)
    if (p.options || p.targetSelect) { valueCell.style.display = "none"; controlCell.style.gridColumn = "2 / -1"; }
    else attachValueEdit(p, valueCell, () => patch[p.addr], v => {
      controls[p.addr].forEach(fn => fn(v));   // patch + every synced copy, like a slider move
      onPatchChange(p, v);
    });

    row.append(nameCell, controlCell, valueCell);
    main.appendChild(row);

    // live value descriptor
    let descEl = null;
    if (p.bands || p.optionNotes) {
      descEl = document.createElement("p");
      descEl.className = "value-desc";
      descEl.textContent = describeValue(p, patch[p.addr]);
      row.appendChild(descEl);
    }

    // firmware warning, shown when a connected device is too old for this param
    let fwWarnEl = null;
    if (p.fw) {
      fwWarnEl = document.createElement("p");
      fwWarnEl.className = "fw-warning";
      fwWarnEl.innerHTML = `<span>⚠</span> Needs firmware v${p.fw}. Won't affect your device.`;
      fwWarnEl.style.display = "none";
      row.appendChild(fwWarnEl);
      (fwWarnings[p.addr] = fwWarnings[p.addr] || []).push(fwWarnEl);
    }

    // tip lives under the value description (uses the control column's space).
    // Built for the verbose-inline density only. Compact density shows the
    // tip inside the param popover instead (CSS hides these unless verbose).
    if (!opts.compact && p.explain && p.explain.tips) {
      const tip = document.createElement("p");
      tip.className = "row-tip";
      tip.innerHTML = `<span>Tip</span> ${p.explain.tips}`;
      row.appendChild(tip);
    }

    el.appendChild(main);

    // inline explanation column, definition + what-it-does (verbose density only)
    if (!opts.compact && p.explain) {
      const explain = document.createElement("div");
      explain.className = "param-explain";
      explain.innerHTML = `<p class="ex-def">${p.explain.is}</p>` + doesHtml(p.explain.does);
      el.appendChild(explain);
    }

    // silent setter, lets the device push a value into this control without echoing a
    // send back (updates UI + patch only; caller redraws). A param can be rendered in more
    // than one place (e.g. a home tab AND the Play panel), so controls[addr] holds the
    // LIST of setters; updating one updates every synced copy.
    const setter = value => {
      patch[p.addr] = value;
      control.set(value);
      if (!p.options) valueCell.innerHTML = formatValue(p, value);
      if (descEl) { descEl.textContent = describeValue(p, value); glossify(descEl); }
    };
    (controls[p.addr] = controls[p.addr] || []).push(setter);

    // disposal contract: a re-rendered copy (only the Play pinned card does
    // this) must unhook its setter + warning, or controls[] accumulates dead
    // entries. Static call sites never call it.
    el._dispose = () => {
      const list = controls[p.addr] || [];
      const i = list.indexOf(setter);
      if (i >= 0) list.splice(i, 1);
      if (fwWarnEl && fwWarnings[p.addr]) {
        const j = fwWarnings[p.addr].indexOf(fwWarnEl);
        if (j >= 0) fwWarnings[p.addr].splice(j, 1);
      }
    };

    control.onChange(value => {
      controls[p.addr].forEach(fn => fn(value));   // patch + every synced copy of this control
      if (p.autoReference) {
        snapshotReference();
        if (!showGhost) { showGhost = true; syncToolbars(); }
      }
      onPatchChange(p, value);
    });

    return el;
  }

  function sliderControl(p) {
    const input = document.createElement("input");
    input.type = "range";
    const n = stepsFor(p);
    input.min = 0; input.max = n; input.step = 1;
    input.value = valueToPos(p, patch[p.addr], n);
    let cb = () => {};
    input.addEventListener("input", () => cb(posToValue(p, Number(input.value), n)));
    // scroll wheel = one position per notch (the same resolution as an arrow
    // press: one param step on linear sliders, 1/1000 of an exponential track)
    input.addEventListener("wheel", e => {
      e.preventDefault();
      const pos = Math.min(n, Math.max(0, Number(input.value) - Math.sign(e.deltaY)));
      if (pos === Number(input.value)) return;
      input.value = pos;
      cb(posToValue(p, pos, n));
    }, { passive: false });
    return { el: input, onChange: fn => { cb = fn; }, set: v => { input.value = valueToPos(p, v, n); } };
  }

  // small enums render as a one-click segmented row instead of a dropdown:
  // opt in via `seg` (short button labels) or `segmented: true` in params.js,
  // or automatically when there are only 2-3 options. Long lists (waveforms,
  // voicings, knob targets) keep the card dropdown.
  const segWorthy = p => !!(p.seg || p.segmented === true || p.options.length <= 3);

  // tape-deck control for small enums, same {el, onChange, set} contract as
  // selectControl/sliderControl, so renderParam and controls[] don't care.
  // Button labels come from p.seg when set (the full option label moves to the
  // button's tooltip); value = option index, like every non-mapped enum.
  function segControl(p) {
    let cb = () => {};
    const labels = p.seg || p.options;
    const seg = segButtons(labels.map((label, i) => ({
      label,
      value: i,
      title: p.options[i] !== label ? p.options[i] : "",
    })), v => { seg.set(v); cb(v); });
    seg.el.classList.add("param-seg");
    if (labels.length > 8) seg.el.classList.add("seg-grid");   // e.g. the 12 key signatures
    seg.set(patch[p.addr]);
    return { el: seg.el, onChange: fn => { cb = fn; }, set: v => seg.set(v) };
  }

  // a set of chromatic degrees held as a bitmask in one parameter. Same
  // {el, onChange, set} contract as the other controls, so renderParam and
  // controls[] treat it like anything else. Value = the mask, bit 0 = root.
  function degreesControl(p) {
    let cb = () => {};
    let mask = patch[p.addr] || 0;
    const wrap = document.createElement("div");
    wrap.className = "param-degrees";
    const boxes = (p.degrees || []).map((label, bit) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "degree-btn";
      b.textContent = label;
      b.setAttribute("aria-pressed", "false");
      b.title = "Degree " + label;
      b.addEventListener("click", () => {
        mask ^= (1 << bit);
        paint();
        cb(mask);
      });
      wrap.appendChild(b);
      return b;
    });
    function paint() {
      boxes.forEach((b, bit) => {
        const on = (mask & (1 << bit)) !== 0;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    paint();
    return {
      el: wrap,
      onChange: fn => { cb = fn; },
      set: v => { mask = v || 0; paint(); },
    };
  }

  // a single enum dropdown may be open at a time (shared with outside-click/Esc)
  let openCardSelect = null;
  function closeOpenCardSelect() { if (openCardSelect) { openCardSelect.close(); openCardSelect = null; } }

  // options for a knob-target dropdown: every nameable parameter (value = its
  // address) plus "None", built once from the catalog. Ordered like the app
  // (Chord voice, Harp voice, Space, Play, MIDI, catalog order within each),
  // with a section header per domain, instead of raw sysex-address order.
  let TARGET_OPTS = null;
  const DOMAIN_LABEL = { harp: "Harp", chord: "Chord", play: "Play", space: "Space", midi: "MIDI", knobs: "Knobs" };
  function targetOptions() {
    if (TARGET_OPTS) return TARGET_OPTS;
    const values = [0], labels = ["None"], headers = {};
    const seen = new Set();

    // labels must be unique: Harp and Chord share group titles, and a group's
    // cards repeat names (3 oscillators, two "Envelope" cards), so qualify with
    // domain + group + card. Drop the group when a card already names it (e.g.
    // card "Oscillator 1" under group "Oscillator").
    const DOMAIN_ORDER = [["chord", "Chord voice"], ["harp", "Harp voice"], ["space", "Space"], ["play", "Play"], ["midi", "MIDI"]];
    DOMAIN_ORDER.forEach(([dom, header]) => {
      let first = true;
      PARAM_GROUPS.filter(g => (g.domain || "harp") === dom).forEach(g => g.params.forEach(p => {
        if (p.addr < 21 || p.addr > 219 || p.targetSelect || seen.has(p.addr)) return;
        seen.add(p.addr);
        if (first) { headers[values.length] = header; first = false; }
        const card = p.card && !p.card.toLowerCase().startsWith(g.title.toLowerCase()) ? p.card : null;
        const mid = p.card && !card ? p.card : g.title;   // card subsumes the title when redundant
        values.push(p.addr);
        labels.push([DOMAIN_LABEL[dom], mid, card, p.name].filter(Boolean).join(" · "));
      }));
    });
    // fill any address the grouped catalog doesn't cover yet
    const ADDR_NAMES = window.ADDR_NAMES || {};
    let firstOther = true;
    Object.keys(ADDR_NAMES).map(Number).sort((a, b) => a - b).forEach(a => {
      if (a < 21 || a > 219 || seen.has(a)) return;
      if (firstOther) { headers[values.length] = "Other"; firstOther = false; }
      values.push(a);
      labels.push(ADDR_NAMES[a]);
    });
    TARGET_OPTS = { values, labels, headers };
    return TARGET_OPTS;
  }

  // custom card-style dropdown for enum params, matches the preset browser's
  // dropdown (trigger + floating card of option rows), instead of a native select.
  // `override` ({labels, values}) gives value-mapped options where the stored
  // value isn't the option index (used by knob-target pickers).
  // `selOpts.crumb`: the selected label renders like a pinned row, the name on
  // top, its "Domain · Group · Card" path as a faint crumb line beneath,
  // instead of one long dotted string stretching the trigger.
  function selectControl(p, override, selOpts) {
    selOpts = selOpts || {};
    const wrap = document.createElement("div");
    wrap.className = "card-select";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "card-select-trigger";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.className = "card-select-label";
    const caret = document.createElement("span");
    caret.className = "card-select-caret"; caret.textContent = "▾";
    trigger.append(label, caret);

    const popup = document.createElement("div");
    popup.className = "card-select-popup";
    const list = document.createElement("div");
    list.className = "card-select-list";
    popup.appendChild(list);

    let labels = override ? override.labels.slice() : p.options.slice();
    let values = override ? override.values.slice() : labels.map((_, i) => i);
    let current = patch[p.addr];
    let cb = () => {};
    const optionEls = [];

    // make sure the current value is representable (e.g. a saved knob target the
    // catalog doesn't name yet)
    function ensureValue(v) {
      if (v != null && values.indexOf(v) < 0) {
        values.push(v);
        labels.push((window.ADDR_NAMES && window.ADDR_NAMES[v]) || `Address ${v}`);
      }
    }
    ensureValue(current);

    function buildOptions() {
      list.innerHTML = ""; optionEls.length = 0;
      const headers = override && override.headers;
      labels.forEach((text, i) => {
        if (headers && headers[i] != null) {
          const h = document.createElement("div");
          h.className = "card-select-group-label";
          h.textContent = headers[i];
          list.appendChild(h);
        }
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "card-select-option" + (values[i] === current ? " selected" : "");
        if (selOpts.crumb) {
          // same two-line name + home-path formatting as the selected value
          const parts = text.split(" · ");
          const name = parts.pop() || "";
          opt.innerHTML = `<span class="cs-name">${name}</span>` +
            (parts.length ? `<span class="cs-crumb">${parts.join(" · ")}</span>` : "");
        } else opt.textContent = text;
        opt.title = text;   // long labels ellipsize at the dropdown's width, full text on hover
        opt.addEventListener("click", () => choose(i));
        optionEls.push(opt);
        list.appendChild(opt);
      });
    }
    const refreshLabel = () => {
      const i = values.indexOf(current);
      const text = i >= 0 ? labels[i] : "";
      if (selOpts.crumb) {
        const parts = text.split(" · ");
        const name = parts.pop() || "";
        label.innerHTML = `<span class="cs-name">${name}</span>` +
          (parts.length ? `<span class="cs-crumb">${parts.join(" · ")}</span>` : "");
      } else label.textContent = text;
    };
    const refreshSelected = () => optionEls.forEach((o, i) => o.classList.toggle("selected", values[i] === current));

    function open() {
      closeOpenCardSelect();
      closeParamPop();
      wrap.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");

      // at least the trigger's width (anchorPopup minWidth), and allowed to
      // grow past it so options longer than the selected one stay readable.
      // Capped, and anchorPopup's left/edge clamps keep it on screen
      // 25.14rem ≈ 440px at the default root size, scales with the text-size pref
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 17.5;
      popup.style.maxWidth = Math.round(Math.min(25.1429 * remPx, window.innerWidth - 16)) + "px";
      anchorPopup(trigger, popup);
      openCardSelect = { wrapper: wrap, close };
      // keyboard flow: focus lands on the current choice, arrows walk the list
      const sel = optionEls.find(o => o.classList.contains("selected")) || optionEls[0];
      if (sel) sel.focus();
    }
    function close() { wrap.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); }
    function choose(i) { current = values[i]; refreshLabel(); refreshSelected(); close(); openCardSelect = null; cb(current); trigger.focus(); }

    trigger.addEventListener("click", e => {
      e.stopPropagation();
      if (wrap.classList.contains("open")) { close(); openCardSelect = null; } else open();
    });
    // options are real buttons (Enter/Space select natively). Add list navigation
    popup.addEventListener("keydown", e => {
      if (e.key === "Escape") { close(); openCardSelect = null; trigger.focus(); e.stopPropagation(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const i = optionEls.indexOf(document.activeElement);
      let next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : optionEls.length - 1;
      if (i < 0) next = (e.key === "ArrowUp" || e.key === "End") ? optionEls.length - 1 : 0;
      next = Math.max(0, Math.min(optionEls.length - 1, next));
      optionEls[next].focus();
      e.preventDefault();
    });

    buildOptions(); refreshLabel();
    wrap.append(trigger, popup);

    return {
      el: wrap,
      onChange: fn => { cb = fn; },
      set: v => { ensureValue(v); current = v; refreshLabel(); refreshSelected(); },
      setOptionLabels: newLabels => { labels = newLabels.slice(); values = labels.map((_, i) => i); buildOptions(); refreshLabel(); },
    };
  }

  /* ---- reset-to-preset (revert edits back to the loaded preset) ------------ */
  const presetResetButtons = [];   // buttons that need an active preset (disabled otherwise)
  let presetResetAllBtn = null;

  // decoded raw values (by addr) of the currently-loaded preset, or null
  function activePresetVals() {
    if (activePresetName == null || !window.PresetMatch) return null;
    const preset = window.PresetMatch.all.find(p => p.name === activePresetName);
    return preset ? window.PresetMatch.decode(preset.value) : null;
  }
  // a preset param's value in real units (clamped), or null if absent
  function presetRealValue(p, vals) {
    const raw = vals[p.addr];
    if (raw == null) return null;
    const v = p.type === "float" ? raw / FLOAT_MULT : raw;
    return Math.min(p.max, Math.max(p.min, v));
  }
  // restore the given addresses to the loaded preset (UI + device); preset stays selected
  function resetToPreset(addrs) {
    const vals = activePresetVals();
    if (!vals) return false;
    addrs.forEach(a => {
      const p = paramByAddr[a];
      if (!p || !controls[a]) return;
      const v = presetRealValue(p, vals);
      if (v == null) return;
      controls[a].forEach(fn => fn(v));   // silent UI/patch update (every synced copy)
      sendToDevice(p, v);      // and push to the device when connected
    });
    drawActiveGraph(); renderProfiles(); updateGateFlags();
    return true;
  }
  // set the comparison reference (ghost) to the loaded preset's values
  function resetReferenceToPreset() {
    const vals = activePresetVals();
    if (!vals) return false;
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const v = presetRealValue(p, vals);
      if (v != null) reference[p.addr] = v;
    }));
    if (!showGhost) { showGhost = true; syncToolbars(); }
    drawActiveGraph();
    return true;
  }
  function syncPresetButtons() {
    const on = activePresetName != null;
    presetResetButtons.forEach(b => { b.disabled = !on; });
    if (presetResetAllBtn) presetResetAllBtn.disabled = !on;
  }

  /* ---- reference controls (per graph card, in the middle panel) ----------- */
  function buildGraphToolbar(group) {
    const bar = document.createElement("div");
    bar.className = "graph-toolbar";

    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "mini-btn ghost-toggle" + (showGhost ? " active" : "");
    sw.textContent = "Compare to reference";
    sw.setAttribute("aria-pressed", showGhost ? "true" : "false");
    ghostToggles.push(sw);
    sw.addEventListener("click", () => {
      showGhost = !showGhost; syncToolbars(); drawActiveGraph();
    });

    const setBtn = document.createElement("button");
    setBtn.className = "mini-btn";
    setBtn.textContent = "Set reference";
    setBtn.title = "Snapshot the current settings as the comparison reference";
    setBtn.addEventListener("click", () => {
      snapshotReference();
      if (!showGhost) { showGhost = true; syncToolbars(); }
      flash(setBtn, "Saved");
      drawActiveGraph();
    });

    // set the ghost to the loaded preset, so edits compare against the original
    const refPreset = document.createElement("button");
    refPreset.className = "mini-btn";
    refPreset.textContent = "Reference → preset";
    refPreset.title = "Set the comparison reference to the loaded preset";
    refPreset.addEventListener("click", () => { resetReferenceToPreset(); });
    presetResetButtons.push(refPreset);

    bar.append(sw, setBtn, refPreset);
    return bar;
  }

  /* ---- tab switching + graph drawing -------------------------------------- */
  // detail cards split across the two .detail-col columns, order preserved.
  // The contiguous break point minimises the taller column, ties broken
  // toward MORE cards on the LEFT (the left column always fills first).
  // Heights only measure while the group is visible, so this runs on group
  // switch, resize and text-scale/density changes.
  function balanceDetailCols() {
    const sec = rightRoot.querySelector(".comp-right.active");
    const wrap = sec && sec.querySelector(".detail-cols");
    if (!wrap) return;
    const [colA, colB] = wrap.children;
    Array.from(colB.children).forEach(c => colA.appendChild(c));   // collect, order preserved
    const cards = Array.from(colA.children);
    if (cards.length < 2) return;   // single-stack modes (verbose, narrow) also stop here visually
    const hs = cards.map(c => c.offsetHeight);
    const total = hs.reduce((a, b) => a + b, 0);
    let bestK = cards.length, bestCost = Infinity, run = 0;
    for (let k = 1; k <= cards.length; k++) {   // k = cards kept in the LEFT column
      run += hs[k - 1];
      const cost = Math.max(run, total - run);
      if (cost <= bestCost) { bestCost = cost; bestK = k; }   // <= : ties prefer left
    }
    cards.slice(bestK).forEach(c => colB.appendChild(c));
  }
  function setActiveGroup(id) {
    activeGroupId = id;
    tabsRoot.querySelectorAll(".tab").forEach(t => {
      t.classList.toggle("active", t.dataset.group === id);
      t.setAttribute("aria-selected", t.dataset.group === id ? "true" : "false");
    });
    Object.entries(groupEls).forEach(([gid, els]) => {
      if (els.mid) els.mid.classList.toggle("active", gid === id);
      if (els.right) els.right.classList.toggle("active", gid === id);
    });
    balanceDetailCols();
    drawActiveGraph();
    renderComponentProfile(id);
    updateRoute();
  }

  function drawActiveGraph() {
    if (activeDomain === "overview") { drawOverviewDash(); return; }
    const entry = groupEls[activeGroupId];
    if (!entry || !entry.canvases || !entry.canvases.length || !window.Graphs) return;
    const ref = showGhost ? reference : null;
    requestAnimationFrame(() =>
      entry.canvases.forEach(c => window.Graphs.drawSpec(c.canvas, c.draw, patch, ref)));
  }

  // screen-reader announcements: write into the polite live region (cleared
  // first so repeating the same message is re-announced)
  const srStatus = document.getElementById("sr-status");
  function announce(text) {
    if (!srStatus) return;
    srStatus.textContent = "";
    setTimeout(() => { srStatus.textContent = text; }, 30);
  }

  function flash(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    btn.classList.add("flashed");
    announce(text);
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("flashed"); }, 900);
  }

  /* ---- Sound Profiler ------------------------------------------------------*/
  const overallRoot = document.getElementById("overall-profile");

  // vibe color-coding: each tag maps to a palette family
  const TAG_VIBE = {
    bright: "warm", full: "warm", warm: "warm", open: "warm",
    mellow: "cool", spacious: "cool", roomy: "cool", clean: "cool", balanced: "cool",
    dark: "cold", "very dark": "cold", soft: "cold", swelling: "cold",
    plucky: "muted", percussive: "muted", resonant: "muted", lofi: "muted",
    sustained: "purple", "long tail": "purple", evolving: "purple", sweeping: "purple", subtle: "purple",
    short: "neutral", dry: "neutral", static: "neutral", moderate: "neutral", decaying: "neutral", tight: "neutral",
    // waveform character
    pure: "cool", round: "cool", crisp: "cool",
    buzzy: "muted", crunchy: "muted", nasal: "muted", edgy: "muted", reedy: "muted",
    hollow: "cold", digital: "cold",
    // transient / tremolo / vibrato / delay / general
    pulsing: "purple", shimmer: "cool", deep: "cold", lush: "warm", chromatic: "neutral",
    silent: "neutral", wavering: "purple", echoing: "purple",
    gritty: "muted", breathy: "cool",
  };
  const vibeOf = t => TAG_VIBE[t] || "neutral";

  // per-dimension meter fill color
  const DIM_COLOR = {
    Brightness: "#FAC775", Punch: "#F0A488", Length: "#CABFF4",
    Space: "#9FE1CB", Movement: "#E6B0DE",
  };

  // vibe palettes (mirror the CSS) for blending the signature-name chip color
  const VIBE_BG = { warm: "#6e3f08", cool: "#0b5244", cold: "#1d4778", muted: "#7c3015", purple: "#3a3192", neutral: "#43423d" };
  const VIBE_FG = { warm: "#FBD08C", cool: "#AFE9D5", cold: "#BBD7FB", muted: "#F8CFBE", purple: "#D8D5F8", neutral: "#d2d0c7" };
  const VIBE_BG_LIGHT = { warm: "#FAEBCB", cool: "#D4F0E6", cold: "#DCE8FB", muted: "#F8DCD0", purple: "#E7E4FB", neutral: "#f0efe9" };
  const VIBE_FG_LIGHT = { warm: "#8a5512", cool: "#1c6b56", cold: "#2f5896", muted: "#9c3f1f", purple: "#4a40a8", neutral: "#5f5e57" };

  function mixHex(h1, h2, t) {
    t = t == null ? 0.5 : t;
    const p = h => { h = h.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const a = p(h1), b = p(h2);
    return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }

  function signatureColors(tags) {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    const BG = light ? VIBE_BG_LIGHT : VIBE_BG, FG = light ? VIBE_FG_LIGHT : VIBE_FG;
    if (!tags || !tags.length) return { bg: BG.neutral, fg: FG.neutral };
    const a = vibeOf(tags[0]), b = vibeOf(tags[1] || tags[0]);
    return { bg: mixHex(BG[a], BG[b]), fg: mixHex(FG[a], FG[b]) };
  }

  const glossify = el => { if (window.Glossary && el) window.Glossary.apply(el); };

  /* ---- per-parameter explanation popover (the ⓘ / name-click) --------------
   * One shared fixed element, filled per open with the param's full explanation
   * (definition + effect list + tip + firmware note) and glossified, so terms
   * inside it open the glossary popover ON TOP (#param-pop sits below
   * #gloss-pop in z-index; glossary term clicks stopPropagation, which also
   * keeps this popover open underneath).                                      */
  let paramPopEl = null, paramPopAnchor = null;
  const groupByAddr = {};
  PARAM_GROUPS.forEach(g => g.params.forEach(p => { groupByAddr[p.addr] = g; }));

  // "Domain · Group · Card" home breadcrumb, so a popover opened from Play (or
  // a pinned copy) says where the setting lives in Customize. The card is what
  // tells the three pinned "Amplitude"s apart (Oscillator 1/2/3) or a harp
  // setting from its chord twin; it subsumes the group title when it already
  // names it (same rule as the knob-target labels).
  function paramBreadcrumb(p) {
    const g = groupByAddr[p.addr];
    if (!g) return "";
    const d = domainOf(g);
    const dom = DOMAINS.find(x => x.id === d);
    const domLabel = dom ? dom.label : (DOMAIN_LABEL[d] || "");
    const card = p.card && !p.card.toLowerCase().startsWith(g.title.toLowerCase()) ? p.card : null;
    const mid = p.card && !card ? p.card : g.title;
    return [domLabel, mid, card].filter(Boolean).join(" · ");
  }

  function openParamPop(p, anchorEl) {
    if (!paramPopEl) {
      paramPopEl = document.createElement("div");
      paramPopEl.id = "param-pop";
      paramPopEl.setAttribute("role", "dialog");
      paramPopEl.setAttribute("aria-label", "Setting explanation");
      document.body.appendChild(paramPopEl);
    }
    const crumb = paramBreadcrumb(p);
    paramPopEl.innerHTML =
      `<div class="param-pop-name">${p.name}</div>` +
      (crumb ? `<div class="param-pop-crumb">${crumb}</div>` : "") +
      `<p class="ex-def">${p.explain.is}</p>` + doesHtml(p.explain.does) +
      (p.explain.tips ? `<p class="row-tip"><span>Tip</span> ${p.explain.tips}</p>` : "") +
      (p.fw ? `<p class="fw-warning"><span>⚠</span> Needs firmware v${p.fw}.</p>` : "");
    glossify(paramPopEl);
    paramPopEl.classList.add("open");
    paramPopAnchor = anchorEl;
    positionParamPop();
  }
  function positionParamPop() {
    if (!paramPopEl || !paramPopAnchor) return;
    // measure invisibly, without the fade (reduced motion) a frame painted
    // at the (0,0) measuring spot would flash top-left
    paramPopEl.style.visibility = "hidden";
    paramPopEl.style.left = "0px"; paramPopEl.style.top = "0px";
    const r = paramPopAnchor.getBoundingClientRect();
    const pw = paramPopEl.offsetWidth, ph = paramPopEl.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
    paramPopEl.style.left = left + "px";
    paramPopEl.style.top = Math.max(8, top) + "px";
    paramPopEl.style.visibility = "";
  }
  function closeParamPop() {
    if (paramPopEl) paramPopEl.classList.remove("open");
    paramPopAnchor = null;

    // a glossary definition opened from inside this popover would dangle once
    // its anchor text is gone, close it along with the popover
    if (window.Glossary && window.Glossary.hide) window.Glossary.hide();
  }
  function toggleParamPop(p, anchorEl) {
    const wasOpenHere = paramPopEl && paramPopEl.classList.contains("open") && paramPopAnchor === anchorEl;
    closeParamPop();   // always, also clears a glossary definition left over from another popover
    if (wasOpenHere) return;
    closeOpenCardSelect();
    openParamPop(p, anchorEl);
  }
  window.addEventListener("scroll", () => {
    if (paramPopEl && paramPopEl.classList.contains("open")) positionParamPop();
  }, true);

  // pot-warning chips (.pot-warn, here and inside the device mirror) open the
  // same popover shell with their explanation. Registered BEFORE the global
  // outside-click closer so stopPropagation keeps the toggle clean.
  function openNotePop(text, anchorEl) {
    if (!paramPopEl) {
      paramPopEl = document.createElement("div");
      paramPopEl.id = "param-pop";
      paramPopEl.setAttribute("role", "dialog");
      paramPopEl.setAttribute("aria-label", "Setting explanation");
      document.body.appendChild(paramPopEl);
    }
    paramPopEl.innerHTML = `<p class="ex-def">${text}</p>`;
    glossify(paramPopEl);
    paramPopEl.classList.add("open");
    paramPopAnchor = anchorEl;
    positionParamPop();
  }
  document.addEventListener("click", e => {
    const warn = e.target.closest && e.target.closest(".pot-warn");
    if (!warn) return;

    // BOTH this handler and the outside-click closer live on document.
    // stopPropagation alone would still let the closer run on the same event
    // and instantly close what we just opened (registration order makes this
    // safe: this listener is added first)
    e.stopImmediatePropagation();
    const wasOpenHere = paramPopEl && paramPopEl.classList.contains("open") && paramPopAnchor === warn;
    closeParamPop();
    if (wasOpenHere) return;
    closeOpenCardSelect();
    openNotePop(warn.dataset.note || warn.title, warn);
  });

  /* ---- pin-to-Play ----------------------------------------------------------
   * Any Customize param can be pinned into the Play view's "Pinned controls"
   * card (persisted in Prefs "pins", append order = display order). The pinned
   * copy is a normal renderParam render, so the controls[addr] multi-setter
   * keeps it in sync with its home tab and the device for free. The card is
   * the ONLY place params re-render, so it disposes its children first.     */
  const pinButtons = {};   // addr -> pin-toggle buttons living in Customize rows
  function isPinned(addr) { return Prefs.get("pins").includes(addr); }
  function togglePin(addr) {
    const pins = Prefs.get("pins").slice();
    const i = pins.indexOf(addr);
    if (i >= 0) pins.splice(i, 1); else pins.push(addr);
    Prefs.set("pins", pins);
  }
  function syncPinBtn(btn, on) {
    btn.classList.toggle("pinned", on);
    btn.title = on ? "Unpin from Play" : "Pin to Play";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function refreshPinUI() {
    const pins = new Set(Prefs.get("pins"));
    Object.keys(pinButtons).forEach(addr =>
      pinButtons[addr].forEach(b => syncPinBtn(b, pins.has(Number(addr)))));
  }

  /* ---- locks: addrs shielded from randomize (manual edits stay allowed) --- */
  const lockButtons = {};   // addr -> padlock toggles living in Customize rows
  function isLocked(addr) { return Prefs.get("locks").includes(addr); }
  function toggleLock(addr) {
    const locks = Prefs.get("locks").slice();
    const i = locks.indexOf(addr);
    if (i >= 0) locks.splice(i, 1); else locks.push(addr);
    Prefs.set("locks", locks);
  }
  function syncLockBtn(btn, on) {
    btn.classList.toggle("locked", on);
    btn.title = on ? "Unlock: let randomize change this" : "Lock: randomize won't touch this";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function refreshLockUI() {
    const locks = new Set(Prefs.get("locks"));
    Object.keys(lockButtons).forEach(addr =>
      lockButtons[addr].forEach(b => syncLockBtn(b, locks.has(Number(addr)))));
  }
  Prefs.subscribe("locks", refreshLockUI);

  /* ---- randomize: roll new values for a group / domain / everything -------
   * The roll logic itself (catalog sampling, playability bands, eligibility)
   * lives in random.js, pure and shared with the headless distribution
   * validator. This side owns locks, history, device commits and announce. */
  const RANDOM_SKIP_DOMAINS = window.RandomRoll.SKIP_DOMAINS;
  let lastDeviceNoteT = 0;   // last note-on from the device, set by the controller wiring
  function randomizeGroups(groups, label) {
    const randRefs = [];   // fresh sample pool, picks up custom presets loaded since
    if (window.PresetMatch) window.PresetMatch.all.forEach(pr => {
      try { randRefs.push(window.PresetMatch.decode(pr.value)); } catch (e) { /* skip bad preset */ }
    });
    const style = Prefs.get("randomStyle");
    const locks = new Set(Prefs.get("locks"));
    // rhythm pattern + settings hold when the section padlock is on (default),
    // and ALWAYS while the rhythm is playing. "Playing" = the playhead is
    // locked onto live playback, or device notes in the last 2 s (rolls from
    // Customize, where the playhead tracker is off).
    const rhythmLive = (rhythmSync && rhythmSync.isLive && rhythmSync.isLive())
      || (Date.now() - lastDeviceNoteT < 2000);
    const rhythmHold = rhythmLive || Prefs.get("rhythmLock");
    const before = {}, after = {};
    let n = 0, locked = 0, rhythmHeld = 0;
    groups.forEach(g => {
      g.params.forEach(p => {
        if (!window.RandomRoll.eligible(p, g.domain)) return;
        if (rhythmHold && window.RandomRoll.rhythmParam(p)) { rhythmHeld++; return; }
        if (locks.has(p.addr)) { locked++; return; }
        before[p.addr] = patch[p.addr];
        after[p.addr] = window.RandomRoll.value(p, randRefs, style);
        n++;
      });
    });
    if (!n) { announce("Nothing to randomize. Everything in scope is locked."); return; }
    window.RandomRoll.tameFeedback(after, patch);   // delay-feedback trios must sum below unity
    applyPatchSnapshot(after);
    recordPatchChange("Randomized " + label, before, after);
    scheduleIdentify();
    announce(`Randomized ${n} setting${n === 1 ? "" : "s"} in ${label}`
      + (locked ? `, ${locked} locked setting${locked === 1 ? "" : "s"} kept` : "")
      + (rhythmHeld ? (rhythmLive ? ", rhythm held while it plays" : ", rhythm locked (padlock on the Play screen)") : ""));
  }
  // dice tooltips describe the CURRENT randomize style, composed from the
  // pref and refreshed live when it flips in Preferences
  const diceBtns = new Set();
  function diceTitle(scope) {
    return Prefs.get("randomStyle") === "true"
      ? `${scope}, true random: full ranges, except a roll can never drone on its own (resonance, levels and reverb stay under self-oscillation). Locked settings keep their value.`
      : `${scope}, safe rolls lean on values real presets use (switch to true random in Preferences). Locked settings keep their value.`;
  }
  function setDiceScope(b, scope) {
    b._diceScope = scope;
    b.title = diceTitle(scope);
    b.setAttribute("aria-label", b.title);
  }
  function diceButton(scope, run) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini-btn dice-btn";
    b.textContent = "🎲";
    setDiceScope(b, scope);
    b.addEventListener("click", e => { e.stopPropagation(); run(); });
    diceBtns.add(b);
    return b;
  }
  Prefs.subscribe("randomStyle", () => diceBtns.forEach(b => setDiceScope(b, b._diceScope)));

  let pinnedListEl = null, pinnedEmptyEl = null;
  let playColsEls = null, pinCardA = null, pinCardB = null, pinListB = null;

  /* the pinned rows are the only Note-settings content whose height changes at
   * runtime. To keep the panel as short as possible they SPLIT across the two
   * columns: the column that's shorter without them fills up first, and the
   * remainder spills into a continuation card in the other column. The split
   * point is chosen by minimising the taller column over every contiguous
   * break (order preserved). Heights only measure while Play is visible.    */
  function balancePinnedCards() {
    if (!playColsEls || !pinCardA) return;
    if (!layoutEl || !layoutEl.classList.contains("devicemap")) return;
    // collect every row back into card A (keeps append order), then re-split
    Array.from(pinListB.children).forEach(r => pinnedListEl.appendChild(r));
    pinCardB.style.display = "none";
    // single column (the container query stacked the two columns): there's no second
    // column to balance against, so keep every pin in ONE card, no continuation stub
    if (getComputedStyle(playColsEls[0].parentNode).display !== "flex") {
      playColsEls[1].appendChild(pinCardA);   // sits last in the stacked order
      return;
    }
    const rows = Array.from(pinnedListEl.children);
    const baseH = col => Array.from(col.children)
      .filter(el => el !== pinCardA && el !== pinCardB)
      .reduce((sum, el) => sum + el.offsetHeight, 0);
    const [colL, colR] = playColsEls;
    const hL = baseH(colL), hR = baseH(colR);
    const shortCol = hL <= hR ? colL : colR;
    const longCol = hL <= hR ? colR : colL;
    shortCol.appendChild(pinCardA);
    longCol.appendChild(pinCardB);
    if (!rows.length) return;   // hint-only card sits in the blank column
    const rh = rows.map(r => r.offsetHeight);
    const prefix = [0];
    rh.forEach(h => prefix.push(prefix[prefix.length - 1] + h));
    const total = prefix[rows.length];
    const CHROME = 46;   // approx card padding + title line
    let bestK = rows.length, bestCost = Infinity;
    for (let k = 0; k <= rows.length; k++) {
      const a = Math.min(hL, hR) + (k > 0 ? CHROME + prefix[k] : 0);
      const b = Math.max(hL, hR) + (k < rows.length ? CHROME + total - prefix[k] : 0);
      const cost = Math.max(a, b);
      if (cost < bestCost) { bestCost = cost; bestK = k; }
    }
    if (bestK === 0) {   // everything balances best on the long side, one card, no stub
      longCol.appendChild(pinCardA);
      return;
    }
    if (bestK < rows.length) {
      pinCardB.style.display = "";
      rows.slice(bestK).forEach(r => pinListB.appendChild(r));
    }
  }

  function renderPinnedCard() {
    if (!pinnedListEl) return;
    // rows live in BOTH cards once the balance split has run, dispose both
    Array.from(pinnedListEl.children).forEach(el => { if (el._dispose) el._dispose(); });
    pinnedListEl.innerHTML = "";
    if (pinListB) {
      Array.from(pinListB.children).forEach(el => { if (el._dispose) el._dispose(); });
      pinListB.innerHTML = "";
    }
    // unknown addresses (an older catalog, a typo'd pref) are skipped, not deleted
    const pins = Prefs.get("pins").filter(a => paramByAddr[a]);
    if (pinnedEmptyEl) pinnedEmptyEl.style.display = pins.length ? "none" : "";
    pins.forEach(a => {
      const p = paramByAddr[a];
      const row = renderParam(p, { unpin: true });
      const crumb = document.createElement("p");
      crumb.className = "pin-crumb";
      crumb.textContent = paramBreadcrumb(p);
      const mainEl = row.querySelector(".param-main");
      if (mainEl) mainEl.appendChild(crumb);
      pinnedListEl.appendChild(row);
    });
    glossify(pinnedListEl);
    updateFirmwareWarnings();   // fresh copies start hidden; reflect the connected device
    balancePinnedCards();       // the rows just changed, re-split them across the columns
  }
  Prefs.subscribe("pins", () => { renderPinnedCard(); refreshPinUI(); });

  // wrap each defined flavor word (signature / material / vibe / register) so the
  // headline and the material·vibe line are click-to-define, like the tag chips
  function flavorTerms(text) {
    const defs = (window.Glossary && window.Glossary.TAGDEFS) || {};
    return String(text).split(/\s+/).map(w => {
      const key = w.toLowerCase();
      return defs[key] ? `<span class="flavor-term" data-term="${key}" role="button" tabindex="0">${w}</span>` : w;
    }).join(" ");
  }

  function tagsHtml(tags) {
    if (!tags || !tags.length) return "";
    return "<div class=\"profile-tags\">" +
      tags.map(t => `<span class="tag-chip tag-${vibeOf(t)}" data-term="${t}" role="button" tabindex="0">${t}</span>`).join("") + "</div>";
  }

  // shared profile-card markup (signature chip + tags + feel meters + summary)
  function profileCardHtml(prof) {
    const name = prof.word || window.SoundProfiler.signatureName(prof.tags);
    const sc = signatureColors(prof.tags);
    // don't repeat a tag that's already the flavor name
    const tags = prof.tags.filter(t => t.toLowerCase() !== name.toLowerCase());

    // material · vibe sub-line, show only the axes not already in the headline
    // (when the headline IS the theme, e.g. "Bubbly Watery", this stays empty)
    const nameTokens = new Set(name.toLowerCase().split(/[\s-]+/));
    const axes = prof.theme
      ? [prof.theme.vibe, prof.theme.material].filter(w => w && !nameTokens.has(w.toLowerCase()))
      : [];
    const axesHtml = axes.length ? `<div class="theme-axes">${axes.map(flavorTerms).join(" · ")}</div>` : "";
    return `<div class="signature"><span class="sig-chip" style="background:${sc.bg};color:${sc.fg}">${flavorTerms(name)}</span></div>` +
      axesHtml +
      tagsHtml(tags) +
      "<div class=\"meters\">" + prof.dimensions.map(d =>
        `<div class="meter"><span class="meter-label">${d.label}</span>` +
        `<span class="meter-bar"><i style="width:${d.value}%;background:${DIM_COLOR[d.label] || "var(--accent-line)"}"></i></span>` +
        `<span class="meter-val">${d.value}</span></div>`).join("") + "</div>" +
      `<p class="profile-summary">${prof.summary}</p>`;
  }

  function renderOverallProfile() {
    if (!overallRoot || !window.SoundProfiler) return;
    overallRoot.className = "profile-card";
    overallRoot.innerHTML = profileCardHtml(window.SoundProfiler.overall(patch));
    glossify(overallRoot);
  }

  // per-voice profile cards in the Overview dashboard
  function renderOverviewProfiles() {
    if (!window.SoundProfiler || !window.SoundProfiler.voiceProfile) return;
    overviewProfiles.forEach(({ el, voice }) => {
      el.innerHTML = profileCardHtml(window.SoundProfiler.voiceProfile(patch, voice));
      glossify(el);
    });
  }

  function renderComponentProfile(id) {
    const els = groupEls[id];
    if (!els || !els.prof || !window.SoundProfiler) return;
    const c = window.SoundProfiler.component(id, patch);

    // groups the Profiler doesn't score yet (e.g. transient, tremolo) return no
    // tags/text. Hide the card rather than show an empty "Neutral" chip
    if ((!c.tags || !c.tags.length) && !c.text) { els.prof.style.display = "none"; els.prof.innerHTML = ""; return; }
    els.prof.style.display = "";
    const name = window.SoundProfiler.signatureName(c.tags);
    const sc = signatureColors(c.tags);
    const tags = c.tags.filter(t => t.toLowerCase() !== name.toLowerCase());
    els.prof.innerHTML =
      `<div class="signature"><span class="sig-chip" style="background:${sc.bg};color:${sc.fg}">${flavorTerms(name)}</span></div>` +
      tagsHtml(tags) + `<p class="prof-text">${c.text}</p>`;
    glossify(els.prof);
  }

  function renderProfiles() {
    renderOverallProfile();
    renderOverviewProfiles();
    renderComponentProfile(activeGroupId);
  }

  /* ---- change hook --------------------------------------------------------*/
  // settings that change how buttons/strings map to notes, the "Play" mirror
  // relabels + recomputes its note map when any of these move (key sig, transpose,
  // frame shift, barry harris, sharp/flat, chromatic harp, harp/chord shuffling, slash).
  // Octave change (99/198) shifts audio pitch only, not the emitted MIDI notes, but
  // the labels show the SOUNDING pitch, so it relabels too (matching stays raw-MIDI).
  // 108 (single port) doesn't change note mapping but drives the mirror's warning chip
  // addresses the Play mirror draws from: editing one of these relabels the grid
  // and the strings straight away. 36 is the harp scale mode, 39 the chord
  // layout and 202-208 its slot assignments, 236 the custom scale.
  const DEVICEMAP_ADDRS = new Set([35, 30, 34, 33, 31, 98, 40, 120, 23, 108, 99, 198,
    36, 37, 38, 39, 236, 202, 203, 204, 205, 206, 207, 208]);
  function onPatchChange(p, value) {
    if (p) {   // undo/redo: every committed change records against the previous value
      const before = prevPatch[p.addr];
      prevPatch[p.addr] = value;
      recordSetChange(p, before, value);
    }
    drawActiveGraph();
    updateGateFlags();
    renderProfiles();
    if (deviceMap && p && DEVICEMAP_ADDRS.has(p.addr)) deviceMap.rebuild();
    // the double tap's value control mirrors whatever its target is, so picking
    // a new target has to redraw it
    if (p && p.addr === 200) render();    if (staffView && p && p.addr === 35) staffView.setKey(patch[35] || 0);
    if (p && p.addr === 108) updatePortNotice();
    // re-fingerprint after the edit settles (undo/redo identifies itself at
    // the end of applyHistState, don't double up mid-restore)
    if (!histApplying) scheduleIdentify();
    sendToDevice(p, value);
  }

  /* ---- undo / redo -----------------------------------------------------------
   * One history for every committed change: manual edits, rhythm toggles and
   * trigger fires record per-address entries (drags coalesce); preset loads
   * record one whole-patch snapshot. Device dumps are EXTERNAL state. They
   * only re-baseline prevPatch (via applyParamArray) and are never undoable.
   * Buttons live on the Play screen's Triggers panel; Ctrl+Z / Ctrl+Y are
   * rebindable nav hotkeys, so undo works anywhere in the app.             */
  const HIST_MAX = 100;
  const undoStack = [], redoStack = [];
  let histApplying = false, histLastT = 0;
  let histBtns = null;                          // {undo, redo} buttons, built with the Triggers panel
  let prevPatch = Object.assign({}, patch);     // "before" baseline per address

  function recordSetChange(p, before, after) {
    if (histApplying || before == null || before === after) return;
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    // a slider drag commits per input event, fold the stream into one entry
    if (top && top.kind === "set" && top.addr === p.addr && now - histLastT < 800) top.after = after;
    else {
      undoStack.push({ kind: "set", addr: p.addr, before, after });
      if (undoStack.length > HIST_MAX) undoStack.shift();
    }
    histLastT = now;
    redoStack.length = 0;
    syncHistUI();
  }
  function recordPatchChange(label, before, after) {
    if (histApplying) return;
    undoStack.push({ kind: "patch", label, before, after });
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack.length = 0;
    syncHistUI();
  }
  function histLabel(e) {
    if (e.kind === "patch") return e.label;
    const p = paramByAddr[e.addr];
    return p ? p.name : "#" + e.addr;
  }
  // after undo/redo the editor may once again (or no longer) match a known
  // preset. Re-fingerprint the patch so the preset browser highlight AND the
  // device card's "this slot holds…" line stay honest (the undo pushed the
  // restored state into the device's working memory, but no dump comes back)

  // the knobs a player is EXPECTED to ride mid-performance: Play-screen
  // settings, the rhythm scalars, pinned controls and trigger targets,
  // edits there count 1/4 in the fuzzy fingerprint
  function presetLeewayAddrs() {
    const lee = new Set([187, 188, 189, 190, 191]);   // rhythm scalars
    PLAY_SETTING_CARDS.forEach(c => c.addrs.forEach(a => lee.add(a)));
    Prefs.get("pins").forEach(a => lee.add(a));
    if (window.Triggers) window.Triggers.list().forEach(t =>
      t.do.forEach(a => { if (a.kind === "set") lee.add(a.addr); }));
    return lee;
  }
  function identifyCurrentPatch() {
    if (!window.PresetMatch) return;
    const raw = [];
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      if (patch[p.addr] == null) return;
      raw[p.addr] = p.type === "float" ? Math.round(patch[p.addr] * FLOAT_MULT) : Math.round(patch[p.addr]);
    }));
    const match = window.PresetMatch.identify(raw, presetLeewayAddrs());
    activePresetName = match ? match.preset.name : null;
    activePresetEdited = !!(match && match.edited);
    highlightPresets();
    if (controller && controller.isConnected()) {
      const sp = match ? match.preset : null;            // null renders as "custom / unrecognised"
      if (sp !== slotPreset || activePresetEdited !== slotPresetEdited) {
        slotPreset = sp;
        slotPresetEdited = activePresetEdited;
        updateConnectionUI(true);   // rebuild the device card ONLY when the slot line changed
      }
    }
  }
  // edits re-fingerprint too (debounced past the drag coalescing), the label
  // honestly flips to "(edited)" and back instead of going stale
  let identifyTimer = null;
  function scheduleIdentify() {
    if (identifyTimer) clearTimeout(identifyTimer);
    identifyTimer = setTimeout(() => { identifyTimer = null; identifyCurrentPatch(); }, 300);
  }
  function applyHistState(e, snapKey) {
    histApplying = true;
    try {
      if (e.kind === "set") {
        const p = paramByAddr[e.addr];
        if (p && controls[e.addr]) {
          controls[e.addr].forEach(fn => fn(e[snapKey]));
          prevPatch[e.addr] = e[snapKey];
          onPatchChange(p, e[snapKey]);
        }
      } else {
        applyPatchSnapshot(e[snapKey]);
      }
    } finally { histApplying = false; }
    identifyCurrentPatch();   // the restored state may match a preset again (or stop matching)
  }
  // whole-patch snapshot: write the diffs, then ONE refresh pass (the per-addr
  // onPatchChange path would re-run the profiler per address). Shared by
  // undo/redo of patch entries, randomize and paste-settings.
  function applyPatchSnapshot(snap) {
    let any = false;
    Object.keys(snap).forEach(k => {
      const addr = Number(k), p = paramByAddr[addr];
      if (!p || !controls[addr] || patch[addr] === snap[k]) return;
      controls[addr].forEach(fn => fn(snap[k]));
      prevPatch[addr] = snap[k];
      sendToDevice(p, snap[k]);
      any = true;
    });
    if (any) {
      drawActiveGraph(); renderProfiles(); updateGateFlags(); updatePortNotice();
      if (deviceMap) deviceMap.rebuild();
    }
    return any;
  }
  function undoChange() {
    const e = undoStack.pop();
    if (!e) return;
    applyHistState(e, "before");
    redoStack.push(e);
    syncHistUI();
    announce("Undid " + histLabel(e));
  }
  function redoChange() {
    const e = redoStack.pop();
    if (!e) return;
    applyHistState(e, "after");
    undoStack.push(e);
    syncHistUI();
    announce("Redid " + histLabel(e));
  }
  function syncHistUI() {
    if (!histBtns) return;
    histBtns.undo.disabled = !undoStack.length;
    histBtns.redo.disabled = !redoStack.length;
    histBtns.undo.title = undoStack.length ? `Undo: ${histLabel(undoStack[undoStack.length - 1])} (Ctrl+Z)` : "Nothing to undo";
    histBtns.redo.title = redoStack.length ? `Redo: ${histLabel(redoStack[redoStack.length - 1])} (Ctrl+Y)` : "Nothing to redo";
    histBtns.undo.setAttribute("aria-label", histBtns.undo.title);
    histBtns.redo.setAttribute("aria-label", histBtns.redo.title);
  }
  // the buttons sit beside the left panel's "Device" label, visible in every view
  (function buildHistButtons() {
    const wrap = document.getElementById("hist-actions");
    if (!wrap) return;
    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "mini-btn hist-btn";
    undoBtn.textContent = "↶";
    undoBtn.addEventListener("click", undoChange);
    const redoBtn = document.createElement("button");
    redoBtn.type = "button";
    redoBtn.className = "mini-btn hist-btn";
    redoBtn.textContent = "↷";
    redoBtn.addEventListener("click", redoChange);
    wrap.append(undoBtn, redoBtn);
    histBtns = { undo: undoBtn, redo: redoBtn };
    syncHistUI();
  })();

  /* ---- theme + responsive redraw ------------------------------------------ */
  // the FOUC guard in the <head> already set data-theme from the saved pref;
  // applyTheme keeps the attribute + theme-sensitive renders in step with
  // Prefs. "auto" follows the OS scheme live (the media query can flip
  // mid-session, e.g. a scheduled OS dark mode).
  const lightSchemeMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function applyTheme() {
    const t = Prefs.get("theme");
    const light = t === "light" || (t === "auto" && lightSchemeMq && lightSchemeMq.matches);
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    applyBankAccent();       // "all"-mode accent shades are theme-specific (also redraws graphs)
    renderProfiles();        // re-blend the signature chip for the new theme
    renderPresetsPanel();    // re-tint the preset options for the new theme
  }
  Prefs.subscribe("theme", applyTheme);
  if (lightSchemeMq && lightSchemeMq.addEventListener) lightSchemeMq.addEventListener("change", () => { if (Prefs.get("theme") === "auto") applyTheme(); });

  // explanation density: a pure CSS body-class toggle (params are NEVER
  // re-rendered for it, that would push duplicate setters into controls[]).
  // Graphs repaint because the column widths shift under them.
  function applyDensity() {
    // verbose is a CUSTOMIZE concept. The Play (and About) layouts always
    // render compact, so the class is gated on the active view too
    document.body.classList.toggle("density-verbose",
      Prefs.get("density") === "verbose" && activeViewId === "customize");
    balanceDetailCols();   // card heights change with the density
    drawActiveGraph();
  }
  applyDensity();
  Prefs.subscribe("density", applyDensity);

  // knob-warning badges: a body-class toggle, the chips keep their inline
  // show/hide logic, the class just suppresses them entirely when off
  function applyPotWarnings(on) { document.body.classList.toggle("pot-warn-off", !on); }
  applyPotWarnings(Prefs.get("potWarnings"));
  Prefs.subscribe("potWarnings", applyPotWarnings);

  /* ---- accessibility prefs (the ♿ popup) -----------------------------------
   * Each pref toggles a hook on <html>/<body> that the override blocks at the
   * end of the stylesheet key off. The FOUC guard in index.html pre-applies
   * the same hooks before first paint; these appliers keep them live. Text
   * scale and control size reflow the layout under the graph canvases, which
   * only redraw on window resize, so those two redraw explicitly.          */
  let lastAnchor = null;   // most recent anchorPopup pair, re-anchored when the root font changes
  function applyTextScale(v) {
    if (v === "m") document.documentElement.removeAttribute("data-text");
    else document.documentElement.setAttribute("data-text", v);
    // a popover sized at the old scale keeps stale fixed coordinates. The
    // grown ♿ popup ran off the right edge when changing size from inside it
    if (lastAnchor && lastAnchor.popupEl.classList.contains("open")) anchorPopup(lastAnchor.triggerEl, lastAnchor.popupEl);
    balanceDetailCols();   // card heights change with the text size
    drawActiveGraph();
  }
  applyTextScale(Prefs.get("textScale"));
  Prefs.subscribe("textScale", applyTextScale);

  function applyContrast(v) {
    if (v === "high") document.documentElement.setAttribute("data-contrast", "high");
    else document.documentElement.removeAttribute("data-contrast");
  }
  applyContrast(Prefs.get("contrast"));
  Prefs.subscribe("contrast", applyContrast);

  // "auto" follows the OS setting live (the media query can flip mid-session)
  const reducedMotionMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function applyMotion() {
    const m = Prefs.get("motion");
    const off = m === "on" || (m === "auto" && reducedMotionMq && reducedMotionMq.matches);
    document.documentElement.classList.toggle("motion-off", off);
  }
  applyMotion();
  Prefs.subscribe("motion", applyMotion);
  if (reducedMotionMq && reducedMotionMq.addEventListener) reducedMotionMq.addEventListener("change", applyMotion);

  function applyBigControls(on) {
    document.body.classList.toggle("controls-large", !!on);
    drawActiveGraph();
  }
  applyBigControls(Prefs.get("bigControls"));
  Prefs.subscribe("bigControls", applyBigControls);

  // collapsible left (device / presets / profile) panel: a topbar toggle hides it
  // and zeroes its grid track (--left-col), handing the ~360px to the other columns.
  // The FOUC guard pre-applies the class from the saved pref; this keeps it live.
  const deviceToggleBtn = document.getElementById("device-toggle");
  let leftAnimTimer = null;
  function applyDeviceCollapsed(on) {
    const de = document.documentElement;
    // animate the column resize on real toggles only — not the initial load
    // (anim-ready gates that) and not under reduced motion
    if (de.classList.contains("anim-ready") && !de.classList.contains("motion-off")) {
      de.classList.add("left-animating");
      clearTimeout(leftAnimTimer);
      leftAnimTimer = setTimeout(() => de.classList.remove("left-animating"), 360);
    }
    de.classList.toggle("device-collapsed", !!on);
    if (deviceToggleBtn) {
      deviceToggleBtn.textContent = on ? "»" : "«";   // » show / « hide
      deviceToggleBtn.title = on ? "Show the device panel" : "Hide the device panel";
      deviceToggleBtn.setAttribute("aria-label", deviceToggleBtn.title);
      deviceToggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    // column widths shifted: repaint the graph and re-split the balanced cards,
    // now and again once the width animation has settled
    const settle = () => { drawActiveGraph(); balancePinnedCards(); balanceDetailCols(); };
    settle();
    setTimeout(settle, 360);
  }
  applyDeviceCollapsed(Prefs.get("deviceCollapsed"));
  Prefs.subscribe("deviceCollapsed", applyDeviceCollapsed);
  if (deviceToggleBtn) deviceToggleBtn.addEventListener("click",
    () => Prefs.set("deviceCollapsed", !Prefs.get("deviceCollapsed")));
  // enable the width transition only after first paint, so a saved-collapsed load
  // doesn't animate the panel shut on arrival
  requestAnimationFrame(() => document.documentElement.classList.add("anim-ready"));

  /* ---- segmented "tape-deck" button row ------------------------------------
   * A row of latching buttons with radio behaviour, pressing one releases the
   * others. Shared by the preferences popover and small-enum param controls
   * (segControl). options = [{label, value, title?}].                        */
  function segButtons(options, onPick) {
    const wrap = document.createElement("div");
    wrap.className = "seg";
    const btns = options.map(o => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn";
      b.textContent = o.label;
      if (o.title) b.title = o.title;
      b.addEventListener("click", () => onPick(o.value));
      wrap.appendChild(b);
      return { b, value: o.value };
    });
    return {
      el: wrap,
      set: v => btns.forEach(({ b, value }) => {
        b.classList.toggle("on", value === v);
        b.setAttribute("aria-pressed", value === v ? "true" : "false");
      }),
    };
  }

  /* ---- preferences popover (gear button, top-right) ------------------------ */
  let prefsPopupEl = null;
  const prefsBtn = document.getElementById("prefs-btn");

  // one preference block: name + a one-line hint + its segmented buttons
  function prefRow(label, hint, options, prefKey) {
    const row = document.createElement("div");
    row.className = "pref-row";
    const lab = document.createElement("div");
    lab.className = "pref-label";
    lab.textContent = label;
    row.appendChild(lab);
    if (hint) {
      const h = document.createElement("p");
      h.className = "pref-hint";
      h.textContent = hint;
      row.appendChild(h);
    }
    const seg = segButtons(options, v => Prefs.set(prefKey, v));
    seg.set(Prefs.get(prefKey));
    Prefs.subscribe(prefKey, v => seg.set(v));
    row.appendChild(seg.el);
    return row;
  }

  // accent-color picker: a row of hue swatches bound to the accentHue pref
  // (shared by the preferences popover and the welcome screen)
  const ACCENT_CHOICES = [
    { h: 245, name: "Lavender" }, { h: 210, name: "Blue" }, { h: 175, name: "Teal" },
    { h: 135, name: "Green" }, { h: 45, name: "Gold" }, { h: 25, name: "Orange" },
    { h: 0, name: "Red" }, { h: 320, name: "Pink" },
  ];
  function accentRow(hint) {
    const row = document.createElement("div");
    row.className = "pref-row";
    const lab = document.createElement("div");
    lab.className = "pref-label";
    lab.textContent = "Accent color";
    row.appendChild(lab);
    if (hint) {
      const p = document.createElement("p");
      p.className = "pref-hint";
      p.textContent = hint;
      row.appendChild(p);
    }
    const wrap = document.createElement("div");
    wrap.className = "hue-row";
    const btns = ACCENT_CHOICES.map(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hue-swatch";
      b.title = c.name;
      b.setAttribute("aria-label", c.name);
      b.style.background = hslToHex(c.h, 62, 60);
      b.addEventListener("click", () => Prefs.set("accentHue", c.h));
      wrap.appendChild(b);
      return b;
    });
    // custom hue: a rainbow swatch opens the same hue slider the bank color
    // popup uses (live preview, the accent re-tints as the slider moves)
    const customWrap = document.createElement("span");
    customWrap.className = "color-field accent-custom";
    const rainbow = document.createElement("button");
    rainbow.type = "button";
    rainbow.className = "hue-swatch rainbow";
    rainbow.title = "Custom hue…";
    rainbow.setAttribute("aria-label", "Custom accent hue");
    rainbow.setAttribute("aria-haspopup", "true");
    rainbow.setAttribute("aria-expanded", "false");
    const cpop = document.createElement("div");
    cpop.className = "color-popup";
    const hue = document.createElement("input");
    hue.type = "range";
    hue.className = "hue-slider";
    hue.min = 0; hue.max = 360; hue.step = 1;
    hue.value = String(Prefs.get("accentHue"));
    hue.setAttribute("aria-label", "Custom accent hue");
    hue.addEventListener("input", () => Prefs.set("accentHue", Number(hue.value)));
    cpop.appendChild(hue);
    rainbow.addEventListener("click", () => {
      const open = customWrap.classList.toggle("open");
      rainbow.setAttribute("aria-expanded", open ? "true" : "false");
    });
    customWrap.append(rainbow, cpop);
    wrap.appendChild(customWrap);
    const refresh = v => {
      btns.forEach((b, i) => {
        b.classList.toggle("on", ACCENT_CHOICES[i].h === v);
        b.setAttribute("aria-pressed", ACCENT_CHOICES[i].h === v ? "true" : "false");
      });
      const custom = !ACCENT_CHOICES.some(c => c.h === v);
      rainbow.classList.toggle("on", custom);
      rainbow.setAttribute("aria-pressed", custom ? "true" : "false");
      hue.value = String(v);
    };
    refresh(Prefs.get("accentHue"));
    Prefs.subscribe("accentHue", refresh);
    row.appendChild(wrap);
    return row;
  }

  function buildPrefsPopup() {
    const pop = document.createElement("div");
    pop.className = "prefs-popup prefs-main";   // prefs-main: the only popup with the two-column layout
    const title = document.createElement("h3");
    title.className = "prefs-title";
    title.textContent = "Preferences";
    pop.appendChild(title);
    pop.appendChild(prefRow("Theme", "Interface colors. System follows your OS setting.", [
      { label: "Dark", value: "dark" }, { label: "Light", value: "light" }, { label: "System", value: "auto" },
    ], "theme"));
    pop.appendChild(accentRow("Tint for highlights, buttons and graphs. 'Bank color: Everything' overrides it."));
    pop.appendChild(prefRow("Explanations", "Compact keeps settings short: click a setting's name for details. Verbose writes them out inline.", [
      { label: "Compact", value: "compact" },
      { label: "Verbose", value: "verbose" },
    ], "density"));
    pop.appendChild(prefRow("Harp shape", "How the strings are drawn on the Play screen. Plate lays them out four by three, as they sit on the faceplate.", [
      { label: "Strip", value: "strip" }, { label: "Plate", value: "plate" },
    ], "harpShape"));    pop.appendChild(prefRow("Notation", "Show a staff under the Play mirror with what you are playing, its key signature and the chord's roman numeral.", [
      { label: "Show", value: "on" }, { label: "Hide", value: "off" },
    ], "staffShow"));
    pop.appendChild(prefRow("Term highlights", "Underline glossary words in descriptions (click to define).", [
      { label: "On", value: true }, { label: "Off", value: false },
    ], "glossary"));
    pop.appendChild(prefRow("Open at", "Which view loads on start.", [
      { label: "Play", value: "play" }, { label: "Customize", value: "customize" },
      { label: "Last used", value: "last" },
    ], "startView"));
    pop.appendChild(prefRow("Bank color", "What the device's bank color tints in the app.", [
      { label: "Off", value: "none", title: "Tints nothing. Playing visuals use the default accent" },
      { label: "Playing", value: "play", title: "Tints the device mirror and rhythm grid (default)" },
      { label: "Everything", value: "all", title: "All accents across the app take the bank color" },
    ], "bankAccent"));
    pop.appendChild(prefRow("Randomize style", "How the dice roll new values. Rolls never make sound on their own, and a playing rhythm is never touched.", [
      { label: "Safe", value: "safe", title: "Weighted toward values real presets use, with loudness and tail guardrails (default)" },
      { label: "True random", value: "true", title: "Uniform across full ranges. Harsh results welcome, but a roll can never make sound on its own (self-oscillation stays capped)" },
    ], "randomStyle"));
    pop.appendChild(prefRow("Knob warnings", "The ! badge shown when a physical knob can affect what's displayed.", [
      { label: "On", value: true }, { label: "Off", value: false },
    ], "potWarnings"));
    pop.appendChild(prefRow("Welcome screen", "The first-visit intro with quick setup.", [
      { label: "Show on next load", value: true }, { label: "Hidden", value: false },
    ], "welcome"));
    pop.addEventListener("click", e => e.stopPropagation());   // clicks inside don't close it
    document.body.appendChild(pop);
    return pop;
  }

  /* ---- accessibility popover (♿ button, left of the gear) ------------------ */
  let a11yPopupEl = null;
  const a11yBtn = document.getElementById("a11y-btn");

  function buildA11yPopup() {
    const pop = document.createElement("div");
    pop.className = "prefs-popup";
    const title = document.createElement("h3");
    title.className = "prefs-title";
    title.textContent = "Accessibility";
    pop.appendChild(title);
    pop.appendChild(prefRow("Text size", "Scales the whole interface.", [
      { label: "Small", value: "s" }, { label: "Default", value: "m" },
      { label: "Large", value: "l" }, { label: "Larger", value: "xl" },
    ], "textScale"));
    pop.appendChild(prefRow("Reduce motion", "Turns off animations and fades. Auto follows your system's reduce-motion setting.", [
      { label: "Auto", value: "auto" }, { label: "On", value: "on" }, { label: "Off", value: "off" },
    ], "motion"));
    pop.appendChild(prefRow("High contrast", "Brighter secondary text, stronger edges, and selection marked by shape as well as color.", [
      { label: "Off", value: "normal" }, { label: "On", value: "high" },
    ], "contrast"));
    pop.appendChild(prefRow("Larger controls", "Bigger buttons, sliders and click targets.", [
      { label: "Off", value: false }, { label: "On", value: true },
    ], "bigControls"));
    pop.addEventListener("click", e => e.stopPropagation());   // clicks inside don't close it
    document.body.appendChild(pop);
    return pop;
  }

  /* ---- keyboard shortcuts popover (⌨ button) --------------------------------
   * One row per action: label + a key chip. Clicking the chip arms a one-shot
   * capture (hotkeys.js, capture phase). The next key pressed becomes the
   * binding. Conflicts are rejected with a message naming the holder; Backspace
   * (or the × button) disables an action; "Reset all" clears every override. */
  let hkPopupEl = null, hkPopupRefresh = null;
  const hkBtn = document.getElementById("hotkeys-btn");

  function buildHotkeysPopup() {
    const pop = document.createElement("div");
    pop.className = "prefs-popup hk-popup";
    const title = document.createElement("h3");
    title.className = "prefs-title";
    title.textContent = "Keyboard shortcuts";
    pop.appendChild(title);
    const hint = document.createElement("p");
    hint.className = "pref-hint";
    hint.textContent = "Click a key to rebind it. Single keys or Ctrl / Alt / Shift combos all work "
      + "(G, 5, ?, Ctrl+Shift+K); Esc, Enter, Tab, Space and the arrows are reserved. "
      + "Backspace disables, Esc cancels. Press ? anywhere for the overview.";
    pop.appendChild(hint);
    const err = document.createElement("p");
    err.className = "save-error";
    pop.appendChild(err);

    const list = document.createElement("div");
    list.className = "hk-list";
    pop.appendChild(list);

    let armedChip = null;   // {el, id} while waiting for the new key
    function renderList() {
      armedChip = null;
      list.innerHTML = "";
      let lastGroup = null;
      window.Hotkeys.actions().forEach(a => {
        if (a.group !== lastGroup) {
          lastGroup = a.group;
          const g = document.createElement("div");
          g.className = "preset-group-label";
          g.textContent = a.group;
          list.appendChild(g);
        }
        const row = document.createElement("div");
        row.className = "hk-row";
        const lab = document.createElement("span");
        lab.className = "hk-label";
        lab.textContent = a.label;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "hk-chip" + (a.combo ? "" : " off");
        chip.textContent = a.combo || "off";
        chip.title = "Click, then press the new key";
        chip.setAttribute("aria-label", `Shortcut for ${a.label}: ${a.combo || "disabled"}, click to change`);
        chip.addEventListener("click", () => startCapture(a, chip));
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "hk-clear";
        clear.textContent = "×";
        clear.title = "Disable this shortcut";
        clear.setAttribute("aria-label", `Disable shortcut for ${a.label}`);
        clear.style.visibility = a.combo ? "" : "hidden";
        clear.addEventListener("click", () => { err.textContent = ""; window.Hotkeys.setBinding(a.id, ""); renderList(); });
        row.append(lab, chip, clear);
        list.appendChild(row);
      });
    }
    function startCapture(a, chip) {
      err.textContent = "";
      if (armedChip && armedChip.el !== chip) {   // re-arm: restore the chip left waiting
        armedChip.el.textContent = window.Hotkeys.bindingFor(armedChip.id) || "off";
        armedChip.el.classList.remove("capturing");
      }
      armedChip = { el: chip, id: a.id };
      chip.textContent = "Press a key…";
      chip.classList.add("capturing");
      window.Hotkeys.capture(res => {
        armedChip = null;
        if (res && res.clear) window.Hotkeys.setBinding(a.id, "");
        else if (res && res.reserved) err.textContent =
          `${res.reserved} is reserved. Esc, Enter, Tab, Space and the arrow keys can't be shortcuts.`;
        else if (res) {
          const r = window.Hotkeys.setBinding(a.id, res.combo);
          if (!r.ok) err.textContent = r.reason === "conflict"
            ? `${res.combo} already runs “${r.conflict.label}”. Clear that one first.`
            : "That key can't be used as a shortcut.";
        }
        renderList();
      });
    }

    const foot = document.createElement("div");
    foot.className = "hk-foot";
    const trigBtn = document.createElement("button");
    trigBtn.type = "button";
    trigBtn.className = "mini-btn";
    trigBtn.textContent = "Triggers…";
    trigBtn.title = "Custom triggers: chords, strings, timers and keys that change settings or load presets";
    trigBtn.addEventListener("click", () => { closeHkPopup(); openTrigSheet(); });
    const sheetBtn = document.createElement("button");
    sheetBtn.type = "button";
    sheetBtn.className = "mini-btn";
    sheetBtn.textContent = "Cheat sheet";
    sheetBtn.addEventListener("click", toggleHkSheet);
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "mini-btn";
    resetBtn.textContent = "Reset all";
    resetBtn.title = "Restore every shortcut to its default";
    resetBtn.addEventListener("click", () => { err.textContent = ""; window.Hotkeys.resetAll(); renderList(); });
    foot.append(trigBtn, sheetBtn, resetBtn);
    pop.appendChild(foot);

    renderList();
    hkPopupRefresh = renderList;
    pop.addEventListener("click", e => e.stopPropagation());   // clicks inside don't close it
    document.body.appendChild(pop);
    return pop;
  }

  /* ---- "?" cheat-sheet: modal overlay listing every current binding -------- */
  let hkSheetEl = null, hkSheetPrevFocus = null;

  function renderHkSheet() {
    const card = hkSheetEl.querySelector(".hk-sheet-card");
    const groups = new Map();
    window.Hotkeys.actions().forEach(a => {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    });
    let html = "<h3 class=\"prefs-title\">Keyboard shortcuts</h3><div class=\"hk-sheet-grid\">";
    groups.forEach((acts, g) => {
      html += `<div class="hk-sheet-col"><div class="preset-group-label">${g}</div>` +
        acts.map(a => `<div class="hk-row"><span class="hk-label">${a.label}</span>` +
          `<kbd class="hk-chip${a.combo ? "" : " off"}">${a.combo || "off"}</kbd></div>`).join("") +
        "</div>";
    });
    html += "</div><p class=\"pref-hint\">Rebind these from the ⌨ button in the top bar. Press ? or Esc to close.</p>" +
      "<button type=\"button\" class=\"mini-btn hk-sheet-close\">Close</button>";
    card.innerHTML = html;
    card.querySelector(".hk-sheet-close").addEventListener("click", closeHkSheet);
  }
  function buildHkSheet() {
    const overlay = document.createElement("div");
    overlay.className = "hk-sheet";
    const card = document.createElement("div");
    card.className = "hk-sheet-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Keyboard shortcuts");
    card.addEventListener("click", e => e.stopPropagation());
    overlay.appendChild(card);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeHkSheet(); });
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); closeHkSheet(); }
      else if (e.key === "Tab") { e.preventDefault(); const c = overlay.querySelector(".hk-sheet-close"); if (c) c.focus(); }
    });
    document.body.appendChild(overlay);
    return overlay;
  }
  function openHkSheet() {
    hkSheetPrevFocus = document.activeElement;
    if (!hkSheetEl) hkSheetEl = buildHkSheet();
    renderHkSheet();   // always fresh, bindings may have changed since last open
    hkSheetEl.classList.add("open");
    window.Hotkeys.setSuspended(true);   // the sheet handles its own keys while open
    const c = hkSheetEl.querySelector(".hk-sheet-close");
    if (c) c.focus();
  }
  function closeHkSheet() {
    if (!hkSheetEl || !hkSheetEl.classList.contains("open")) return;
    hkSheetEl.classList.remove("open");
    window.Hotkeys.setSuspended(false);
    if (hkSheetPrevFocus && hkSheetPrevFocus.focus) hkSheetPrevFocus.focus();
    hkSheetPrevFocus = null;
  }
  function toggleHkSheet() {
    if (hkSheetEl && hkSheetEl.classList.contains("open")) closeHkSheet(); else openHkSheet();
  }

  /* ============================================================================
   * Custom triggers: WHEN <event> DO <action> (engine: triggers.js)
   *
   * The engine owns the data, matching and arming; this section owns the DOM:
   * the ⚡ arm toggle on the Play screen (built in render()), the editor modal
   * (.trig-sheet overlay) and the action executor. Event feeds are wired where
   * each source lives: keyboard through hotkeys.js's dynamic table, rhythm
   * steps via rhythmSync.onStep, chord/pluck from the device mirror.
   * ========================================================================== */
  let armBtnEl = null;
  let trigCardEl = null, trigCardListEl = null, trigCardEmptyEl = null;   // the Play screen's "Triggers" card

  // the Play card lists ALL triggers (off rows dim in place). The row body
  // opens that trigger's editor, the pill and × toggle/delete without leaving
  // Play. Events render as hk-chips so the card matches the editor's vocabulary.
  function renderPlayTrigCard() {
    if (!trigCardListEl) return;
    const all = window.Triggers.list();
    trigCardEmptyEl.style.display = all.length ? "none" : "";
    trigCardListEl.innerHTML = "";
    all.forEach(t => {
      const row = document.createElement("div");
      row.className = "trig-active-row" + (t.on ? "" : " off");
      row.dataset.tid = t.id;
      const summary = `${trigWhenLabel(t.when)} → ${trigDoLabel(t.do, t)}`;
      const onBtn = document.createElement("button");
      onBtn.type = "button";
      onBtn.className = "mini-btn trig-on" + (t.on ? " active" : "");
      onBtn.textContent = t.on ? "On" : "Off";
      onBtn.setAttribute("aria-pressed", t.on ? "true" : "false");
      onBtn.setAttribute("aria-label", `Trigger ${t.on ? "enabled" : "disabled"}, click to ${t.on ? "disable" : "enable"}: ${summary}`);
      onBtn.addEventListener("click", () => window.Triggers.setEnabled(t.id, !t.on));
      const body = document.createElement("button");
      body.type = "button";
      body.className = "trig-row-body";
      body.title = "Edit this trigger";
      body.addEventListener("click", () => openTrigSheet(t.id));
      const w = document.createElement("span");
      w.className = "trig-active-when";
      const evs = Array.isArray(t.when) ? t.when : t.when ? [t.when] : [];
      (evs.length ? evs : [null]).forEach((ev, i) => {
        if (i) {
          const or = document.createElement("span");
          or.className = "trig-active-or";
          or.textContent = "or";
          w.appendChild(or);
        }
        const chip = document.createElement("span");
        chip.className = "hk-chip trig-active-ev" + (ev ? "" : " off");
        chip.textContent = trigEventLabel(ev);
        w.appendChild(chip);
      });
      const arrow = document.createElement("span");
      arrow.className = "trig-active-arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      const a = document.createElement("span");
      a.className = "trig-active-do";
      a.textContent = trigDoLabel(t.do, t);
      a.title = trigDoLabel(t.do, t);
      body.append(w, arrow, a);
      if (t.on && t.when.some(x => x.kind === "steps" || x.kind === "seconds")) {
        const cd = document.createElement("span");   // live countdown while armed
        cd.className = "trig-countdown";
        body.appendChild(cd);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "hk-clear";
      del.textContent = "×";
      del.title = "Delete this trigger";
      del.setAttribute("aria-label", `Delete trigger: ${summary}`);
      del.addEventListener("click", () => { window.Triggers.remove(t.id); announce("Trigger deleted"); });
      row.append(onBtn, body, del);
      trigCardListEl.appendChild(row);
    });
    updateTrigCountdowns();
  }

  // live countdowns on the Play card's timer rows (ticks only while armed)
  let trigTickTimer = null;
  function updateTrigCountdowns() {
    if (!trigCardListEl) return;
    const armed = window.Triggers.isArmed();
    const info = armed ? window.Triggers.timerInfo() : [];
    trigCardListEl.querySelectorAll(".trig-active-row").forEach(row => {
      const cd = row.querySelector(".trig-countdown");
      if (!cd) return;
      const mine = info.filter(x => x.id === row.dataset.tid);
      // resting = an alternation off-phase interval (counts down, won't fire);
      // a fire limit shows how many fires remain before the trigger stops
      let txt = !mine.length ? "" : mine.map(x => x.done ? "done"
        : (x.kind === "seconds" ? `${x.left}s` : `${x.left} step${x.left === 1 ? "" : "s"}`)
          + (x.resting ? " (rest)" : "")).join(" · ");
      if (armed && txt) {
        const leftN = window.Triggers.firesLeft(row.dataset.tid);
        if (leftN != null) txt += ` · ${leftN} left`;
      }
      cd.textContent = txt;
    });
  }

  function syncArmBtn() {
    if (!armBtnEl) return;
    const armed = window.Triggers.isArmed();
    const n = window.Triggers.activeCount();
    if (trigCardEl) trigCardEl.classList.toggle("armed", armed);   // built after the first sync, hence the guard
    armBtnEl.textContent = armed ? `⚡ Armed (${n})` : "⚡ Arm";
    armBtnEl.classList.toggle("armed", armed);
    armBtnEl.setAttribute("aria-pressed", armed ? "true" : "false");
    armBtnEl.title = armed
      ? `Triggers are live (${n} active), app hotkeys are paused. Click to disarm`
      : "Start your custom triggers (they stay off until armed, every visit)";
    armBtnEl.setAttribute("aria-label", armBtnEl.title);
  }

  // the trigger executor: both action kinds route through the app's normal
  // paths, so UI copies, profiles, graphs and the device all stay in sync.
  // Set actions either jump to a fixed value or STEP the current value (by an
  // amount or % of range) with an edge policy: clamp, wrap, or bounce.
  const trigBounceDir = new Map();   // "triggerId:addr" -> ±1, reset on arming
  const trigWalkPos = new Map();     // preset-walk position per (trigger, list), reset on arming
  function trigParamRange(p) {
    // enums don't always carry min/max. Their range is the option indices
    return p.options ? { lo: 0, hi: p.options.length - 1 } : { lo: p.min, hi: p.max };
  }
  function runTriggerAction(doSpec, trigger) {
    if (doSpec.kind === "set") {
      const p = paramByAddr[doSpec.addr];
      if (!p || !controls[doSpec.addr]) return false;
      const range = trigParamRange(p);
      let lo = range.lo, hi = range.hi;
      let v;
      if (doSpec.mode === "inc") {
        // optional user-picked travel ends (bounce/loop within a sub-range)
        if (doSpec.lo != null) lo = Math.max(lo, Math.min(doSpec.lo, doSpec.hi != null ? doSpec.hi : hi));
        if (doSpec.hi != null) hi = Math.min(hi, Math.max(doSpec.hi, lo));
        const cur = patch[doSpec.addr] != null ? patch[doSpec.addr] : lo;
        let step = doSpec.unit === "pct" ? (hi - lo) * (doSpec.by / 100) : doSpec.by;
        // a step below the param's representable quantum would round straight
        // back to the current value ("Shuffle +0.14%" never moved), every
        // fire travels at least one quantum
        const q = (p.options || p.type === "int") ? 1 : p.step;
        if (q && Math.abs(step) < q) step = (step < 0 ? -1 : 1) * q;
        const dirKey = (trigger ? trigger.id : "?") + ":" + doSpec.addr;
        if (doSpec.edge === "bounce") step *= (trigBounceDir.get(dirKey) || 1);
        v = cur + step;
        if (doSpec.edge === "wrap") { if (v > hi) v = lo; else if (v < lo) v = hi; }
        else if (doSpec.edge === "bounce") {
          if (v >= hi) { v = hi; trigBounceDir.set(dirKey, -1); }
          else if (v <= lo) { v = lo; trigBounceDir.set(dirKey, 1); }
        }
      } else if (doSpec.mode === "alt") {
        // alternate: land on `a` unless we're already there, then flip to `b`
        const cur = patch[doSpec.addr];
        const norm = x => ((p.options || p.type === "int") ? Math.round(x) : roundTo(x, p.step));
        v = norm(cur) === norm(doSpec.a) ? doSpec.b : doSpec.a;
      } else if (doSpec.mode === "rand") {
        // random in range (or the user's lo–hi sub-range), fresh every fire
        if (doSpec.lo != null) lo = Math.max(lo, Math.min(doSpec.lo, doSpec.hi != null ? doSpec.hi : hi));
        if (doSpec.hi != null) hi = Math.min(hi, Math.max(doSpec.hi, lo));
        v = (p.options || p.type === "int")
          ? Math.ceil(lo) + Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1))
          : lo + Math.random() * (hi - lo);
      } else v = doSpec.value;
      v = Math.min(hi, Math.max(lo, v));
      v = (p.options || p.type === "int") ? Math.round(v) : roundTo(v, p.step);
      if (doSpec.mode === "inc" && v === patch[doSpec.addr]) return false;   // already pinned at an edge
      controls[doSpec.addr].forEach(fn => fn(v));
      onPatchChange(p, v);
      return true;
    }
    if (doSpec.kind === "preset") {
      // single name loads every fire; a names list WALKS in order per fire
      // (position resets on arming) or, with pick "rand", rolls one each fire
      const names = Array.isArray(doSpec.names) ? doSpec.names : [doSpec.name];
      let name = names[0];
      if (names.length > 1 && doSpec.pick === "rand") {
        name = names[Math.floor(Math.random() * names.length)];
      } else if (names.length > 1) {
        const key = (trigger ? trigger.id : "?") + ":walk:" + names.join("|");
        const pos = trigWalkPos.get(key) || 0;
        name = names[pos % names.length];
        trigWalkPos.set(key, (pos + 1) % names.length);
      }
      // resolved by NAME at fire time, custom presets load async and reorder indices
      const idx = window.PresetMatch ? window.PresetMatch.all.findIndex(pr => pr.name === name) : -1;
      if (idx < 0) { announce(`Trigger preset "${name}" not found`); return false; }
      loadPreset(idx);   // announces "Loaded preset …" itself
      return true;
    }
    return false;
  }

  /* ---- summary labels (chips in the editor + fire announcements) ---------- */
  const TRIG_COLS = ["F", "C", "G", "D", "A", "E", "B"];   // faceplate columns, left→right
  const TRIG_TYPE_LABEL = {
    major: "major", minor: "minor", seventh: "7th",
    maj_seventh: "maj 7th", min_seventh: "min 7th", dim: "dim", aug: "aug",
  };
  function trigEventLabel(w) {
    if (!w) return "(not set)";
    if (w.kind === "key") return w.combo || "(not set)";
    if (w.kind === "chord") {
      const slash = Number.isInteger(w.slashCol) ? `/${TRIG_COLS[w.slashCol] || "?"}` : "";
      return `${TRIG_COLS[w.col] || "?"}${w.sharp ? "♯" : ""}${slash} ${TRIG_TYPE_LABEL[w.type] || w.type}`
        + (w.strength === "any" ? " (incl. inferred)" : "");
    }
    if (w.kind === "pluck") return `String ${w.string + 1}`;
    if (w.kind === "steps" || w.kind === "seconds") {
      const unit = w.kind === "steps" ? "step" : "second";
      // alternation: fire y intervals, rest x, "(alternating)" for the 1/1 case
      const alt = (w.altOn || w.altOff)
        ? ((w.altOn || 1) === 1 && (w.altOff || 1) === 1 ? " (alternating)" : ` (${w.altOn || 1} on / ${w.altOff || 1} off)`)
        : "";
      return `${w.once ? "Once after" : "Every"} ${w.every} ${unit}${w.every === 1 ? "" : "s"}${alt}`;
    }
    return "(not set)";
  }
  // a trigger's events read as alternatives: any one of them fires it
  function trigWhenLabel(when) {
    const evs = Array.isArray(when) ? when : when ? [when] : [];
    return evs.length ? evs.map(trigEventLabel).join(" or ") : "(not set)";
  }
  function trigActionLabel(d) {
    if (!d) return "(not set)";
    if (d.kind === "preset") {
      const names = Array.isArray(d.names) ? d.names : d.name ? [d.name] : [];
      if (!names.length) return "Load a preset (pick one)";
      if (names.length === 1) return `Load "${names[0]}"`;
      return d.pick === "rand" ? `One of ${names.map(n => `"${n}"`).join(" / ")} (random)`
        : `Walk ${names.map(n => `"${n}"`).join(" → ")}`;
    }
    if (d.kind === "set") {
      const p = paramByAddr[d.addr];
      if (!p) return `Set #${d.addr}`;
      // twins ("Amplitude" ×3 oscillators, harp/chord pairs) carry their card
      const pname = p.card && p.card.toLowerCase() !== p.name.toLowerCase() ? `${p.name} (${p.card})` : p.name;
      if (d.mode === "inc") {
        const ends = (d.lo != null || d.hi != null) ? ` ${d.lo != null ? d.lo : "min"}–${d.hi != null ? d.hi : "max"}` : "";
        const edge = d.edge === "wrap" ? ` (loop${ends})` : d.edge === "bounce" ? ` (bounce${ends})`
          : ends ? ` (within${ends})` : "";
        if (p.options && d.unit === "abs" && Math.abs(d.by) === 1)
          return `${pname} ${d.by > 0 ? "next" : "previous"}${edge}`;
        const amt = d.unit === "pct" ? `${d.by > 0 ? "+" : ""}${d.by}%` : `${d.by > 0 ? "+" : ""}${d.by}${p.unit || ""}`;
        return `${pname} ${amt}${edge}`;
      }
      const optName = v => (p.options && p.options[Math.round(v)] != null ? p.options[Math.round(v)] : `${p.type === "int" ? Math.round(v) : v}${p.options ? "" : p.unit || ""}`);
      if (d.mode === "alt") return `${pname} ⇄ ${optName(d.a)} / ${optName(d.b)}`;
      if (d.mode === "rand") {
        const ends = (d.lo != null || d.hi != null) ? ` ${d.lo != null ? d.lo : "min"}–${d.hi != null ? d.hi : "max"}` : "";
        return `${pname} ? (random${ends})`;
      }
      return `${pname} → ${optName(d.value)}`;
    }
    return "(not set)";
  }
  // a trigger's actions all run together: read them as a sum (or a roll of the
  // dice when the trigger picks one at random); the fire limit reads last
  function trigDoLabel(doList, t) {
    const acts = Array.isArray(doList) ? doList : doList ? [doList] : [];
    let s = acts.length ? acts.map(trigActionLabel).join(acts.length > 1 && t && t.doPick === "one" ? " / " : " + ") : "(not set)";
    if (acts.length > 1 && t && t.doPick === "one") s = `1 of ${acts.length}: ${s}`;
    if (t && t.limit) s += ` (stops after ${t.limit})`;
    return s;
  }

  /* ---- editor modal (.trig-sheet, hk-sheet conventions) -------------------- */
  let trigSheetEl = null, trigSheetPrevFocus = null;
  let trigEditing = null;   // {id: existing id | null}, one editor open at a time

  // target options for the action picker: the knob-target list minus "None"
  // and minus addr 108 (single-port mode kills the trigger input stream, a
  // trigger must not be able to disable its own ears)
  let TRIG_TARGET_OPTS = null;
  function trigTargetOptions() {
    if (TRIG_TARGET_OPTS) return TRIG_TARGET_OPTS;
    const base = targetOptions();
    const labels = [], values = [], headers = {};
    let pendingHeader = null;
    base.values.forEach((v, i) => {
      if (base.headers[i] != null) pendingHeader = base.headers[i];
      if (v === 0 || v === 108) return;
      if (pendingHeader) { headers[values.length] = pendingHeader; pendingHeader = null; }
      values.push(v);
      labels.push(base.labels[i]);
    });
    TRIG_TARGET_OPTS = { labels, values, headers };
    return TRIG_TARGET_OPTS;
  }

  /* rich preset picker for the trigger editor, the same rounded cards as the
   * main preset browser (groups, author, color-coded profile chip), plus an
   * upload that lands in the SHARED custom list, so an uploaded preset shows
   * up in the main browser too (and vice versa). */
  function trigPresetPicker(currentName, onPick) {
    const wrap = document.createElement("div");
    wrap.className = "trig-preset-wrap";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "preset-trigger";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    const tlabel = document.createElement("span");
    tlabel.className = "preset-trigger-label";
    tlabel.textContent = currentName || "Choose a preset…";
    const caret = document.createElement("span");
    caret.className = "preset-caret";
    caret.textContent = "▾";
    trigger.append(tlabel, caret);
    const pop = document.createElement("div");
    pop.className = "preset-dropdown trig-preset-pop";
    let outsideClose = null;
    const close = () => {
      pop.style.display = "";
      trigger.setAttribute("aria-expanded", "false");
      if (outsideClose) { document.removeEventListener("click", outsideClose, true); outsideClose = null; }
    };
    const renderList = () => {
      pop.innerHTML = "";
      const scroll = document.createElement("div");
      scroll.className = "preset-scroll";
      const all = window.PresetMatch ? window.PresetMatch.all : [];
      const customCount = (window.PresetMatch && window.PresetMatch.custom || []).length;
      const groups = [["Custom", []], ["Community", []], ["Built-in defaults", []]];
      all.forEach((p, i) => {
        if (i < customCount) groups[0][1].push(i);
        else if (/^Default Preset/.test(p.name)) groups[2][1].push(i);
        else groups[1][1].push(i);
      });
      groups.forEach(([label, idxs]) => {
        if (!idxs.length) return;
        const lab = document.createElement("div");
        lab.className = "preset-group-label";
        lab.textContent = label;
        scroll.appendChild(lab);
        idxs.forEach(i => {
          const preset = all[i];
          const meta = presetMeta[i] || { profileName: "", fg: "", bg: "" };
          const card = document.createElement("button");
          card.type = "button";
          card.className = "preset-item" + (preset.name === currentName ? " active" : "");
          if (preset.description) card.title = preset.description;
          card.innerHTML =
            `<span class="preset-name">${preset.name}</span>` +
            "<span class=\"preset-meta\">" +
              `<span class="preset-by">${preset.author || ""}</span>` +
              (meta.profileName ? `<span class="preset-profile" style="background:${meta.bg};color:${meta.fg}">${meta.profileName}</span>` : "") +
            "</span>";
          card.addEventListener("click", () => { close(); onPick(preset.name); });
          scroll.appendChild(card);
        });
      });
      pop.appendChild(scroll);
      const foot = document.createElement("div");
      foot.className = "preset-actions";
      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "mini-btn";
      upBtn.textContent = "Upload preset…";
      upBtn.title = "Load a .json preset from your computer. It joins the Custom list everywhere, including the main preset browser";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".json,application/json";
      fileInput.multiple = true;
      fileInput.style.display = "none";
      fileInput.addEventListener("change", () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = "";
        if (!files.length) return;
        let pending = files.length;
        const collected = [];
        const done = () => {
          if (--pending > 0 || !collected.length) return;
          addCustomPresets(collected, false);   // shared custom list, the main browser re-renders too
          close();
          onPick(collected[0].name);            // the upload becomes this trigger's preset
        };
        files.forEach(file => {
          const reader = new FileReader();
          reader.onload = () => { try { presetsFromJson(JSON.parse(reader.result)).forEach(p => collected.push(p)); } catch (e) {} done(); };
          reader.onerror = done;
          reader.readAsText(file);
        });
      });
      upBtn.addEventListener("click", () => fileInput.click());
      // pasting works too: a preset .json, copied settings text or a bare
      // preset string becomes a Custom preset and is picked for this trigger
      const pasteBtn = document.createElement("button");
      pasteBtn.type = "button";
      pasteBtn.className = "mini-btn";
      pasteBtn.textContent = "Paste preset…";
      pasteBtn.title = "Use a preset from the clipboard: a preset .json, copied settings text or a preset string";
      pasteBtn.addEventListener("click", () => {
        if (!(navigator.clipboard && navigator.clipboard.readText)) {
          announce("Clipboard read is blocked in this browser. Use Paste settings, then \"Save current as preset…\".");
          return;
        }
        navigator.clipboard.readText().then(t => {
          const pr = presetFromText(t);
          if (!pr) { announce("Couldn't read the clipboard as a preset. Copy a preset .json, settings text or a preset string."); return; }
          addCustomPresets([pr], false);   // joins Custom everywhere, like uploads
          close();
          onPick(pr.name);
          announce(`Added "${pr.name}" to Custom presets`);
        }, () => announce("Couldn't read the clipboard. The browser blocked it."));
      });
      foot.append(upBtn, fileInput, pasteBtn);
      pop.appendChild(foot);
    };
    trigger.addEventListener("click", () => {
      if (pop.style.display === "block") { close(); return; }
      renderList();
      pop.style.display = "block";
      trigger.setAttribute("aria-expanded", "true");
      anchorPopup(trigger, pop);
      outsideClose = e => { if (!wrap.contains(e.target)) close(); };
      document.addEventListener("click", outsideClose, true);
    });
    wrap.append(trigger, pop);
    return wrap;
  }

  function buildTrigSheet() {
    const overlay = document.createElement("div");
    overlay.className = "trig-sheet";
    const card = document.createElement("div");
    card.className = "trig-sheet-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Custom triggers");
    card.addEventListener("click", e => {
      e.stopPropagation();   // clicks inside never reach the document closers…
      // …so close a floating explanation popover ourselves (its own anchor
      // clicks stopPropagation before this runs)
      if (paramPopEl && paramPopEl.classList.contains("open") && !paramPopEl.contains(e.target)
          && !(e.target.closest && e.target.closest("#gloss-pop"))) closeParamPop();
    });
    card.innerHTML =
      "<h3 class=\"prefs-title\">Custom triggers</h3>" +
      "<p class=\"pref-hint\"><b>When</b> any of a trigger's events happens (a chord, a string, a key, a timer), " +
      "it runs all its actions: set settings, load a preset. Triggers only fire while <b>⚡ armed</b> " +
      "(Play screen, always off after a reload), and Ctrl+Z undoes whatever they do.</p>";
    const list = document.createElement("div");
    list.className = "trig-list";
    card.appendChild(list);
    const foot = document.createElement("div");
    foot.className = "trig-foot";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "mini-btn primary trig-add";
    addBtn.textContent = "+ Add trigger";
    addBtn.addEventListener("click", () => {
      window.Triggers.cancelCapture();
      trigEditing = { id: null };
      renderTrigList();
      // this button hides while editing, keep focus from dropping to <body>
      const first = trigSheetEl.querySelector(".trig-editor button, .trig-editor input");
      if (first) first.focus();
    });
    // save/load: triggers otherwise live only in this browser's storage
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "mini-btn trig-import";
    importBtn.textContent = "Import…";
    importBtn.title = "Load triggers from a JSON file (added to the current list)";
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json,.json";
    importInput.style.display = "none";
    importBtn.addEventListener("click", () => { importInput.value = ""; importInput.click(); });
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let arr = [];
        try {
          const j = JSON.parse(reader.result);
          arr = j && Array.isArray(j.soundlab_triggers) ? j.soundlab_triggers : Array.isArray(j) ? j : [];
        } catch (e) { /* not JSON, falls through to the 0-imported message */ }
        const n = window.Triggers.importTriggers(arr);
        announce(n ? `Imported ${n} trigger${n === 1 ? "" : "s"}` : "No triggers found in that file");
      };
      reader.readAsText(file);
    });
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "mini-btn trig-export";
    exportBtn.textContent = "Export";
    exportBtn.title = "Download all triggers as a JSON file";
    exportBtn.addEventListener("click", () => {
      const all = window.Triggers.list();
      const blob = new Blob([JSON.stringify({ soundlab_triggers: all }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "minichord-triggers.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      announce(`Exported ${all.length} trigger${all.length === 1 ? "" : "s"}`);
    });
    const footLeft = document.createElement("span");
    footLeft.className = "trig-foot-left";
    footLeft.append(addBtn, importBtn, exportBtn, importInput);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mini-btn trig-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeTrigSheet);
    foot.append(footLeft, closeBtn);
    card.appendChild(foot);
    overlay.appendChild(card);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeTrigSheet(); });
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // explanation popovers close first. Esc peels one layer at a time
        if (document.querySelector("#gloss-pop.open")) { window.Glossary.hide(); return; }
        if (paramPopEl && paramPopEl.classList.contains("open")) { closeParamPop(); return; }
        closeTrigSheet();
        return;
      }
      if (e.key !== "Tab") return;   // welcome-style trap: Tab cycles within the card
      const focusables = Array.from(card.querySelectorAll("button:not(:disabled), input, [tabindex]:not([tabindex=\"-1\"])"));
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      const inside = card.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { first.focus(); e.preventDefault(); }
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function renderTrigList() {
    if (!trigSheetEl) return;
    const listEl = trigSheetEl.querySelector(".trig-list");
    listEl.innerHTML = "";
    const all = window.Triggers.list();
    // the card is COMPACT while empty and grows to the fixed frame for the
    // first editor, the one place it ever resizes; editing hides + Add
    const card = trigSheetEl.querySelector(".trig-sheet-card");
    card.classList.toggle("empty", !all.length && !trigEditing);
    card.classList.toggle("editing", !!trigEditing);
    if (!all.length && !trigEditing) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No triggers yet. Add one below.";
      listEl.appendChild(empty);
    }
    all.forEach(t => {
      if (trigEditing && trigEditing.id === t.id) { listEl.appendChild(buildTrigEditor(t)); return; }
      const row = document.createElement("div");
      row.className = "trig-row" + (t.on ? "" : " off");
      const onBtn = document.createElement("button");
      onBtn.type = "button";
      onBtn.className = "mini-btn trig-on" + (t.on ? " active" : "");
      onBtn.textContent = t.on ? "On" : "Off";
      onBtn.setAttribute("aria-pressed", t.on ? "true" : "false");
      onBtn.setAttribute("aria-label", `Trigger ${t.on ? "enabled" : "disabled"}, click to ${t.on ? "disable" : "enable"}`);
      onBtn.addEventListener("click", () => window.Triggers.setEnabled(t.id, !t.on));
      const whenChip = document.createElement("button");
      whenChip.type = "button";
      whenChip.className = "hk-chip trig-when";
      whenChip.textContent = trigWhenLabel(t.when);
      whenChip.title = "Edit this trigger";
      whenChip.addEventListener("click", () => { window.Triggers.cancelCapture(); trigEditing = { id: t.id }; renderTrigList(); });
      const doBtn = document.createElement("button");
      doBtn.type = "button";
      doBtn.className = "trig-do";
      doBtn.textContent = trigDoLabel(t.do, t);
      doBtn.title = "Edit this trigger";
      doBtn.addEventListener("click", () => { window.Triggers.cancelCapture(); trigEditing = { id: t.id }; renderTrigList(); });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "hk-clear";
      del.textContent = "×";
      del.title = "Delete this trigger";
      del.setAttribute("aria-label", "Delete this trigger");
      del.addEventListener("click", () => window.Triggers.remove(t.id));
      row.append(onBtn, whenChip, doBtn, del);
      listEl.appendChild(row);
    });
    if (trigEditing && trigEditing.id === null) listEl.appendChild(buildTrigEditor(null));
  }

  /* one trigger's edit panel: WHEN kind + per-kind config, DO kind + config */
  function buildTrigEditor(existing) {
    const draft = {   // engine normalises both to lists
      when: existing ? JSON.parse(JSON.stringify(existing.when)) : [],
      do: existing ? JSON.parse(JSON.stringify(existing.do)) : [],
      doPick: existing && existing.doPick === "one" ? "one" : "all",
      limit: existing && existing.limit ? existing.limit : null,
    };
    const panel = document.createElement("div");
    panel.className = "trig-editor";
    const err = document.createElement("p");
    err.className = "save-error";
    const hintP = text => {
      const p = document.createElement("p");
      p.className = "pref-hint";
      p.textContent = text;
      return p;
    };

    /* WHEN: the trigger's events. ANY of them fires it. */
    const whenLab = document.createElement("div");
    whenLab.className = "pref-label";
    whenLab.textContent = "When any of these happens…";
    const evList = document.createElement("div");
    evList.className = "trig-ev-list";
    function renderEvents() {
      evList.innerHTML = "";
      if (!draft.when.length) {
        const none = document.createElement("span");
        none.className = "pref-hint";
        none.textContent = "No events yet. Add one below.";
        evList.appendChild(none);
        return;
      }
      draft.when.forEach((w, i) => {
        const wrap = document.createElement("span");
        wrap.className = "trig-ev-wrap";
        const chip = document.createElement("span");
        chip.className = "hk-chip trig-ev";
        chip.textContent = trigEventLabel(w);
        const x = document.createElement("button");
        x.type = "button";
        x.className = "hk-clear";
        x.textContent = "×";
        x.title = "Remove this event";
        x.setAttribute("aria-label", `Remove event: ${trigEventLabel(w)}`);
        x.addEventListener("click", () => { draft.when.splice(i, 1); renderEvents(); refreshSave(); });
        wrap.append(chip, x);
        evList.appendChild(wrap);
      });
    }
    function pushEvent(w) {
      err.classList.remove("note");   // any fresh message starts as a real error again
      const label = trigEventLabel(w);
      if (draft.when.some(x => trigEventLabel(x) === label)) {
        err.textContent = "That event is already on this trigger.";
        return;
      }
      err.textContent = "";
      draft.when.push(w);
      renderEvents();
      refreshSave();
    }

    /* add-event flow: pick a kind, then capture / configure it */
    const addLab = hintP("Add an event:");
    addLab.classList.add("trig-add-lab");
    const KINDS = [
      { label: "Key", value: "key", title: "A keyboard shortcut" },
      { label: "Chord", value: "chord", title: "A chord shape on the minichord, button combos included" },
      { label: "Harp string", value: "pluck", title: "Plucking one of the 12 harp strings" },
      { label: "Timer", value: "timer", title: "Every N rhythm steps or seconds, repeating or one-shot" },
    ];
    const whenCfg = document.createElement("div");
    whenCfg.className = "trig-cfg";
    const kindSeg = segButtons(KINDS, k => {
      window.Triggers.cancelCapture();
      trigSheetCaptureMode(false);
      err.textContent = "";
      kindSeg.set(k);
      renderWhenCfg(k);
    });

    function captureChip(text, arm) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hk-chip";
      chip.textContent = text;
      chip.addEventListener("click", () => {
        err.textContent = "";
        chip.textContent = "Waiting…";
        chip.classList.add("capturing");
        arm();
      });
      return chip;
    }

    function renderWhenCfg(k) {
      whenCfg.innerHTML = "";
      if (!k) return;
      if (k === "key") {
        const chip = captureChip("Press a key…", () => {
          window.Hotkeys.capture(res => {
            if (res && res.reserved) err.textContent =
              `${res.reserved} is reserved. Esc, Enter, Tab, Space and the arrow keys can't be triggers.`;
            else if (res && res.combo) {
              const nav = window.Hotkeys.actions().find(a => a.combo === res.combo);
              const other = window.Triggers.list().find(t => (!existing || t.id !== existing.id)
                && t.when.some(w => w.kind === "key" && w.combo === res.combo));
              if (other) err.textContent = `${res.combo} is already used by another trigger.`;
              else {
                // sharing a nav shortcut is FINE: nav keys pause while triggers
                // are armed (the trigger wins), and the trigger key only exists
                // while armed (nav wins when disarmed), just say so
                pushEvent({ kind: "key", combo: res.combo });
                if (nav) {
                  err.textContent = `Heads-up: ${res.combo} is also "${nav.label}". While armed, your trigger wins; disarmed, the shortcut works as usual.`;
                  err.classList.add("note");
                }
              }
            }
            renderWhenCfg(k);
          });
        });
        whenCfg.appendChild(chip);
        whenCfg.appendChild(hintP("Single keys or Ctrl / Alt / Shift combos all work: G, 5, ?, Ctrl+5, Ctrl+Shift+G. "
          + "Esc, Enter, Tab, Space and the arrows are reserved. Never fires while you're typing."));
      } else if (k === "chord") {
        let strength = "strong";
        const chip = captureChip("Play or click a chord…", () => {
          let lastLabel = "";
          trigSheetCaptureMode(true, "Play or click the chord, then press \"Use this chord\". Esc cancels",
            () => renderWhenCfg(k), { confirmLabel: "Use this chord" });
          window.Triggers.captureNext("chord", c => {
            trigSheetCaptureMode(false);
            // slashCol: a captured C/E fires only on C/E; a captured plain C
            // (slashCol null) fires only on plain C. Old saves match any slash
            pushEvent({ kind: "chord", col: c.col, type: c.type, sharp: !!c.sharp, strength,
              slashCol: c.slashCol === undefined ? null : c.slashCol });
            renderWhenCfg(k);
          }, shape => {
            // combos build up (maj+7th → maj7); NOTHING locks in by itself.
            // The user always confirms with the Use button. shape = null is a
            // release/deselect: the built shape survives, keep showing it.
            if (shape) lastLabel = trigEventLabel(Object.assign({ kind: "chord" }, shape));
            trigSheetCaptureToast(lastLabel + ". Press \"Use this chord\" to lock it in, or keep adjusting");
          });
        });
        whenCfg.appendChild(chip);
        const sSeg = segButtons([
          { label: "Strong match", value: "strong", title: "Fires only on a chord you actually press or click" },
          { label: "Also inferred", value: "any", title: "Also fires when the Lab deduces the chord from a harp strum or a running rhythm pattern" },
        ], v => { strength = v; sSeg.set(v); });
        sSeg.set(strength);
        whenCfg.appendChild(sSeg.el);
        whenCfg.appendChild(hintP("The shape is the physical buttons (combos count: maj+min = dim), so it works in every key. "
          + "Split chords count too. Capture C/E and only C/E fires it. Nothing is added until you press \"Use this chord\"."));
      } else if (k === "pluck") {
        const chip = captureChip("Pluck or click a string…", () => {
          trigSheetCaptureMode(true, "Pluck the string, or click its plate on the mirror. Esc cancels",
            () => renderWhenCfg(k));
          window.Triggers.captureNext("pluck", s => {
            trigSheetCaptureMode(false);
            pushEvent({ kind: "pluck", string: s });
            renderWhenCfg(k);
          });
        });
        whenCfg.appendChild(chip);
        const sel = selectControl({ addr: -1 }, {
          labels: Array.from({ length: 12 }, (_, i) => `String ${i + 1}`),
          values: Array.from({ length: 12 }, (_, i) => i),
        });
        sel.onChange(s => { pushEvent({ kind: "pluck", string: s }); });
        whenCfg.appendChild(sel.el);
        whenCfg.appendChild(hintP("String 1 is the lowest plate."));
      } else if (k === "timer") {
        let unit = "steps", once = false;
        const uSeg = segButtons([
          { label: "Rhythm steps", value: "steps", title: "Counts the rhythm playhead, only while the rhythm runs on the Play screen" },
          { label: "Seconds", value: "seconds", title: "Plain clock time, counted from the moment you arm" },
        ], u => { unit = u; uSeg.set(u); });
        uSeg.set(unit);
        const oSeg = segButtons([
          { label: "Repeats", value: false, title: "Fires every N, again and again" },
          { label: "Once", value: true, title: "Fires a single time after N, then waits for the next arming" },
        ], v => { once = v; oSeg.set(v); });
        oSeg.set(once);
        const num = document.createElement("input");
        num.type = "number";
        num.className = "save-field trig-every";
        num.min = "1"; num.max = "3600"; num.value = "16";
        num.setAttribute("aria-label", "Count N");
        // alternation: fire y consecutive intervals, rest x, repeat. "16 ticks
        // of action, 16 ticks of rest" is every:16 with 1 on / 1 off
        let alt = false;
        const mkCount = label => {
          const f = document.createElement("input");
          f.type = "number";
          f.className = "save-field trig-every";
          f.min = "1"; f.max = "999"; f.value = "1";
          f.setAttribute("aria-label", label);
          return f;
        };
        const altOnF = mkCount("Fire this many intervals"), altOffF = mkCount("Then rest this many");
        const altRow = document.createElement("div");
        altRow.className = "trig-timer-row trig-alt-row";
        const altLab = t => { const s = document.createElement("span"); s.className = "hk-label"; s.textContent = t; return s; };
        altRow.append(altLab("fire"), altOnF, altLab("then rest"), altOffF);
        altRow.style.display = "none";
        const aSeg = segButtons([
          { label: "Every time", value: false, title: "Fires on every completed interval" },
          { label: "Alternate", value: true, title: "Fires some intervals, rests others, e.g. 16 steps on, 16 steps off" },
        ], v => { alt = v; aSeg.set(v); altRow.style.display = v ? "" : "none"; });
        aSeg.set(alt);
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "mini-btn primary";
        addBtn.textContent = "Add timer";
        addBtn.addEventListener("click", () => {
          const n = Math.max(1, Math.min(3600, Math.round(Number(num.value) || 0)));
          const ev = once ? { kind: unit, every: n, once: true } : { kind: unit, every: n };
          if (alt && !once) {
            ev.altOn = Math.max(1, Math.min(999, Math.round(Number(altOnF.value) || 1)));
            ev.altOff = Math.max(1, Math.min(999, Math.round(Number(altOffF.value) || 1)));
          }
          pushEvent(ev);
        });
        const wrap = document.createElement("div");
        wrap.className = "trig-timer-row";
        const every = document.createElement("span");
        every.className = "hk-label";
        every.textContent = "count";
        wrap.append(uSeg.el, oSeg.el, every, num, addBtn);
        whenCfg.appendChild(wrap);
        whenCfg.appendChild(aSeg.el);
        whenCfg.appendChild(altRow);
        whenCfg.appendChild(hintP("Steps need the rhythm playing; seconds count from arming. "
          + "Alternate fires a stretch of intervals then rests one. On/off rhythm patterns without extra triggers."));
      }
    }

    /* DO: the trigger's actions. ALL run on fire (bulk updates). Picking from
     * the dropdown adds the setting straight to the right-hand card, where it
     * renders as a FULL control row (real slider/options, live value, and the
     * setting's definition), adjustable in place. */
    const doLab = document.createElement("div");
    doLab.className = "pref-label";
    doLab.textContent = "…do all of this";
    const actList = document.createElement("div");
    actList.className = "trig-act-card";
    // run every action, or pick ONE at random per fire (a choice only once
    // there are two actions to choose from)
    function syncDoLab() {
      doLab.textContent = draft.doPick === "one" && draft.do.length > 1
        ? "…do ONE of these, at random" : "…do all of this";
    }
    const doPickSeg = segButtons([
      { label: "Run all", value: "all", title: "Every action runs on each fire, in order" },
      { label: "One at random", value: "one", title: "Each fire picks a single action from the list at random" },
    ], v => { draft.doPick = v; doPickSeg.set(v); syncDoLab(); });
    doPickSeg.set(draft.doPick);
    syncDoLab();
    function renderActions() {
      doPickSeg.el.style.display = draft.do.length > 1 ? "" : "none";
      syncDoLab();
      actList.innerHTML = "";
      if (!draft.do.length) {
        const none = document.createElement("p");
        none.className = "empty-note pin-hint";
        none.textContent = "Nothing yet. Pick a setting or a preset on the left and it lands here.";
        actList.appendChild(none);
        return;
      }
      draft.do.forEach((a, i) => {
        const row = document.createElement("div");
        row.className = "trig-act-row";
        const head = document.createElement("div");
        head.className = "trig-act-head";
        const name = document.createElement("span");
        name.className = "trig-act-name";
        const x = document.createElement("button");
        x.type = "button";
        x.className = "hk-clear";
        x.textContent = "×";
        x.title = "Remove this action";
        x.setAttribute("aria-label", `Remove action: ${trigActionLabel(a)}`);
        x.addEventListener("click", () => { draft.do.splice(i, 1); renderActions(); refreshSave(); });
        if (a.kind === "set") {
          const p = paramByAddr[a.addr];
          name.textContent = p ? p.name : `#${a.addr}`;
          if (p && p.explain) {
            // same affordance as everywhere else: the name opens the full
            // explanation popover (elevated above the sheet via CSS)
            name.classList.add("param-name-text", "has-info");
            name.title = "What is this?";
            name.setAttribute("role", "button");
            name.setAttribute("aria-haspopup", "dialog");
            name.tabIndex = 0;
            name.addEventListener("click", e => { e.stopPropagation(); toggleParamPop(p, name); });
            name.addEventListener("keydown", e => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleParamPop(p, name); }
            });
          }
          head.append(name, x);
          row.appendChild(head);
          if (p) {
            // "Amplitude" exists on every oscillator and both voices. The
            // home breadcrumb (Domain · Group · Card) tells the twins apart
            const crumb = document.createElement("p");
            crumb.className = "pin-crumb";
            crumb.textContent = paramBreadcrumb(p);
            row.appendChild(crumb);
            // jump to a fixed value, STEP from wherever the setting is now,
            // flip between two values, or roll a fresh random one per fire.
            // The mode seg rides the head row's free space, beside the ×
            const curMode = ["inc", "alt", "rand"].includes(a.mode) ? a.mode : "fix";
            const modeSeg = segButtons([
              { label: "Set to", value: "fix", title: "Jump the setting to a fixed value" },
              { label: "Step", value: "inc", title: "Nudge the setting from wherever it is, every fire moves it again" },
              { label: "A/B", value: "alt", title: "Alternate between two values, every fire flips to the other one" },
              { label: "Random", value: "rand", title: "Roll a fresh random value on every fire" },
            ], m => {
              if (m === curMode) return;
              const r = trigParamRange(p);
              if (m === "inc") draft.do[i] = { kind: "set", addr: a.addr, mode: "inc",
                by: p.options ? 1 : (p.step || Math.round(((r.hi - r.lo) / 10) * 100) / 100),
                unit: "abs", edge: "clamp" };
              else if (m === "alt") draft.do[i] = { kind: "set", addr: a.addr, mode: "alt", a: r.lo, b: r.hi };
              else if (m === "rand") draft.do[i] = { kind: "set", addr: a.addr, mode: "rand" };
              else draft.do[i] = { kind: "set", addr: a.addr, value: p.def };
              renderActions(); refreshSave();
            });
            modeSeg.set(curMode);
            head.insertBefore(modeSeg.el, x);
            const ctl = document.createElement("div");
            ctl.className = "trig-act-control";
            if (a.mode === "inc") {
              // stepping nudges from wherever the setting IS, show that too,
              // as the real live control (edits commit exactly like the
              // instrument's own row, and Ctrl+Z applies)
              const liveLab = document.createElement("div");
              liveLab.className = "pin-crumb";
              liveLab.textContent = "Current value (live control):";
              const live = document.createElement("div");
              live.className = "trig-act-control";
              if (p.options) {
                const lc = segWorthy(p) ? segControl(p) : selectControl(p);
                lc.onChange(v => { (controls[a.addr] || []).forEach(fn => fn(v)); onPatchChange(p, v); });
                live.appendChild(lc.el);
              } else {
                const lc = sliderControl(p);
                const ro = document.createElement("span");
                ro.className = "param-value";
                ro.innerHTML = formatValue(p, patch[a.addr]);
                lc.onChange(v => { (controls[a.addr] || []).forEach(fn => fn(v)); onPatchChange(p, v); ro.innerHTML = formatValue(p, v); });
                attachValueEdit(p, ro, () => patch[a.addr], v => {
                  (controls[a.addr] || []).forEach(fn => fn(v));
                  onPatchChange(p, v);
                  lc.set(v);
                  ro.innerHTML = formatValue(p, v);
                });
                live.append(lc.el, ro);
              }
              row.appendChild(liveLab);
              row.appendChild(live);
              if (p.options) {
                const dirSeg = segButtons([
                  { label: "Previous", value: -1 }, { label: "Next", value: 1 },
                ], v => { a.by = v; dirSeg.set(v); });
                dirSeg.set(a.by > 0 ? 1 : -1);
                ctl.appendChild(dirSeg.el);
              } else {
                const r = trigParamRange(p);
                const by = document.createElement("input");
                by.type = "number";
                by.className = "save-field trig-every";
                by.step = "any";
                by.value = String(a.by);
                by.setAttribute("aria-label", "Step amount");
                // the amount is bounded by the unit: ±range in units, ±100 in %
                const byLimit = () => a.unit === "pct" ? 100 : r.hi - r.lo;
                const syncByBounds = () => { by.min = String(-byLimit()); by.max = String(byLimit()); };
                const clampBy = () => {
                  const n = Number(by.value);
                  if (!isFinite(n) || n === 0) return;
                  a.by = Math.max(-byLimit(), Math.min(byLimit(), n));
                  by.value = String(a.by);
                };
                syncByBounds();
                by.addEventListener("input", () => { const n = Number(by.value); if (isFinite(n) && n !== 0) a.by = n; });
                by.addEventListener("change", clampBy);
                const unitSeg = segButtons([
                  { label: p.unit || "units", value: "abs" }, { label: "% of range", value: "pct" },
                ], u => { a.unit = u; unitSeg.set(u); syncByBounds(); clampBy(); });
                unitSeg.set(a.unit);
                ctl.append(by, unitSeg.el);
              }
              // amount, unit and edge policy share one wrapping row
              const edgeSeg = segButtons([
                { label: "Stop at ends", value: "clamp", title: "Sticks at the travel ends" },
                { label: "Loop", value: "wrap", title: "Past the end jumps back to the other side" },
                { label: "Bounce", value: "bounce", title: "Reverses direction at the ends" },
              ], e2 => { a.edge = e2; edgeSeg.set(e2); });
              edgeSeg.set(a.edge);
              ctl.appendChild(edgeSeg.el);
              // the travel ENDS are pickable (bounce between 90 and 140 bpm);
              // blank = the parameter's own min/max
              if (!p.options) {
                const r = trigParamRange(p);
                const ends = document.createElement("span");
                ends.className = "trig-ends";
                const mkEnd = (key, what, def) => {
                  const f = document.createElement("input");
                  f.type = "number";
                  f.className = "save-field trig-every";
                  f.step = String(p.step || "any");
                  f.min = String(r.lo); f.max = String(r.hi);
                  f.placeholder = String(def);
                  if (a[key] != null) f.value = String(a[key]);
                  f.setAttribute("aria-label", `${what} travel end`);
                  f.addEventListener("change", () => {
                    const n = Number(f.value);
                    if (f.value === "" || !isFinite(n)) { delete a[key]; f.value = ""; }
                    else { a[key] = Math.min(r.hi, Math.max(r.lo, n)); f.value = String(a[key]); }
                    if (a.lo != null && a.hi != null && a.lo > a.hi) {   // keep the ends ordered
                      const t = a.lo; a.lo = a.hi; a.hi = t;
                      loF.value = String(a.lo); hiF.value = String(a.hi);
                    }
                  });
                  return f;
                };
                const endsLab = t => {
                  const s = document.createElement("span");
                  s.className = "trig-ends-lab";
                  s.textContent = t;
                  return s;
                };
                const loF = mkEnd("lo", "Lower", r.lo), hiF = mkEnd("hi", "Upper", r.hi);
                ends.append(endsLab("between"), loF, endsLab("and"), hiF);
                ctl.appendChild(ends);
              }
              row.appendChild(ctl);
            } else if (a.mode === "alt") {
              // two draft values, flipped on every fire, compact pickers
              const r = trigParamRange(p);
              const mkVal = (key, what) => {
                const wrapEl = document.createElement("span");
                wrapEl.className = "trig-ends";
                const lab = document.createElement("span");
                lab.className = "trig-ends-lab";
                lab.textContent = what;
                if (p.options) {
                  const vc = segWorthy(p) ? segControl(p) : selectControl(p);
                  vc.set(Math.round(a[key]));
                  vc.onChange(v => { a[key] = v; });
                  wrapEl.append(lab, vc.el);
                } else {
                  const f = document.createElement("input");
                  f.type = "number";
                  f.className = "save-field trig-every";
                  f.step = String(p.step || "any");
                  f.min = String(r.lo); f.max = String(r.hi);
                  f.value = String(a[key]);
                  f.setAttribute("aria-label", `Value ${what}`);
                  f.addEventListener("change", () => {
                    const n = Number(f.value);
                    if (isFinite(n)) a[key] = Math.min(r.hi, Math.max(r.lo, n));
                    f.value = String(a[key]);
                  });
                  wrapEl.append(lab, f);
                }
                return wrapEl;
              };
              ctl.append(mkVal("a", "A"), mkVal("b", "B"));
              row.appendChild(ctl);
            } else if (a.mode === "rand") {
              // optional roll range, blank ends mean the setting's own min/max
              if (!p.options) {
                const r = trigParamRange(p);
                const ends = document.createElement("span");
                ends.className = "trig-ends";
                const mkEnd = (key, what, def) => {
                  const f = document.createElement("input");
                  f.type = "number";
                  f.className = "save-field trig-every";
                  f.step = String(p.step || "any");
                  f.min = String(r.lo); f.max = String(r.hi);
                  f.placeholder = String(def);
                  if (a[key] != null) f.value = String(a[key]);
                  f.setAttribute("aria-label", `${what} roll end`);
                  f.addEventListener("change", () => {
                    const n = Number(f.value);
                    if (f.value === "" || !isFinite(n)) { delete a[key]; f.value = ""; }
                    else { a[key] = Math.min(r.hi, Math.max(r.lo, n)); f.value = String(a[key]); }
                    if (a.lo != null && a.hi != null && a.lo > a.hi) {
                      const t = a.lo; a.lo = a.hi; a.hi = t;
                      loF.value = String(a.lo); hiF.value = String(a.hi);
                    }
                  });
                  return f;
                };
                const endsLab = t => {
                  const s = document.createElement("span");
                  s.className = "trig-ends-lab";
                  s.textContent = t;
                  return s;
                };
                const loF = mkEnd("lo", "Lower", r.lo), hiF = mkEnd("hi", "Upper", r.hi);
                ends.append(endsLab("roll between"), loF, endsLab("and"), hiF);
                ctl.appendChild(ends);
              } else {
                const note = document.createElement("span");
                note.className = "trig-ends-lab";
                note.textContent = "rolls any option";
                ctl.appendChild(note);
              }
              row.appendChild(ctl);
            } else {
              if (p.options) {
                const vc = segWorthy(p) ? segControl(p) : selectControl(p);
                vc.set(Math.round(a.value));
                vc.onChange(v => { a.value = v; });
                ctl.appendChild(vc.el);
              } else {
                const vc = sliderControl(p);
                vc.set(a.value);
                const readout = document.createElement("span");
                readout.className = "param-value";
                readout.innerHTML = formatValue(p, a.value);
                vc.onChange(v => { a.value = v; readout.innerHTML = formatValue(p, v); });
                attachValueEdit(p, readout, () => a.value, v => {
                  a.value = v;   // draft only, applies when the trigger fires
                  vc.set(v);
                  readout.innerHTML = formatValue(p, v);
                });
                ctl.append(vc.el, readout);
              }
              row.appendChild(ctl);
            }
            // no definition line, the clickable setting name already opens it
          }
        } else {
          // preset action: an ordered list, one name loads it every fire,
          // several WALK in order (fire 1 → A, fire 2 → B, …, wrapping)
          if (!Array.isArray(a.names)) { a.names = a.name ? [a.name] : []; delete a.name; }
          name.textContent = a.names.length > 1
            ? (a.pick === "rand" ? "Load one of these presets" : "Walk presets (in this order)") : "Load preset";
          head.append(name, x);
          if (a.names.length > 1) {   // order seg: walk the list, or roll one per fire
            const orderSeg = segButtons([
              { label: "In order", value: "walk", title: "Each fire loads the next preset in the list, wrapping" },
              { label: "At random", value: "rand", title: "Each fire rolls one preset from the list" },
            ], v => { a.pick = v === "rand" ? "rand" : undefined; renderActions(); refreshSave(); });
            orderSeg.set(a.pick === "rand" ? "rand" : "walk");
            head.insertBefore(orderSeg.el, x);
          }
          row.appendChild(head);
          if (a.names.length) {
            const listEl = document.createElement("div");
            listEl.className = "trig-walk-list";
            a.names.forEach((n, j) => {
              const chip = document.createElement("span");
              chip.className = "trig-walk-item";
              const lab = document.createElement("span");
              lab.textContent = a.names.length > 1 ? `${j + 1}. ${n}` : n;
              const rm = document.createElement("button");
              rm.type = "button";
              rm.className = "hk-clear";
              rm.textContent = "×";
              rm.setAttribute("aria-label", `Remove preset ${n} from this action`);
              rm.addEventListener("click", () => { a.names.splice(j, 1); renderActions(); refreshSave(); });
              chip.append(lab, rm);
              listEl.appendChild(chip);
            });
            row.appendChild(listEl);
          }
          const picker = trigPresetPicker(null, n => { a.names.push(n); renderActions(); refreshSave(); });
          row.appendChild(picker);
          if (a.names.length <= 1) {
            const hint = hintP("Add more presets to walk them in order, or roll one at random.");
            hint.classList.add("pin-crumb");
            row.appendChild(hint);
          }
        }
        actList.appendChild(row);
      });
    }
    function pushAction(a) {
      err.classList.remove("note");
      if (a.kind === "set" && draft.do.some(x => x.kind === "set" && x.addr === a.addr)) {
        err.textContent = "That setting is already on this trigger. Adjust its value on the right.";
        return;
      }
      // several preset actions are fine (with "One at random" they roll like
      // any other action), just fill the empty one before adding another
      if (a.kind === "preset" && draft.do.some(x => x.kind === "preset" && Array.isArray(x.names) && !x.names.length)) {
        err.textContent = "There's an empty preset action on the right. Pick its preset(s) first.";
        return;
      }
      err.textContent = "";
      draft.do.push(a);
      renderActions();
      refreshSave();
    }
    const addActLab = hintP("Add an action:");
    addActLab.classList.add("trig-add-lab");
    const doCfg = document.createElement("div");
    doCfg.className = "trig-cfg";
    const doSeg = segButtons([
      { label: "Set a setting", value: "set", title: "Push any minichord setting to a chosen value" },
      { label: "Load a preset", value: "preset", title: "Load a whole preset, like picking it in the browser" },
    ], dk => {
      doSeg.set(dk);
      renderDoCfg(dk);
    });

    function renderDoCfg(dk) {
      doCfg.innerHTML = "";
      if (!dk) return;
      if (dk === "set") {
        const sel = selectControl({ addr: -1 }, trigTargetOptions(), { crumb: true });
        sel.onChange(addr => {
          const p = paramByAddr[addr];
          if (p) pushAction({ kind: "set", addr, value: p.def });
        });
        doCfg.appendChild(sel.el);
        doCfg.appendChild(hintP("Picking one adds it to the card on the right, where you set its value. "
          + "Fires act exactly like moving the control. Ctrl+Z takes it back."));
      } else if (dk === "preset") {
        // action first, presets second: the card lands on the right immediately
        // and the preset(s) are picked there, several names walk in order
        const addPresetBtn = document.createElement("button");
        addPresetBtn.type = "button";
        addPresetBtn.className = "mini-btn";
        addPresetBtn.textContent = "+ Add a preset action";
        addPresetBtn.addEventListener("click", () => pushAction({ kind: "preset", names: [] }));
        doCfg.appendChild(addPresetBtn);
        doCfg.appendChild(hintP("Pick the preset(s) on the right. Several can walk in order or land at random. "
          + "Saved banks stay untouched."));
      }
    }

    const foot = document.createElement("div");
    foot.className = "trig-editor-foot";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "mini-btn primary";
    saveBtn.textContent = existing ? "Save" : "Add";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mini-btn";
    cancelBtn.textContent = "Cancel";
    // stop-after-x: blank = keep running forever
    const limitRow = document.createElement("div");
    limitRow.className = "trig-timer-row trig-limit-row";
    const limitLab = document.createElement("span");
    limitLab.className = "hk-label";
    limitLab.textContent = "stop after";
    const limitF = document.createElement("input");
    limitF.type = "number";
    limitF.className = "save-field trig-every";
    limitF.min = "1"; limitF.max = "9999";
    limitF.placeholder = "∞";
    if (draft.limit) limitF.value = String(draft.limit);
    limitF.setAttribute("aria-label", "Stop after this many fires (blank = no limit)");
    limitF.addEventListener("change", () => {
      const n = Math.round(Number(limitF.value));
      draft.limit = isFinite(n) && n >= 1 ? Math.min(9999, n) : null;
      limitF.value = draft.limit ? String(draft.limit) : "";
    });
    const limitTail = document.createElement("span");
    limitTail.className = "hk-label";
    limitTail.textContent = "fires, then the trigger turns itself off";
    limitRow.append(limitLab, limitF, limitTail);

    function draftComplete() {
      return draft.when.length > 0 && draft.do.length > 0
        && draft.do.every(a => a.kind !== "preset" || (Array.isArray(a.names) ? a.names.length > 0 : !!a.name));
    }
    function refreshSave() { saveBtn.disabled = !draftComplete(); }
    saveBtn.addEventListener("click", () => {
      if (!draftComplete()) return;
      const entry = { when: draft.when, do: draft.do,
        doPick: draft.doPick === "one" && draft.do.length > 1 ? "one" : undefined,
        limit: draft.limit || undefined };   // undefined keys drop at save (JSON)
      if (existing) window.Triggers.update(existing.id, entry);
      else window.Triggers.add(entry);
      trigEditing = null;
      renderTrigList();   // store onChange also re-renders; this covers no-op updates
    });
    cancelBtn.addEventListener("click", () => {
      window.Triggers.cancelCapture();
      trigSheetCaptureMode(false);
      trigEditing = null;
      renderTrigList();
    });
    foot.append(saveBtn, cancelBtn);

    renderEvents();
    renderWhenCfg(null);
    renderActions();
    renderDoCfg(null);
    refreshSave();
    // two columns: pickers and capture flows on the left (each add-flow in its
    // own bordered block, sharing the column height); the growing action card
    // (full controls + definitions) on the right
    const evBlock = document.createElement("div");
    evBlock.className = "trig-add-block";
    evBlock.append(addLab, kindSeg.el, whenCfg);
    const actBlock = document.createElement("div");
    actBlock.className = "trig-add-block";
    actBlock.append(addActLab, doSeg.el, doCfg);
    const left = document.createElement("div");
    left.className = "trig-ed-left";
    left.append(whenLab, evList, evBlock, actBlock);
    const right = document.createElement("div");
    right.className = "trig-ed-right";
    right.append(doLab, doPickSeg.el, actList, limitRow);
    panel.append(err, left, right, foot);
    return panel;
  }

  /* capture mode: while the editor waits for a chord/pluck, the sheet melts
   * away (transparent + click-through) so the Play screen mirror IS clickable
   * underneath; a small toast explains what's happening and offers Cancel.
   * Esc cancels the capture and brings the editor back. It does NOT close
   * the sheet, so the half-built trigger isn't lost.                        */
  let trigCaptureKeyHandler = null, trigCaptureCancelCb = null;
  function trigSheetCaptureToast(text) {
    const t = trigSheetEl && trigSheetEl.querySelector(".trig-capture-text");
    if (t) t.textContent = text;
  }
  function trigSheetCaptureMode(on, label, onCancel, opts) {
    // opts.confirmLabel shows a confirm button (chord combos build up, then
    // lock in via the button or the editor's settle timer). In the OFF call
    // the 4th argument means "cancelled" (Esc / Cancel button).
    if (!trigSheetEl) return;
    trigSheetEl.classList.toggle("capturing", !!on);
    if (on) {
      let toast = trigSheetEl.querySelector(".trig-capture-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "trig-capture-toast";
        const txt = document.createElement("span");
        txt.className = "trig-capture-text";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "mini-btn primary trig-capture-confirm";
        confirm.addEventListener("click", () => window.Triggers.confirmCapture());
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "mini-btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => {
          window.Triggers.cancelCapture();
          trigSheetCaptureMode(false, null, null, true);
        });
        toast.append(txt, confirm, cancel);
        trigSheetEl.appendChild(toast);
      }
      toast.querySelector(".trig-capture-text").textContent = label || "Waiting…";
      const confirmBtn = toast.querySelector(".trig-capture-confirm");
      confirmBtn.style.display = opts && opts.confirmLabel ? "" : "none";
      if (opts && opts.confirmLabel) confirmBtn.textContent = opts.confirmLabel;
      trigCaptureCancelCb = onCancel || null;
      announce(label || "Waiting for a capture");
      trigCaptureKeyHandler = e => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        window.Triggers.cancelCapture();
        trigSheetCaptureMode(false, null, null, true);
      };
      document.addEventListener("keydown", trigCaptureKeyHandler, true);
    } else {
      if (trigCaptureKeyHandler) { document.removeEventListener("keydown", trigCaptureKeyHandler, true); trigCaptureKeyHandler = null; }
      const cb = trigCaptureCancelCb;
      trigCaptureCancelCb = null;
      if (arguments[3] && cb) cb();   // cancelled (Esc / Cancel button): let the editor reset its chip
    }
  }

  function openTrigSheet(editId) {
    trigSheetPrevFocus = document.activeElement;
    if (!trigSheetEl) trigSheetEl = buildTrigSheet();
    trigEditing = editId != null ? { id: editId } : null;   // deep-link: open straight into that trigger's editor
    renderTrigList();
    trigSheetEl.classList.add("open");
    document.body.classList.add("trig-sheet-open");   // elevates #param-pop/#gloss-pop above the sheet
    window.Hotkeys.setSuspended(true);     // nav + trigger keys pause while editing
    window.Triggers.setSuspended(true);    // capture gestures must not fire siblings
    const a = trigSheetEl.querySelector(editId != null ? ".trig-editor button, .trig-editor input" : ".trig-add");
    if (a) a.focus();
  }
  function closeTrigSheet() {
    if (!trigSheetEl || !trigSheetEl.classList.contains("open")) return;
    window.Triggers.cancelCapture();
    trigSheetCaptureMode(false);
    closeParamPop();   // don't leave an explanation floating after its anchor is gone
    trigSheetEl.classList.remove("open");
    document.body.classList.remove("trig-sheet-open");
    window.Hotkeys.setSuspended(false);
    window.Triggers.setSuspended(false);
    trigEditing = null;
    if (trigSheetPrevFocus && trigSheetPrevFocus.focus) trigSheetPrevFocus.focus();
    trigSheetPrevFocus = null;
  }

  /* ---- engine wiring (executor + arm/fire/change feedback) ----------------- */
  window.Triggers.init({ runAction: runTriggerAction });
  window.Triggers.onLimit(t => {   // stop-after-x reached: the engine turned it off
    announce(`Trigger stopped after ${t.limit} fire${t.limit === 1 ? "" : "s"}. Flip its pill to run it again`);
  });
  window.Triggers.onArmChange(armed => {
    trigBounceDir.clear();   // bounce steps restart upward on every arming
    trigWalkPos.clear();     // preset walks restart from their first preset
    window.Hotkeys.setNavSuspended(armed);   // performing: nav keys must not switch views/undo
    syncArmBtn();
    announce(armed
      ? `Triggers armed: ${window.Triggers.activeCount()} active (app hotkeys paused)`
      : "Triggers disarmed");
    if (trigTickTimer) { clearInterval(trigTickTimer); trigTickTimer = null; }
    if (armed) trigTickTimer = setInterval(updateTrigCountdowns, 500);
    updateTrigCountdowns();
  });
  window.Triggers.onChange(() => {
    syncArmBtn();
    renderPlayTrigCard();
    if (trigSheetEl && trigSheetEl.classList.contains("open")) renderTrigList();
  });
  window.Triggers.onFire(t => {
    // the fired rule's own row flashes, and ONLY the row; pulsing the arm
    // button too read as double-flashing (ids are selector-safe: t- + base36)
    const row = trigCardListEl && trigCardListEl.querySelector(`.trig-active-row[data-tid="${t.id}"]`);
    if (row) { row.classList.remove("fired"); void row.offsetWidth; row.classList.add("fired"); }
    const sets = t.do.filter(a => a.kind === "set");   // preset fires announce via loadPreset
    if (sets.length) announce("Trigger: " + sets.map(trigActionLabel).join(" + "));
  });

  /* ---- first-visit welcome (pref: welcome) ----------------------------------
   * A one-time modal: quick directions plus the taste settings (a Beginner /
   * Advanced bundle over density+glossary, then the individual rows to
   * override, then theme + accent). Closing it flips the pref off; it can be
   * re-armed from the preferences popover to show again on the next load.   */
  function openWelcome() {
    const prevFocus = document.activeElement;   // restored when the modal closes
    const overlay = document.createElement("div");
    overlay.className = "welcome-overlay";
    const card = document.createElement("div");
    card.className = "welcome-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "welcome-title");
    card.addEventListener("click", e => e.stopPropagation());

    const intro = document.createElement("div");
    intro.innerHTML =
      '<h3 class="welcome-title" id="welcome-title">Welcome to minichord <span>Sound Lab</span></h3>' +
      '<p class="welcome-blurb">A free companion for the minichord. Watch your playing live, ' +
      "understand every setting, shape the sound.</p>" +
      '<ul class="welcome-list">' +
      "<li><b>Play</b> mirrors your minichord: connect it over USB and the buttons and strings " +
      "light up as you play.</li>" +
      "<li><b>Customize</b> opens every setting inside the instrument, each one explained.</li>" +
      "<li>Click a setting's name, or any underlined term, for a plain-language explanation.</li>" +
      "<li>The ⚙ gear (top right) reopens all of these choices any time.</li>" +
      "</ul>";
    card.appendChild(intro);

    // Beginner/Advanced bundle: one press sets explanation density and term
    // highlights together; the two rows below override either individually.
    // The choice is REQUIRED. Everything below it (and the close paths) stays
    // locked until one of the two is clicked.
    let chosen = false;
    const bundleRow = document.createElement("div");
    bundleRow.className = "pref-row";
    const bl = document.createElement("div");
    bl.className = "pref-label";
    bl.textContent = "First: how should it talk to you?";
    const bh = document.createElement("p");
    bh.className = "pref-hint";
    bh.textContent = "Pick one to start: Beginner spells everything out; Advanced keeps it tight. Fine-tune below.";
    const bundleSeg = segButtons([
      { label: "Beginner", value: "beginner", title: "Verbose explanations + term highlights" },
      { label: "Advanced", value: "advanced", title: "Compact explanations, no term highlights" },
    ], v => {
      Prefs.set("density", v === "beginner" ? "verbose" : "compact");
      Prefs.set("glossary", v === "beginner");
      chosen = true;
      unlock();
    });
    const refreshBundle = () => {
      const d = Prefs.get("density"), g = Prefs.get("glossary");
      bundleSeg.set(d === "verbose" && g ? "beginner" : d === "compact" && !g ? "advanced" : null);
    };
    refreshBundle();
    Prefs.subscribe("density", refreshBundle);
    Prefs.subscribe("glossary", refreshBundle);
    bundleRow.append(bl, bh, bundleSeg.el);
    card.appendChild(bundleRow);

    const lockedRows = [
      prefRow("Explanations", null, [
        { label: "Compact", value: "compact" }, { label: "Verbose", value: "verbose" },
      ], "density"),
      prefRow("Term highlights", null, [
        { label: "On", value: true }, { label: "Off", value: false },
      ], "glossary"),
      prefRow("Theme", null, [
        { label: "Dark", value: "dark" }, { label: "Light", value: "light" }, { label: "System", value: "auto" },
      ], "theme"),
      accentRow(null),
    ];
    lockedRows.forEach(r => { r.classList.add("locked"); card.appendChild(r); });

    const go = document.createElement("button");
    go.type = "button";
    go.className = "mini-btn primary welcome-go";
    go.textContent = "Get started";
    go.disabled = true;
    function unlock() {
      lockedRows.forEach(r => r.classList.remove("locked"));
      go.disabled = false;
    }
    const onKey = e => {
      if (e.key === "Escape") { close(); return; }
      // focus trap: Tab cycles within the card (skipping locked rows and the
      // disabled Get-started button), the page behind a modal is off-limits
      if (e.key === "Tab") {
        const focusables = Array.from(card.querySelectorAll("button:not(:disabled), [tabindex]:not([tabindex=\"-1\"])"))
          .filter(el => !el.closest(".pref-row.locked"));
        if (!focusables.length) { e.preventDefault(); return; }
        const first = focusables[0], last = focusables[focusables.length - 1];
        const inside = card.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && (!inside || document.activeElement === last)) { first.focus(); e.preventDefault(); }
      }
    };
    function close() {
      if (!chosen) return;           // Beginner/Advanced must be picked first
      Prefs.set("welcome", false);   // self-flips off; re-arm in preferences
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }
    go.addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey, true);
    card.appendChild(go);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const firstChoice = bundleSeg.el.querySelector("button");
    if (firstChoice) firstChoice.focus();
  }

  function closePrefsPopup() {
    if (prefsPopupEl) prefsPopupEl.classList.remove("open");
    if (prefsBtn) prefsBtn.setAttribute("aria-expanded", "false");
  }
  function closeA11yPopup() {
    if (a11yPopupEl) a11yPopupEl.classList.remove("open");
    if (a11yBtn) a11yBtn.setAttribute("aria-expanded", "false");
  }
  function closeHkPopup() {
    if (hkPopupEl) hkPopupEl.classList.remove("open");
    if (hkBtn) hkBtn.setAttribute("aria-expanded", "false");
    if (window.Hotkeys) window.Hotkeys.cancelCapture();   // closing mid-rebind abandons the capture
  }
  // topbar buttons stopPropagation, so the document-level outside-click closer
  // never sees a click on a sibling button, each opener closes the others
  if (prefsBtn) prefsBtn.addEventListener("click", e => {
    e.stopPropagation();
    closeA11yPopup();
    closeHkPopup();
    if (!prefsPopupEl) prefsPopupEl = buildPrefsPopup();
    const willOpen = !prefsPopupEl.classList.contains("open");
    if (willOpen) {
      prefsPopupEl.classList.add("open");
      prefsBtn.setAttribute("aria-expanded", "true");
      anchorPopup(prefsBtn, prefsPopupEl);
    } else closePrefsPopup();
  });
  if (a11yBtn) a11yBtn.addEventListener("click", e => {
    e.stopPropagation();
    closePrefsPopup();
    closeHkPopup();
    if (!a11yPopupEl) a11yPopupEl = buildA11yPopup();
    const willOpen = !a11yPopupEl.classList.contains("open");
    if (willOpen) {
      a11yPopupEl.classList.add("open");
      a11yBtn.setAttribute("aria-expanded", "true");
      anchorPopup(a11yBtn, a11yPopupEl);
    } else closeA11yPopup();
  });
  if (hkBtn) hkBtn.addEventListener("click", e => {
    e.stopPropagation();
    closePrefsPopup();
    closeA11yPopup();
    if (!hkPopupEl) hkPopupEl = buildHotkeysPopup();
    const willOpen = !hkPopupEl.classList.contains("open");
    if (willOpen) {
      if (hkPopupRefresh) hkPopupRefresh();   // a capture may have been abandoned mid-"Press a key…"
      hkPopupEl.classList.add("open");
      hkBtn.setAttribute("aria-expanded", "true");
      anchorPopup(hkBtn, hkPopupEl);
    } else closeHkPopup();
  });

  // glossary highlighting follows its pref; re-apply to the big roots when
  // turned back on (content rendered while off was never wrapped)
  if (window.Glossary) {
    window.Glossary.setEnabled(Prefs.get("glossary"));
    Prefs.subscribe("glossary", on => {
      window.Glossary.setEnabled(on);
      if (on) { glossify(rightRoot); glossify(middleRoot); }
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawActiveGraph(); balancePinnedCards(); balanceDetailCols(); }, 120);
    if (presetsPanel && presetsPanel.classList.contains("open")) positionPresetDropdown();
    closeOpenCardSelect();
    closeColorPopup();
    closeSavePopup();
    closePastePopup();
    closePrefsPopup();
    closeA11yPopup();
    closeHkPopup();
    positionParamPop();   // the param popover tracks its anchor instead of closing
  });

  /* ---- Web MIDI device sync ------------------------------------------------ */
  const FLOAT_MULT = 100;
  const controller = (typeof MiniChordController !== "undefined") ? new MiniChordController() : null;
  const deviceCard = document.getElementById("device-card");
  const badge = document.getElementById("mode-badge");

  // send one parameter to the device (floats go over the wire x100, like the firmware)
  function sendToDevice(p, value) {
    if (!controller || !controller.isConnected() || !p) return;
    const wire = p.type === "float" ? Math.round(value * FLOAT_MULT) : Math.round(value);
    controller.sendParameter(p.addr, wire);

    // the LED only repaints when the color (addr 20) is written, re-send it so
    // a change to LED brightness (addr 32) takes effect immediately
    if (p.addr === 32) controller.sendParameter(COLOR_ADDR, bankColor);
  }

  // Master tuning (255) is DEVICE state, not preset state: the firmware keeps it
  // in its own file and leaves it out of serialize()/deserialize(). Writing it
  // from a preset pushes one bank's stored number into a device-wide setting,
  // and in a 12-bank sweep it restarts the firmware's deferred flash write
  // twelve times. Every bulk parameter loop below skips it.
  const DEVICE_STATE_ADDRS = new Set([255]);

  // write a full preset into the device's current bank (live working state).
  // Mirrors minicontrol's "Try": push every stored parameter (raw ints, by
  // address), then ping address 0 so the device applies them and dumps the new
  // bank back to us (→ loadFromDevice re-syncs the UI + slot identity). No-op
  // offline. "Save to bank" on the Device card then persists it to flash.
  function sendPresetToDevice(vals) {
    if (!controller || !controller.isConnected()) return false;
    for (let a = 2; a < vals.length && a < controller.parameter_size; a++) {
      if (DEVICE_STATE_ADDRS.has(a)) continue;
      controller.sendParameter(a, vals[a]);
    }
    controller.sendParameter(0, 0);   // apply + request a fresh dump
    return true;
  }

  // which known preset is sitting in the current slot:
  //   undefined = no dump read yet   null = custom / unrecognised   object = matched preset
  let slotPreset;
  let slotPresetEdited = false;     // slot matched fuzzily, render "(edited)"
  let activePresetName = null;  // preset currently reflected in the editor (drives list highlight)
  let activePresetEdited = false;   // editor patch matched fuzzily, label gets "(edited)"
  let bankColor = 0;            // current bank's LED hue (sysex addr 20, 0-360)
  const COLOR_ADDR = 20;
  const LED_GAMMA = 2.2;     // perceptual curve for the LED brightness slider (eye sees ~luminance^(1/2.2))
  const LED_V_FLOOR = 0.005;  // dimmest VISIBLE luminance, below this the LED reads as off (PWM/eye floor)
  let colorFieldEl = null;      // the bank-color popup wrapper in the device card
  let lastDeviceData = null;    // most recent full bank dump (for complete preset export)
  let deviceFirmware = null;    // firmware version reported by the device (sysex addr 7)
  // newest firmware the Lab knows parameters for (max `introduction_version` in
  // parameters.json), params newer than the device's firmware won't take effect
  const LATEST_FIRMWARE = 8;
  const FIRMWARE_GUIDE = "https://minichord.com/user_manual/#updating-the-firmware";

  // populate the UI controls from a raw param array (indexed by sysex address).
  // Silent: uses the no-echo setters, so it never sends back to the device.
  function applyParamArray(paramsByAddr) {
    let any = false;
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const raw = paramsByAddr[p.addr];
      if (raw == null || !controls[p.addr]) return;
      let v = p.type === "float" ? raw / FLOAT_MULT : raw;
      v = Math.min(p.max, Math.max(p.min, v));
      controls[p.addr].forEach(fn => fn(v));
      any = true;
    }));
    if (any) { drawActiveGraph(); renderProfiles(); updateGateFlags(); updatePortNotice(); }
    if (any && deviceMap) deviceMap.rebuild();   // refresh Play-tab labels for the new patch (strum pattern, chromatic, key…)
    if (any) prevPatch = Object.assign({}, patch);   // bulk loads re-baseline undo's "before" values
    return any;
  }

  // load the device's current bank dump into the UI (silent, no echo back)
  function loadFromDevice(data) {
    lastDeviceData = data;   // keep the full dump so exports include non-UI params + rhythm
    if (data.firmwareVersion != null) { deviceFirmware = data.firmwareVersion; console.info("[SoundLab] device firmware version:", data.firmwareVersion); }
    // fingerprint the raw dump against the known presets before the UI clamps anything
    const slotMatch = window.PresetMatch ? window.PresetMatch.identify(data.parameters, presetLeewayAddrs()) : null;
    slotPreset = slotMatch ? slotMatch.preset : null;
    slotPresetEdited = !!(slotMatch && slotMatch.edited);
    // when nothing matches, log the closest preset + which addresses differ
    if (!slotPreset && window.PresetMatch && window.PresetMatch.closest) {
      const c = window.PresetMatch.closest(data.parameters);
      if (c) console.info(`[SoundLab] No preset match. Closest: "${c.preset.name}" — ${c.diffs.length} differing address(es):`, c.diffs);
    }
    if (data.parameters[COLOR_ADDR] != null) bankColor = data.parameters[COLOR_ADDR];
    applyParamArray(data.parameters);
    activePresetName = slotPreset ? slotPreset.name : null;
    activePresetEdited = slotPresetEdited;
    snapshotReference();                                 // ghost rebases to the new bank
    if (!showGhost) { showGhost = true; syncToolbars(); }
    drawActiveGraph();
    highlightPresets();
    updateFirmwareWarnings();
    updateGateFlags();
    updateConnectionUI(true, data);
    if (deviceMap) { deviceMap.setConnected(true); deviceMap.rebuild(); }   // refresh the live mirror
    midiRec.connection(true);   // a dump means the device is live, un-gray the Record button
    applyBankAccent();       // bank hue may have changed with the new bank
    updateRhythmPotNote();   // pot targets (patch[10/12/14/16]) may have changed
  }

  // show a warning next to any parameter the connected device's firmware is too
  // old to support (offline we assume a current device and show none)
  function updateFirmwareWarnings() {
    const fw = (controller && controller.isConnected()) ? deviceFirmware : null;
    Object.keys(fwWarnings).forEach(addr => {
      const p = paramByAddr[addr];
      const unsupported = fw != null && p && p.fw != null && fw < p.fw;
      fwWarnings[addr].forEach(w => { w.style.display = unsupported ? "" : "none"; });
    });
  }

  // mark a sub-component card "inert" when its gating control is turned all the
  // way down (e.g. amplitude/depth/mix at 0). The card dims and shows why.
  function updateGateFlags() {
    const active = {};   // "groupId card" -> msg
    PARAM_GROUPS.forEach(g => (g.gates || []).forEach(gate => {
      const p = paramByAddr[gate.addr];
      const min = p ? p.min : 0;
      if (patch[gate.addr] <= min) active[g.id + " " + (gate.card || "")] = gate.msg;
    }));
    Object.keys(cardFlags).forEach(key => {
      const { flag } = cardFlags[key];
      const msg = active[key];
      flag.dataset.note = msg || "";
      flag.title = msg ? `${msg}. Click for details` : "";
      flag.setAttribute("aria-label", msg ? `Section disabled: ${msg}, click for details` : "Section disabled");
      flag.style.visibility = msg ? "visible" : "hidden";
      // never leave the popover dangling on a chip that just went invisible
      if (!msg && paramPopEl && paramPopEl.classList.contains("open") && paramPopAnchor === flag) closeParamPop();
    });
    // the rhythm grid dims steps past the cycle length, repaint both copies on any change
    const rg = groupEls.chord_rhythm;
    if (rg && rg.rhythmRefresh) rg.rhythmRefresh();
    if (playRhythmRefresh) playRhythmRefresh();
  }

  // load a known preset into the editor (so the Profiler describes it) and, when
  // a minichord is connected, into its current bank's live working state.
  function loadPreset(idx) {
    if (!window.PresetMatch) return;
    const preset = window.PresetMatch.all[idx];
    if (!preset) return;
    const histBefore = Object.assign({}, patch);   // one undo entry for the whole load
    const vals = window.PresetMatch.decode(preset.value);
    applyParamArray(vals);
    recordPatchChange(`preset "${preset.name}"`, histBefore, Object.assign({}, patch));
    activePresetName = preset.name;
    activePresetEdited = false;
    snapshotReference();                                 // ghost rebases to the loaded preset
    if (!showGhost) { showGhost = true; syncToolbars(); }
    drawActiveGraph();
    highlightPresets();
    announce(`Loaded preset ${preset.name}`);
    sendPresetToDevice(vals);                            // load into the current bank (if connected)
  }

  /* ---- preset browser: a dropdown card of rounded preset cards ------------- */
  const presetsPanel = document.getElementById("presets-panel");
  let presetTrigger = null, presetTriggerText = null, presetDropdown = null;
  const presetMeta = {};    // preset index -> { profileName, fg, bg }
  const presetCards = {};   // preset index -> card element

  // build a real-value patch object for a preset so the Profiler can read it
  // (the Profiler, like the rest of the Lab, works in real units, floats /100)
  function presetPatch(vals) {
    const pp = {};
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const raw = vals[p.addr];
      if (raw == null) return;
      pp[p.addr] = p.type === "float" ? raw / FLOAT_MULT : raw;
    }));
    return pp;
  }

  function setPresetOpen(open) {
    if (!presetsPanel) return;
    presetsPanel.classList.toggle("open", open);
    if (presetTrigger) presetTrigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) positionPresetDropdown();
  }

  // anchor the floating dropdown to the trigger; flip above + cap its height to
  // fit the viewport so it never spills off-screen (it's position:fixed).
  function positionPresetDropdown() {
    if (!presetDropdown || !presetTrigger) return;
    const r = presetTrigger.getBoundingClientRect();
    const gap = 6, margin = 12, vh = window.innerHeight;
    // height available for the whole card, dropping down vs flipping up
    const spaceBelow = vh - (r.bottom + gap) - margin;
    const spaceAbove = (r.top - gap) - margin;
    const useAbove = spaceBelow < 200 && spaceAbove > spaceBelow;
    const cardMax = Math.min(useAbove ? spaceAbove : spaceBelow, Math.round(vh * 0.7));
    // the scroll area must leave room for the card's own padding + borders
    const chrome = presetDropdown.offsetHeight - (presetDropdown.querySelector(".preset-scroll")?.offsetHeight || 0);
    const scroll = presetDropdown.querySelector(".preset-scroll");
    if (scroll) scroll.style.maxHeight = Math.max(120, cardMax - (chrome > 0 ? chrome : 20)) + "px";
    presetDropdown.style.left = Math.round(r.left) + "px";
    presetDropdown.style.width = Math.round(r.width) + "px";
    if (useAbove) {
      presetDropdown.style.top = "auto";
      presetDropdown.style.bottom = Math.round(vh - r.top + gap) + "px";
    } else {
      presetDropdown.style.bottom = "auto";
      presetDropdown.style.top = Math.round(r.bottom + gap) + "px";
    }
  }

  // anchor a small fixed popup under (or above) a trigger, left-aligned to it
  // (clamped so it never spills past the right edge, e.g. the gear's popover)
  function anchorPopup(triggerEl, popupEl) {
    if (!triggerEl || !popupEl) return;
    lastAnchor = { triggerEl, popupEl };
    const r = triggerEl.getBoundingClientRect();
    const gap = 6, margin = 12, vh = window.innerHeight;
    popupEl.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - popupEl.offsetWidth - 8))) + "px";
    popupEl.style.minWidth = Math.round(r.width) + "px";
    const flipUp = (vh - r.bottom - gap - margin) < popupEl.offsetHeight && r.top > (vh - r.bottom);
    // never taller than the side it opens into, long lists scroll inside
    const avail = flipUp ? (r.top - gap - margin) : (vh - r.bottom - gap - margin);
    popupEl.style.maxHeight = Math.round(Math.max(140, avail)) + "px";
    if (flipUp) {
      popupEl.style.top = "auto";
      popupEl.style.bottom = Math.round(vh - r.top + gap) + "px";
    } else {
      popupEl.style.bottom = "auto";
      popupEl.style.top = Math.round(r.bottom + gap) + "px";
    }
  }

  function closeColorPopup() { if (colorFieldEl) colorFieldEl.classList.remove("open"); }

  // compact density: the preset-action pills show monochrome symbols (full
  // label in the tooltip); verbose writes the labels out
  function syncPresetActionLabels(scope) {
    const compact = Prefs.get("density") === "compact";
    const root = scope || presetsPanel;
    if (!root) return;
    root.querySelectorAll(".preset-actions .mini-btn[data-icon]").forEach(b => {
      b.textContent = compact ? b.dataset.icon : b.dataset.full;
      b.classList.toggle("icon-btn", compact);
    });
  }
  Prefs.subscribe("density", () => syncPresetActionLabels());

  function renderPresetsPanel() {
    if (!presetsPanel || !window.PresetMatch || !window.SoundProfiler) return;
    const all = window.PresetMatch.all;
    const customCount = (window.PresetMatch.custom || []).length;
    const custom = [], community = [], defaults = [];
    all.forEach((p, i) => {
      if (i < customCount) custom.push(i);                          // custom presets come first in `all`
      else if (/^Default Preset/.test(p.name)) defaults.push(i);
      else community.push(i);
    });

    // trigger
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "preset-trigger";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    const tlabel = document.createElement("span");
    tlabel.className = "preset-trigger-label";
    const caret = document.createElement("span");
    caret.className = "preset-caret"; caret.textContent = "▾";
    trigger.append(tlabel, caret);
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      setPresetOpen(!presetsPanel.classList.contains("open"));
    });

    // dropped card
    const dd = document.createElement("div");
    dd.className = "preset-dropdown";
    const scroll = document.createElement("div");
    scroll.className = "preset-scroll";
    const hint = document.createElement("p");
    hint.className = "preset-hint";
    hint.textContent = "Loads into the Lab, and your minichord's current bank when connected.";
    scroll.appendChild(hint);

    // one rounded card per preset, with its profile name as a color-coded chip
    const addGroup = (label, idxs) => {
      if (!idxs.length) return;
      const lab = document.createElement("div");
      lab.className = "preset-group-label";
      lab.textContent = label;
      scroll.appendChild(lab);
      idxs.forEach(i => {
        const preset = all[i];
        const prof = window.SoundProfiler.overall(presetPatch(window.PresetMatch.decode(preset.value)));
        const profileName = prof.word || window.SoundProfiler.signatureName(prof.tags);
        const sc = signatureColors(prof.tags);
        presetMeta[i] = { profileName, fg: sc.fg, bg: sc.bg };
        const card = document.createElement("button");
        card.type = "button";
        card.className = "preset-item";
        card.dataset.idx = String(i);
        if (preset.description) card.title = preset.description;
        card.innerHTML =
          `<span class="preset-name">${preset.name}</span>` +
          "<span class=\"preset-meta\">" +
            `<span class="preset-by">${preset.author}</span>` +
            `<span class="preset-profile" style="background:${sc.bg};color:${sc.fg}">${profileName}</span>` +
          "</span>";
        card.addEventListener("click", () => { loadPreset(i); setPresetOpen(false); });
        presetCards[i] = card;
        scroll.appendChild(card);
      });
    };

    addGroup("Custom", custom);                 // custom presets first (omitted entirely if none)
    addGroup("Community", community);
    addGroup("Built-in defaults", defaults);
    dd.appendChild(scroll);

    // active preset's description (moved here from the device card)
    const desc = document.createElement("p");
    desc.className = "preset-active-desc";
    presetDescEl = desc;

    // actions: save current settings, load a preset file, revert to preset.
    // Compact density shows monochrome symbols (the full label moves to the
    // tooltip); verbose writes the labels out, synced by syncPresetActionLabels
    const actions = document.createElement("div");
    actions.className = "preset-actions";
    const actionBtn = (icon, label, title) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mini-btn";
      b.dataset.icon = icon; b.dataset.full = label;
      b.title = title;
      b.setAttribute("aria-label", label);
      return b;
    };

    const saveBtn = actionBtn("Save…", "Save as preset…", "Save as preset…: download the current settings as a .json preset");
    saveBtn.addEventListener("click", e => { e.stopPropagation(); toggleSavePopup(saveBtn); });

    const loadBtn = actionBtn("Load…", "Load from file…", "Load from file…: load a .json preset from your computer");
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = ".json,application/json"; fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => { loadPresetFiles(fileInput.files); fileInput.value = ""; });
    loadBtn.addEventListener("click", () => fileInput.click());

    // whole-device backup: every bank in one file, for swapping or restoring
    const banksBtn = actionBtn("All banks\u2026", "All banks\u2026",
      "All banks\u2026: see all twelve banks, reorder them, or set a value across every one at once");
    banksBtn.addEventListener("click", openBankSheet);

    const backupBtn = actionBtn("Back up all\u2026", "Back up every bank\u2026",
      "Back up every bank\u2026: read all twelve banks off the minichord into one .json file");
    backupBtn.addEventListener("click", async () => {
      if (!controller || !controller.isConnected()) { announce("Connect a minichord first"); return; }
      backupBtn.disabled = true;
      try {
        const data = await backupAllBanks((i, n) => announce("Reading bank " + (i + 1) + " of " + n));
        downloadBackup(data);
        announce("Backed up all twelve banks");
      } catch (e) {
        announce("Backup failed: " + e.message);
      } finally { backupBtn.disabled = false; }
    });

    const restoreBtn = actionBtn("Restore all\u2026", "Restore every bank\u2026",
      "Restore every bank\u2026: write a backup file back to all twelve banks, replacing what is on the minichord");
    const restoreInput = document.createElement("input");
    restoreInput.type = "file"; restoreInput.accept = ".json,application/json";
    restoreInput.style.display = "none";
    restoreInput.addEventListener("change", async () => {
      const file = restoreInput.files && restoreInput.files[0];
      restoreInput.value = "";
      if (!file) return;
      if (!controller || !controller.isConnected()) { announce("Connect a minichord first"); return; }
      let data;
      try { data = JSON.parse(await file.text()); }
      catch (e) { announce("That file isn't valid JSON"); return; }
      if (!data.minichord_backup) { announce("That isn't a minichord backup file"); return; }
      const fw = patch[7];
      const note = (data.firmware_version != null && fw != null && data.firmware_version !== fw)
        ? "\n\nThe backup was made on firmware v" + data.firmware_version +
          " and this minichord reports v" + fw + ". Settings may have moved between versions."
        : "";
      if (!confirm("Replace all twelve banks on the minichord with this backup?" + note)) return;
      restoreBtn.disabled = true;
      try {
        await restoreAllBanks(data, (i, n) => announce("Writing bank " + (i + 1) + " of " + n));
        announce("Restored all twelve banks");
        if (controller.requestCurrentData) controller.requestCurrentData();
      } catch (e) {
        announce("Restore failed: " + e.message);
      } finally { restoreBtn.disabled = false; }
    });
    restoreBtn.addEventListener("click", () => restoreInput.click());

    const resetAll = actionBtn("Reset", "Reset to preset", "Reset to preset: revert every control to the loaded preset");
    resetAll.addEventListener("click", () => {
      const addrs = [];
      PARAM_GROUPS.forEach(g => g.params.forEach(p => addrs.push(p.addr)));
      resetToPreset(addrs);
    });
    presetResetAllBtn = resetAll;

    // readable copy/paste: named-params JSON on the clipboard, no base64
    const copyBtn = actionBtn("Copy", "Copy settings", "Copy settings: every setting as readable text (named, by section)");
    copyBtn.addEventListener("click", () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(settingsToText()).then(
          () => announce("Settings copied as text. Paste them anywhere"),
          () => announce("Couldn't copy. The browser blocked clipboard access"));
      } else announce("Couldn't copy. No clipboard access in this browser");
    });

    const pasteBtn = actionBtn("Paste", "Paste settings", "Paste settings: apply copied text, a preset .json or a preset string");
    pasteBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(t => applyPastedSettings(t), () => togglePastePopup(pasteBtn));
      } else togglePastePopup(pasteBtn);   // Firefox: no readText, paste into a box instead
    });

    actions.append(saveBtn, loadBtn, fileInput, banksBtn, backupBtn, restoreBtn, restoreInput, resetAll, copyBtn, pasteBtn);
    syncPresetActionLabels(actions);

    const savePopup = buildSavePopup();   // hidden until "Save current as preset…"
    const pastePopup = buildPastePopup(); // hidden fallback when clipboard read is blocked

    presetsPanel.innerHTML = "";
    presetsPanel.append(trigger, dd, actions, savePopup, pastePopup, desc);
    presetTrigger = trigger; presetTriggerText = tlabel; presetDropdown = dd;
    highlightPresets();
  }

  /* ---- save / load custom presets ----------------------------------------- */
  const PRESET_LEN = 255;   // presets store addresses 0..254
  let presetDescEl = null, savePopupEl = null, saveNameInput = null;

  // raw base64 "value" for the current settings: start from the last device dump
  // (so non-UI params + rhythm survive), overlay the edited catalog params, and
  // force the standard pot/volume values presets store.
  function buildCurrentRawValue() {
    const arr = new Array(PRESET_LEN).fill(0);
    if (lastDeviceData && lastDeviceData.parameters) {
      for (let a = 0; a < PRESET_LEN; a++) if (lastDeviceData.parameters[a] != null) arr[a] = lastDeviceData.parameters[a];
      const rd = lastDeviceData.rhythmData;
      if (rd) for (let j = 0; j < 16; j++) {
        const bits = rd[j];
        if (bits) { let v = 0; for (let k = 0; k < 7; k++) if (bits[k]) v |= (1 << k); arr[220 + j] = v; }
      }
    }
    arr[2] = 50; arr[3] = 50; arr[4] = 512; arr[5] = 512; arr[6] = 512;   // pot/volume, as presets store them
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const v = patch[p.addr];
      if (v == null) return;
      arr[p.addr] = p.type === "float" ? Math.round(v * FLOAT_MULT) : Math.round(v);
    }));
    return window.PresetMatch ? window.PresetMatch.encode(arr) : btoa(arr.join(";"));
  }

  function downloadPreset(name, author, description) {
    const preset = { name, author: author || "", value: buildCurrentRawValue(), description: description || "" };
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    let fn = name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "preset";
    a.download = fn.endsWith(".json") ? fn : fn + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---- bank workspace -----------------------------------------------------
   * Reading twelve banks walks the device audibly through every preset, so it
   * happens once on demand and is then cached. Reordering and bulk edits stage
   * against the cache; Apply writes back only the banks that actually changed,
   * because every write is a flash erase.                                     */
  const bankState = {
    slots: null,        // [{ values, dirty }] in slot order, or null when unread
    read: false,
    busy: false,
  };
  // Bulk edits staged so far, one row per setting, each remembering what every
  // bank held before it so a row can be taken back.
  let bulkStaged = [];

  // Anything that writes a bank from outside this sheet — saving the preset you
  // are editing, resetting a bank, wiping memory — leaves the cached copy wrong.
  // Mark it rather than silently showing stale banks.
  function bankCacheStale() {
    if (bankState.read) bankState.stale = true;
  }

  // Recomputes which slots differ from what was read, after a staged row is
  // withdrawn — dirty cannot simply be cleared, since a drag may also have
  // moved things.
  function recomputeDirty() {
    if (!bankState.slots || !bankState.original) return;
    bankState.slots.forEach(slot => {
      const was = bankState.original[slot.id];
      if (!was) return;
      slot.dirty = slot.movedFrom !== slot.id || slot.values.some((v, i) => v !== was[i]);
    });
  }

  // bank names are player-typed and end up inside innerHTML strings
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function bankNamesGet() {
    const raw = (window.Prefs && window.Prefs.get("bankNames")) || [];
    const out = [];
    for (let i = 0; i < 12; i++) out.push(typeof raw[i] === "string" ? raw[i] : "");
    return out;
  }
  function bankNamesSet(names) {
    if (window.Prefs) window.Prefs.set("bankNames", names.slice(0, 12));
    // the device card names the current slot, so it has to follow a rename
    if (controller && controller.isConnected()) updateConnectionUI(true);
  }

  function bankSlotLabel(values) {
    if (!window.PresetMatch || !values) return null;
    const m = window.PresetMatch.identify(values, presetLeewayAddrs());
    if (!m || !m.preset) return null;
    return m.preset.name + (m.edited ? " (edited)" : "");
  }

  function bankSlotHue(values) {
    const h = values && values[20];
    return (h == null) ? null : h;
  }

  async function readAllBanks(onProgress) {
    if (!controller || !controller.isConnected()) throw new Error("no minichord connected");
    const startingBank = controller.getDeviceInfo().activeBankNumber;
    const slots = [];
    const original = [];
    const names = bankNamesGet();
    for (let b = 0; b < 12; b++) {
      if (onProgress) onProgress(b, 12);
      const values = await controller.readBank(b, 3000, true);
      const copy = Array.from(values, v => (v == null ? 0 : v));
      slots.push({ id: b, movedFrom: b, values: copy, dirty: false, name: names[b] });
      original[b] = copy.slice();
    }
    if (startingBank >= 0) await controller.readBank(startingBank, 3000, true);
    bankState.slots = slots;
    bankState.original = original;
    bankState.read = true;
    bankState.stale = false;
    bulkStaged = [];
    return slots;
  }

  // Move a slot and mark everything whose position changed, since a moved bank
  // has to be rewritten wherever it landed.
  function moveBankSlot(from, to) {
    if (!bankState.slots || from === to) return;
    const slots = bankState.slots;
    const [moved] = slots.splice(from, 1);
    slots.splice(to, 0, moved);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) { slots[i].movedFrom = i; slots[i].dirty = true; }
    bankNamesSet(slots.map(sl => sl.name || ""));   // the name belongs to the bank, not the slot
  }

  // Set one address across a chosen set of slots.
  function bulkSetParameter(addr, value, slotIndices) {
    if (!bankState.slots) return 0;
    let changed = 0;
    slotIndices.forEach(i => {
      const slot = bankState.slots[i];
      if (!slot || slot.values[addr] === value) return;
      slot.values[addr] = value;
      slot.dirty = true;
      changed++;
    });
    return changed;
  }

  // Write staged slots back. Only dirty ones are touched: a flash erase per
  // bank is slow, and rewriting an unchanged bank buys nothing.
  async function applyBankChanges(onProgress) {
    if (!controller || !controller.isConnected()) throw new Error("no minichord connected");
    if (!bankState.slots) return 0;
    const dirty = [];
    bankState.slots.forEach((slot, i) => { if (slot.dirty) dirty.push(i); });
    if (!dirty.length) return 0;
    const startingBank = controller.getDeviceInfo().activeBankNumber;
    for (let n = 0; n < dirty.length; n++) {
      const i = dirty[n];
      if (onProgress) onProgress(n, dirty.length);
      const values = bankState.slots[i].values;
      controller.loadBank(i);
      await new Promise(r => setTimeout(r, 60));
      for (let a = 2; a < values.length; a++) {
        if (values[a] == null || DEVICE_STATE_ADDRS.has(a)) continue;
        controller.sendParameter(a, values[a]);
        if ((a & 31) === 0) await new Promise(r => setTimeout(r, 1));
      }
      await new Promise(r => setTimeout(r, 40));
      controller.saveCurrentSettings(i);
      await new Promise(r => setTimeout(r, 120));
      bankState.slots[i].dirty = false;
      if (bankState.original) bankState.original[bankState.slots[i].id] = bankState.slots[i].values.slice();
    }
    if (startingBank >= 0) controller.loadBank(startingBank);
    return dirty.length;
  }

  /* ---- bank sheet: overview, reorder, bulk edit --------------------------- */
  let bankSheetEl = null, bankSheetPrevFocus = null;

  function buildBankSheet() {
    const overlay = document.createElement("div");
    overlay.className = "bank-sheet";
    const card = document.createElement("div");
    card.className = "bank-sheet-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Banks");
    card.addEventListener("click", e => e.stopPropagation());
    overlay.appendChild(card);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeBankSheet(); });
    overlay.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBankSheet(); }
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function renderBankSheet() {
    const card = bankSheetEl.querySelector(".bank-sheet-card");
    card.innerHTML = "";

    const h = document.createElement("h2");
    h.textContent = "Banks";
    card.appendChild(h);

    const intro = document.createElement("p");
    intro.className = "bank-sheet-intro";
    card.appendChild(intro);

    const grid = document.createElement("div");
    grid.className = "bank-grid";
    card.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "bank-sheet-actions";
    card.appendChild(actions);

    const mkBtn = (label, title) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mini-btn"; b.textContent = label; b.title = title;
      return b;
    };

    if (!bankState.read) {
      intro.textContent = "Reading the banks walks the minichord through all twelve presets, " +
        "so it is done once, on request. Everything after that is staged here until you apply it.";
      const readBtn = mkBtn("Read banks", "Read all twelve banks off the minichord");
      readBtn.classList.add("primary");
      readBtn.addEventListener("click", async () => {
        if (!controller || !controller.isConnected()) { announce("Connect a minichord first"); return; }
        readBtn.disabled = true;
        try {
          await readAllBanks((i, n) => { intro.textContent = "Reading bank " + (i + 1) + " of " + n + "\u2026"; });
          renderBankSheet();
        } catch (e) {
          intro.textContent = "Couldn't read the banks: " + e.message;
          readBtn.disabled = false;
        }
      });
      actions.appendChild(readBtn);
      return;
    }

    const dirtyCount = bankState.slots.filter(s => s.dirty).length;

    // Something wrote a bank since these were read, so what is on screen is not
    // what is on the device. Say so rather than let it be discovered.
    if (bankState.stale) {
      const warn = document.createElement("p");
      warn.className = "bank-sheet-stale";
      warn.textContent = dirtyCount
        ? "A bank has been written since these were read, so this list is out of date. Reading again will discard the staged changes below."
        : "A bank has been written since these were read, so this list is out of date.";
      const reread = mkBtn("Read again", "Read all twelve banks off the minichord again");
      reread.addEventListener("click", async () => {
        if (dirtyCount && !confirm("Read the banks again? The staged changes will be discarded.")) return;
        reread.disabled = true;
        try {
          await readAllBanks((i, n) => { intro.textContent = "Reading bank " + (i + 1) + " of " + n + "\u2026"; });
        } catch (e) {
          intro.textContent = "Couldn't read the banks: " + e.message;
        }
        renderBankSheet();
      });
      warn.appendChild(reread);
      card.insertBefore(warn, grid);
    }

    intro.textContent = dirtyCount
      ? dirtyCount + (dirtyCount === 1 ? " bank has" : " banks have") + " unsaved changes. " +
        "Nothing is written to the minichord until you apply."
      : "Drag a bank to move it. Changes are staged until you apply.";

    bankState.slots.forEach((slot, i) => {
      const cellEl = document.createElement("div");
      cellEl.className = "bank-cell" + (slot.dirty ? " dirty" : "");
      cellEl.draggable = true;
      cellEl.dataset.index = String(i);

      const hue = bankSlotHue(slot.values);
      const swatch = document.createElement("span");
      swatch.className = "bank-swatch";
      if (hue != null) swatch.style.background = "hsl(" + hue + ", 70%, 55%)";
      cellEl.appendChild(swatch);

      const num = document.createElement("span");
      num.className = "bank-num";
      num.textContent = String(i + 1);
      cellEl.appendChild(num);

      const matched = bankSlotLabel(slot.values);
      const name = document.createElement("input");
      name.className = "bank-name" + (slot.name ? " named" : "");
      name.type = "text";
      name.value = slot.name || "";
      name.placeholder = matched || "\u2014";
      name.title = slot.name
        ? "Your name for this bank"
        : (matched ? "Matches \u201c" + matched + "\u201d in the preset library" : "Unnamed");
      name.setAttribute("aria-label", "Name for bank " + (i + 1));
      // typing in a name should not start a drag
      name.addEventListener("mousedown", e => e.stopPropagation());
      name.addEventListener("focus", () => { cellEl.draggable = false; });
      name.addEventListener("blur", () => {
        cellEl.draggable = true;
        const v = name.value.trim().slice(0, 24);
        if (v === (slot.name || "")) return;
        slot.name = v;
        name.classList.toggle("named", !!v);
        bankNamesSet(bankState.slots.map(sl => sl.name || ""));
      });
      name.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); name.blur(); }
        if (e.key === "Escape") { e.preventDefault(); name.value = slot.name || ""; name.blur(); }
        e.stopPropagation();
      });
      cellEl.appendChild(name);

      cellEl.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", String(i));
        cellEl.classList.add("dragging");
      });
      cellEl.addEventListener("dragend", () => cellEl.classList.remove("dragging"));
      cellEl.addEventListener("dragover", e => { e.preventDefault(); cellEl.classList.add("over"); });
      cellEl.addEventListener("dragleave", () => cellEl.classList.remove("over"));
      cellEl.addEventListener("drop", e => {
        e.preventDefault();
        cellEl.classList.remove("over");
        const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const to = parseInt(cellEl.dataset.index, 10);
        if (!isNaN(from) && !isNaN(to)) { moveBankSlot(from, to); renderBankSheet(); }
      });
      grid.appendChild(cellEl);
    });

    // ---- bulk edit ----
    const bulk = document.createElement("div");
    bulk.className = "bank-bulk";
    const bulkTitle = document.createElement("h3");
    bulkTitle.textContent = "Set settings across every bank";
    bulk.appendChild(bulkTitle);

    // Staged bulk edits, listed so several can be set up before applying. Each
    // row is one setting and the value it will take in every bank.
    const stagedList = document.createElement("div");
    stagedList.className = "bank-bulk-staged";
    bulk.appendChild(stagedList);

    function renderStaged() {
      stagedList.innerHTML = "";
      if (!bulkStaged.length) return;
      bulkStaged.forEach((entry, i) => {
        const row = document.createElement("div");
        row.className = "bank-bulk-row";
        const label = document.createElement("span");
        label.className = "bank-bulk-name";
        label.textContent = entry.label;
        const val = document.createElement("span");
        val.className = "bank-bulk-val";
        val.textContent = entry.valueLabel;
        const undo = document.createElement("button");
        undo.type = "button";
        undo.className = "bank-bulk-undo";
        undo.textContent = "\u00d7";
        undo.title = "Put this setting back to what each bank had";
        undo.addEventListener("click", () => {
          // restore the value every bank held before this row was staged
          bankState.slots.forEach((slot, si) => {
            if (entry.before[si] == null) return;
            slot.values[entry.addr] = entry.before[si];
          });
          bulkStaged.splice(i, 1);
          recomputeDirty();
          renderBankSheet();
        });
        row.append(label, val, undo);
        stagedList.appendChild(row);
      });
    }
    renderStaged();

    const picker = document.createElement("div");
    picker.className = "bank-bulk-picker";
    bulk.appendChild(picker);

    // The list is ordered and labelled the way the knob target picker is: by
    // voice and card rather than alphabetically, so "Target" is not four
    // identical-looking entries and a setting is found where it lives.
    const paramSel = document.createElement("select");
    paramSel.className = "save-field bank-bulk-select";
    const DOMAIN_LABEL = { chord: "Chord", harp: "Harp", space: "Space", play: "Play", midi: "MIDI", knobs: "Knobs" };
    [["chord"], ["harp"], ["space"], ["play"], ["midi"], ["knobs"]].forEach(([dom]) => {
      const group = document.createElement("optgroup");
      group.label = DOMAIN_LABEL[dom] || dom;
      PARAM_GROUPS.filter(g => (g.domain || "harp") === dom).forEach(g => {
        g.params.forEach(p => {
          if (p.grid) return;
          const o = document.createElement("option");
          o.value = String(p.addr);
          const card = p.card && !p.card.toLowerCase().startsWith(g.title.toLowerCase()) ? p.card : null;
          const mid = p.card && !card ? p.card : g.title;
          o.textContent = [mid, card, p.name].filter(Boolean).join(" \u00b7 ");
          group.appendChild(o);
        });
      });
      if (group.childNodes.length) paramSel.appendChild(group);
    });
    picker.appendChild(paramSel);

    const valWrap = document.createElement("span");
    valWrap.className = "bank-bulk-value";
    picker.appendChild(valWrap);

    function renderValueField() {
      valWrap.innerHTML = "";
      const p = paramByAddr[parseInt(paramSel.value, 10)];
      if (!p) return;
      // A setting that is itself an assignment — a knob's target, the double
      // tap's — takes an address as its value. Offering a number box there asks
      // the player to know the address numbers, so give them the same named
      // list the assignment itself uses.
      if (p.targetSelect) {
        const opts = targetOptions();
        const sel = document.createElement("select");
        sel.className = "save-field bank-bulk-select";
        opts.values.forEach((v, i) => {
          const o = document.createElement("option");
          o.value = String(v); o.textContent = opts.labels[i];
          sel.appendChild(o);
        });
        valWrap.appendChild(sel);
        return;
      }
      if (p.options) {
        const sel = document.createElement("select");
        sel.className = "save-field";
        p.options.forEach((label, idx) => {
          const o = document.createElement("option");
          o.value = String(idx); o.textContent = label;
          sel.appendChild(o);
        });
        valWrap.appendChild(sel);
      } else {
        const inp = document.createElement("input");
        inp.type = "number"; inp.className = "save-field";
        inp.min = String(p.min); inp.max = String(p.max);
        inp.step = String(p.step || 1);
        inp.value = String(p.def != null ? p.def : p.min);
        valWrap.appendChild(inp);
      }
    }
    paramSel.addEventListener("change", renderValueField);
    renderValueField();

    const applyAll = mkBtn("Set in all banks", "Stage this value in every bank and start another");
    applyAll.addEventListener("click", () => {
      const p = paramByAddr[parseInt(paramSel.value, 10)];
      const field = valWrap.querySelector("select, input");
      if (!p || !field) return;
      let v = Number(field.value);
      if (p.type === "float" && !p.options) v = Math.round(v * FLOAT_MULT);
      // remember what each bank held, so the row can be taken back
      const before = bankState.slots.map(slot => slot.values[p.addr]);
      const n = bulkSetParameter(p.addr, v, bankState.slots.map((_, i) => i));
      const existing = bulkStaged.findIndex(e => e.addr === p.addr);
      const entry = {
        addr: p.addr,
        label: paramSel.options[paramSel.selectedIndex].textContent,
        valueLabel: p.targetSelect ? field.options[field.selectedIndex].textContent
          : p.options ? p.options[Number(field.value)]
          : String(field.value) + (p.unit || ""),
        before: existing >= 0 ? bulkStaged[existing].before : before,
      };
      if (existing >= 0) bulkStaged[existing] = entry; else bulkStaged.push(entry);
      announce(n ? "Staged in " + n + (n === 1 ? " bank" : " banks") : "Every bank already has that value");
      renderBankSheet();
    });
    picker.appendChild(applyAll);
    card.appendChild(bulk);

    // ---- actions ----
    const applyBtn = mkBtn("Apply", "Write the staged changes to the minichord");
    applyBtn.classList.add("primary");
    applyBtn.disabled = !dirtyCount;
    applyBtn.addEventListener("click", async () => {
      if (!confirm("Write " + dirtyCount + (dirtyCount === 1 ? " bank" : " banks") +
                   " to the minichord? Back up first if you want a copy of what is there now.")) return;
      applyBtn.disabled = true;
      try {
        const n = await applyBankChanges((i, t) => { intro.textContent = "Writing " + (i + 1) + " of " + t + "\u2026"; });
        announce("Wrote " + n + (n === 1 ? " bank" : " banks"));
        if (controller.requestCurrentData) controller.requestCurrentData();
      } catch (e) {
        announce("Couldn't write: " + e.message);
      }
      renderBankSheet();
    });

    const discardBtn = mkBtn("Discard", "Throw away the staged changes and read the banks again");
    discardBtn.disabled = !dirtyCount;
    discardBtn.addEventListener("click", () => {
      bankState.slots = null; bankState.read = false; bulkStaged = [];
      renderBankSheet();
    });

    const closeBtn = mkBtn("Close", "Close");
    closeBtn.className = "mini-btn bank-sheet-close";
    closeBtn.addEventListener("click", closeBankSheet);

    actions.append(applyBtn, discardBtn, closeBtn);
  }

  function openBankSheet() {
    bankSheetPrevFocus = document.activeElement;
    if (!bankSheetEl) bankSheetEl = buildBankSheet();
    renderBankSheet();
    bankSheetEl.classList.add("open");
    if (window.Hotkeys) window.Hotkeys.setSuspended(true);
  }
  function closeBankSheet() {
    if (!bankSheetEl || !bankSheetEl.classList.contains("open")) return;
    bankSheetEl.classList.remove("open");
    if (window.Hotkeys) window.Hotkeys.setSuspended(false);
    if (bankSheetPrevFocus && bankSheetPrevFocus.focus) bankSheetPrevFocus.focus();
    bankSheetPrevFocus = null;
  }

  /* ---- whole-device backup ------------------------------------------------
   * A single file holding every bank, so an instrument can be restored or
   * swapped wholesale. The device has no bulk transfer: the firmware exposes
   * "load bank" and "report parameters", and the walk over all twelve banks
   * happens here.
   *
   * The file records the firmware version it came from, because a restore into
   * different firmware may be reading addresses that have since moved. Values
   * are stored raw and an address-to-name map is written once at the top, so
   * the file stays readable without repeating labels twelve times.            */
  const BACKUP_FORMAT = 1;

  function backupAddressNames() {
    const map = {};
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      map[p.addr] = (p.card ? p.card + " \u00b7 " : "") + p.name;
    }));
    return map;
  }

  async function backupAllBanks(onProgress) {
    if (!controller || !controller.isConnected()) throw new Error("no minichord connected");
    const startingBank = controller.getDeviceInfo().activeBankNumber;
    const bnames = bankNamesGet();
    const banks = [];
    for (let b = 0; b < 12; b++) {
      if (onProgress) onProgress(b, 12);
      const values = await controller.readBank(b, 3000, true);
      banks.push({ bank: b, name: bnames[b] || "", values: Array.from(values, v => (v == null ? 0 : v)) });
    }
    if (startingBank >= 0) await controller.readBank(startingBank, 3000, true);   // leave it where we found it
    if (controller.requestCurrentData) controller.requestCurrentData();            // one refresh, after the walk
    return {
      minichord_backup: BACKUP_FORMAT,
      created: new Date().toISOString(),
      firmware_version: patch[7] != null ? patch[7] : null,
      parameter_size: controller.getDeviceInfo().parameterSize,
      address_names: backupAddressNames(),
      banks,
    };
  }

  async function restoreAllBanks(data, onProgress) {
    if (!controller || !controller.isConnected()) throw new Error("no minichord connected");
    if (!data || !Array.isArray(data.banks)) throw new Error("not a minichord backup file");
    const startingBank = controller.getDeviceInfo().activeBankNumber;
    const restoredNames = bankNamesGet();
    for (let i = 0; i < data.banks.length; i++) {
      const entry = data.banks[i];
      if (entry.bank == null || !Array.isArray(entry.values)) continue;
      if (typeof entry.name === "string") restoredNames[entry.bank] = entry.name;
      if (onProgress) onProgress(i, data.banks.length);
      controller.loadBank(entry.bank);
      await new Promise(r => setTimeout(r, 60));
      // addresses 0 and 1 are the file marker and the bank number, not settings
      for (let a = 2; a < entry.values.length; a++) {
        const v = entry.values[a];
        if (v == null || DEVICE_STATE_ADDRS.has(a)) continue;
        controller.sendParameter(a, v);
        if ((a & 31) === 0) await new Promise(r => setTimeout(r, 1));   // let the buffer drain
      }
      await new Promise(r => setTimeout(r, 40));
      controller.saveCurrentSettings(entry.bank);
      await new Promise(r => setTimeout(r, 120));                       // the write is to flash
    }
    // A backup holds the tuning in every bank's dump, because the firmware
    // substitutes the live value at address 255 when it dumps. Restore it ONCE,
    // from the first bank that carries a plausible one, rather than per bank.
    for (const entry of data.banks) {
      const t = entry && entry.values ? entry.values[255] : null;
      if (t != null && t >= 4320 && t <= 4460) { controller.sendParameter(255, t); break; }
    }
    bankNamesSet(restoredNames);
    if (startingBank >= 0) controller.loadBank(startingBank);
  }

  function downloadBackup(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = "minichord-backup-" + stamp + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // pull preset objects out of parsed JSON (single object / array / wrapper)
  function presetsFromJson(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.shared_presets)) return data.shared_presets;
    if (data && data.name && data.value) return [data];
    return [];
  }

  // merge loaded preset objects into the custom list, re-render, optionally load the first
  function addCustomPresets(list, loadFirst) {
    if (!window.PresetMatch || !list || !list.length) return;
    const valid = list.filter(p => p && p.name && p.value);
    if (!valid.length) return;
    const names = new Set(valid.map(p => p.name));
    const merged = valid.concat(window.PresetMatch.custom.filter(p => !names.has(p.name)));
    window.PresetMatch.setCustom(merged);
    renderPresetsPanel();
    if (loadFirst) {
      const idx = window.PresetMatch.all.findIndex(p => p.name === valid[0].name);
      if (idx >= 0) loadPreset(idx);
    }
  }

  // auto-load json/custom_presets/*.json, works when served over HTTP; on
  // file:// fetch throws and we simply end up with no custom presets.
  async function loadCustomPresets() {
    let files = [];
    try {
      const idx = await fetch("json/custom_presets/index.json", { cache: "no-store" });
      if (idx.ok) { const j = await idx.json(); if (Array.isArray(j)) files = j; }
    } catch (e) { /* no manifest */ }
    if (!files.length) {
      try {
        const dir = await fetch("json/custom_presets/", { cache: "no-store" });
        if (dir.ok) {
          const html = await dir.text();
          files = Array.from(html.matchAll(/href="([^"]+\.json)"/gi))
            .map(m => decodeURIComponent(m[1].split("/").pop()))
            .filter(f => f && f.toLowerCase() !== "index.json");
        }
      } catch (e) { /* file:// or no folder */ }
    }
    const out = [];
    for (const f of files) {
      try {
        const r = await fetch("json/custom_presets/" + f, { cache: "no-store" });
        if (r.ok) presetsFromJson(await r.json()).forEach(p => out.push(p));
      } catch (e) { /* skip */ }
    }
    if (out.length) addCustomPresets(out, false);
  }

  // load preset(s) from a user-picked file (works on file://)
  function loadPresetFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let pending = files.length;
    const collected = [];
    const done = () => { if (--pending === 0) addCustomPresets(collected, true); };
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => { try { presetsFromJson(JSON.parse(reader.result)).forEach(p => collected.push(p)); } catch (e) {} done(); };
      reader.onerror = done;
      reader.readAsText(file);
    });
  }

  /* ---- copy / paste settings as readable text ------------------------------
   * Copy puts { soundlab_settings: 1, params: { "Harp · Oscillator":
   * { "Waveform": 3, … } } } on the clipboard, named params, forum-friendly.
   * Paste accepts that shape, any preset .json (object / array /
   * shared_presets wrapper) or a bare base64 value string. */
  // copied keys stay plain ASCII (no "·"/"×", typing them back is painful)
  const asciiKey = s => s.replace(/\s*·\s*/g, " - ").replace(/×/g, "x");
  function sectionKeyOf(g) {
    const dom = domainOf(g);
    const dm = DOMAINS.find(d => d.id === dom);
    return `${dm ? dm.label : dom.charAt(0).toUpperCase() + dom.slice(1)} - ${g.title}`;
  }
  // a few groups reuse a param name across cards (chord oscillators 1/2/3,
  // vibrato Envelope vs Pitch bend, the four knob slots), append the card so
  // a copy keeps all of them instead of last-wins collapsing to one
  function paramKeyOf(g, p) {
    const dup = g.params.some(q => q !== p && q.name === p.name);
    return asciiKey(dup ? `${p.name} (${p.card})` : p.name);
  }
  function settingsToText() {
    const params = {};
    PARAM_GROUPS.forEach(g => {
      const sect = params[sectionKeyOf(g)] = params[sectionKeyOf(g)] || {};
      g.params.forEach(p => { if (patch[p.addr] != null) sect[paramKeyOf(g, p)] = patch[p.addr]; });
    });
    return JSON.stringify({ soundlab_settings: 1, params }, null, 2);
  }
  function clampToParam(p, v) {
    if (!Number.isFinite(v)) return null;
    const c = Math.min(p.max, Math.max(p.min, v));
    return p.type === "float" ? roundTo(c, p.step) : Math.round(c);
  }
  // raw ';'-decoded int list → {addr: UI value} over the catalog params
  function rawToSnap(raw) {
    if (!raw || raw.length < 100) return null;
    const snap = {};
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const rv = raw[p.addr];
      if (rv == null || !Number.isFinite(rv)) return;
      const v = clampToParam(p, p.type === "float" ? rv / FLOAT_MULT : rv);
      if (v != null) snap[p.addr] = v;
    }));
    return Object.keys(snap).length ? snap : null;
  }
  // parse pasted text → {snap, applied, skipped, label} or null when unreadable
  function settingsFromText(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* maybe a bare base64 string */ }

    if (j && j.soundlab_settings && j.params && typeof j.params === "object" && !Array.isArray(j.params)) {
      const bySection = {};   // section key -> { param key -> param }
      const byName = {};      // param key -> param, or "dup" when ambiguous across sections
      PARAM_GROUPS.forEach(g => {
        const sect = bySection[sectionKeyOf(g)] = bySection[sectionKeyOf(g)] || {};
        g.params.forEach(p => {
          const n = paramKeyOf(g, p);
          sect[n] = p;
          byName[n] = n in byName && byName[n] !== p ? "dup" : p;
        });
      });
      const snap = {};
      let applied = 0, skipped = 0;
      Object.keys(j.params).forEach(k => {
        const sect = j.params[k];
        if (!sect || typeof sect !== "object" || Array.isArray(sect)) { skipped++; return; }
        Object.keys(sect).forEach(n => {
          // exact section first; a section-less / renamed-section paste still
          // lands when the param name is unique across the whole catalog
          const hit = (bySection[k] && bySection[k][n]) || byName[n];
          const p = hit && hit !== "dup" ? hit : null;
          const v = p ? clampToParam(p, Number(sect[n])) : null;
          if (v != null) { snap[p.addr] = v; applied++; } else skipped++;
        });
      });
      return applied ? { snap, applied, skipped, label: "settings text" } : null;
    }

    const tryDecode = v => { try { return window.PresetMatch.decode(v); } catch (e) { return null; } };

    const list = j ? presetsFromJson(j) : [];
    if (list.length && list[0] && list[0].value && window.PresetMatch) {
      const snap = rawToSnap(tryDecode(list[0].value));
      return snap ? { snap, applied: Object.keys(snap).length, skipped: 0, label: `preset "${list[0].name || "?"}"` } : null;
    }

    if (!j && window.PresetMatch) {
      const raw = tryDecode(t);
      const snap = raw && raw.every(Number.isFinite) ? rawToSnap(raw) : null;
      return snap ? { snap, applied: Object.keys(snap).length, skipped: 0, label: "a preset string" } : null;
    }
    return null;
  }
  // fallback paste box for browsers that block clipboard reads (Firefox)
  let pastePopupEl = null, pasteAreaEl = null;
  function buildPastePopup() {
    const pop = document.createElement("div");
    pop.className = "save-popup paste-popup";
    const area = document.createElement("textarea");
    area.className = "save-field save-desc"; area.rows = 6;
    area.placeholder = "Paste copied settings text, a preset .json or a preset string here…";
    const row = document.createElement("div"); row.className = "save-actions";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "mini-btn"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closePastePopup());
    const apply = document.createElement("button");
    apply.type = "button"; apply.className = "mini-btn primary"; apply.textContent = "Apply settings";
    apply.addEventListener("click", () => { applyPastedSettings(area.value); closePastePopup(); });
    row.append(cancel, apply);
    pop.append(area, row);
    pop.addEventListener("click", e => e.stopPropagation());
    pastePopupEl = pop; pasteAreaEl = area;
    return pop;
  }
  function togglePastePopup(trigger) {
    if (!pastePopupEl) return;
    const willOpen = !pastePopupEl.classList.contains("open");
    closePastePopup();
    if (willOpen) {
      pastePopupEl.classList.add("open");
      anchorPopup(trigger, pastePopupEl);
      if (pasteAreaEl) { pasteAreaEl.value = ""; pasteAreaEl.focus(); }
    }
  }
  function closePastePopup() { if (pastePopupEl) pastePopupEl.classList.remove("open"); }

  // pasted text → a named custom preset ({name, author, value}). A real preset
  // .json keeps its identity; settings text / bare strings get a synthesized
  // name and a value rebuilt over the catalog defaults (so trigger preset
  // actions, which resolve by NAME, can target a paste).
  function presetFromText(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    let j = null;
    try { j = JSON.parse(t); } catch (e) { /* not json, maybe a bare string */ }
    const list = j ? presetsFromJson(j) : [];
    if (list.length && list[0] && list[0].name && list[0].value) return list[0];
    const r = settingsFromText(t);
    if (!r) return null;
    const n = ((window.PresetMatch && window.PresetMatch.custom) || []).filter(p => /^Pasted preset/.test(p.name)).length;
    const arr = new Array(PRESET_LEN).fill(0);
    arr[2] = 50; arr[3] = 50; arr[4] = 512; arr[5] = 512; arr[6] = 512;   // pot/volume, as presets store them
    PARAM_GROUPS.forEach(g => g.params.forEach(p => {
      const v = r.snap[p.addr] != null ? r.snap[p.addr] : p.def;
      arr[p.addr] = p.type === "float" ? Math.round(v * FLOAT_MULT) : Math.round(v);
    }));
    return { name: "Pasted preset" + (n ? " " + (n + 1) : ""), author: "", description: "Pasted from settings text",
      value: window.PresetMatch ? window.PresetMatch.encode(arr) : btoa(arr.join(";")) };
  }

  function applyPastedSettings(text) {
    const r = settingsFromText(text);
    if (!r) {
      announce("Couldn't read that as settings. Paste copied settings text, a preset .json, or a preset string.");
      return;
    }
    const before = {};
    Object.keys(r.snap).forEach(a => { before[a] = patch[a]; });
    applyPatchSnapshot(r.snap);
    recordPatchChange("Pasted settings", before, r.snap);
    scheduleIdentify();
    announce(`Applied ${r.applied} setting${r.applied === 1 ? "" : "s"} from ${r.label}`
      + (r.skipped ? `, ${r.skipped} unrecognized skipped` : ""));
  }

  /* ---- save popup (name required, author + description optional) ----------- */
  function buildSavePopup() {
    const pop = document.createElement("div");
    pop.className = "save-popup";
    const name = document.createElement("input");
    name.type = "text"; name.className = "save-field"; name.placeholder = "Name (required)";
    const author = document.createElement("input");
    author.type = "text"; author.className = "save-field"; author.placeholder = "Author (optional)";
    const descr = document.createElement("textarea");
    descr.className = "save-field save-desc"; descr.rows = 2; descr.placeholder = "Description (optional)";
    const err = document.createElement("p"); err.className = "save-error";
    const row = document.createElement("div"); row.className = "save-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "mini-btn"; cancel.textContent = "Cancel";
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "mini-btn primary"; dl.textContent = "Download .json";
    cancel.addEventListener("click", closeSavePopup);
    dl.addEventListener("click", () => {
      const n = name.value.trim();
      if (!n) { err.textContent = "Please enter a name."; name.focus(); return; }
      downloadPreset(n, author.value.trim(), descr.value.trim());
      closeSavePopup();
    });
    row.append(cancel, dl);
    pop.append(name, author, descr, err, row);
    pop.addEventListener("click", e => e.stopPropagation());   // clicks inside don't close it
    savePopupEl = pop; saveNameInput = name;
    return pop;
  }
  function toggleSavePopup(trigger) {
    if (!savePopupEl) return;
    const willOpen = !savePopupEl.classList.contains("open");
    closeSavePopup();
    if (willOpen) {
      savePopupEl.classList.add("open");
      anchorPopup(trigger, savePopupEl);
      if (saveNameInput) saveNameInput.focus();
    }
  }
  function closeSavePopup() { if (savePopupEl) savePopupEl.classList.remove("open"); }

  // reflect editor state: label + tint the trigger with the loaded preset's
  // profile, and mark its card active (cleared once the user edits a control).
  function highlightPresets() {
    if (!presetTrigger || !window.PresetMatch) return;
    let activeIdx = -1;
    if (activePresetName != null)
      activeIdx = window.PresetMatch.all.findIndex(p => p.name === activePresetName);

    const m = activeIdx >= 0 ? presetMeta[activeIdx] : null;
    if (activeIdx >= 0) {
      const preset = window.PresetMatch.all[activeIdx];
      presetTriggerText.textContent = `${preset.name}${preset.author ? " · " + preset.author : ""}${activePresetEdited ? " (edited)" : ""}`;
      presetTrigger.style.color = m ? m.fg : "";
      presetTrigger.style.borderColor = m ? m.fg : "";
    } else {
      presetTriggerText.textContent = "Browse presets…";
      presetTrigger.style.color = "";
      presetTrigger.style.borderColor = "";
    }
    Object.entries(presetCards).forEach(([i, card]) =>
      card.classList.toggle("active", Number(i) === activeIdx));
    if (presetDescEl) {
      const d = activeIdx >= 0 ? (window.PresetMatch.all[activeIdx].description || "") : "";
      presetDescEl.textContent = d;
      presetDescEl.style.display = d ? "" : "none";
    }
    syncPresetButtons();
  }

  // one line naming the preset in the slot (or flagging it as custom)
  function slotPresetHtml() {
    if (slotPreset === undefined) return "<p class=\"device-preset checking\">Identifying slot…</p>";
    // a name the player gave this bank takes precedence: they know what it is
    // better than a library fingerprint does
    const bank = controller ? controller.active_bank_number : -1;
    const given = (bank != null && bank >= 0) ? (bankNamesGet()[bank] || "") : "";
    if (given) {
      const also = slotPreset
        ? `<span class="preset-author"> \u00b7 ${slotPreset.name}${slotPresetEdited ? " (edited)" : ""}</span>`
        : "";
      return `<p class="device-preset matched">This slot holds <b>${escapeHtml(given)}</b>${also}</p>`;
    }
    if (slotPreset === null)
      return "<p class=\"device-preset custom\">Custom or unrecognised patch. Not one of the shared presets. " +
        "You can name it in All banks\u2026</p>";
    return `<p class="device-preset matched">This slot holds <b>${slotPreset.name}</b>` +
      `<span class="preset-author"> by ${slotPreset.author}</span>${slotPresetEdited ? " (edited)" : ""}</p>`;
  }

  // firmware version + up-to-date status (with a link to the update guide)
  function firmwareHtml() {
    if (deviceFirmware == null) return "";
    if (deviceFirmware >= LATEST_FIRMWARE)
      return `<p class="device-fw ok">Firmware v${deviceFirmware}</p>`;
    return `<p class="device-fw stale">⚠ Firmware v${deviceFirmware} is out of date. ` +
      `Some controls need v${LATEST_FIRMWARE} and won't affect your device. ` +
      `<a href="${FIRMWARE_GUIDE}" target="_blank" rel="noopener">How to update ↗</a></p>`;
  }

  let lastAnnouncedConn = false;   // announce only actual changes, not the load-time state
  function setBadge(connected) {
    refreshRhythmHelp();   // re-word the rhythm play/pause help for live vs learning mode
    applyBankAccent();     // --ui-hue follows the bank only while connected
    if (connected !== lastAnnouncedConn) {
      lastAnnouncedConn = connected;
      announce(connected ? "minichord connected" : "minichord disconnected. Learning mode");
    }
    if (!badge) return;
    badge.className = "badge " + (connected ? "connected" : "offline");
    badge.textContent = connected ? "connected" : "learning mode";
  }

  function updateConnectionUI(connected, data) {
    setBadge(connected);
    if (!deviceCard) return;
    if (!connected) { slotPreset = undefined; colorFieldEl = null; updateFirmwareWarnings(); buildConnectCard(typeof data === "string" ? data : ""); return; }
    const bank = (data && data.bankNumber != null) ? data.bankNumber + 1 : (controller.active_bank_number + 1) || "?";

    // LED brightness sits with Bank color (both cosmetic LED settings). Addr 32 is an ATTENUATION
    // (0 = full brightness, higher = dimmer); the firmware drives the LED at v = 1 - attenuation,
    // ~linear in PWM duty. The slider (a) shows the INVERSE (left = dim, right = full), (b) is
    // PERCEPTUAL (the eye sees brightness ≈ v^(1/γ)), and (c) maps its visible travel onto
    // [V_FLOOR, 1] so no slider region is a dead "all off" band, only the very bottom edge is off.
    const p32 = paramByAddr[32];
    const ledAtten = patch[32] != null ? patch[32] : (p32 ? p32.def : 0);
    const ledV = 1 - ledAtten;   // current LED luminance
    const ledPos = ledV <= LED_V_FLOOR ? 0 : Math.pow((ledV - LED_V_FLOOR) / (1 - LED_V_FLOOR), 1 / LED_GAMMA);
    deviceCard.innerHTML =
      "<div class=\"device-status connected\" id=\"dev-status\"><span class=\"dot\" id=\"dev-dot\"></span>minichord connected" +
        `<span class="bank-stepper">` +
          `<button class="bank-step" id="dev-bank-prev" type="button" title="Previous bank" aria-label="Previous bank">\u2039</button>` +
          `<span class="bank-badge">Bank ${bank}</span>` +
          `<button class="bank-step" id="dev-bank-next" type="button" title="Next bank" aria-label="Next bank">\u203a</button>` +
        `</span></div>` +
      "<p class=\"device-sub\">Live sync on. Moving a control updates the device.</p>" +
      slotPresetHtml() +
      "<div class=\"color-field\" id=\"dev-color-field\">" +
        "<button class=\"color-trigger\" id=\"dev-color-btn\" type=\"button\" aria-haspopup=\"true\" aria-expanded=\"false\">" +
          "<span class=\"color-swatch\" id=\"dev-color-swatch\"></span><span>Bank color</span>" +
        "</button>" +
        "<div class=\"color-popup\" id=\"dev-color-popup\">" +
          `<input type="range" class="hue-slider" id="dev-color" min="0" max="360" step="1" value="${bankColor}" aria-label="Bank color">` +
          "<label class=\"led-bright-label\" for=\"dev-bright\">LED brightness</label>" +
          `<input type="range" class="bright-slider" id="dev-bright" min="0" max="1" step="0.01" value="${ledPos}" aria-label="LED brightness">` +
        "</div>" +
      "</div>" +
      "<div class=\"device-actions\">" +
      "<button class=\"mini-btn primary\" id=\"dev-save\" title=\"Write the current sound into this bank's flash memory. It survives power-off\">Save to bank</button>" +
      "<button class=\"mini-btn\" id=\"dev-reload\" title=\"Re-read this bank from the device, discarding unsaved edits in the Lab\">Reload</button>" +
      "<button class=\"mini-btn\" id=\"dev-reset\" title=\"Restore this bank to its factory default preset\">Reset bank</button>" +
      "</div>" +
      firmwareHtml();
    // Stepping banks from here is only possible because the firmware exposes a
    // load-bank command; the device used to be steppable only from its own
    // preset buttons. Loading a bank reports nothing back, so ask for the dump.
    const stepBank = delta => {
      if (!controller.isConnected()) return;
      const cur = controller.active_bank_number;
      if (cur == null || cur < 0) return;
      const next = (cur + delta + 12) % 12;
      if (!controller.loadBank(next)) return;
      setTimeout(() => controller.requestCurrentData(), 80);
    };
    const bankPrev = document.getElementById("dev-bank-prev");
    const bankNext = document.getElementById("dev-bank-next");
    if (bankPrev) bankPrev.addEventListener("click", () => stepBank(-1));
    if (bankNext) bankNext.addEventListener("click", () => stepBank(1));

    const save = document.getElementById("dev-save");
    const reload = document.getElementById("dev-reload");
    const reset = document.getElementById("dev-reset");
    const colorField = document.getElementById("dev-color-field");
    const colorBtn = document.getElementById("dev-color-btn");
    const colorPopup = document.getElementById("dev-color-popup");
    const colorInput = document.getElementById("dev-color");
    const colorSwatch = document.getElementById("dev-color-swatch");
    const statusEl = document.getElementById("dev-status");
    const dotEl = document.getElementById("dev-dot");
    colorFieldEl = colorField;
    // the bank color also tints the "connected" status text + indicator light
    const paintColor = hue => {
      const vivid = `hsl(${hue},85%,55%)`;
      if (colorSwatch) colorSwatch.style.background = vivid;
      if (statusEl) statusEl.style.color = `hsl(${hue},72%,62%)`;
      if (dotEl) { dotEl.style.background = vivid; dotEl.style.boxShadow = `0 0 7px ${vivid}`; }
    };
    paintColor(bankColor);
    if (colorBtn) colorBtn.addEventListener("click", e => {
      e.stopPropagation();
      const open = !colorField.classList.contains("open");
      colorField.classList.toggle("open", open);
      colorBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) anchorPopup(colorBtn, colorPopup);
    });
    if (colorInput) colorInput.addEventListener("input", () => {
      bankColor = Number(colorInput.value);
      paintColor(bankColor);
      applyBankAccent();   // rhythm grid, live mirror and (in "all" mode) every accent follow
      controller.sendParameter(COLOR_ADDR, bankColor);   // live-update the device LED
    });

    // LED brightness (addr 32) lives here beside Bank color. Hand-wired like the hue slider
    // (the device card is rebuilt per dump, reading patch[32]); routes through the normal control
    // path so patch + any synced copy update and the device gets it (sendToDevice re-sends the
    // color so the LED repaints immediately).
    const brightInput = document.getElementById("dev-bright");
    if (brightInput) brightInput.addEventListener("input", () => {
      const pos = Number(brightInput.value);
      // bottom edge = off; everything above maps onto the visible band [V_FLOOR, 1] with the γ curve
      const v = pos <= 0 ? 0 : LED_V_FLOOR + (1 - LED_V_FLOOR) * Math.pow(pos, LED_GAMMA);
      const attn = 1 - v;
      patch[32] = attn;
      (controls[32] || []).forEach(fn => fn(attn));
      onPatchChange(paramByAddr[32], attn);
    });
    if (save) save.addEventListener("click", () => {
      if (controller.saveCurrentSettings(controller.active_bank_number)) { flash(save, "Saved"); bankCacheStale(); }
    });
    if (reload) reload.addEventListener("click", requestDump);
    if (reset) reset.addEventListener("click", () => {
      if (controller.resetCurrentBank()) {
        bankCacheStale();
        flash(reset, "Reset");
        setTimeout(requestDump, 150);   // let the reset land, then re-read the bank into the UI
      }
    });
  }

  function buildConnectCard(message) {
    if (!deviceCard) return;
    // the Connect button always renders. Web MIDI is feature-detected on
    // CLICK, not here. Some browsers only start their permission flow once
    // requestMIDIAccess is actually called from a user gesture, so gating the
    // button on the API's presence or an earlier failed attempt could lock
    // those users out of the prompt entirely.
    deviceCard.innerHTML =
      "<div class=\"device-status\"><span class=\"dot off\"></span>not connected</div>" +
      "<p class=\"device-sub\">Connect your minichord over USB to edit and hear changes live. The Lab works fully without it too.</p>" +
      (controller ? "<button class=\"mini-btn primary\" id=\"dev-connect\">Connect minichord</button>" : "") +
      (message ? `<p class="device-warn">${message}</p>` : "");
    const c = document.getElementById("dev-connect");
    if (c) c.addEventListener("click", connect);
  }

  function connect() {
    if (!controller) return;
    if (!navigator.requestMIDIAccess) {
      buildConnectCard("This browser doesn't offer Web MIDI here. Use Chrome or Edge.");
      return;
    }
    if (deviceCard) deviceCard.innerHTML = "<div class=\"device-status\"><span class=\"dot\"></span>connecting…</div>";
    controller.initialize().then(ok => {
      if (ok && controller.isConnected()) {
        updateConnectionUI(true);   // device detected, flip now, don't wait for the dump
        requestDump();              // ask the device for its current bank
      } else if (!ok) {
        buildConnectCard("Couldn't get MIDI access. Allow the browser's prompt and try again, or use Chrome or Edge.");
      }
      // ok but no device: controller.onConnectionChange(false, …) already updated the card
    });
  }

  function requestDump() {
    if (controller && controller.device) controller.device.send([0xF0, 0, 0, 0, 0, 0xF7]);
  }

  /* ---- MIDI recorder: capture the device's note stream, save a .mid --------
   * The minichord only SENDS notes (nothing can be played back into it), so
   * this is record + save: buffer (t, role, note, vel) while armed, then write
   * a format-1 SMF, tempo from the BPM at record start, chord + harp as two
   * named tracks on their configured channels (addrs 106/107). */
  const midiRec = (function () {
    let events = null, t0 = 0, recBpm = 120, btn = null, cancelBtn = null, tickId = null;
    const pad = n => (n < 10 ? "0" : "") + n;
    function syncBtn() {
      if (!btn) return;
      const live = !!(controller && controller.isConnected());
      btn.disabled = !live && !events;
      btn.classList.toggle("recording", !!events);
      if (cancelBtn) cancelBtn.style.display = events ? "" : "none";
      if (events) {
        const s = Math.floor((performance.now() - t0) / 1000);
        btn.textContent = `■ Save ${Math.floor(s / 60)}:${pad(s % 60)}`;
        btn.title = "Stop recording and download the .mid file";
      } else {
        btn.textContent = "● Record MIDI";
        btn.title = live ? "Record what you play into a standard .mid file"
          : "Connect the minichord to record what you play";
      }
    }
    function cancel() {   // discard without saving
      if (!events) return;
      events = null;
      if (tickId) { clearInterval(tickId); tickId = null; }
      syncBtn();
      announce("Recording discarded. Nothing saved");
    }
    function feed(role, type, note, vel) {
      if (!events || (type !== "on" && type !== "off")) return;
      events.push({ t: performance.now() - t0, role, type, note, vel: vel || 0 });
    }
    function start() {
      events = []; t0 = performance.now();
      recBpm = Math.max(30, Math.min(300, Math.round(patch[187] || 120)));
      tickId = setInterval(syncBtn, 500);
      syncBtn();
      announce("Recording MIDI. Play away, press the button again to save");
    }
    function stop() {
      const evs = events;
      events = null;
      if (tickId) { clearInterval(tickId); tickId = null; }
      syncBtn();
      if (!evs) return;
      if (!evs.length) { announce("Nothing recorded. No notes arrived from the device"); return; }
      downloadMidi(evs, recBpm);
      announce(`Saved ${evs.filter(e => e.type === "on").length} notes to minichord-recording.mid`);
    }
    function downloadMidi(evs, bpm) {
      const TPQ = 480;
      const msToTicks = ms => Math.round(ms * TPQ * bpm / 60000);
      const vlq = n => { const out = [n & 0x7F]; for (n >>>= 7; n > 0; n >>>= 7) out.unshift((n & 0x7F) | 0x80); return out; };
      const chOf = addr => Math.max(0, Math.min(15, Math.round(patch[addr] || 1) - 1));
      const track = (name, ch, list, tempoFirst) => {
        const d = [];
        if (tempoFirst) {
          const us = Math.round(60000000 / bpm);
          d.push(0, 0xFF, 0x51, 0x03, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF);
        }
        d.push(0, 0xFF, 0x03, name.length);
        for (const c of name) d.push(c.charCodeAt(0) & 0x7F);
        let last = 0;
        list.forEach(e => {
          const t = msToTicks(e.t);
          d.push(...vlq(Math.max(0, t - last)));
          last = t;
          d.push((e.type === "on" ? 0x90 : 0x80) | ch, e.note & 0x7F, e.vel & 0x7F);
        });
        d.push(0, 0xFF, 0x2F, 0x00);
        return [0x4D, 0x54, 0x72, 0x6B,
          (d.length >>> 24) & 0xFF, (d.length >>> 16) & 0xFF, (d.length >>> 8) & 0xFF, d.length & 0xFF].concat(d);
      };
      const chord = evs.filter(e => e.role !== "harp");   // single-port mode: everything lands here
      const harp = evs.filter(e => e.role === "harp");
      const tracks = [track("minichord chords", chOf(106), chord, true)];
      if (harp.length) tracks.push(track("minichord harp", chOf(107), harp, false));
      const head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (TPQ >> 8) & 0xFF, TPQ & 0xFF];
      const blob = new Blob([new Uint8Array(head.concat(...tracks))], { type: "audio/midi" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "minichord-recording.mid";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    function makeButton() {
      const wrap = document.createElement("span");
      wrap.className = "rec-wrap";
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini-btn rec-btn";
      btn.addEventListener("click", () => { if (events) stop(); else start(); });
      cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "hk-clear rec-cancel";
      cancelBtn.textContent = "×";
      cancelBtn.title = "Discard the recording without saving";
      cancelBtn.setAttribute("aria-label", cancelBtn.title);
      cancelBtn.addEventListener("click", cancel);
      wrap.append(btn, cancelBtn);
      syncBtn();
      return wrap;
    }
    // disconnect mid-take: save what's captured rather than losing it
    function connection(connected) { if (!connected && events) stop(); else syncBtn(); }
    return { feed, makeButton, connection };
  })();

  let autoConnecting = false;   // suppresses the "not found" message during the load-time attempt
  if (controller) {
    controller.onConnectionChange = (connected, msg) => {
      if (!connected) updateConnectionUI(false, autoConnecting ? "" : msg);
      if (deviceMap) deviceMap.setConnected(connected);
      midiRec.connection(connected);
    };
    controller.onDataReceived = data => loadFromDevice(data);
    controller.onNoteEvent = (role, type, note, vel) => {
      if (type === "on") lastDeviceNoteT = Date.now();   // "is the device sounding?" proxy (rhythm lock for rolls)
      midiRec.feed(role, type, note, vel);   // the recorder hears everything, even in single-port mode
      if (patch[108] === 1) return;   // single-port mode: the mirror can't trust roles, drop the stream
      if (deviceMap) deviceMap.onNote(role, type, note, vel);
      if (staffView) {
        if (type === "on") staffView.noteOn(role, note); else staffView.noteOff(role, note);
      }
      if (role === "chord") rhythmSync.onChordNote(type, note);
    };
  }
  buildConnectCard();

  // try to connect on load (like minicontrol). Chrome shows the MIDI permission
  // prompt once, then silently grants on later visits; once the session is live
  // the controller auto-connects when the minichord is plugged in. Browsers
  // that need a user gesture for their permission flow quietly fail here and
  // get it from the Connect button instead. If access is refused or no device
  // is present, we quietly stay in learning mode.
  function autoConnect() {
    if (!controller || !navigator.requestMIDIAccess) return;
    autoConnecting = true;
    controller.initialize().then(ok => {
      autoConnecting = false;
      if (ok && controller.isConnected()) { updateConnectionUI(true); midiRec.connection(true); requestDump(); }
    }).catch(() => { autoConnecting = false; });
  }

  /* ---- hotkey actions --------------------------------------------------------
   * The engine (hotkeys.js) owns serialization/dispatch/persistence; the
   * handlers are this module's closures. Defaults live HERE. The "hotkeys"
   * pref stores only the user's overrides. Escape stays hardcoded app-wide. */
  const TEXT_SCALE_STEPS = ["s", "m", "l", "xl"];
  function stepTextScale(d) {
    const i = TEXT_SCALE_STEPS.indexOf(Prefs.get("textScale"));
    Prefs.set("textScale", TEXT_SCALE_STEPS[Math.max(0, Math.min(TEXT_SCALE_STEPS.length - 1, i + d))]);
  }
  function stepDomain(d) {
    if (activeViewId !== "customize") setActiveView("customize");
    const doms = DOMAINS.filter(dm => dm.id === "overview" || groupsInDomain(dm.id).length);
    const i = doms.findIndex(x => x.id === activeDomain);
    setActiveDomain(doms[((i < 0 ? 0 : i) + d + doms.length) % doms.length].id);
  }
  function stepGroup(d) {
    if (activeViewId !== "customize") setActiveView("customize");
    if (activeDomain === "overview") { stepDomain(d); return; }
    const groups = groupsInDomain(activeDomain);
    if (!groups.length) return;
    const i = groups.findIndex(g => g.id === activeGroupId);
    setActiveGroup(groups[((i < 0 ? 0 : i) + d + groups.length) % groups.length].id);
  }
  if (window.Hotkeys) window.Hotkeys.register([
    { id: "view-play",      group: "Views", label: "Go to Play",      def: "1", run: () => setActiveView("play") },
    { id: "view-customize", group: "Views", label: "Go to Customize", def: "2", run: () => setActiveView("customize") },
    { id: "view-about",     group: "Views", label: "Go to About",     def: "3", run: () => setActiveView("about") },
    { id: "tab-prev",    group: "Navigate", label: "Previous settings tab", def: "[", run: () => stepGroup(-1) },
    { id: "tab-next",    group: "Navigate", label: "Next settings tab",     def: "]", run: () => stepGroup(1) },
    { id: "domain-prev", group: "Navigate", label: "Previous section",      def: "{", run: () => stepDomain(-1) },
    { id: "domain-next", group: "Navigate", label: "Next section",          def: "}", run: () => stepDomain(1) },
    { id: "presets", group: "Panels", label: "Open presets",          def: "B", run: () => { if (presetTrigger) presetTrigger.click(); } },
    { id: "prefs",   group: "Panels", label: "Preferences",           def: "P", run: () => { if (prefsBtn) prefsBtn.click(); } },
    { id: "a11y",    group: "Panels", label: "Accessibility options", def: "A", run: () => { if (a11yBtn) a11yBtn.click(); } },
    { id: "hotkeys", group: "Panels", label: "Shortcut editor",       def: "K", run: () => { if (hkBtn) hkBtn.click(); } },
    { id: "save-device", group: "Device", label: "Save to device bank", def: "S", run: () => { const b = document.getElementById("dev-save"); if (b) b.click(); } },
    { id: "undo", group: "Device", label: "Undo last change", def: "Ctrl+Z", run: () => undoChange() },
    { id: "redo", group: "Device", label: "Redo change", def: "Ctrl+Y", run: () => redoChange() },
    // toggles from the EFFECTIVE theme ("auto" resolves to the OS scheme), and pins the explicit opposite
    { id: "theme",        group: "Appearance", label: "Toggle dark / light", def: "T", run: () => Prefs.set("theme", document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light") },
    { id: "text-bigger",  group: "Appearance", label: "Larger text",  def: "+", run: () => stepTextScale(1) },
    { id: "text-smaller", group: "Appearance", label: "Smaller text", def: "-", run: () => stepTextScale(-1) },
    { id: "cheatsheet", group: "Help", label: "Show the cheat sheet", def: "?", run: toggleHkSheet },
  ]);

  window.SoundLab = { patch, reference, posToValue, valueToPos, setActiveGroup, controller, loadPreset };

  // live "Play" mirror, reads the patch for note mapping + the playing hue for
  // its glow; chord/pluck observers feed the trigger system (device AND clicks)
  if (window.DeviceMap) deviceMap = window.DeviceMap.create({
    getPatch: () => patch,
    getHue: () => effectiveHue(),
    onChord: ev => window.Triggers.feedChord(ev),
    onPluck: strings => window.Triggers.feedPluck(strings),
  });

  render();
  applyBankAccent();   // restore the saved accent scope (and "all"-mode colors) on load
  if (Prefs.get("welcome")) openWelcome();   // first visit, or re-armed in preferences
  renderPresetsPanel();
  loadCustomPresets();   // async; re-renders the list if any custom presets are found
  autoConnect();         // attempt to connect to a plugged-in minichord on load

  // close the preset dropdown / color popup / save popup on outside-click or Escape
  document.addEventListener("click", e => {
    // a click that re-rendered its own target mid-dispatch (glossary see-also /
    // back nav swaps the popover's innerHTML) leaves e.target DETACHED. Its
    // ancestor chain is gone, so every contains()/closest() below would read it
    // as "outside" and close everything. Never treat a detached node as outside.
    if (e.target instanceof Element && !document.documentElement.contains(e.target)) return;
    if (presetsPanel && presetsPanel.classList.contains("open") && !presetsPanel.contains(e.target))
      setPresetOpen(false);
    if (colorFieldEl && colorFieldEl.classList.contains("open") && !colorFieldEl.contains(e.target))
      closeColorPopup();
    if (openCardSelect && !openCardSelect.wrapper.contains(e.target)) closeOpenCardSelect();
    if (savePopupEl && savePopupEl.classList.contains("open") && !savePopupEl.contains(e.target)) closeSavePopup();
    if (pastePopupEl && pastePopupEl.classList.contains("open") && !pastePopupEl.contains(e.target)) closePastePopup();
    if (prefsPopupEl && prefsPopupEl.classList.contains("open") && !prefsPopupEl.contains(e.target)) closePrefsPopup();
    if (a11yPopupEl && a11yPopupEl.classList.contains("open") && !a11yPopupEl.contains(e.target)) closeA11yPopup();
    if (hkPopupEl && hkPopupEl.classList.contains("open") && !hkPopupEl.contains(e.target)) closeHkPopup();
    // glossary clicks must not close the param popover under them (#gloss-pop stacks on top)
    if (paramPopEl && paramPopEl.classList.contains("open") && !paramPopEl.contains(e.target)
        && !(e.target.closest && e.target.closest("#gloss-pop"))) closeParamPop();
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    // hand focus back to whatever opened the closing popup, so keyboard users
    // aren't dropped at the document body (the topmost open popup wins)
    let refocus = null;
    if (presetsPanel && presetsPanel.classList.contains("open")) refocus = presetTrigger;
    if (colorFieldEl && colorFieldEl.classList.contains("open")) refocus = document.getElementById("dev-color-btn");
    if (prefsPopupEl && prefsPopupEl.classList.contains("open")) refocus = prefsBtn;
    if (a11yPopupEl && a11yPopupEl.classList.contains("open")) refocus = a11yBtn;
    if (hkPopupEl && hkPopupEl.classList.contains("open")) refocus = hkBtn;
    if (paramPopEl && paramPopEl.classList.contains("open") && paramPopAnchor) refocus = paramPopAnchor;
    setPresetOpen(false); closeColorPopup(); closeOpenCardSelect(); closeSavePopup(); closePastePopup(); closePrefsPopup(); closeA11yPopup(); closeHkPopup(); closeParamPop(); closeHkSheet(); closeTrigSheet();
    if (refocus && refocus.focus) refocus.focus();
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawActiveGraph);
  }
})();

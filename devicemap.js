/* ============================================================================
 * devicemap.js: the Play tab's live mirror of the physical minichord
 *
 * The minichord transmits only musical NOTES over USB MIDI (note-on/off),
 * never a button id. This module forward-simulates the exact note set each of
 * the 21 chord buttons and 12 harp strings WOULD emit under the current
 * settings, then matches incoming notes back to buttons/strings to light
 * them. The note generation is a faithful port of the firmware
 * (github.com/BenjaminPoilve/minichord, firmware/src/main.cpp):
 * calculate_note_chord, calculate_note_harp, get_root_button and the
 * chord/shuffling/key tables. The inference layer on top, recovering the
 * held chord, transpose and harp row from notes alone, is specified in
 * MINICHORD-REFERENCE.md §10.
 *
 * Self-contained: builds and owns its DOM subtree; reads the live patch and
 * bank hue through callbacks. No build step, no dependencies.
 * ========================================================================== */
(function () {
  "use strict";

  /* ---- firmware note tables (verbatim from main.cpp) ---------------------- */
  // each chord: the 4 chord notes first, then decorations (2nd, 4th, 6th)
  const CHORD = {
    major:       [0, 4, 7, 12, 2, 5, 9],
    minor:       [0, 3, 7, 12, 1, 5, 8],
    maj_sixth:   [0, 4, 7, 9, 2, 5, 12],
    min_sixth:   [0, 3, 7, 9, 1, 5, 12],
    seventh:     [0, 4, 10, 7, 2, 5, 9],
    maj_seventh: [0, 4, 11, 7, 2, 5, 9],
    // the alternate layout's chords, mirroring the firmware's catalogue
    half_dim:    [0, 3, 6, 10, 2, 5, 8],
    sus_fourth:  [0, 5, 7, 12, 2, 9, 10],
    sus_second:  [0, 2, 7, 12, 5, 9, 4],
    seventh_sus: [0, 5, 10, 7, 2, 9, 4],
    major_ninth: [0, 4, 11, 2, 7, 5, 9],
    minor_ninth: [0, 3, 10, 2, 7, 5, 8],
    added_ninth: [0, 4, 7, 2, 5, 9, 11],
    six_nine:    [0, 4, 9, 2, 7, 5, 11],
    min_seventh: [0, 3, 10, 7, 1, 5, 8],
    aug:         [0, 4, 8, 12, 2, 5, 9],
    dim:         [0, 3, 6, 12, 2, 5, 9],
    full_dim:    [0, 3, 6, 9, 2, 5, 12],
  };

  // the interval (mod 12) that makes each COLORED quality audible, and so is REQUIRED before any scorer
  // dares name it: you can't hear "diminished" until the ♭5 sounds, "dominant" until the ♭7 sounds, etc.
  // Without this a color can win on a NON-diagnostic decoration that happens to differ between types in
  // this firmware (minor's 2nd is D♭ but dim's is D, so a stray D would flip Cm→Cdim with no ♭5 ever
  // heard). Plain triads (major/minor, the 3rd separates them) and the note-identical barry pairs
  // (maj_sixth≡major, full_dim shares dim's ♭5) carry no extra diagnostic, so they're absent here.
  const TYPE_SIG = { seventh: 10, maj_seventh: 11, min_seventh: 10, dim: 6, full_dim: 6, aug: 8, min_sixth: 9 };
  // hardware button order is B, E, A, D, G, C, F (firmware enum Button = 0..6)
  const BASE_NOTES   = [11, 4, 9, 2, 7, 0, 5];   // semitone (rel. C) per button
  const MUSICAL_INDEX = [6, 2, 5, 1, 4, 0, 3];   // scale-degree per button (C=0..B=6)
  // 0-11 are the plain keys; 12-20 are the enharmonic ones the physical key
  // change reaches, which need seven accidentals plus doubles
  const KEY_SIGNATURES = [0, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 7, 7, 7, 8, 7];
  // buttons made sharp / flat by N accidentals (values are firmware button indices)
  const SHARP_BTNS = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 1], [6, 5, 4, 3, 2, 1, 0]];
  const FLAT_BTNS  = [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6]];
  // second sharp for G#, D#, A#, E#, B# (key 14-18)
  const DBL_SHARP_BTNS = [[6], [6, 5], [6, 5, 4], [6, 5, 4, 3], [6, 5, 4, 3, 2]];
  const KEY_SHARP_SET = new Set([0, 1, 2, 3, 4, 5, 12, 13]);   // keys spelled with sharps
  const KEY_DBL_SHARP_LO = 14, KEY_DBL_SHARP_HI = 18, KEY_FB = 19;
  // voicing/shuffling: each entry encodes octave*10 + chord-note index
  const CHORD_SHUF = [
    [0, 1, 2, 3, 4, 5, 6],
    [10, 11, 12, 13, 14, 15, 16],
    [10, 11, 12, 13, 0, 2, 3],
    [10, 11, 12, 13, 2, 5, 6],
    [10, 11, 12, 13, 2, 15, 16],
    [20, 21, 22, 23, 24, 25, 26],
  ];
  const HARP_SHUF = [
    [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32],
    [4, 1, 0, 2, 14, 11, 10, 12, 24, 21, 20, 22],
    [5, 2, 0, 1, 15, 12, 10, 11, 25, 22, 20, 21],
    [6, 2, 0, 1, 16, 12, 10, 11, 26, 22, 20, 21],
    [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23],
    [0, 4, 1, 5, 2, 6, 10, 14, 11, 15, 12, 16],
    [0, 10, 20, 1, 11, 21, 2, 12, 22, 3, 13, 23],
  ];
  const MIDI_BASE = 48; // C3

  /* ---- faceplate geometry ------------------------------------------------- */
  // columns left→right on the device read F C G D A E B, the reverse of the firmware button order
  // (B,E,A,D,G,C,F = buttons 0..6), so faceplate column i shows firmware button (6 - i). The map is
  // its own inverse, so one involution `6 - n` projects both ways (button↔column).
  const colOf = button => 6 - button;   // firmware button → faceplate column
  const buttonOfCol = col => 6 - col;   // faceplate column → firmware button
  // rows top→bottom: major, minor, 7th (a single press makes the named chord)
  const ROWS = [
    { type: "major",   suffix: "",  barrySuffix: "6"  },
    { type: "minor",   suffix: "m", barrySuffix: "m6" },
    { type: "seventh", suffix: "7", barrySuffix: "7"  },
  ];

  // the 7 chord types and which physical rows are held to make each
  // (mirrors handle_chord_type), used to map an emitted chord back to buttons.
  const COMBOS = [
    { rows: [0],       type: "major" },
    { rows: [1],       type: "minor" },
    { rows: [2],       type: "seventh" },
    { rows: [0, 2],    type: "maj_seventh" },
    { rows: [1, 2],    type: "min_seventh" },
    { rows: [0, 1],    type: "dim" },
    { rows: [0, 1, 2], type: "aug" },
  ];

  // reverse of COMBOS: a set of held rows → chord type. Every non-empty subset of the 3 rows
  // {maj,min,7th} is one of the 7 types, so the grid click-preview can combine button presses
  // exactly like the device's handle_chord_type (e.g. major + 7th → maj_seventh).
  const COMBO_BY_ROWS = {};
  COMBOS.forEach(c => { COMBO_BY_ROWS[c.rows.join(",")] = c.type; });
  const comboType = (rows, s) => {
    const key = Array.from(rows).sort((a, b) => a - b).join(",");
    if (s && s.altLayout && ALT_SLOT_BY_ROWS[key] != null) return altSlotType(ALT_SLOT_BY_ROWS[key], s);
    return COMBO_BY_ROWS[key] || "major";
  };

  // a chord TYPE → the grid rows that produce it. Barry's 6th tables come from the SAME rows as their
  // plain triads (major→maj_sixth, minor→min_sixth, dim→full_dim), so map them back before lookup.
  // Otherwise the grid tint for a Barry 6th chord falls back to the major row (wrong column lit).
  const BARRY_BASE = { maj_sixth: "major", min_sixth: "minor", full_dim: "dim" };
  const typeRows = (type, s) => {
    if (s && s.altLayout) {
      for (const key of Object.keys(ALT_SLOT_BY_ROWS)) {
        if (altSlotType(ALT_SLOT_BY_ROWS[key], s) === type) return key.split(",").map(Number);
      }
    }
    const c = COMBOS.find(x => x.type === (BARRY_BASE[type] || type));
    return c ? c.rows : [0];
  };

  // how many chord-row buttons each type needs (its rows length); types not reachable by a simple
  // combo are left undefined so identifyChord treats them as costlier. Used to break ID ties toward
  // the chord that's fewest button presses to play.
  const TYPE_PRESSES = {};
  COMBOS.forEach(c => { TYPE_PRESSES[c.type] = c.rows.length; });

  // rhythm tie-break cost of a chord type. In Barry-Harris mode the device SUBSTITUTES the 6th chords
  // for the plain triads (major→maj_sixth, minor→min_sixth, dim→full_dim), so those 6ths ARE the cheap
  // primary chords and the triads they replace are never played. Flip the preference so a barry
  // arpeggio reads "F6" instead of flickering to "F" on the stabs that omit the added 6th. (maj_sixth
  // and major share most notes, so notes alone can't separate them. Barry mode is the reliable signal.)
  const pressOf = (type, barry) => {
    if (barry && BARRY_BASE[type]) return TYPE_PRESSES[BARRY_BASE[type]];                 // maj_sixth→major's cost, etc.
    if (barry && (type === "major" || type === "minor" || type === "dim")) return 9;      // not played in barry
    return TYPE_PRESSES[type] != null ? TYPE_PRESSES[type] : 9;
  };

  // shared key/transpose resolver tuning: how long a harp onset stays usable as evidence, the
  // min distinct harp pitch-classes needed to trust a non-zero transpose, and the ± semitone search.
  const EVID_TTL = 2000;   // ms: recent-harp window feeding the resolver
  const HARP_MIN = 3;      // distinct harp pitch-classes required before a Δ≠0 is allowed / to name a lone note
  const DMAX = 12;         // ± semitone range searched for the live transpose offset Δ
  const STICK_MARGIN = 1;  // a rival chord must beat the current one by >this coverage to switch (anti-flicker)
  const HARP_SUFFIX_MIN = 3;  // harp settle: a rival context must PERFECTLY explain at least this many trailing
                              // strum notes to take the read; 2-note suffixes are routinely ambiguous on real
                              // strums ({B6,C6} fits both Cmaj7 and G/C); 3 disambiguates in practice
  const SEG_MS = 2000;        // harp settle: the suffix never crosses an inter-onset gap above this; a slow
                              // deliberate strum gaps ~1.6s between notes, separate gestures ~2.4s+
  // VISUAL ONLY: which end of the strip string 0 is drawn at. Does NOT affect the
  // note→string matching logic (that's harpStringNote, by string index).
  const HARP_STRING0_AT_TOP = false;

  /* ---- spelled pitch -------------------------------------------------------
   * A note is a LETTER plus an ALTERATION, not a pitch class. A twelve-entry
   * table cannot tell E# from F or B♭♭ from A, so anything built on one spells
   * the enharmonic keys and the altered chord tones wrong however the table is
   * chosen. Pitch is derived from the spelling rather than the other way round.
   *
   * Roots come out of the hardware for free: the seven buttons are B E A D G C F,
   * which is exactly the order of flats, and reversed the order of sharps — which
   * is why SHARP_BTNS is the button list backwards. A button's letter is fixed;
   * the key signature supplies its alteration.
   */
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];              // natural pc of C D E F G A B
  const LETTER_NAME = ["C", "D", "E", "F", "G", "A", "B"];
  const ALT_TEXT = { "-2": "\u266d\u266d", "-1": "\u266d", "0": "", "1": "#", "2": "x" };
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];             // F C G D A E B, as letters
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];              // B E A D G C F
  const BTN_LETTER = [6, 2, 5, 1, 4, 0, 3];              // the buttons, as letters
  // signed position on the circle of fifths, and tonic letter, for each of the 21 keys
  const KEY_FIFTHS = [0, 1, 2, 3, 4, 5, -1, -2, -3, -4, -5, -6, 6, 7, 8, 9, 10, 11, 12, -8, -7];
  const KEY_TONIC = [0, 4, 1, 5, 2, 6, 3, 6, 2, 5, 1, 4, 3, 0, 4, 1, 5, 2, 6, 3, 0];

  const spelledPc = sp => (((LETTER_PC[sp.letter] + sp.alt) % 12) + 12) % 12;
  const spellText = sp => LETTER_NAME[sp.letter]
    + (String(sp.alt) in ALT_TEXT ? ALT_TEXT[String(sp.alt)] : "");

  function keyAlt(acc, count, letter) {
    const order = acc > 0 ? SHARP_ORDER : FLAT_ORDER;
    let alt = 0;
    for (let i = 0; i < count; i++) if (order[i % 7] === letter) alt += acc;
    return alt;
  }

  // Transposing moves the sounding key without changing the fingering, so the
  // letters move with it: in C transposed up one, the B button plays C. The key
  // itself is taken exactly as selected when there is no transpose, so C# major
  // stays C# major rather than being quietly respelled as Db.
  function spellingKey(key, semis) {
    const k = Math.max(0, Math.min(20, key | 0));
    if (!semis) return { acc: KEY_FIFTHS[k] >= 0 ? 1 : -1, count: Math.abs(KEY_FIFTHS[k]),
                         tonic: KEY_TONIC[k], base: k };
    const from = KEY_FIFTHS[k], want = from + 7 * semis;
    let best = null;
    for (let f = -8; f <= 12; f++) {
      if ((((f - want) % 12) + 12) % 12 !== 0) continue;
      if (best === null || Math.abs(f) < Math.abs(best)
          || (Math.abs(f) === Math.abs(best) && (from >= 0 ? f > best : f < best))) best = f;
    }
    return { acc: best >= 0 ? 1 : -1, count: Math.abs(best),
             tonic: (((KEY_TONIC[k] + 4 * (best - from)) % 7) + 7) % 7, base: k };
  }

  // the root a button names: letter from the button (moved by any transpose),
  // alteration from the key signature, plus the modifier when it is held
  function spellRoot(s, button, sharpHeld, semis) {
    const tr = semis == null ? (s.transpose | 0) : semis;
    const sk = spellingKey(s.key, tr);
    const shift = (((sk.tonic - KEY_TONIC[Math.max(0, Math.min(20, s.key | 0))]) % 7) + 7) % 7;
    const letter = (BTN_LETTER[button] + shift) % 7;
    let alt = keyAlt(sk.acc, sk.count, letter);
    if (sharpHeld) alt += s.flat ? -1 : 1;
    return { letter, alt };
  }

  const NOTE_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const NOTE_FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

  // [Play] diagnostics: ON by default; silence with `window.PLAY_DEBUG = false`. DeviceMap.startCapture()
  // also buffers the lines for DeviceMap.dumpLog() (→ clipboard) even while the console is silenced.
  // The console.log wrapper below routes [Play] lines into that buffer and prints them live when on.
  let capturing = false;
  const playLog = [];
  const PLAY_LOG_CAP = 6000;   // ring buffer of recent [Play] lines (plenty for a ~30s repro)
  const logOn = () => (typeof window === "undefined" || window.PLAY_DEBUG !== false);   // console ON unless PLAY_DEBUG === false
  const dbg = () => capturing || logOn();
  if (typeof console !== "undefined" && console.log && !console.__playCapture) {
    console.__playCapture = true;
    const orig = console.log.bind(console);
    console.log = function () {
      const args = Array.prototype.slice.call(arguments);
      if (typeof args[0] === "string" && args[0].indexOf("[Play]") === 0) {
        if (capturing) { playLog.push(args.join(" ")); if (playLog.length > PLAY_LOG_CAP) playLog.shift(); }
        if (!logOn()) return;   // capturing with the console silenced → buffer only, don't print
      }
      orig.apply(console, args);
    };
  }
  const noteLabel = n => NOTE_SHARP[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  const TYPE_NAME = { major: "", minor: "m", seventh: "7", maj_seventh: "maj7", min_seventh: "m7", dim: "dim", aug: "aug", maj_sixth: "6", min_sixth: "m6", full_dim: "°7",
    half_dim: "m7\u266d5", sus_fourth: "sus4", sus_second: "sus2", seventh_sus: "7sus4",
    major_ninth: "maj9", minor_ninth: "m9", added_ninth: "add9", six_nine: "6/9" };

  // The alternate layout points each of the seven button combinations at one of
  // these, mirroring the firmware's chord_catalogue. Index 0 means "the slot's
  // default", which is what the seven defaults below supply.
  const ALT_CATALOGUE = ["major", "minor", "seventh", "maj_seventh", "min_seventh", "dim", "aug",
    "maj_sixth", "min_sixth", "full_dim", "half_dim",
    "sus_fourth", "sus_second", "seventh_sus",
    "major_ninth", "minor_ninth", "added_ninth", "six_nine"];
  const ALT_SLOT_DEFAULT = [11, 12, 13, 14, 15, 16, 17];
  // which slot each set of held rows selects, in the same order as COMBOS
  const ALT_SLOT_BY_ROWS = { "0": 0, "1": 1, "2": 2, "0,2": 3, "1,2": 4, "0,1": 5, "0,1,2": 6 };

  function altSlotType(slot, s) {
    const v = (s.altSlots && s.altSlots[slot]) | 0;
    const i = (v <= 0 || v > ALT_CATALOGUE.length) ? ALT_SLOT_DEFAULT[slot] : v - 1;
    return ALT_CATALOGUE[i];
  }
  // harp shuffling row names (addr 40 / harp_shuffling_selection), index = row
  const HARP_PATTERN_NAME = ["normal", "2nd", "4th", "6th", "octaves", "chromatic", "keymaster"];
  // firmware button index → letter (0..6 = B,E,A,D,G,C,F); debug labels only
  const BTN_NAMES = ["B", "E", "A", "D", "G", "C", "F"];

  // note-shaping addresses a pot can drive → friendly name + which section it skews. When a pot
  // targets one of these the dump can't be trusted (applied-not-saved), so that section is inferred
  // from the notes, surfaced to the user. (Octave 99/198 is AUDIO-only → deliberately NOT here.)
  // inferred:true → the mirror reconstructs it from the emitted notes (the two "shuffling" dims,
  // they rearrange notes into sets that don't alias with a different chord). The rest shift the
  // tuning uniformly/ambiguously: a transposed (or re-keyed) chord is byte-identical over MIDI to a
  // DIFFERENT chord that's already on the grid, so the offset is unobservable. We can only warn.
  const POT_AFFECTED = {
    40:  { name: "strum pattern",     affects: "harp",   inferred: true  },
    120: { name: "chord voicing",     affects: "chords", inferred: true  },
    37:  { name: "chord inversion",   affects: "chords", inferred: true  },
    38:  { name: "chord spacing",     affects: "chords", inferred: true  },
    30:  { name: "transpose",         affects: "both",   inferred: false },
    35:  { name: "key",               affects: "both",   inferred: false },
    34:  { name: "register shift",    affects: "both",   inferred: false },
    33:  { name: "Barry-Harris mode", affects: "both",   inferred: false },
    31:  { name: "sharp/flat",        affects: "both",   inferred: false },
    23:  { name: "slash level",       affects: "both",   inferred: false },
    98:  { name: "chromatic mode",    affects: "harp",   inferred: false },
  };

  // a pot can silently drive a "shuffling" address (harp row 40 / chord voicing 120); the dump
  // reports the stored value while the knob drives the real one, so search ALL rows when a pot can
  // drive it, else just the stored row. Shared by buildChordLookup (120) and reinferHarp (40).
  function shuffleRows(potTargets, addr, stored, count) {
    if (!potTargets.has(addr)) return [stored];
    const rows = []; for (let r = 0; r < count; r++) rows.push(r); return rows;
  }

  /* ---- note engine -------------------------------------------------------- */
  // read the layout-affecting device settings out of the live patch
  function readSettings(patch) {
    const g = (a, d) => { const v = patch ? patch[a] : null; return v == null ? d : v | 0; };
    return {
      key:       Math.min(20, Math.max(0, g(35, 0))),   // chord key signature
      altLayout: g(39, 0) ? 1 : 0,                      // 0 standard chords, 1 the alternate set
      altSlots:  [g(202, 0), g(203, 0), g(204, 0), g(205, 0), g(206, 0), g(207, 0), g(208, 0)],
      inversion: Math.min(3, Math.max(0, g(37, 0))),    // chord inversion
      spacing:   Math.min(4, Math.max(0, g(38, 0))),    // chord spacing
      harpMode:  g(36, 0),                              // scalar harp mode, 0 = follow the chord
      customScale: g(236, 0b101010110101),              // the player's own scale, one bit per degree
      transpose: g(30, 0),                              // semitones
      shift:     Math.min(6, Math.max(0, g(34, 0))),    // chord frame shift
      barry:     !!g(33, 0),                            // barry harris mode
      flat:      !!g(31, 0),                            // sharp button → flat
      chromatic: !!g(98, 0),                            // chromatic harp
      harpShuf:  Math.min(6, Math.max(0, g(40, 0))),    // harp shuffling
      chordShuf: Math.min(5, Math.max(0, g(120, 2))),   // chord shuffling
      slashLevel: Math.min(2, Math.max(0, g(23, 0))),   // which voice a slash replaces
      // NOTE: octave change (harp addr 99 / chord addr 198) shifts the internal AUDIO
      // pitch but NOT the MIDI note numbers sent over USB, verified against hardware
      // (a chord-octave=1 preset still emits notes at the base octave). So it is
      // deliberately NOT folded into note generation; doing so breaks matching.
      // It IS read for DISPLAY: labels show the sounding pitch (semitone shift below),
      // while every matching/logging path keeps the raw MIDI numbers.
      harpOctSemis:  (Math.min(4, Math.max(0, g(99, 2))) - 2) * 12,    // sounding-pitch shift, harp labels
      chordOctSemis: (Math.min(4, Math.max(0, g(198, 2))) - 2) * 12,   // sounding-pitch shift, chord label
      // addresses the 3 potentiometers can drive (their configurable targets): chord-pot
      // alternate (10), harp-pot alternate (12), mod-pot main (14), mod-pot alternate (16).
      // The hardwired pot mains (chord=3, harp=2) are gain. A pot's MAIN value is applied
      // but never written back to the dump, so any of these addresses can be live-driven to
      // a value the dump doesn't report. Used to gate harp-row inference.
      // Addresses something can change without telling us: the four knob
      // assignments, and whatever the double tap gesture is pointed at. For
      // those the dump is stale by design, so the matcher enumerates instead of
      // trusting it.
      potTargets: new Set([g(10, 0), g(12, 0), g(14, 0), g(16, 0), g(200, 0)]),
    };
  }

  // barry-harris substitutes the three triad types for their 6th equivalents
  function resolveTable(type, barry) {
    if (!barry) return type;
    if (type === "major") return "maj_sixth";
    if (type === "minor") return "min_sixth";
    if (type === "dim") return "full_dim";
    return type;
  }

  // get_root_button(key, shift, button)
  function rootButton(s, button) {
    let note = BASE_NOTES[button];
    if (MUSICAL_INDEX[button] < s.shift) note += 12;
    const n = KEY_SIGNATURES[s.key];
    if (KEY_SHARP_SET.has(s.key)) {
      for (let i = 0; i < n; i++) if (button === SHARP_BTNS[n - 1][i]) note += 1;
    } else if (s.key >= KEY_DBL_SHARP_LO && s.key <= KEY_DBL_SHARP_HI) {
      for (let i = 0; i < 7; i++) if (button === SHARP_BTNS[6][i]) note += 1;
      const d = DBL_SHARP_BTNS[s.key - KEY_DBL_SHARP_LO];
      for (let i = 0; i < d.length; i++) if (button === d[i]) note += 1;
    } else {
      for (let i = 0; i < n && i < 7; i++) {
        if (s.key === KEY_FB && button === 0) continue;   // B double-flat, applied below
        if (button === FLAT_BTNS[Math.min(n, 7) - 1][i]) note -= 1;
      }
      if (s.key === KEY_FB && button === 0) note -= 2;
    }
    return note;
  }

  // calculate_note_chord (sharp button assumed released; sharp is handled in
  // matching by also indexing the ±1 shifted set). `slash` = {button} swaps the
  // bass voice for another column's root ("split" / slash chord).
  /* ---- inversion and spacing ----------------------------------------------
   * Ports of the firmware's revoicing. Both work from the chord's distinct
   * pitch classes in ascending order, not from the table's index order: the
   * seventh table lists the seventh before the fifth, so rotating indices would
   * not give an inversion. Without these the lookup only ever holds root
   * position, and any inversion or spacing is matched as some other chord.   */
  function chordTones(table) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const pc = table[i] % 12;
      if (out.indexOf(pc) === -1) out.push(pc);
    }
    return out.sort((a, b) => a - b);
  }

  function invertedOffset(table, voice, inversion) {
    const t = chordTones(table);
    const k = voice + inversion;
    return t[k % t.length] + 12 * Math.floor(k / t.length);
  }

  // how far each voice moves for a spacing; the numbering counts from the top,
  // and after the inversion step the voices are in pitch order
  function spacingShift(voice, spacing) {
    switch (spacing) {
      case 1: return voice === 2 ? -12 : 0;                         // drop 2
      case 2: return voice === 1 ? -12 : 0;                         // drop 3
      case 3: return (voice === 2 || voice === 0) ? -12 : 0;        // drop 2 and 4
      case 4: return voice === 0 ? -12 : (voice === 3 ? 12 : 0);    // spread
      default: return 0;
    }
  }

  const CHORD_NOTE_FLOOR = 12, CHORD_NOTE_CEILING = 96;

  function chordVoiceNote(voice, button, table, s, slash, rowOverride) {
    const level = CHORD_SHUF[rowOverride == null ? s.chordShuf : rowOverride][voice];

    // transpose enters the chord MIDI only at a chord press (firmware adds it at NoteOn send-time
    // via midi_base_note_transposed; a held chord's notes are already sent and are NOT resent when
    // addr 30 changes). So the grid matches against the PRESS-TIME transpose, s.chordTranspose,
    // frozen in rebuild while a chord is held. Falls back to the live s.transpose when unset.
    const transpose = s.chordTranspose == null ? s.transpose : s.chordTranspose;
    if (slash && (level % 10) === s.slashLevel) {
      return MIDI_BASE + transpose + 12 * Math.floor(level / 10) + rootButton(s, slash.button);
    }

    const inv = s.inversion | 0, sp = s.spacing | 0;
    const useSorted = (inv > 0 || sp > 0) && voice < 4 && (level % 10) < 4;
    const offset = useSorted ? invertedOffset(table, voice, inv) : table[level % 10];
    let note = MIDI_BASE + transpose + 12 * Math.floor(level / 10) + rootButton(s, button) + offset;

    if (sp > 0 && voice < 4 && (level % 10) < 4) {
      const shift = spacingShift(voice, sp);
      if (shift) {
        const moved = note + shift;
        // a move outside the usable range is not made, and a drop may not land
        // under a slash bass unless it is another octave of the same note
        let allowed = moved >= MIDI_BASE + CHORD_NOTE_FLOOR && moved <= MIDI_BASE + CHORD_NOTE_CEILING;
        if (allowed && slash && shift < 0) {
          const bass = MIDI_BASE + transpose + 12 * Math.floor(level / 10) + rootButton(s, slash.button);
          if (moved < bass && (((moved - bass) % 12) + 12) % 12 !== 0) allowed = false;
        }
        if (allowed) note = moved;
      }
    }
    return note;
  }

  // The ONE chord-note generator every chord matcher stands on (grid lookup, rhythm identify, harp
  // voice list). Returns the `count` voice notes a (button, table) chord emits, chordVoiceNote per
  // voice, plus the whole-set shifts: `off` (the ±1 the grid's lookup bakes in for the sharp button,
  // or an inferred transpose Δ) and `sharp` (the live sharp/flat button). `row` overrides the chord
  // voicing (addr 120, for the pot-driven voicing search), `slash` swaps the bass to another column.
  function voiceSet(button, table, s, opts) {
    opts = opts || {};
    const count = opts.count == null ? 7 : opts.count;
    const shift = (opts.sharp ? (s.flat ? -1 : 1) : 0) + (opts.off || 0);
    const out = [];
    for (let v = 0; v < count; v++) out.push(chordVoiceNote(v, button, table, s, opts.slash || null, opts.row) + shift);
    return out;
  }

  /* ---- scalar harp modes --------------------------------------------------
   * A port of the firmware's scale tables. Modes 1-7 run a fixed scale from the
   * key, 8 and 9 pick a scale to suit the held chord, 10 and 11 run the player's
   * own scale rooted on the key or on the chord. Mode 0 is the original
   * chord-following behaviour, handled below.                                 */
  const SCALE_ROOT_OFFSETS = [
    0, 7, 2, 9, 4, 11,       // C, G, D, A, E, B
    5, 10, 3, 8, 1, 6,       // F, Bb, Eb, Ab, Db, Gb
    6, 1, 8, 3, 10, 5, 0,    // F#, C#, G#, D#, A#, E#, B#
    4, 11,                   // Fb, Cb
  ];
  const SCALE_INTERVALS = [
    [0, 2, 4, 5, 7, 9, 11],   // 1 major
    [0, 2, 4, 7, 9],          // 2 major pentatonic
    [0, 2, 3, 7, 10],         // 3 minor pentatonic
    [0, 2, 4, 5, 7, 8, 9, 11],// 4 diminished 6th
    [0, 2, 3, 5, 7, 8, 10],   // 5 relative natural minor
    [0, 2, 3, 5, 7, 8, 11],   // 6 relative harmonic minor
    [0, 2, 3, 7, 10],         // 7 relative minor pentatonic
  ];
  const CHORD_SCALE_INTERVALS = [
    [0, 2, 4, 7, 9],           //  0 major pentatonic
    [0, 2, 4, 6, 9],           //  1 lydian pentatonic
    [0, 3, 5, 7, 10],          //  2 minor pentatonic
    [0, 2, 4, 7, 10],          //  3 mixolydian pentatonic
    [0, 3, 5, 7, 9],           //  4 dorian pentatonic
    [0, 1, 3, 4, 6, 7, 9, 10], //  5 octatonic
    [0, 2, 4, 6, 8, 10],       //  6 whole tone
    [0, 2, 4, 5, 7, 8, 9, 11], //  7 diminished 6th
    [0, 2, 3, 5, 7, 8, 9, 11], //  8 diminished 6th minor
    [0, 2, 3, 4, 6, 7, 9, 11], //  9 offset diminished 6th
    [0, 2, 4, 5, 7, 9, 11],    // 10 ionian
    [0, 2, 3, 5, 7, 9, 10],    // 11 dorian
    [0, 2, 4, 6, 7, 9, 11],    // 12 lydian
    [0, 2, 4, 5, 7, 9, 10],    // 13 mixolydian
    [0, 2, 3, 5, 7, 8, 10],    // 14 aeolian
    // for the alternate layout's chords; the suspended ones leave the third out
    [0, 2, 5, 7, 9],           // 15 suspended pentatonic (1 2 4 5 6)
    [0, 2, 5, 7, 10],          // 16 suspended b7 pentatonic (1 2 4 5 b7)
    [0, 3, 5, 6, 10],          // 17 half-diminished pentatonic
    [0, 1, 3, 5, 6, 8, 10],    // 18 locrian
  ];
  // chord type → index into CHORD_SCALE_INTERVALS, pentatonic first then full
  const CHORD_SCALE_INDEX = {
    major: [0, 10], maj_seventh: [1, 12], minor: [2, 14], seventh: [3, 13],
    min_seventh: [4, 11], dim: [5, 5], aug: [6, 6], maj_sixth: [7, 7],
    min_sixth: [8, 8], full_dim: [9, 9],
    // a ninth chord takes the scale of the seventh it is built on; suspended
    // chords withhold their third, so the harp does too
    major_ninth: [1, 12], minor_ninth: [2, 11], added_ninth: [0, 10],
    six_nine: [0, 12], half_dim: [17, 18],
    sus_fourth: [15, 13], sus_second: [15, 10], seventh_sus: [16, 13],
  };
  const CUSTOM_SCALE_MAX_OCTAVE = 3;

  // the twelve-bit mask expanded to an ascending interval list, as
  // rebuild_custom_scale does on the device
  function customScaleIntervals(mask) {
    const out = [];
    for (let i = 0; i < 12; i++) if (mask & (1 << i)) out.push(i);
    return out.length ? out : [0];
  }

  function staticScaleNote(string, mode, key) {
    const scale = SCALE_INTERVALS[mode - 1];
    const octave = Math.floor(string / scale.length);
    let root = SCALE_ROOT_OFFSETS[key] || 0;
    if (mode >= 5 && mode <= 7) root = (root + 12 - 3) % 12;   // the relative minor
    return root + scale[string % scale.length] + octave * 12 + 12;
  }

  function customScaleNote(string, rootNote, sharpOffset, mask) {
    const scale = customScaleIntervals(mask);
    let octave = Math.floor(string / scale.length);
    if (octave > CUSTOM_SCALE_MAX_OCTAVE) octave = CUSTOM_SCALE_MAX_OCTAVE;
    return rootNote + sharpOffset + scale[string % scale.length] + octave * 12;
  }

  function chordSpecificNote(string, rootNote, sharpOffset, type, pentatonic) {
    const pair = CHORD_SCALE_INDEX[type] || CHORD_SCALE_INDEX.major;
    const scale = CHORD_SCALE_INTERVALS[pair[pentatonic ? 0 : 1]];
    const octave = Math.floor(string / scale.length);
    return rootNote + sharpOffset + scale[string % scale.length] + octave * 12;
  }

  // calculate_note_harp for a string, given the currently held chord (incl. slash + sharp)
  function harpStringNote(string, held, s, rowOverride) {
    if (s.chromatic) return MIDI_BASE + s.transpose + string + 24;

    // the scalar modes, in the same order the firmware tests them
    const mode = s.harpMode | 0;
    const sharpOff = held.sharp ? (s.flat ? -1 : 1) : 0;
    if (mode >= 1 && mode <= 7) {
      return MIDI_BASE + s.transpose + staticScaleNote(string, mode, s.key);
    }
    if (mode === 10) {
      return MIDI_BASE + s.transpose
        + customScaleNote(string, (SCALE_ROOT_OFFSETS[s.key] || 0) + 12, 0, s.customScale);
    }
    if (mode === 11 || mode === 8 || mode === 9) {
      // these root on the chord, and on the slash bass when one is held
      const rootNote = rootButton(s, held.slash ? held.slash.button : held.button);
      if (mode === 11) {
        return MIDI_BASE + s.transpose + customScaleNote(string, rootNote, sharpOff, s.customScale);
      }
      return MIDI_BASE + s.transpose
        + chordSpecificNote(string, rootNote, sharpOff, held.type, mode === 9);
    }

    const level = HARP_SHUF[rowOverride == null ? s.harpShuf : rowOverride][string];
    const sharp = held.sharp ? (s.flat ? -1 : 1) : 0;   // sharp button shifts every harp note
    if (held.slash && (level % 10) === s.slashLevel) {
      return MIDI_BASE + s.transpose + 12 * Math.floor(level / 10) + rootButton(s, held.slash.button) + sharp;
    }

    // held.type is already a RESOLVED chord table (barry baked in when held was set, like the
    // firmware's current_chord at press time). Index CHORD directly, don't re-apply barry.
    const table = CHORD[held.type];
    return MIDI_BASE + s.transpose + 12 * Math.floor(level / 10)
         + rootButton(s, held.button) + table[level % 10] + sharp;
  }

  // Note spelling follows the KEY SIGNATURE and nothing else.
  //
  // The sharp/flat modifier (addr 31) says which way the button moves a chord
  // while it is HELD. It is not a spelling preference, so it must not respell
  // the roots the key signature produced: in A major the G button is G#
  // whether the modifier is set to sharp or to flat.
  //
  // The modifier's own alteration is shown separately, as the accidental
  // appended to the root name in chordLabel (G becomes G# or G♭), which is
  // where it belongs.
  const flatKey = key => (key >= 6 && key <= 11) || key >= KEY_FB;
  const noteNames = s => (flatKey(s.key) ? NOTE_FLAT : NOTE_SHARP);

  function pitchName(midi, s) {
    const pc = ((midi % 12) + 12) % 12;
    return noteNames(s)[pc];
  }

  // multiset key (keeps duplicates) so a doubled bass voice is distinguishable:
  // e.g. C/E sends {64,64,67,72} vs C/G's {64,67,67,72}; deduping would merge them.
  const noteKey = arr => arr.slice().sort((a, b) => a - b).join(",");

  // multiset → Map(note→count): the shared currency of every overlap / coverage / containment score.
  const countsOf = arr => { const m = new Map(); for (const n of arr) m.set(n, (m.get(n) || 0) + 1); return m; };

  // two chords are the same highlight when button + type + sharp + slash bass all match
  const slashBtn = c => (c.slash ? c.slash.button : null);
  const sameChord = (a, b) => a.button === b.button && a.type === b.type && a.sharp === b.sharp && slashBtn(a) === slashBtn(b);

  // build a lookup from emitted note-set → candidate button highlight(s). Covers
  // all 7 columns × 7 chord types × {plain, every slash column} × {sharp off/on}.
  // A key can map to MORE THAN ONE candidate when two presses are enharmonically
  // identical over MIDI (E#+sharp ≡ F, B#+sharp ≡ C, or a slash that lands on a
  // plain chord). matchChord then disambiguates by musical context.
  function buildChordLookup(s) {
    const map = new Map();
    const sharpOffset = s.flat ? -1 : 1;

    // a pot can silently drive the chord voicing (addr 120), octave-shifting the emitted chord
    // notes; the dump lies, so register each chord at every reachable voicing (else just the stored
    // one, identical to before for the common no-pot case). Mirrors the harp's row search.
    const chordRows = shuffleRows(s.potTargets, 120, s.chordShuf, CHORD_SHUF.length);
    // Same reasoning for inversion (addr 37) and spacing (addr 38): a knob moves
    // them without telling the host, so the dump reads 0 while the device is
    // playing a revoiced chord. Register every reachable voicing when a knob is
    // assigned, and just the stored one otherwise.
    const invOpts = shuffleRows(s.potTargets, 37, s.inversion, 4);
    const spOpts = shuffleRows(s.potTargets, 38, s.spacing, 5);
    const layoutOpts = shuffleRows(s.potTargets, 39, s.altLayout, 2);
    // plain (no slash) FIRST so a plain chord is the default reading of a collision
    const slashOpts = [null];
    for (let b = 0; b < 7; b++) slashOpts.push({ button: buttonOfCol(b) });
    slashOpts.forEach(slash => {
      for (let col = 0; col < 7; col++) {
        const button = buttonOfCol(col);
        if (slash && slash.button === button) continue;    // slash is a different column
        COMBOS.forEach(combo => {
          // the alternate layout names its own tables, and the firmware applies no
          // Barry substitution there; building from the standard types would leave
          // every emitted chord unmatched and nothing lit
          const types = layoutOpts.map(L => L
            ? altSlotType(ALT_SLOT_BY_ROWS[combo.rows.join(",")] || 0, s)
            : resolveTable(combo.type, s.barry));
          const table = CHORD[types[0]];
          [[0, false], [sharpOffset, true]].forEach(([off, sharp]) => {
            // one note-set per voicing → the SAME (voicing-agnostic) candidate; sameChord dedups
            chordRows.forEach(vrow => {
             invOpts.forEach(iv => {
              spOpts.forEach(sp => {
              const vs = (iv === s.inversion && sp === s.spacing) ? s : Object.assign({}, s, { inversion: iv, spacing: sp });
              types.forEach(ty => {
                const tbl = CHORD[ty] || table;
                // the candidate has to carry the type whose table produced these notes.
                // Building it once from types[0] labelled every alternate-layout note
                // set with its standard-layout counterpart, so a 7sus4 read as a 7.
                const cand = { button, type: ty, sharp, slash: slash || null };
                const notes = voiceSet(button, tbl, vs, { count: 4, slash, row: vrow, off });
                const k = noteKey(notes);
                if (!map.has(k)) map.set(k, [cand]);
                else { const arr = map.get(k); if (!arr.some(x => sameChord(x, cand))) arr.push(cand); }
              });
              });
             });
            });
          });
        });
      }
    });
    return map;
  }

  // flatten the lookup into a list of {counts:Map(note→mult), cands} for overlap matching
  function listFromLookup(map) {
    const list = [];
    map.forEach((cands, key) => {
      const counts = countsOf(key.split(",").map(Number));
      list.push({ counts, cands });
    });
    return list;
  }

  // precomputed base note-sets for the rhythm identifier, one per (button × CHORD type × reachable
  // voicing), built with the chord lookup (same inputs: key/shift/transpose/voicing/potTargets). The
  // rhythm scans these every burst instead of regenerating 70+ sets each time, mirroring how the grid
  // precomputes buildChordLookup. identifyChord only shifts by Δ + the slash bass on top.
  function buildRhythmBases(s) {
    const rows = shuffleRows(s.potTargets, 120, s.chordShuf, CHORD_SHUF.length);
    const out = [];
    // both natural AND sharp voicings, mirroring buildChordLookup: the sharp button raises every
    // chord voice a semitone, so an F#-chord arpeggio (F+sharp) is only reachable as a sharp base.
    // Natural FIRST so it stays the default reading of an enharmonic collision (C ≡ B#+sharp).
    for (let b = 0; b < 7; b++) for (const type in CHORD) {
      const press = pressOf(type, s.barry);
      for (const row of rows) for (const sharp of [false, true]) {
        out.push({ b, type, press, row, sharp, notes: voiceSet(b, CHORD[type], s, { row, sharp }) });
      }
    }
    return out;
  }
  const LOOKBACK = 130; // ms a released note can still be borrowed to complete a strummed/retriggered chord
  const HELD_TTL = 8000; // ms a note may stay "held" with no re-trigger before we assume its note-off was missed
  const fadeMs = v => Math.max(120, Math.min(4000, v == null ? 1000 : v));   // light-out tail (envelope release)

  /* ---- view + highlight controller --------------------------------------- */
  function create(opts) {
    opts = opts || {};
    const getPatch = opts.getPatch || (() => ({}));
    const getHue = opts.getHue || (() => 210);

    let s = readSettings(getPatch());

    // the grid lookup, its flat matching list, and the rhythm base table are all derived from `s` and
    // ALWAYS rebuilt together (one helper, three call sites: init, rebuild, chordNoteOn transpose-adopt)
    // so the rhythm bases can never drift from the chord lookup they share inputs with.
    let chordLookup, lookupList, rhythmBases;
    const rebuildLookups = () => { chordLookup = buildChordLookup(s); lookupList = listFromLookup(chordLookup); rhythmBases = buildRhythmBases(s); };
    rebuildLookups();
    let held = { button: 0, type: "major", sharp: false, slash: null }; // resting harp context = B major (matches firmware fundamental=0)
    // the harp's OWN context when it diverges from `held` (the chord-port truth). Firmware race:
    // two near-simultaneous chord buttons can queue the chord voices from the previous loop's
    // current_chord while update_harp_notes() reads the live pointer; the port plays F, the harp
    // plays Fmaj7, until the next chord trigger (§10.8). null = in sync (the harp follows `held`).
    let harpHeld = null;
    let harpHeldT = 0;        // when the current desync episode started (gates the badge's min play time)
    const harpCtx = () => harpHeld || held;
    const harpHeldEq = c => c.button === held.button && c.type === held.type
      && (c.slash ? c.slash.button : null) === (held.slash ? held.slash.button : null)
      && !held.sharp;   // settle candidates are always natural; a sharp held never equals them
    let lastCol = null;       // column of the last matched chord (disambiguates E#/F, B#/C)
    let lastSharp = false;    // was the last matched chord a sharp chord? (gates E#/B#)
    let lastOnNote = null;    // most recent chord note-on (identifies the chord being played)
    // this chord began from SILENCE (nothing held, nothing in the lookback pool) → it's a fresh
    // press, not a sharp added to a live chord. A fresh enharmonic collision (E#≡F, B#≡C) must
    // read as the NATURAL, never inherit the previous chord's sharp/column context. Cleared once a
    // chord commits; a sharp ADDED to a still-live chord (F→F#, E→E#) never goes cold, so it keeps it.
    let freshChord = true;

    // optional observers (the trigger system), fired at every `held` adoption
    // and on harp lights. Callback-only and silent: the golden harness creates
    // the mirror WITHOUT them, so registering nothing must change nothing.
    const onChordCb = opts.onChord || null;   // ({col,button,type,rawType,sharp,strength,slashCol} | null on release)
    const onPluckCb = opts.onPluck || null;   // (stringIndices: number[])
    const emitChord = strength => {
      if (!onChordCb) return;
      onChordCb({
        col: colOf(held.button), button: held.button,
        type: BARRY_BASE[held.type] || held.type,   // normalized: a barry 6th matches its row-combo type
        rawType: held.type, sharp: !!held.sharp, strength,
        slashCol: held.slash ? colOf(held.slash.button) : null,   // split-chord bass column (triggers match it)
      });
    };
    const emitChordOff = () => { if (onChordCb) onChordCb(null); };
    const emitPluck = strings => { if (onPluckCb && strings.length) onPluckCb(strings.slice()); };

    // a chord is identified from the notes currently HELD, completed if needed by the most
    // recently DROPPED notes (the device strums/retriggers, so voices toggle). Every held
    // note must belong to the chord; dropped notes only fill missing voices, fewest first
    // ("least greedy") so an old straggler is never used unless nothing else completes it.
    const heldNotes = new Map();     // note → currently-held count
    const dropped = new Map();       // note → {timer} recently released, available to complete a chord
    const heldWatch = new Map();     // note → watchdog timer; force-releases a note whose note-off was missed
    let curChord = null;             // currently shown chord candidate
    let curCounts = null;            // its note multiset (Map note→count)
    // a slash/combo (multi-button) chord must persist briefly before it shows, so a transient
    // two-column overlap during a fast change can't flash a phantom (e.g. C→F → Dm7/G).
    let pendingCand = null;
    let pendingTimer = null;
    const COMPLEX_HOLD = 45;
    const harpLit = new Map();       // harp note → [string indices currently lit]
    const activeHarp = new Map();    // harp note → active note-on count (= physical strings sounding it)
    // the displayed harp shuffling row. Normally s.harpShuf (from the dump), but a preset
    // can map a potentiometer to addr 40; the firmware applies the pot value to the live
    // shuffling yet deliberately does NOT report it over sysex ("applied but not saved", §6.2),
    // so the dump can lie. We infer the true row from the notes the device emits.
    let effHarpShuf = s.harpShuf;

    // the chromatic state the HARP renders with. The firmware recomputes current_harp_notes
    // only on a chord press (button_pushed) or an addr-40/99 edit, so a lone chromatic (98)
    // toggle doesn't change the emitted harp until the next chord (§10.7). effChromatic lags
    // s.chromatic until then, matching the device. (s.chromatic is overwritten with this in rebuild.)
    let effChromatic = s.chromatic;

    // the transpose the CHORD GRID matches against. The firmware adds transpose at NoteOn
    // send-time (midi_base_note_transposed); a held chord's notes are already sent and are NOT
    // resent when addr 30 changes, so a held chord stays at its PRESS-TIME transpose until the
    // next chord press recomputes it (§10.3). effChordTranspose freezes that value while held.
    // (The harp is different. Each string IS resent live, so the harp keeps the live s.transpose.)
    let effChordTranspose = s.transpose;
    const recentHarp = [];           // recent harp notes, for chord/row inference context
    let lastHarpPos = null;          // last lit string (finger position) for duplicate-note choice
    let lastHarpT = 0, harpDir = 0;  // when it moved + travel direction (±1): strum momentum
    let lastLoggedChord = null;      // debug: last logged detection (to log only on change)
    let previewSel = null;           // offline click-preview: {rootCol, rows:Set, slashCol} or null
    let connectedState = false;      // mirrors setConnected, gates offline-only behaviours (click readout)

    /* DOM ---------------------------------------------------------------- */
    const root = document.createElement("div");
    root.className = "devicemap-root";

    const caption = document.createElement("p");
    caption.className = "dm-caption";
    root.appendChild(caption);

    const board = document.createElement("div");
    board.className = "dm-board";
    root.appendChild(board);

    // left column: KEY readout (top) → sharp button → chord grid (bottom). The readout is always
    // shown (current chord large in bank-hue, previous chord faded to its left), so pressing keys
    // never reflows the grid; the grid is pinned to the bottom of the panel and the sharp sits on it.
    const left = document.createElement("div");
    left.className = "dm-left";

    // readout block: history + big current chord, the chord's sounding voices
    // beneath it, and a key/transpose context line (shown when non-default)
    const roWrap = document.createElement("div");
    roWrap.className = "dm-ro-wrap";

    // 1fr | auto | 1fr grid: the current chord stays EXACTLY centred no matter
    // how wide its text is; history trails leftward into the free space
    const readout = document.createElement("div");
    readout.className = "dm-key-readout";
    const roHist = document.createElement("div"); roHist.className = "dm-ro-hist";
    const roPrev3 = document.createElement("span"); roPrev3.className = "dm-ro dm-ro-prev3"; roPrev3.style.display = "none";
    const roPrev2 = document.createElement("span"); roPrev2.className = "dm-ro dm-ro-prev2"; roPrev2.style.display = "none";
    const roPrev = document.createElement("span"); roPrev.className = "dm-ro dm-ro-prev"; roPrev.style.display = "none";
    roHist.appendChild(roPrev3); roHist.appendChild(roPrev2); roHist.appendChild(roPrev);
    const roCurEl = document.createElement("span"); roCurEl.className = "dm-ro dm-ro-cur";
    const roSpacer = document.createElement("span"); roSpacer.className = "dm-ro-spacer";
    readout.appendChild(roHist); readout.appendChild(roCurEl); readout.appendChild(roSpacer);
    roWrap.appendChild(readout);
    const roNotesEl = document.createElement("div");
    roNotesEl.className = "dm-ro-notes";
    roWrap.appendChild(roNotesEl);
    const roCtxEl = document.createElement("div");
    roCtxEl.className = "dm-ro-ctx";
    roCtxEl.style.display = "none";
    roWrap.appendChild(roCtxEl);
    left.appendChild(roWrap);

    const sharpRow = document.createElement("div");
    sharpRow.className = "dm-sharp-row";
    const sharpBtn = document.createElement("button");
    sharpBtn.type = "button";
    sharpBtn.className = "dm-sharp";
    sharpRow.appendChild(sharpBtn);
    left.appendChild(sharpRow);

    const grid = document.createElement("div");
    grid.className = "dm-grid";
    const cells = [];   // cells[col][row]
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 7; col++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dm-chord";
        b.addEventListener("click", () => previewChord(col, row));
        (cells[col] = cells[col] || [])[row] = b;
        grid.appendChild(b);
      }
    }
    left.appendChild(grid);
    board.appendChild(left);

    // right: 12-section harp strip
    const harp = document.createElement("div");
    harp.className = "dm-harp";
    // "strip" draws the twelve strings in a line; "plate" arranges them four by
    // three on a lean, matching the faceplate where the strings sit in angled
    // rows. Purely how they are drawn: string indices and note matching are
    // untouched.
    function setHarpShape(shape) {
      harp.classList.toggle("dm-harp-plate", shape === "plate");
    }
    const harpLabel = document.createElement("div");
    harpLabel.className = "dm-harp-label";
    harpLabel.textContent = "harp";
    harp.appendChild(harpLabel);

    // small badge: the chord the harp is ACTUALLY playing while it differs from the chord
    // section (the firmware desync race), shown/hidden by relabelHarp, cleared on resync
    const harpDesync = document.createElement("div");
    harpDesync.className = "dm-harp-desync";
    harpDesync.style.display = "none";
    harp.appendChild(harpDesync);
    // The strings live in their own container so the plate arrangement can lay
    // them out independently. In strip mode it is display:contents, so they are
    // direct children of the panel exactly as before.
    const harpStrings = document.createElement("div");
    harpStrings.className = "dm-harp-strings";
    const segByString = [];
    for (let pos = 0; pos < 12; pos++) {
      const str = HARP_STRING0_AT_TOP ? pos : 11 - pos;
      const seg = document.createElement("button");
      seg.type = "button";
      seg.className = "dm-string";
      seg.addEventListener("click", () => flashString(str));
      segByString[str] = seg;
      harpStrings.appendChild(seg);
    }
    harp.appendChild(harpStrings);
    board.appendChild(harp);

    // warning chip shown when a knob is mapped to a note-shaping parameter: the device can't
    // report a pot's live position, so what's shown is inferred / may not match. Clicking it
    // opens the shared popover (soundlab's .pot-warn handler) with the full explanation.
    const potNote = document.createElement("button");
    potNote.type = "button";
    potNote.className = "pot-warn dm-pot-warn";
    potNote.textContent = "";   // the ! is DRAWN by .pot-warn::before/::after (a font glyph smears into a line at this size)
    potNote.title = "A knob affects what's shown here. Click for details";
    potNote.setAttribute("aria-label", "Knob warning: a knob affects what's shown here, click for details");
    potNote.setAttribute("aria-haspopup", "dialog");
    potNote.style.display = "none";
    root.appendChild(potNote);

    /* labels ------------------------------------------------------------- */
    function relabel() {
      const p = getPatch();
      root.style.setProperty("--dm-hue", getHue());
      root.style.setProperty("--dm-chord-fade", fadeMs(p[141]) + "ms");   // chord amp-env release
      root.style.setProperty("--dm-harp-fade", fadeMs(p[47]) + "ms");     // harp amp-env release
      sharpBtn.textContent = s.flat ? "♭" : "♯";
      sharpBtn.title = s.flat ? "flat modifier" : "sharp modifier";
      sharpBtn.setAttribute("aria-label", sharpBtn.title);
      for (let col = 0; col < 7; col++) {
        const button = buttonOfCol(col);

        // LIVE transpose, like the harp labels: a cell names what the button plays on its NEXT
        // press (a new press always adopts the live addr 30). Only the readout of a currently
        // HELD chord keeps the frozen press-time transpose (chordLabel/chordVoiceNote).
        const rootName = spellText(spellRoot(s, button, false));
        for (let row = 0; row < 3; row++) {
          const suffix = s.altLayout ? (TYPE_NAME[altSlotType(row, s)] || "")
            : (s.barry ? ROWS[row].barrySuffix : ROWS[row].suffix);
          const label = rootName + suffix;
          cells[col][row].textContent = label;
          // the pads are sized for "C" through "C#7"; the alternate layout brings
          // names like "C#7sus4", so step the type down as the label grows
          cells[col][row].classList.toggle("dm-chord-long", label.length >= 5);
          cells[col][row].classList.toggle("dm-chord-xlong", label.length >= 7);
        }
      }
      relabelHarp();
      updatePotNote();
      if (roCur == null) resetReadout();   // seed the device-default chord before anything is detected
    }

    // contextual help: when a pot is mapped to a note-shaping address the dump can't be trusted, so
    // that section (harp / chord grid / both) is inferred. Tell the user right here why it may not
    // match what they play. (Octave knobs 99/198 are audio-only → not in POT_AFFECTED, no note.)
    function updatePotNote() {
      const driven = Object.keys(POT_AFFECTED).map(Number).filter(a => s.potTargets.has(a));
      if (!driven.length) { potNote.style.display = "none"; return; }
      const names = list => list.map(a => POT_AFFECTED[a].name).join(" & ");
      const sectionOf = list => {
        const harp = list.some(a => POT_AFFECTED[a].affects !== "chords");
        const chords = list.some(a => POT_AFFECTED[a].affects !== "harp");
        return harp && chords ? "harp and chord grid" : chords ? "chord grid" : "harp";
      };
      const inferred = driven.filter(a => POT_AFFECTED[a].inferred);   // 40 / 120: self-correct
      const blind = driven.filter(a => !POT_AFFECTED[a].inferred);     // transpose/key/…: can't
      let msg = "";
      if (inferred.length) msg += "A knob controls the " + names(inferred) + ". The "
        + sectionOf(inferred) + " here is inferred from the notes you play, so it's a best guess"
        + " that may not always match. ";
      if (blind.length) msg += "A knob controls the " + names(blind) + ". The device can't report"
        + " its live position and this can't be inferred from notes, so the " + sectionOf(blind)
        + " shown might not match what you're playing.";
      potNote.style.display = "";
      // shown by the popover, not inline (dataset guard: the node-harness DOM shim has none)
      if (potNote.dataset) potNote.dataset.note = msg.trim();
      else potNote.textContent = "⚠ " + msg.trim();
    }
    function relabelHarp() {
      const hc = harpCtx();   // the harp follows its OWN context while desynced from the chord port
      for (let i = 0; i < 12; i++) {
        const note = harpStringNote(i, hc, s, effHarpShuf);
        segByString[i].textContent = pitchName(note, s);
        // raw MIDI stays the truth; an explicit octave setting shifts AUDIO only,
        // so show the sounding pitch beside it when they differ
        segByString[i].title = "string#" + i + " · MIDI " + note + " " + noteLabel(note)
          + (s.harpOctSemis ? " · sounds " + noteLabel(note + s.harpOctSemis) : "");
      }

      // desync badge above the strip: the chord the harp is actually playing, only while it
      // differs from the main chord AND the divergence has persisted (min play time, a transient
      // adoption relabels strings but never flashes the badge); relabelHarp is the single choke
      // point (every context change routes through here), so render it here and nowhere else
      const showDesync = harpHeld && (Date.now() - harpHeldT) >= HARP_DESYNC_MS;
      harpDesync.textContent = showDesync ? ctxLabel(harpHeld) : "";
      harpDesync.style.display = showDesync ? "" : "none";

      // visible only while harp notes sound (or fade). A badge rendered after
      // the strings went quiet starts faded; the next harp note reveals it
      // (classList.add/remove, not toggle: the node-harness DOM shim has no toggle)
      if (showDesync) {
        if (activeHarp.size === 0) harpDesync.classList.add("faded");
        else harpDesync.classList.remove("faded");
      }
      if (dbg()) {
        const t2b = [];
        for (let pos = 0; pos < 12; pos++) { const str = HARP_STRING0_AT_TOP ? pos : 11 - pos; t2b.push(`#${str}:${noteLabel(harpStringNote(str, hc, s, effHarpShuf))}`); }
        console.log(`[Play] HARP shown top→bot: ${t2b.join("  ")}`);

        // effective settings the labels were computed from. Compare against the device.
        // shuffling shows the displayed row; if it differs from the dump value, a pot is
        // driving addr 40 (the dump can't report pot positions).
        const shufStr = effHarpShuf === s.harpShuf
          ? `${effHarpShuf}(${HARP_PATTERN_NAME[effHarpShuf] || "?"})${s.potTargets.has(40) ? " [pot can drive]" : ""}`
          : `${effHarpShuf}(${HARP_PATTERN_NAME[effHarpShuf] || "?"}) [inferred; dump=${s.harpShuf}, pot-driven]`;
        console.log(`[Play] effective: harpShuf=${shufStr} `
          + `key=${s.key} frameShift=${s.shift} transpose=${s.transpose}`
          + `${s.chordTranspose != null && s.chordTranspose !== s.transpose ? `(chord frozen@${s.chordTranspose})` : ""} `
          + `slashLevel=${s.slashLevel} chordShuf=${s.chordShuf}${s.potTargets.has(120) ? "[pot]" : ""} `
          + `chromatic=${s.chromatic ? 1 : 0} barry=${s.barry ? 1 : 0} ${s.flat ? "flat" : "sharp"}-btn `
          + `altLayout=${s.altLayout ? 1 : 0}${s.potTargets.has(39) ? "[gesture]" : ""}${s.altLayout ? "[" + s.altSlots.join(",") + "]" : ""} `
          + `inv=${s.inversion}${s.potTargets.has(37) ? "[pot]" : ""} `
          + `spacing=${s.spacing}${s.potTargets.has(38) ? "[pot]" : ""} `
          + `harpMode=${s.harpMode || 0} `
          + `| held: button=${held.button}(${BTN_NAMES[held.button] || "?"}) type=${held.type}`
          + `${held.sharp ? " +sharp" : ""}${held.slash ? ` slash→${BTN_NAMES[held.slash.button] || "?"}` : ""}`
          + `${harpHeld ? ` | harp: ${ctxLabel(harpHeld)} (desynced)` : ""}`);
      }
    }

    // which strings carry `note` under a given chord context + shuffling row
    function noteStrings(note, ctx, row) {
      const out = [];
      for (let i = 0; i < 12; i++) if (harpStringNote(i, ctx, s, row) === note) out.push(i);
      return out;
    }

    // every chord table the resting harp can hold: the device's current_chord is set (with
    // barry baked in) at chord-press time and PERSISTS, so a major octaves strum can survive
    // into a barry preset. Inference picks among these RESOLVED tables from the emitted NOTES
    // first (not from s.barry, the octaves row exposes the idx3 slot, so major vs 6th differ
    // and the persisted chord reads correctly); only a FULL evidence tie (rows 0–2 never expose
    // idx3/idx6) falls to the button-simplicity score term, which IS barry-aware: fewest
    // presses to play on this preset, matching the rhythm scorer's pressOf.
    const HARP_INFER_TYPES = ["major", "minor", "seventh", "maj_seventh", "min_seventh", "dim", "aug", "maj_sixth", "min_sixth", "full_dim"];

    const FAST_MS = 150;       // notes ≤ this apart count as one quick strum-run (expect adjacency)
    const HARP_DIR_MS = 600;   // strum momentum: travel direction stays trusted for this long after the
                               // front last moved; after a pause the duplicate choice falls back to nearest
    const HARP_DESYNC_MS = 1000;   // the desync badge shows only after the divergent harp context has
                                   // PERSISTED this long (≈ one strum confirming it). A transient
                                   // adoption relabels the strings immediately but never flashes the badge
    const ctxLabel = c => `${BTN_NAMES[c.button] || "?"}${TYPE_NAME[c.type] || ""}${c.slash ? "/" + (BTN_NAMES[c.slash.button] || "?") : ""}`;

    // fit of one candidate (ctx,row) over the recent strum, shared by the fuzzy path and the
    // settled closed-search so the two can't drift. (We do NOT require a candidate to place the
    // TRIGGERING note. That constraint forced a flip to whatever could place the latest miss even
    // when it covered the whole strum WORSE, so a non-chord strum like F#,G,A oscillated
    // D→A7→Gmaj7; a note the winner can't place falls to the nearest-string light in setHarpLit.)
    function candFit(ctx, row, seq, emitted, playedCount) {
      // note → strings under this candidate (the list length = how many strings carry it)
      const map = new Map();
      for (let i = 0; i < 12; i++) { const nn = harpStringNote(i, ctx, s, row); let a = map.get(nn); if (!a) { a = []; map.set(nn, a); } a.push(i); }

      // multiset fit: coverage credits each played occurrence the candidate can place (capped at its
      // string count); overplay penalises notes played MORE times than it has strings for
      let coverage = 0, overplay = 0;
      playedCount.forEach((cnt, n) => { const exp = (map.get(n) || []).length; coverage += Math.min(cnt, exp); overplay += Math.max(0, cnt - exp); });
      // strum smoothness: walk the played order; quick successive notes should be adjacent
      let pathLen = 0, prevS = null, prevT = 0;
      for (const e of seq) {
        const pos = map.get(e.note);
        if (!pos) { prevS = null; continue; }         // this candidate can't place that note
        let chosen = pos[0];
        if (prevS != null) { let bd = Math.abs(pos[0] - prevS); for (const p of pos) { const d = Math.abs(p - prevS); if (d < bd) { bd = d; chosen = p; } } }
        if (prevS != null && e.t - prevT <= FAST_MS) pathLen += Math.abs(chosen - prevS);
        prevS = chosen; prevT = e.t;
      }
      let extra = 0; map.forEach((_, n) => { if (!emitted.has(n)) extra++; });
      return { map, coverage, overplay, pathLen, extra };
    }

    // CLOSED-SEARCH SETTLE (spec: MINICHORD-REFERENCE.md §10.6). With no chord held and no pot on
    // addr 40, every candidate's 12-string layout is EXACT. A context either CAN or CANNOT emit a
    // note, so one inexplicable note disproves it. Slash variants are first-class candidates and a
    // rival takes the read only by PERFECTLY explaining the trailing notes (a fuzzy coverage margin
    // would both flip through ambiguous runs and never search slash layouts):
    //   • suffix: walk the strum newest→oldest, never across a gap > SEG_MS (a new gesture is a new
    //     segment), counting notes the candidate carries (multiset, up to its string count). A note
    //     placeable by NOBODY (glitch/out-of-range) is transparent: skipped (≤2), it glows but can
    //     neither cause nor block a switch. The trigger note itself must be placed.
    //   • switch when the best rival's suffix ≥ HARP_SUFFIX_MIN, or instantly when the incumbent
    //     places NOTHING of the current segment and the rival explains ALL of it (cold start: the
    //     first strum lights with no chord press, no threshold wait).
    //   • otherwise hold: the misfit lights nearest/glows and an ambiguous run (B-C-D fits
    //     fragments of both Bm and Cmaj7) stops flicking the context.
    function settleHarp(note, seq, emitted, emittedPc, playedCount, chordActive) {
      const row = s.harpShuf;                        // no pot on 40 → the dump's row is the truth
      const hc = harpCtx();                          // the harp's own context (≠ held while desynced)
      const curSlash = hc.slash ? hc.slash.button : null;
      let segStart = seq.length - 1;                 // suffix never crosses a silence > SEG_MS
      while (segStart > 0 && seq[segStart].t - seq[segStart - 1].t <= SEG_MS) segStart--;

      // candidates: plains first (a tie prefers the simpler reading), then slash variants whose bass
      // pitch-class actually sounded (slash strings CARRY the bass, so a real slash strum emits it);
      // the current slash is exempt from that prune, like the gate's current-context exemption
      const cands = [];
      for (const pass of [0, 1]) for (let b = 0; b < 7; b++) for (const type of HARP_INFER_TYPES) {
        // diagnostic-tone gate: don't ADOPT a colored context (7/maj7/m7/dim/aug/m6) unless its
        // signature tone was strummed; the CURRENT context is exempt so a settled read survives its
        // diagnostic string scrolling out of the last-12 window
        const sig = TYPE_SIG[type];
        if (sig != null && !(b === hc.button && type === hc.type)) {
          const rootPc = ((voiceSet(b, CHORD[type], s)[0] % 12) + 12) % 12;
          if (!emittedPc.has((((rootPc + sig) % 12) + 12) % 12)) continue;
        }
        if (pass === 0) { cands.push({ button: b, type, sharp: false, slash: null }); continue; }
        for (let sb = 0; sb < 7; sb++) {
          if (sb === b) continue;
          const isCurSlash = b === hc.button && type === hc.type && curSlash === sb;
          const bassPc = ((voiceSet(sb, CHORD.major, s)[0] % 12) + 12) % 12;
          if (!emittedPc.has(bassPc) && !isCurSlash) continue;
          cands.push({ button: b, type, sharp: false, slash: { button: sb } });
        }
      }
      // fit everyone first so TRANSPARENT notes (placeable by nobody) are known before suffix walks
      const fits = cands.map(ctx => ({ ctx, f: candFit(ctx, row, seq, emitted, playedCount) }));
      const placeable = new Set();
      for (const c of fits) c.f.map.forEach((_, n) => placeable.add(n));
      let best = null, cur = null;
      for (const c of fits) {
        let len = 0, skips = 0, full = false;
        const used = new Map();
        for (let i = seq.length - 1; i >= segStart; i--) {
          const n = seq[i].note, cap = (c.f.map.get(n) || []).length;
          if (!cap) {
            if (i < seq.length - 1 && !placeable.has(n) && skips < 2) { skips++; continue; }   // transparent glitch
            break;                                   // an explicable note this candidate can't place
          }
          const u = (used.get(n) || 0) + 1;
          if (u > cap) break;                        // played more times than it has strings
          used.set(n, u); len++;
          if (i === segStart) full = true;
        }
        const slashB = c.ctx.slash ? c.ctx.slash.button : null;
        const isCur = c.ctx.button === hc.button && c.ctx.type === hc.type && slashB === curSlash && row === effHarpShuf;

        // BUTTON SIMPLICITY is a SCORE term (not just enumeration order): when the evidence ties,
        // prefer the chord that takes the fewest presses to play: Am (1) over Eaug (3) on a lone C,
        // plain Dm (1) over Dm/F (2, a slash adds a bass column; its doubled bass also collapses the
        // note set, so `extra` alone would have handed the cold adopt to the slash).
        const btns = pressOf(c.ctx.type, s.barry) + (slashB == null ? 0 : 1);
        const score = [-len, -c.f.coverage, c.f.overplay, c.f.pathLen, btns, c.f.extra, isCur ? 0 : 1];
        const cand = { ctx: c.ctx, len, full, score, coverage: c.f.coverage, overplay: c.f.overplay, pathLen: c.f.pathLen, map: c.f.map };
        if (isCur) cur = cand;
        if (!best || lexLess(score, best.score)) best = cand;
      }
      if (!best || best.len === 0) return;           // nobody places the trigger note, leave as is (glow)
      let curPlaced = 0;
      if (cur) for (let i = segStart; i < seq.length; i++) if (cur.map.has(seq[i].note)) curPlaced++;

      // cold-start shortcut only with NO chord held: with a chord down the port prior is strong.
      // A strum STARTING on the one desynced note must glow until the full suffix lands, not
      // one-note adopt whatever places it cheapest (a lone E4 would read Am over Fmaj7)
      const cold = !chordActive && curPlaced === 0 && best.full;
      if (!cold && best.len < HARP_SUFFIX_MIN) {
        if (dbg()) console.log(`[Play] harp settle: keep ${ctxLabel(hc)} — best rival ${ctxLabel(best.ctx)} explains only the last ${best.len}/${seq.length - segStart} (<${HARP_SUFFIX_MIN}); ${noteLabel(note)} stays unplaced`);
        return;
      }
      const newSlashB = best.ctx.slash ? best.ctx.slash.button : null;
      const ctxChanged = best.ctx.button !== hc.button || best.ctx.type !== hc.type || newSlashB !== curSlash;
      if (!ctxChanged && row === effHarpShuf) return;
      if (ctxChanged) {
        const adopt = { button: best.ctx.button, type: best.ctx.type, sharp: false, slash: best.ctx.slash };

        // with a chord held the GRID keeps the port truth; the divergent context belongs to the
        // harp alone (shown as the desync badge); with no chord held the harp context IS the main one
        if (chordActive) {
          // …but never fork the harp while the RHYTHM drives the context: the "held" notes are the
          // arpeggio's own voices, and a strum over a running pattern must not split the display
          if (rhythmActive) {
            if (dbg()) console.log(`[Play] harp settle: rival ${ctxLabel(best.ctx)} suppressed — rhythm owns the context`);
            return;
          }
          const was = harpHeld;
          harpHeld = harpHeldEq(adopt) ? null : adopt;
          if (harpHeld && !was) {
            harpHeldT = Date.now();   // a NEW desync episode: badge appears after HARP_DESYNC_MS
            setTimeout(() => { if (harpHeld) relabelHarp(); }, HARP_DESYNC_MS + 20);
          }
        }
        else { held = adopt; harpHeld = null; emitChord("inferred"); }
      }
      effHarpShuf = row;
      relabelHarp();
      if (dbg()) console.log(`[Play] harp ctx → ${ctxLabel(harpCtx())}${harpHeld ? ` (desynced — chord port holds ${ctxLabel(held)})` : ""} row ${row}(${HARP_PATTERN_NAME[row]}) — note ${noteLabel(note)} didn't fit; last ${best.len}/${seq.length} fully explained (cover ${best.coverage}, overplay ${best.overplay}, path ${best.pathLen})`);
    }

    // Re-infer the harp context from the notes the device is emitting, called when a harp
    // note doesn't fit the current labels. The harp follows the held chord, so the notes
    // themselves carry the chord. Two regimes:
    //   • SETTLED (no chord held, no pot on addr 40, settleHarp above): the row is exactly the
    //     dump's, so every candidate's 12-string layout is EXACT and inference is a closed search
    //     over suffixes of the strum.
    //   • FUZZY (chord held and/or pot on 40): the held chord is reliable but the ROW can be off
    //     (a pot drives addr 40, unreported over sysex), scored over the LAST ≤12 notes by how
    //     plausibly a human strummed them. Lexicographic:
    //       1. coverage: played note-OCCURRENCES the candidate can place (multiset: a note on N
    //          strings is played N times, so multiplicity separates octaves/keymaster, which
    //          repeat a note, from rows that don't)
    //       2. overplay: notes played MORE times than the candidate has strings for (impossible
    //          in one strum) → penalise
    //       3. path: strum smoothness. A strum hits ADJACENT strings in quick succession, so the
    //          right (chord,row) traces a smooth near-monotonic path while a wrong guess scatters
    //       4. extra: fewest spurious notes; then keep the current context on ties.
    function reinferHarp(note) {
      if (s.chromatic) return;                       // chromatic mode: fixed notes, no context
      const seq = recentHarp;                        // ordered {note,t}, last ≤12
      const emitted = new Set(seq.map(e => e.note));
      const emittedPc = new Set([...emitted].map(n => ((n % 12) + 12) % 12));   // strummed pitch-classes (diagnostic gate)
      // occurrence counts: a note on N strings is played N times per strum, so its multiplicity
      // is a strong discriminator (e.g. octaves/keymaster repeat a note that other rows don't)
      const playedCount = new Map();
      for (const e of seq) playedCount.set(e.note, (playedCount.get(e.note) || 0) + 1);
      const chordActive = heldNotes.size > 0;        // a chord is down on the chord port → trust it
      // settled regime: the layout is exact, closed suffix search (see settleHarp). Runs with a
      // chord held too: the firmware can DESYNC the harp from the chord section (a near-simultaneous
      // combo queues the chord voices from the previous loop's chord while the harp follows the live
      // pointer), so a chord-held miss may mean the harp is genuinely playing a different chord.
      if (!s.potTargets.has(40)) return settleHarp(note, seq, emitted, emittedPc, playedCount, chordActive);
      const hc = harpCtx();                          // the harp's own context (≠ held while desynced)
      const ctxs = chordActive ? [hc] : [];
      if (!chordActive) for (let b = 0; b < 7; b++) for (const type of HARP_INFER_TYPES) ctxs.push({ button: b, type, sharp: false, slash: null });

      // the shuffling row is only uncertain when a pot can drive addr 40; otherwise it's
      // exactly the dump value, so don't let inference second-guess it (it would wrongly swap
      // rows on e.g. a repeated-note preset that has no harp pot). The chord is still inferred.
      const rowList = shuffleRows(s.potTargets, 40, s.harpShuf, HARP_SHUF.length);

      // MOMENTUM SPOT (row identification): mid-swipe, the finger's NEXT position is known:
      // lastHarpPos + travel direction. A row that carries the missed note exactly THERE is almost
      // certainly the live knob row, so the distance from that spot is a score term. Neutral (0
      // for every candidate) when momentum is stale, so non-swipe inference is unchanged.
      const nowT = Date.now();
      const spotFresh = harpDir !== 0 && lastHarpPos != null && (nowT - lastHarpT) <= HARP_DIR_MS;
      const spotAt = spotFresh ? lastHarpPos + harpDir : 0;
      let best = null;
      for (const ctx of ctxs) {
        // diagnostic-tone gate (free inference only): don't ADOPT a colored context (7/maj7/m7/dim/aug/m6)
        // unless its signature tone was actually strummed. A decoration string the quality doesn't
        // require (dim's D vs minor's D♭) must not flip the harp to that color. The CURRENT context type
        // is exempt so a settled read survives its diagnostic string scrolling out of the last-12 window.
        const sig = TYPE_SIG[ctx.type];
        if (sig != null && !chordActive && !(ctx.button === hc.button && ctx.type === hc.type)) {
          const rootPc = ((voiceSet(ctx.button, CHORD[ctx.type], s)[0] % 12) + 12) % 12;
          if (!emittedPc.has((((rootPc + sig) % 12) + 12) % 12)) continue;
        }
        for (const row of rowList) {
          const f = candFit(ctx, row, seq, emitted, playedCount);
          const isCur = ctx.button === hc.button && ctx.type === hc.type && row === effHarpShuf;
          let spotDist = 0;
          if (spotFresh) { const pos = f.map.get(note) || []; spotDist = pos.length ? Math.min(...pos.map(i => Math.abs(i - spotAt))) : 13; }

          // lexicographic best: coverage↑, then overplay↓, momentum-spot↓, pathLen↓, then BUTTON
          // SIMPLICITY (fewest presses to play, same rule as the settled path and the rhythm
          // scorer), extra↓, then keep the current context. Negate maximised terms for lexLess.
          const btns = pressOf(ctx.type, s.barry) + (ctx.slash ? 1 : 0);
          const score = [-f.coverage, f.overplay, spotDist, f.pathLen, btns, f.extra, isCur ? 0 : 1];
          if (!best || lexLess(score, best.score)) best = { ctx, row, coverage: f.coverage, overplay: f.overplay, pathLen: f.pathLen, score };
        }
      }
      if (!best) return;                             // nothing explains the note, leave as is
      // slash refinement (only when INFERRING, a held chord already carries its slash): if the strum
      // has notes the base chord can't place but a slash (the bass/root voice swapped for another
      // column's root) CAN: e.g. E6/A, the A replacing E on the root strings, adopt it. The harp then
      // relabels those root strings to the slash bass, so the played notes light on a string with the
      // CORRECT label instead of being forced onto an unrelated neighbour (and repeats stay separate).
      let slashBtn = null;
      if (!chordActive) {
        let cov = best.coverage;
        for (let sb = 0; sb < 7; sb++) {
          if (sb === best.ctx.button) continue;
          const sctx = { button: best.ctx.button, type: best.ctx.type, sharp: false, slash: { button: sb } };
          const smap = new Map();
          for (let i = 0; i < 12; i++) { const nn = harpStringNote(i, sctx, s, best.row); let a = smap.get(nn); if (!a) { a = []; smap.set(nn, a); } a.push(i); }
          let c = 0; playedCount.forEach((cnt, n) => { c += Math.min(cnt, (smap.get(n) || []).length); });
          if (c > cov) { cov = c; slashBtn = sb; }   // a slash that places MORE of the strum
        }
      }
      const curSlash = hc.slash ? hc.slash.button : null;
      const ctxChanged = best.ctx.button !== hc.button || best.ctx.type !== hc.type || (!chordActive && slashBtn !== curSlash);
      if (ctxChanged || best.row !== effHarpShuf) {
        if (!chordActive && ctxChanged) { held = { button: best.ctx.button, type: best.ctx.type, sharp: false, slash: slashBtn != null ? { button: slashBtn } : null }; harpHeld = null; emitChord("inferred"); }
        effHarpShuf = best.row;
        relabelHarp();
        if (dbg()) {
          console.log(`[Play] harp ctx → ${ctxLabel(harpCtx())} row ${best.row}(${HARP_PATTERN_NAME[best.row]}) — note ${noteLabel(note)} didn't fit (cover ${best.coverage}/${seq.length}, overplay ${best.overplay}, path ${best.pathLen})`);
        }
      }
    }

    /* highlight ---------------------------------------------------------- */
    function clearChordLit() {
      for (let col = 0; col < 7; col++) for (let row = 0; row < 3; row++) cells[col][row].classList.remove("lit", "slash");
      sharpBtn.classList.remove("lit");
    }
    const lexLess = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };

    const anyLive = () => heldNotes.size > 0 || dropped.size > 0;
    const heldHas = counts => { for (const n of counts.keys()) if (heldNotes.has(n)) return true; return false; };

    // identify the chord, deliberately MINIMAL / least-greedy. Pick the candidate that
    // most CLOSELY fits the live notes: cover every sounding note (foreign=0) without
    // over-claiming notes that aren't there (missing=0), then prefer the fewest buttons
    // (a plain triad beats a 7th beats a slash), then the chord being newly played, then
    // column proximity (breaks E#≡F / B#≡C). Needs ≥3 voices and a tight fit, so a loose
    // soup of decaying notes never lights a phantom chord.
    function matchChord() {
      if (!heldNotes.size) return null;       // a chord needs at least one note physically held
      // sharp spellings are allowed right after a sharp chord, OR on the column
      // already held. Pressing # while holding F must read as the sharp button
      // (F♭/F#), never relabel to the neighboring natural column (E)
      // lastSharp = the sharp button is still held across chords → the next enharmonic press is sharp
      // too (A#→E#→B# all read sharp, consistently). The same-column hold, by contrast, is only for a
      // sharp ADDED to a live chord (E held → E#); a FRESH natural press must NOT inherit it (E then a
      // fresh F reads F, not E#). So gate only the column clause on freshChord.
      const sharpAllowed = c => lastSharp || (!freshChord && lastCol != null && colOf(c.button) === lastCol);
      // available notes = held (required) + recently dropped (optional, to complete a chord)
      const avail = new Map();
      heldNotes.forEach((c, n) => avail.set(n, c));
      dropped.forEach((_, n) => avail.set(n, (avail.get(n) || 0) + 1));
      let best = null, bestCounts = null, bestScore = null;
      for (const e of lookupList) {
        if (e.counts.size < 3) continue;

        // held ⊆ C ⊆ avail: every HELD note belongs to this chord (it's really sounding),
        // and every chord note is available (held, or recently dropped to fill a voice).
        let ok = true, droppedUsed = 0;
        heldNotes.forEach((c, n) => { if ((e.counts.get(n) || 0) < c) ok = false; });
        if (!ok) continue;
        e.counts.forEach((c, n) => { if ((avail.get(n) || 0) < c) ok = false; droppedUsed += Math.max(0, c - (heldNotes.get(n) || 0)); });
        if (!ok) continue;
        const newest = (lastOnNote != null && e.counts.has(lastOnNote)) ? 0 : 1;
        const hasNatural = e.cands.some(c => !c.sharp);
        for (const c of e.cands) {
          if (c.sharp && !sharpAllowed(c) && hasNatural) continue;   // enharmonic sharps need context (see above)
          const d = lastCol == null ? 0 : Math.abs(colOf(c.button) - lastCol);
          const colDist = Math.min(d, 7 - d);   // circle-of-fifths distance
          const buttons = typeRows(c.type, s).length + (c.slash ? 3 : 0);
          // least greedy: fewest borrowed (dropped) notes, then fewest buttons, then newest, …
          const score = [droppedUsed, buttons, newest, colDist, c.sharp ? 1 : 0];
          if (!best || lexLess(score, bestScore)) { best = c; bestCounts = e.counts; bestScore = score; }
        }
      }
      return best ? { c: best, counts: bestCounts } : null;
    }

    function applyChord(r) {
      // commit r ({c,counts}) as the shown chord (r=null keeps the current one for the fade)
      if (r) {
        freshChord = false;   // a chord is committed/shown; further reads are edits, not fresh presses
        if (!curChord || !sameChord(curChord, r.c)) {
          curChord = r.c; lastCol = colOf(r.c.button); lastSharp = r.c.sharp;

          // the harp's notes follow the held chord (incl. slash + sharp). Update labels. r.c.type is
          // already barry-resolved (the lookup baked it in), so copy the descriptor straight into held.
          // A real chord trigger also RESYNCS the device harp. Clear any desync badge. (Inside the
          // change branch on purpose: retriggers of the SAME chord re-apply without wiping a live
          // desync; a true resync arrives as the new chord's port notes and lands here.)
          held = { button: r.c.button, type: r.c.type, sharp: r.c.sharp, slash: r.c.slash ? { button: r.c.slash.button } : null };
          harpHeld = null;
          recentHarp.length = 0;   // last strum was for the old chord; re-infer fresh
          relabelHarp();
          emitChord("strong");     // live note-set match, the strongest read there is
        }
        curCounts = r.counts;
      }
      renderChord();
    }
    let rhythmActive = false;   // true while the rhythm playhead is locked
    let rhythmChord = null;     // canonical chord {button,type,slash} the rhythm fingerprinted, shown "slash"-style
    let lastRhythmShow = null;  // debug: last logged rhythm-chord decision (log only on change)
    let tintTimer = null;       // debounce so rapid tint changes collapse (a transient never animates)
    const TINT_DEBOUNCE = 90;   // ms: a tint that comes and goes within this window never paints
    // the FULL chord label as HTML: root + octave (as a SUBSCRIPT so it doesn't collide with a 7th,
    // i.e. F₃7 not "F37") + type + slash bass. `type` should already be barry-resolved (e.g. maj_sixth);
    // `off` is the inferred live transpose Δ so the root stays correct when a pot has shifted transpose.
    function chordLabel(button, type, off, slashButton, sharp) {
      const names = noteNames(s);

      // use the PRESS-TIME (frozen) transpose, like chordVoiceNote; transpose only affects NEW notes,
      // so a chord already shown (current or in history) keeps the transpose it was detected at.
      const tr = s.chordTranspose == null ? s.transpose : s.chordTranspose;
      // chordOctSemis: the explicit octave setting moves the SOUNDING pitch only.
      // Fold it into the shown octave digit (a ±12 shift never moves the pitch class)
      const rm = MIDI_BASE + tr + rootButton(s, button) + (off || 0) + (sharp ? (s.flat ? -1 : 1) : 0) + (s.chordOctSemis || 0);
      const oct = Math.floor(rm / 12) - 1;
      // the root carries its own letter, so E# stays E# rather than collapsing to F
      const rootName = spellText(spellRoot(s, button, sharp, tr + (off || 0)));
      let str = rootName + '<sub class="dm-ro-oct">' + oct + "</sub>" + (TYPE_NAME[type] != null ? TYPE_NAME[type] : type);

      // the slash bass must shift with the same transpose as the root. Otherwise, with
      // transpose on, D/G reads as D with the wrong bass name while the root stays correct
      if (slashButton != null) str += "/" + spellText(spellRoot(s, slashButton, false, tr + (off || 0)));
      return str;
    }
    let roCur = null, roCurBtn = null, harpReadT = 0, harpBtn = null;
    const HARP_PRIORITY_MS = 1500;  // after a harp note, the harp fully owns the readout (immediate window)
    const roPop = el => { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; };   // retrigger
    const roSlot = (el, html) => { el.innerHTML = html; el.style.display = html ? "" : "none"; if (html) roPop(el); };

    // update the always-on readout. Each reading is TAGGED with its chord (the root button). A new
    // reading pushes the current one into history ONLY when the button actually changes, i.e. a
    // different chord. Re-readings of the SAME chord (a transpose/type refinement getting better)
    // share the tag and just replace in place. No timers, no delay.
    function setReadoutChord(button, type, off, slashButton, sharp) {
      const name = chordLabel(button, type, off, slashButton, sharp);
      if (name === roCur) return;
      if (roCur != null && button !== roCurBtn) {   // a genuinely different chord → keep the old in history
        roSlot(roPrev3, roPrev2.innerHTML);
        roSlot(roPrev2, roPrev.innerHTML);
        roSlot(roPrev, roCur);
      }
      roCur = name; roCurBtn = button;
      roCurEl.innerHTML = name;
      roPop(roCurEl);
      renderReadoutDetail(button, type, off, slashButton, sharp);
    }

    // the chord's four sounding voices under the big label, plus a key/transpose
    // context line, display only, derived from the same voiceSet the lookups use
    const KEY_NAMES = ["C", "G", "D", "A", "E", "B", "F", "B♭", "E♭", "A♭", "D♭", "G♭",
      "F♯", "C♯", "G♯", "D♯", "A♯", "E♯", "B♯", "F♭", "C♭"];
    function renderReadoutDetail(button, type, off, slashButton, sharp) {
      const table = CHORD[type];   // `type` is the resolved table NAME; voiceSet wants the interval array
      if (!table) { roNotesEl.innerHTML = ""; return; }
      const names = noteNames(s);
      const lbl = n => names[((n % 12) + 12) % 12] + '<sub class="dm-ro-oct">' + (Math.floor(n / 12) - 1) + "</sub>";
      const voices = voiceSet(button, table, s, {
        count: 4, off: off || 0, sharp: !!sharp,
        slash: slashButton != null ? { button: slashButton } : null,
      });
      roNotesEl.innerHTML = voices.map(lbl).join('<span class="dm-ro-sep">·</span>');
      const ctx = [];
      if (s.key) ctx.push("key " + (KEY_NAMES[s.key] || "?"));
      if (s.transpose) ctx.push((s.transpose > 0 ? "+" : "") + s.transpose + " st");
      roCtxEl.textContent = ctx.join(" · ");
      roCtxEl.style.display = ctx.length ? "" : "none";
    }
    // before anything is detected, show the device's default chord (button 0, the fundamental).
    function resetReadout() { roCur = null; roCurBtn = null; roSlot(roPrev, ""); roSlot(roPrev2, ""); roSlot(roPrev3, ""); setReadoutChord(0, resolveTable("major", s.barry), 0, null, false); }

    // while rhythm plays the arpeggio (one note at a time) makes the live detector guess wildly, so
    // instead of letting it flicker we show the controller's fingerprinted chord as a soft "slash" tint.
    function paintRhythmChord() {
      if (!rhythmChord) return;
      const col = colOf(rhythmChord.button);
      typeRows(rhythmChord.type, s).forEach(row => { const c = cells[col] && cells[col][row]; if (c) c.classList.add("slash"); });
      // slash chord: also tint the bass column (the split note), like the live mirror does
      const sc = rhythmChord.slash ? colOf(rhythmChord.slash.button) : null;
      if (sc != null && cells[sc]) {
        for (let row = 0; row < 3; row++) cells[sc][row].classList.add("slash");
      }
    }

    // debounced tint repaint: rapid back-to-back changes reset the timer, so only the SETTLED tint
    // ever paints. A chord that lights and clears within TINT_DEBOUNCE never starts an animation.
    function scheduleTint() {
      if (tintTimer) clearTimeout(tintTimer);
      tintTimer = setTimeout(() => { tintTimer = null; clearChordLit(); if (rhythmActive) paintRhythmChord(); }, TINT_DEBOUNCE);
    }
    function renderChord() {
      clearChordLit();   // a previous chord's old buttons fade out over the release tail
      if (rhythmActive) { paintRhythmChord(); return; }   // readout driven by showRhythmChord while locked
      const showing = curChord && curCounts && heldHas(curCounts);
      if (showing) {
        const col = colOf(curChord.button);
        typeRows(curChord.type, s).forEach(row => cells[col][row].classList.add("lit"));
        if (curChord.sharp) sharpBtn.classList.add("lit");
        // split / slash: light the whole bass column (skip any button already a chord note)
        if (curChord.slash) {
          const sc = colOf(curChord.slash.button);
          for (let row = 0; row < 3; row++) {
            const bass = cells[sc][row];
            if (!bass.classList.contains("lit")) bass.classList.add("slash");
          }
        }
      }

      // mirror path: the live (grid/harp) detected chord drives the readout when rhythm isn't locked.
      // Use `held` (built by applyChord) so the type is barry-resolved (a Barry major reads "6", etc.).
      // Idle keeps the last chord shown (never blanks); the key is always displayed.
      if (showing) setReadoutChord(held.button, held.type, 0, held.slash ? held.slash.button : null, held.sharp);
      if (!anyLive()) { if (curChord) emitChordOff(); curChord = null; curCounts = null; }   // chord LEAVE re-arms triggers
      if (dbg()) {
        const shown = (curChord && curCounts && heldHas(curCounts)) ? describeChord(curChord) : "—";
        if (shown !== lastLoggedChord) {
          console.log(`[Play] ▶ DETECTED: ${shown}   (live: ${Array.from(heldNotes.keys()).sort((a, b) => a - b).map(noteLabel).join(" ") || "none"})`);
          lastLoggedChord = shown;
        }
      }
    }
    function paintChord() {
      const r = matchChord();
      const isComplex = r && (r.c.slash || typeRows(r.c.type, s).length > 1);
      const alreadyShown = r && curChord && sameChord(curChord, r.c);
      if (isComplex && !alreadyShown) {
        // a NEW slash/combo, only show it once it has stayed matched for COMPLEX_HOLD ms,
        // so a transient two-column overlap during a fast change can't flash it
        if (!pendingCand || !sameChord(pendingCand, r.c)) {
          pendingCand = r.c;
          if (pendingTimer) clearTimeout(pendingTimer);
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            const r2 = matchChord();
            if (r2 && pendingCand && sameChord(r2.c, pendingCand)) applyChord(r2);
            pendingCand = null;
          }, COMPLEX_HOLD);
        }
        renderChord();   // keep showing the current chord (it fades if released); don't adopt yet
        return;
      }
      // a simple chord, the same complex already shown, or no match → cancel any pending, show now
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingCand = null;
      applyChord(r);
    }
    function describeChord(c) {
      // spell by the button's own letter, matching the lit column
      const rootName = spellText(spellRoot(s, c.button, c.sharp));
      let str = rootName + (TYPE_NAME[c.type] != null ? TYPE_NAME[c.type] : c.type);
      if (c.slash) str += "/" + spellText(spellRoot(s, c.slash.button, false));
      return str + ` [col${colOf(c.button)} rows${typeRows(c.type, s).join("")}${c.sharp ? " SHARP" : ""}${c.slash ? " slash@col" + colOf(c.slash.button) : ""}]`;
    }

    /* chord note plumbing (held + recently-dropped lookback) ------------- */
    // move a released note into the brief lookback pool, where it can still complete a strummed /
    // retriggered chord before fading over the release tail
    function dropNote(note) {
      const prev = dropped.get(note); if (prev) clearTimeout(prev.timer);
      dropped.set(note, { timer: setTimeout(() => { dropped.delete(note); paintChord(); }, LOOKBACK) });
    }

    // (re)arm the watchdog for a held note. The device re-triggers held / rhythm chords, so an active
    // note keeps refreshing this; only a note whose note-off was MISSED (a phantom) ages out, which
    // both stops a button glowing forever and unblocks the next chord (matchChord needs held ⊆ chord).
    function armWatchdog(note) {
      const w = heldWatch.get(note); if (w) clearTimeout(w);
      heldWatch.set(note, setTimeout(() => {
        heldWatch.delete(note); heldNotes.delete(note); dropNote(note);
        if (dbg()) console.log(`[Play] watchdog released stale note ${note} ${noteLabel(note)}`);
        paintChord();
      }, HELD_TTL));
    }
    function chordNoteOn(note) {
      // cold start (nothing held, nothing in lookback) → this is a fresh chord, not a live edit
      if (!heldNotes.size && !dropped.size) freshChord = true;
      const d = dropped.get(note); if (d) { clearTimeout(d.timer); dropped.delete(note); }
      heldNotes.set(note, (heldNotes.get(note) || 0) + 1);
      armWatchdog(note);             // refresh the stale-note guard on every (re)trigger of this note
      lastOnNote = note;

      // a chord press makes the device recompute the harp (button_pushed) → adopt a deferred
      // chromatic (addr 98) toggle now, in lockstep with the device
      const realChrom = !!((getPatch() || {})[98]);
      if (realChrom !== effChromatic) { effChromatic = realChrom; s.chromatic = realChrom; relabelHarp(); }

      // a press also recomputes the chord at the LIVE transpose (it was frozen while the prior
      // chord was held). Adopt it and rebuild the lookup so this chord matches at the new value.
      if (s.transpose !== effChordTranspose) {
        effChordTranspose = s.transpose; s.chordTranspose = s.transpose;
        rebuildLookups();
      }
      paintChord();
    }
    function chordNoteOff(note) {
      const c = (heldNotes.get(note) || 0) - 1;
      if (c > 0) heldNotes.set(note, c);
      else { heldNotes.delete(note); const w = heldWatch.get(note); if (w) { clearTimeout(w); heldWatch.delete(note); } }
      dropNote(note);                // remember it briefly so it can still complete a retriggering / strummed chord
      paintChord();
    }

    /* harp ---------------------------------------------------------------- */
    function setHarpLit(note, on) {
      if (on) {
        const now = Date.now();
        const live = (activeHarp.get(note) || 0) + 1;   // physical strings sounding this pitch now
        activeHarp.set(note, live);

        // confirm detection: glow the harp panel while ANY harp note is sounding (even a note we can't
        // pin to a string). Stays on while held; removed below only when the LAST note releases, so it
        // mirrors the strings (instant on, fades out together) and never strobes per note.
        harp.classList.add("dm-hit");
        // a still-unresolved desync (no chord trigger yet) comes straight back with the notes
        harpDesync.classList.remove("faded");

        // keep the last 12 harp notes (≈ one strum) as inference context, with timing so
        // inference can tell quick strum-runs (adjacent strings) from deliberate jumps
        recentHarp.push({ note, t: now });
        while (recentHarp.length > 12) recentHarp.shift();

        // stay on the current context while it explains the note; a miss re-infers the chord+row (+slash)
        // from the last 12 notes (so the first strum lights with no chord press, and a pot-driven row is
        // caught). But re-infer only on a GENUINELY NEW pitch: once a full-ish swipe is in hand (≥8
        // notes), a note already played this strum must NOT flip the context to something else; settle.
        let matches = noteStrings(note, harpCtx(), effHarpShuf);
        const fresh = !recentHarp.slice(0, -1).some(e => e.note === note);

        // a miss = the layout can't place the note at all, or, when a pot drives the ROW, can't
        // place it on as many strings as are SOUNDING it now (multiset: an octaves-row double vs a
        // single-carry row shares the pitch set and only the repeat reveals the row). Pot-driven
        // only: with the row fixed by the dump the layout must not be second-guessed (a device
        // note-retrigger doubles a pitch spuriously, and an octaves-shaped capture would contort
        // the CONTEXT (Dm/F doubles F at row 0) to explain a row-level fact). The violation
        // bypasses the fresh guard: the pitch repeats by definition; the repeat IS the news.
        const mviol = matches.length > 0 && live > matches.length && s.potTargets.has(40);
        if ((!matches.length && (fresh || recentHarp.length < 8)) || mviol) { reinferHarp(note); matches = noteStrings(note, harpCtx(), effHarpShuf); }

        // if STILL unplaceable, light NOTHING (the panel glow already confirms the hit). Don't force an
        // unrelated, wrong-labelled neighbour. The slash/row inference above is what makes a played note
        // light on a correctly-labelled string; a true out-of-range note just isn't on this harp.
        if (!matches.length) return;
        let chosen;
        const dirFresh = harpDir !== 0 && (now - lastHarpT) <= HARP_DIR_MS;   // recent travel → momentum valid
        if (matches.length === 1) {
          chosen = matches;
        } else {
          // several strings carry this note (octaves repeat one; a slash bass can land ON a chord
          // tone: C/G carries G on string #0 AND #2). Light as many as are physically SOUNDING it
          // now (the note-on count), choosing strings that follow the FINGER like a heat map:
          // candidates AHEAD of the last position in the direction of travel win (nearest first),
          // the ones behind only after, so a re-plucked twin advances WITH the sweep instead of
          // snapping back to an earlier string on a raw nearest-distance tie (#0 vs #2 from #1).
          // With no fresh direction (first note, or a pause), plain nearest distance.
          const want = Math.min(live, matches.length);
          if (lastHarpPos == null) chosen = matches.slice(0, want);
          else {
            const rank = i => { const d = i - lastHarpPos; return dirFresh && d * harpDir < 0 ? 100 + Math.abs(d) : Math.abs(d); };
            chosen = matches.slice().sort((a, b) => rank(a) - rank(b)).slice(0, want);
          }
        }
        chosen.forEach(i => segByString[i].classList.add("lit"));
        harpLit.set(note, chosen);
        emitPluck(chosen);

        // the strum FRONT moves to the chosen string farthest along the travel (farthest from the
        // previous position when direction is unknown), and the travel direction updates from the
        // front's movement, so the NEXT duplicate keeps following the finger, even right after an
        // octave-double lit two plates at once.
        let front = chosen[0];
        for (const i of chosen) {
          if (lastHarpPos == null ? i > front
            : dirFresh ? (i - front) * harpDir > 0
            : Math.abs(i - lastHarpPos) > Math.abs(front - lastHarpPos)) front = i;
        }
        if (lastHarpPos != null && front !== lastHarpPos) harpDir = front > lastHarpPos ? 1 : -1;
        lastHarpPos = front; lastHarpT = now;

        // the HARP is the source of truth (its 12 strings ≈ the whole scale). It drives the readout
        // AND the rhythm grid tint, taking priority over the rhythm's inference for HARP_PRIORITY_MS.
        setReadoutChord(held.button, held.type, 0, held.slash ? held.slash.button : null, held.sharp);
        if (rhythmActive) tintGrid(held.button, held.type, held.slash ? held.slash.button : null);
        harpReadT = Date.now(); harpBtn = held.button;   // the harp owns this root until the chord moves on
        if (dbg()) console.log(`[Play]   harp ${note} ${noteLabel(note)} -> string#${chosen.join(",")} (labels: ${chosen.map(i => segByString[i].textContent).join(",")})`);
      } else {
        const live = (activeHarp.get(note) || 1) - 1;
        if (live > 0) { activeHarp.set(note, live); return; }   // still sounding on another string, keep lit
        activeHarp.delete(note);
        const hit = harpLit.get(note) || [];
        hit.forEach(i => segByString[i].classList.remove("lit"));   // fades over --dm-harp-fade
        harpLit.delete(note);
        if (activeHarp.size === 0) {
          harp.classList.remove("dm-hit");   // last harp note gone → panel glow fades out
          harpDesync.classList.add("faded"); // …and the desync badge fades with it (state stays; notes bring it back)
        }
      }
    }
    // handle a MIDI note from the device. role = "chord" | "harp".
    let lastMidiT = 0;
    function onNote(role, type, note) {
      if (dbg()) {
        const now = Date.now(), dt = lastMidiT ? now - lastMidiT : 0;
        lastMidiT = now;
        console.log(`[Play] MIDI  ${role}  ${type === "on" ? "ON " : "OFF"}  ${note} ${noteLabel(note)}  (+${dt}ms)`);
      }
      if (role === "harp") {
        setHarpLit(note, type === "on");   // note-off releases outright
        return;
      }
      if (type === "on") chordNoteOn(note); else chordNoteOff(note);
    }

    /* offline interactive preview --------------------------------------- */
    // mouse clicks build a chord the way the device does (handle_chord_type + detect_slash):
    // the FIRST column clicked is the root; more clicks in that column toggle maj/min/7th into a
    // combo; a click in a SECOND column is the split/slash bass. Clicks accumulate. We only
    // clear when a click can't combine (a THIRD column: the chord holds one root + one slash).
    function previewChord(col, row) {
      let sel = previewSel;
      if (!sel) {                              // nothing held yet → this press is the root
        sel = { rootCol: col, rows: new Set([row]), slashCol: null };
      } else if (col === sel.rootCol) {        // same column → toggle a chord-type button (combo)
        if (sel.rows.has(row)) { sel.rows.delete(row); if (!sel.rows.size) sel = null; }  // last one off → release
        else sel.rows.add(row);
      } else if (sel.slashCol == null) {       // a different column → split chord (root stays first)
        sel.slashCol = col;
      } else if (col === sel.slashCol) {        // clicking the split column again removes the split
        sel.slashCol = null;
      } else {                                  // a 3rd column can't combine → start over from here
        sel = { rootCol: col, rows: new Set([row]), slashCol: null };
      }
      previewSel = sel;
      renderPreview();
    }
    function renderPreview() {
      clearChordLit();
      const sel = previewSel;
      if (!sel) {   // empty selection → neutral resting harp context (firmware boots B major)
        held = { button: 0, type: "major", sharp: false, slash: null };
        harpHeld = null;
        recentHarp.length = 0; relabelHarp();
        emitChordOff();   // a preview clear is a release, not a played B major
        return;
      }
      lastCol = sel.rootCol;
      sel.rows.forEach(r => cells[sel.rootCol][r].classList.add("lit"));
      if (sel.slashCol != null) {              // light the whole bass line (slash = a line, not a type)
        for (let r = 0; r < 3; r++) if (!cells[sel.slashCol][r].classList.contains("lit")) cells[sel.slashCol][r].classList.add("slash");
      }
      held = {
        button: buttonOfCol(sel.rootCol),
        type: s.altLayout ? comboType(sel.rows, s) : resolveTable(comboType(sel.rows, s), s.barry),
        sharp: false,
        slash: sel.slashCol != null ? { button: buttonOfCol(sel.slashCol) } : null,
      };
      harpHeld = null;
      recentHarp.length = 0;
      relabelHarp();
      emitChord("strong");   // a deliberate pad click is a strong shape
      // offline only: a mouse-built chord updates the readout history (live notes own it when connected)
      if (!connectedState) setReadoutChord(held.button, held.type, 0, held.slash ? held.slash.button : null, held.sharp);
    }
    function flashString(str) {
      const seg = segByString[str];
      seg.classList.add("lit");
      emitPluck([str]);   // a string click counts as a pluck (capture + offline triggers)
      setTimeout(() => { if (!harpLitActive(str)) seg.classList.remove("lit"); }, 320);
    }
    function harpLitActive(str) {
      for (const arr of harpLit.values()) if (arr.indexOf(str) >= 0) return true;
      return false;
    }

    /* lifecycle ---------------------------------------------------------- */
    function rebuild() {
      const prevShuf = s.harpShuf;
      s = readSettings(getPatch());

      // effHarpShuf tracks the dump's stored row. PRESERVE an inferred row only when a pot can
      // actually drive addr 40 (then the stored value is a lie) AND it didn't change. Otherwise
      // always trust the patch. Without the pot test, switching to a no-pot preset that happens
      // to store the same harpShuf as the last one (e.g. Underwater→Neon, both 4) would keep the
      // previous preset's inferred row. That's invisible to inference: a wrong row like "normal"
      // silently absorbs an octaves strum (every emitted note still maps to SOME string), so no
      // note ever "misses" and reinferHarp never fires to correct it. Resetting here is safe:
      // with no pot on 40 the row can only ever equal s.harpShuf anyway.
      if (!s.potTargets.has(40) || s.harpShuf !== prevShuf) effHarpShuf = s.harpShuf;

      // chromatic (addr 98) only changes the EMITTED harp once the device recomputes
      // current_harp_notes, on a chord press, or when the row (addr 40) changes. A lone 98
      // toggle does neither, so keep rendering the prior chromatic state until a chord is hit
      // (a preset load that moves the row adopts it here; a chord press adopts it in chordNoteOn).
      if (s.harpShuf !== prevShuf) effChromatic = s.chromatic;
      s.chromatic = effChromatic;

      // Freeze the chord-grid transpose while a chord is physically held. The device won't move a
      // held chord when addr 30 changes (its NoteOns are already out). With nothing held it's safe
      // to adopt the live value (the next press would adopt it anyway). The harp keeps the live
      // s.transpose: its strings ARE resent per touch, so harp transpose is never frozen.
      if (!heldNotes.size) effChordTranspose = s.transpose;
      s.chordTranspose = effChordTranspose;
      recentHarp.length = 0;
      rebuildLookups();
      relabel();
      paintChord();
    }
    function clear() {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingCand = null;
      dropped.forEach(d => clearTimeout(d.timer)); dropped.clear();
      heldWatch.forEach(w => clearTimeout(w)); heldWatch.clear();
      harp.classList.remove("dm-hit");
      heldNotes.clear(); harpLit.clear(); activeHarp.clear();
      recentHarp.length = 0; effHarpShuf = s.harpShuf; effChromatic = s.chromatic; effChordTranspose = s.transpose;
      curChord = null; curCounts = null; previewSel = null; lastCol = null; lastSharp = false; lastOnNote = null; lastHarpPos = null; lastHarpT = 0; harpDir = 0; freshChord = true;
      harpHeld = null; harpDesync.style.display = "none";   // clear() never relabels, hide the badge explicitly
      clearChordLit();
      resetReadout();
      for (let i = 0; i < 12; i++) segByString[i].classList.remove("lit");
      emitChordOff();   // disconnect/reset releases any chord-shape trigger edge
    }
    function setConnected(connected) {
      connectedState = !!connected;
      caption.textContent = connected
        ? "Play your minichord. The buttons and strings you press light up here."
        : "Not connected. Click a chord button to preview the chord it plays and the notes the harp would sound.";
      if (!connected) clear();
    }

    // RHYTHM-MODE chord identification, the OTHER SIDE OF THE COIN from matchChord. The grid sees a
    // chord all at once; rhythm plays an ARPEGGIO (one note at a time) so the chord is ASSEMBLED bit by
    // bit from the caller's recent-onset buffer. We deliberately do NOT fold devicemap's live
    // heldNotes/dropped in: in rhythm those are the arpeggio's own still-ringing voices and poison the
    // read across a chord change. Recent HARP onsets (folded to pitch-class) still corroborate.
    //   `onsets` = [{p, vs}]: p is the onset pitch, vs is the VOICE indices the step pattern fires at
    //   that onset's step (supplied by the rhythm controller; empty when the phase isn't known yet or a
    //   pot drives the rhythm settings). vs powers the sequence match that disambiguates relative/dim
    //   chords; with vs empty it degrades to pure bare-note coverage (the prior behaviour).
    // Finds (button, type, voicing, Δ): Δ is the live transpose offset vs the dump, a UNIFORM shift, so
    // one Δ models transpose (addr 30); KEY (addr 35) is a non-uniform per-button remap, NOT modelled.
    function identifyChord(onsets, prev) {
      // accept either rich onsets {p, vs} or a bare pitch array (no pattern info → vs null → bare matching)
      onsets = (onsets || []).map(o => (typeof o === "number" ? { p: o, vs: null } : o)).filter(o => o && o.p != null);
      const want = Array.from(new Set(onsets.map(o => o.p)));   // distinct onset pitches (bare coverage)
      const now = Date.now();
      const harpPc = new Set();                                                   // harp pitch-classes
      for (const h of recentHarp) if (now - h.t <= EVID_TTL) harpPc.add(((h.note % 12) + 12) % 12);
      if (!want.length && !harpPc.size) return null;
      // pitch-classes actually heard (onsets + recent harp), feeds the diagnostic-tone gate below
      const pcHeard = new Set(want.map(p => ((p % 12) + 12) % 12));
      for (const pc of harpPc) pcHeard.add(pc);

      // CLOSED-SEARCH (positional) mode. The arpeggio is an "automated harp": the controller tags each
      // onset with the chord VOICE indices (vs) the step pattern fired, but ONLY when the rhythm phase is
      // locked and no pot drives the pattern (else vs is empty). That's exactly when each onset's POSITION
      // in the chord (root/3rd/5th/♭7/…) is trustworthy, like a harp string's known note. When positional
      // we rank by that position (seq) FIRST and skip the anti-flicker stickiness, so the read tracks the
      // actually-fired voices momentarily (a ♭7 onset IS a 7th); with no vs we fall back to fuzzy coverage.
      const positional = onsets.some(o => o.vs && o.vs.length);

      const prevKey = (prev && prev.notes) ? prev.notes.join(",") : null;        // hysteresis on ties
      // burst multiplicity: a step can sound the same pitch on TWO voices at once (a slash voicing
      // whose bass collides with a chord tone: C6/G at voicing 4 doubles G4); the controller tags
      // each onset with how many times its pitch sounded in its burst. A pitch played more times
      // than a chord has voices carrying it is evidence AGAINST that chord, octave-exact or not.
      const countIn = (arr, p) => { let c = 0; for (const n of arr) if (n === p) c++; return c; };
      const burstM = new Map();
      for (const o of onsets) { const m = o.m || 1; if (m > (burstM.get(o.p) || 0)) burstM.set(o.p, m); }

      // dominance anchor: the NEWEST onset the previous chord cannot place (octave-exact, multiset).
      // Not simply the last onset. A step fires its voices as one burst in arbitrary arrival order,
      // so the distinguishing outsider (D7's C against a D6 prev) is rarely the literal last element.
      let trig = null;
      if (prevKey) {
        const ps = new Set(prev.notes);
        for (let i = onsets.length - 1; i >= 0; i--) {
          const o = onsets[i];
          if (!ps.has(o.p) || (o.m || 1) > countIn(prev.notes, o.p)) { trig = o.p; break; }
        }
      }

      // a live transpose Δ is only trusted with real corroboration (a full harp strum); a sparse rhythm
      // alone stays at Δ=0 so it can't hallucinate a shift. (We do NOT consult the chord-port held notes
      // here. In rhythm they're the arpeggio's own still-ringing voices, not a separate grid press, so
      // trusting them as "authority" mis-fixes the chord across changes.)
      const allowShift = harpPc.size >= HARP_MIN;
      const dMin = allowShift ? -DMAX : 0, dMax = allowShift ? DMAX : 0;

      // scan the precomputed bases (button × type × reachable voicing, incl. a pot-driven addr-120
      // voicing, so a pot-shifted arpeggio identifies like the grid), shifting each by Δ on the fly.
      let best = null, bestB = -1, bestType = null, bestOff = 0, bestRow = s.chordShuf, bestScore = null;
      let bestCov = -1, bestExact = -1, bestHc = 0, bestSeq = 0, bestSharp = false;
      let prevRes = null;   // the previous chord's own fit this round, for sticky hysteresis
      let domBest = null;   // lex-best among candidates that PLACE the triggering onset (dominance rival)
      // a slash result's notes are never generated by this loop (it scans PLAIN chords; the slash
      // spelling is added by the refinement below), so a slash prev matches its PLAIN PARENT here.
      // Otherwise stickiness AND dominance both disengage after an X/Y read and the next burst is
      // decided by raw enumeration order (a C6/G prev lost {A,G,C} to D7).
      const prevSlash = !!(prev && prev.slashButton != null);
      for (const cand of rhythmBases) {
        const base = cand.notes, press = cand.press;
        for (let off = dMin; off <= dMax; off++) {
          const notes = off ? base.map(n => n + off) : base;
          // twins are note-identical — Δ-twins (F7 Δ−3 ≡ D7 Δ0) and now SHARP-twins (E#≡F, B#≡C).
          // A bare notes match would let the wrong spelling claim the sticky hold (E then F reading
          // as E#). Anchor the prev identity to its actual button + sharp: keep the natural F unless
          // the sharp was genuinely the previous read. (Slash prev still matches its PLAIN PARENT.)
          const isPrev = (prevKey && notes.join(",") === prevKey
                            && cand.b === prev.button && cand.sharp === !!prev.sharp)
            || (prevSlash && cand.b === prev.button && cand.type === prev.type && off === (prev.transposeOffset || 0) && cand.row === prev.row);

          // diagnostic-tone gate: a COLORED quality (7/maj7/m7/dim/aug/m6) may only be NAMED while its
          // signature tone is actually being heard. Never inferred from a non-diagnostic decoration that
          // merely differs between types (the Cm→Cdim trap). notes[0] is the root voice. No prev-exemption:
          // momentary semantics mean a color whose tone has left the window should DEMOTE (D7→D6), not persist.
          const sig = TYPE_SIG[cand.type];
          if (sig != null && !pcHeard.has((((notes[0] + sig) % 12) + 12) % 12)) continue;
          const set = new Set(notes);
          let exact = 0; for (const p of want) if (set.has(p)) exact++;          // octave-exact onset coverage
          let hc = 0; if (harpPc.size) { const sPc = new Set(notes.map(n => (((n % 12) + 12) % 12))); for (const pc of harpPc) if (sPc.has(pc)) hc++; }
          const cov = exact + hc;

          // sequence match: # onsets that land on a voice the step pattern actually FIRED, i.e. this
          // candidate's note for one of that step's voices equals the onset. Rewards the chord whose
          // voice STRUCTURE fits the pattern (F's root played at the root step beats Dm; Cm's 5th beats
          // Cdim's), resolving relative/dim ambiguities bare coverage ties on. 0 when vs is empty.
          let seq = 0; for (const o of onsets) { const vs = o.vs; if (vs) for (let j = 0; j < vs.length; j++) if (notes[vs[j]] === o.p) { seq++; break; } }

          // rank by the shared lexLess (smaller wins). POSITIONAL (pattern known): position (seq) is
          // authoritative → seq → coverage → octave-exact → presses → |Δ| → prev. FUZZY (no pattern):
          // coverage leads, seq only breaks ties. Negate maximised terms; ties keep first.
          // final term prefers the NATURAL reading on an exact tie, so a real sharp chord (better
          // coverage) still wins but a natural chord that ties its sharp enharmonic (C ≡ B#) keeps
          // the natural name. Mirrors matchChord's `c.sharp ? 1 : 0` tiebreak.
          const score = positional
            ? [-seq, -cov, -exact, press, Math.abs(off), isPrev ? 0 : 1, cand.sharp ? 1 : 0]
            : [-cov, -exact, -seq, press, Math.abs(off), isPrev ? 0 : 1, cand.sharp ? 1 : 0];
          if (!best || lexLess(score, bestScore)) { best = notes; bestScore = score; bestB = cand.b; bestType = cand.type; bestOff = off; bestRow = cand.row; bestCov = cov; bestExact = exact; bestHc = hc; bestSeq = seq; bestSharp = cand.sharp; }

          // dominance rival: lex-best among candidates that PLACE the anchor onset (at its burst
          // multiplicity). Extra last term: on a full tie keep the previous chord's ROOT. Dominance
          // is about COLOR flips (D6↔D7, F6↔Fmaj7); a root change must win on real evidence, not
          // enumeration order (G7 vs F6).
          if (trig != null && set.has(trig) && countIn(notes, trig) >= (burstM.get(trig) || 1)) {
            const dScore = score.concat(prev && cand.b === prev.button ? 0 : 1);
            if (!domBest || lexLess(dScore, domBest.dScore)) domBest = { notes, button: cand.b, type: cand.type, off, row: cand.row, cov, exact, hc, seq, sharp: cand.sharp, dScore };
          }

          // Δ-twins are note-identical (F7 Δ−3 ≡ D7 Δ0), so "last match wins" would hand the sticky
          // hold a far-shifted twin's button/grid cell; keep the prev fit nearest Δ=0 instead
          if (isPrev && (!prevRes || Math.abs(off) < Math.abs(prevRes.off))) prevRes = { notes, button: cand.b, type: cand.type, off, row: cand.row, cov, exact, hc, seq, sharp: cand.sharp };
        }
      }

      // EXPLANATION DOMINANCE (FUZZY, spec: MINICHORD-REFERENCE.md §10.4): the sticky margin may
      // only arbitrate between candidates that both PLACE the evidence. If the previous chord cannot
      // place an onset at all (octave-exact) while some candidate places it plus all-but-≤1 of the
      // distinct onsets, that candidate takes the read NOW, no margin: two chords can differ in
      // exactly ONE exact pitch (D6/D7: B vs C) and a margin would swallow precisely that
      // distinguishing onset. All-but-one (not all) because the rolling
      // onset window straddles a chord change, so the outgoing chord's tone lingers. Judged on
      // octave-exact onsets only; harp pitch-classes aren't octave-exact, so they stay advisory
      // (cov) and never grant or veto a dominance flip. Momentary flips are CORRECT here: they
      // mirror what the pattern is actually playing (same semantics the positional path has).
      const dominated = !positional && trig != null && prevRes && best
        && domBest && domBest.exact >= want.length - 1;
      if (dominated) {
        best = domBest.notes; bestB = domBest.button; bestType = domBest.type; bestOff = domBest.off; bestRow = domBest.row; bestCov = domBest.cov; bestExact = domBest.exact; bestHc = domBest.hc; bestSharp = domBest.sharp;
      }

      // STICKINESS (FUZZY mode only): keep the previous chord unless a rival clearly beats it (by > STICK
      // on coverage, octave-exact, OR pattern-consistency). Stops flicker between near-equivalent chords
      // (D vs Bm). Skipped when POSITIONAL (the fired-voice verdict is authoritative and momentary)
      // and when DOMINATED (above): a chord that can't place the newest onset has no sticky claim on it.
      else if (!positional && prevRes && best && (bestCov - prevRes.cov) <= STICK_MARGIN && (bestExact - prevRes.exact) <= STICK_MARGIN && (bestSeq - prevRes.seq) <= STICK_MARGIN) {
        best = prevRes.notes; bestB = prevRes.button; bestType = prevRes.type; bestOff = prevRes.off; bestRow = prevRes.row; bestExact = prevRes.exact; bestHc = prevRes.hc; bestSharp = prevRes.sharp;
      }

      // accept only a clean fit. The bucket notes must fit (≤1 stray) and we need ≥2 pieces of evidence
      // total. The HARP is a strong source of truth (12 strings ≈ the whole scale), so a sparse rhythm,
      // even a lone root, can be NAMED when a harp strum (or the held chord, now in the bucket)
      // corroborates it; alone, a single note isn't enough to name a chord (the playhead still locks on timing).
      if (want.length) {
        if (bestExact < want.length - 1) return null;
        if (bestExact + bestHc < 2) return null;
        if (bestExact < 2 && bestHc < HARP_MIN) return null;
      } else if (bestCov < HARP_MIN) return null;

      // slash refinement: a slash chord swaps one voice for another column's bass. Adopt the "X/Y"
      // spelling when that bass note is genuinely among the played onsets and improves coverage, OR
      // when it resolves a MULTISET violation at equal coverage: a burst sounding a pitch on more
      // voices than the plain chord carries it (C6/G at voicing 4 doubles G4: the slash bass lands
      // on the 5th; the plain C6 can produce one G4, never two). The plain chord stays plain unless
      // the bass voice is really in the arpeggio (simplest reading).
      let bestSlash = null;
      if (want.length && best) {
        const mviol = arr => { let v = 0; burstM.forEach((m, p) => { v += Math.max(0, m - countIn(arr, p)); }); return v; };
        const baseSet = new Set(best);
        let slashExact = 0; for (const p of want) if (baseSet.has(p)) slashExact++;   // plain chord's onset coverage
        let slashViol = mviol(best);                                                  // occurrences it can't voice
        for (let sb = 0; sb < 7; sb++) {
          if (sb === bestB) continue;
          const sn = voiceSet(bestB, CHORD[bestType], s, { row: bestRow, sharp: bestSharp, slash: { button: sb } }).map(n => n + bestOff);
          const set = new Set(sn);
          let ex = 0; for (const p of want) if (set.has(p)) ex++;
          const v = mviol(sn);
          if (ex > slashExact || (ex === slashExact && v < slashViol)) { slashExact = ex; slashViol = v; bestSlash = sb; best = sn; }
        }
      }
      return { notes: best, button: bestB, type: bestType, transposeOffset: bestOff, slashButton: bestSlash, row: bestRow, sharp: bestSharp };
    }

    // the rhythm controller calls this when its playhead locks/unlocks: while locked the grid shows
    // the fingerprinted chord (slash tint) instead of the live detector's guesses.
    function setRhythmActive(on) {
      on = !!on;
      if (on === rhythmActive) return;
      rhythmActive = on;
      if (on) { scheduleTint(); }
      else { if (tintTimer) { clearTimeout(tintTimer); tintTimer = null; } rhythmChord = null; paintChord(); }
    }

    // tint the chord grid for a (button, type, slash) chord, the bank-hue "slash" highlight shown
    // while rhythm is locked. Repaints only on a real change. Used by BOTH the rhythm controller and
    // the harp (so a strum lights the grid instantly, not on the next rhythm onset).
    function tintGrid(button, type, slashButton) {
      let target = null;
      if (button != null && type != null) {
        if (button < 0 || button > 6) return;
        target = { button, type, slash: slashButton != null ? { button: slashButton } : null };   // canonical chord
      }
      const same = (!target && !rhythmChord) ||
        (target && rhythmChord && rhythmChord.button === target.button && rhythmChord.type === target.type && slashBtn(rhythmChord) === slashBtn(target));
      if (same) return;
      rhythmChord = target;
      if (rhythmActive) scheduleTint();   // debounced: a tint gone within TINT_DEBOUNCE never paints
    }

    // the rhythm controller passes the chord it fingerprinted (button + type + Δ + slash). harp > rhythm:
    // while a harp note is recent the harp owns the readout, tint AND held. The rhythm stands down so
    // it can't change the key out from under a strum. (The harp drives the tint from setHarpLit.)
    function showRhythmChord(button, type, off, slashButton, sharp) {
      sharp = !!sharp;
      if (button == null || type == null) { tintGrid(null); return; }   // keep the last readout shown
      // trace what the rhythm playhead decided and whether we apply it, logged on change so we can see
      // a missed slash / a chord the harp-priority swallows. (harp owns the readout for HARP_PRIORITY_MS
      // after a strum, and owns its root so a strum's reading isn't yanked away.)
      if (dbg()) {
        const blk = (Date.now() - harpReadT) < HARP_PRIORITY_MS ? "harp-owns-all"
          : (harpBtn != null && button === harpBtn && slashButton == null) ? "harp-owns-root" : null;
        const k = button + "/" + type + "/" + slashButton + "/" + blk;
        if (k !== lastRhythmShow) {
          lastRhythmShow = k;
          console.log(`[Play] rhythm → ${BTN_NAMES[button] || "?"}${TYPE_NAME[type] != null ? TYPE_NAME[type] : type}`
            + `${slashButton != null ? "/" + (BTN_NAMES[slashButton] || "?") : ""} Δ${off}`
            + (blk ? ` [NOT applied: ${blk}]` : " [applied → grid+harp]"));
        }
      }
      if ((Date.now() - harpReadT) < HARP_PRIORITY_MS) return;          // harp owns everything right now
      // harp > rhythm: the harp owns its ROOT. The rhythm can't override the harp's reading of the same
      // root (so a harp E6 never auto-switches to a rhythm E7). It only takes over on a DIFFERENT root
      // (a real chord change), OR to ADD a slash the harp can't detect (the bass fits the plain voicing).
      if (harpBtn != null && button === harpBtn && slashButton == null) return;
      if (slashButton == null) harpBtn = null;
      if (rhythmActive) setReadoutChord(button, type, off, slashButton, sharp);
      tintGrid(button, type, slashButton);
      if (rhythmActive) {   // keep the harp strings in tandem with the arpeggio's chord
        held = { button, type, sharp, slash: slashButton != null ? { button: slashButton } : null };
        harpHeld = null;    // a rhythm-applied chord is a fresh full context; any desync is over
        relabelHarp();
        emitChord("inferred");
      }
    }

    setConnected(false);
    relabel();

    // clear() is intentionally not exported; setConnected(false) is the only caller.
    return { el: root, rebuild, onNote, setConnected, identifyChord, setRhythmActive, showRhythmChord, setHarpShape };
  }

  const VERSION = "play-engine-2026-07-01-r60-sharp-enharmonic";
  // boot banner unless diagnostics are silenced; the version is always on window.DeviceMap.version
  try { if (logOn()) console.info("[Play] device-map engine", VERSION); } catch (e) {}

  // ---- one-command log capture (for sharing a debug session) ---------------
  // DeviceMap.startCapture() arms a SILENT [Play] log buffer; reproduce the issue (play harp / rhythm),
  // then DeviceMap.dumpLog() copies the whole session to the clipboard (and returns it) to paste/share.
  function startCapture() {
    capturing = true; playLog.length = 0;
    try { console.info("[Play] capture ON — reproduce the issue, then run DeviceMap.dumpLog()"); } catch (e) {}
    return "capturing";
  }
  function dumpLog() {
    const text = playLog.join("\n");
    try { if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(text); } catch (e) {}
    try { console.info(`[Play] dumped ${playLog.length} captured lines${text ? " — copied to clipboard" : " (none — call DeviceMap.startCapture() first)"}`); } catch (e) {}
    return text;
  }
  window.DeviceMap = { create, version: VERSION, startCapture, dumpLog };
})();

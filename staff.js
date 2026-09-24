/* staff.js: a live grand staff for the Play view.
 *
 * Draws what the minichord is sounding on a two-stave system — chord voices on
 * the bass stave, harp strings on the treble — with the key signature in place
 * and a roman numeral for the held chord.
 *
 * Built once and then only moved: the staves, clefs and key signature are static
 * until the key changes, and note heads come from a fixed pool of <use> elements
 * that are repositioned and shown or hidden. No note event allocates or
 * re-renders anything.
 *
 * Positions are diatonic "steps": letter index (C=0..B=6) plus seven per octave,
 * so C4 is 28. Every staff line and space is one step, which makes placement a
 * subtraction and keeps enharmonics on the right line — F# sits on F, G♭ on G.
 */
(function (window) {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";

  // ---- geometry -----------------------------------------------------------
  const GAP = 9;                 // px between staff lines
  const HALF = GAP / 2;          // one diatonic step
  const TREBLE_TOP = 22;         // y of the treble's top line (F5, step 38)
  const BASS_TOP = 104;          // y of the bass's top line (A3, step 26)
  const TREBLE_TOP_STEP = 38;
  const BASS_TOP_STEP = 26;
  const CLEF_X = 8;              // clefs sit hard left
  const KEYACC_W = 10;           // width of one key-signature accidental: a Bravura sharp, one staff space, and a pixel
  const LEFT = 52;               // fallback content start, before the clefs are measured
  const RIGHT_PAD = 14;
  const WIDTH = 360;
  const HEIGHT = 172;

  const trebleY = step => TREBLE_TOP + (TREBLE_TOP_STEP - step) * HALF;
  const bassY = step => BASS_TOP + (BASS_TOP_STEP - step) * HALF;

  // ---- spelling -----------------------------------------------------------
  // letter index and alteration for each pitch class, sharp-side and flat-side
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];   // natural pitch class of C D E F G A B
  const SHARP_SPELL = [[0,0],[0,1],[1,0],[1,1],[2,0],[3,0],[3,1],[4,0],[4,1],[5,0],[5,1],[6,0]];
  const FLAT_SPELL  = [[0,0],[1,-1],[1,0],[2,-1],[2,0],[3,0],[4,-1],[4,0],[5,-1],[5,0],[6,-1],[6,0]];

  // how each of the 21 key signatures is drawn. Notation has no eight-sharp
  // signature, so the keys past the usual twelve borrow their enharmonic
  // equivalent's: G# major is drawn as Ab, and so on.
  //   [accidental (1 sharp, -1 flat), count, drawn-as label or null]
  const KEY_SIG = [
    [1,0,null],[1,1,null],[1,2,null],[1,3,null],[1,4,null],[1,5,null],
    [-1,1,null],[-1,2,null],[-1,3,null],[-1,4,null],[-1,5,null],[-1,6,null],
    [1,6,null],[1,7,null],
    [-1,4,"A\u266d"],[-1,3,"E\u266d"],[-1,2,"B\u266d"],[-1,1,"F"],[1,0,"C"],
    [1,4,"E"],[-1,7,null],
  ];
  const SHARP_ORDER = [3,0,4,1,5,2,6];   // F C G D A E B, as letter indices
  const FLAT_ORDER  = [6,2,5,1,4,0,3];   // B E A D G C F

  // where each key-signature accidental sits, as a step within its stave
  const SHARP_STEPS_TREBLE = [38,35,39,36,33,37,34];   // F5 C5 G5 D5 A4 E5 B4
  const FLAT_STEPS_TREBLE  = [34,37,33,36,32,35,31];   // B4 E5 A4 D5 G4 C5 F4
  const shift = (arr, by) => arr.map(v => v - by);

  // A flat key spells with flats; everything else uses sharps. Matches how the
  // rest of the app names notes.
  //
  // The sharp/flat modifier deliberately does NOT come into this. The staff
  // draws a key signature, and its noteheads have to agree with it: three
  // sharps in the signature and a G# drawn as A♭ is not notation anyone can
  // read.
  const flatSide = key => (key >= 6 && key <= 11) || key >= 19;

  // pitch classes the key signature already alters, so a note on them needs no
  // accidental of its own
  function keyAltered(key) {
    const [acc, count] = KEY_SIG[key] || KEY_SIG[0];
    const order = acc > 0 ? SHARP_ORDER : FLAT_ORDER;
    const set = new Map();
    for (let i = 0; i < count && i < 7; i++) set.set(order[i], acc);
    return set;
  }

  // `spelled` is {letter, alt} from whoever knows what chord or scale produced
  // this note. The staff's own table is a fallback for notes nobody claims: it
  // can only go by pitch class, so it cannot tell E# from F.
  function place(midi, key, spelled) {
    const pc = ((midi % 12) + 12) % 12;
    const [letter, alt] = spelled
      ? [spelled.letter, spelled.alt]
      : (flatSide(key) ? FLAT_SPELL : SHARP_SPELL)[pc];
    // the octave the LETTER belongs to: the one whose natural letter lies
    // nearest the sounding pitch. B#3 and Cb4 cross the octave boundary, and so
    // do the double and quarter-tone alterations the divided octaves spell:
    // B half-sharp in 31 rounds to B and stays with it, where a rule keyed on
    // the sign of the alteration dropped it an octave.
    const octave = Math.round((midi - LETTER_PC[letter]) / 12) - 1;
    return { step: octave * 7 + letter, alt, heji: spelled ? spelled.heji : null };
  }

  /* ---- accidentals ------------------------------------------------------
   * Drawn in "Sound Lab Accidentals Staff", a subset of Steinberg's Bravura
   * (fonts/accidentals.css), by SMuFL code point. SMuFL fixes the geometry:
   * at a font size of four staff spaces a glyph drawn at a note's height sits
   * exactly on it (36px here, set in soundlab.css with the font), so nothing
   * here is nudged by eye. Alterations count sharps;
   * in 31 a single step is half of one, drawn as a Stein-Zimmermann sign, and a
   * note spelled in Helmholtz-Ellis (the "ratio" spelling) carries its comma
   * signs, the higher primes to the left and the syntonic arrows fused with the
   * accidental.
   */
  const STD = { "-3": "\ue266", "-2.5": "\ue264\ue280", "-2": "\ue264", "-1.5": "\ue281", "-1": "\ue260",
    "-0.5": "\ue280", "0": "\ue261", "0.5": "\ue282", "1": "\ue262", "1.5": "\ue283", "2": "\ue263",
    "2.5": "\ue263\ue282", "3": "\ue265" };
  // advance widths in staff spaces, from Bravura's metadata (the wider of the
  // advance and the bounding box, since a few arrows overhang their advance)
  const ADV = {
    "\ue260": 0.904, "\ue261": 0.672, "\ue262": 0.996, "\ue263": 1.000, "\ue264": 1.652, "\ue265": 2.052,
    "\ue266": 2.400, "\ue280": 0.908, "\ue281": 1.864, "\ue282": 0.716, "\ue283": 1.268, "\ue284": 0.656,
    "\ue285": 1.656, "\ue2c0": 1.676, "\ue2c1": 0.912, "\ue2c2": 0.952, "\ue2c3": 1.072, "\ue2c4": 0.988,
    "\ue2c5": 1.668, "\ue2c6": 0.904, "\ue2c7": 0.676, "\ue2c8": 1.000, "\ue2c9": 0.992, "\ue2ca": 1.676,
    "\ue2cb": 0.912, "\ue2cc": 0.956, "\ue2cd": 1.076, "\ue2ce": 0.988, "\ue2cf": 1.668, "\ue2d0": 0.904,
    "\ue2d1": 0.676, "\ue2d2": 1.000, "\ue2d3": 0.992, "\ue2d4": 1.676, "\ue2d5": 0.912, "\ue2d6": 0.956,
    "\ue2d7": 1.076, "\ue2d8": 0.988, "\ue2d9": 1.668, "\ue2da": 0.904, "\ue2db": 0.676, "\ue2dc": 1.000,
    "\ue2dd": 0.988, "\ue2de": 0.688, "\ue2df": 0.688, "\ue2e0": 0.688, "\ue2e1": 0.688, "\ue2e2": 0.908,
    "\ue2e3": 1.084, "\ue2e4": 0.860, "\ue2e5": 1.080,
  };
  // how far each glyph reaches above and below its note, in staff spaces
  // (Bravura's bounding boxes): what decides whether two can share a column
  const EXTENT = {
    "\ue260": [1.76, -0.70], "\ue261": [1.36, -1.34], "\ue262": [1.40, -1.39], "\ue263": [0.51, -0.50], "\ue264": [1.75, -0.70],
    "\ue265": [1.40, -1.39], "\ue266": [1.76, -0.70], "\ue280": [1.76, -0.70], "\ue281": [1.76, -0.70], "\ue282": [1.23, -1.41],
    "\ue283": [1.48, -1.39], "\ue284": [1.68, -0.78], "\ue285": [1.68, -0.78], "\ue2c0": [1.75, -1.41], "\ue2c1": [1.75, -1.41],
    "\ue2c2": [1.37, -1.68], "\ue2c3": [1.40, -2.06], "\ue2c4": [0.51, -1.29], "\ue2c5": [2.14, -0.73], "\ue2c6": [2.14, -0.73],
    "\ue2c7": [1.70, -1.33], "\ue2c8": [2.04, -1.39], "\ue2c9": [1.32, -0.50], "\ue2ca": [1.75, -1.85], "\ue2cb": [1.75, -1.85],
    "\ue2cc": [1.37, -2.13], "\ue2cd": [1.40, -2.50], "\ue2ce": [0.51, -1.73], "\ue2cf": [2.58, -0.73], "\ue2d0": [2.58, -0.73],
    "\ue2d1": [2.15, -1.33], "\ue2d2": [2.48, -1.39], "\ue2d3": [1.76, -0.50], "\ue2d4": [1.75, -2.29], "\ue2d5": [1.75, -2.29],
    "\ue2d6": [1.37, -2.57], "\ue2d7": [1.40, -2.94], "\ue2d8": [0.51, -2.17], "\ue2d9": [3.02, -0.73], "\ue2da": [3.02, -0.73],
    "\ue2db": [2.58, -1.33], "\ue2dc": [2.92, -1.39], "\ue2dd": [2.21, -0.50], "\ue2de": [1.74, -0.38], "\ue2df": [0.43, -1.68],
    "\ue2e0": [1.60, -1.17], "\ue2e1": [1.19, -1.58], "\ue2e2": [1.75, -0.73], "\ue2e3": [1.37, -1.31], "\ue2e4": [1.74, -0.69],
    "\ue2e5": [1.52, -1.30],
  };
  function accGlyphs(alt, heji) {
    let t = "";
    if (heji) {
      const pair = (n, down, up) => (n < 0 ? down : up).repeat(Math.abs(n));
      if (heji[13]) t += pair(heji[13], "\ue2e4", "\ue2e5");
      if (heji[11]) t += pair(heji[11], "\ue2e2", "\ue2e3");
      if (heji[7]) t += Math.abs(heji[7]) === 2 ? (heji[7] < 0 ? "\ue2e0" : "\ue2e1") : pair(heji[7], "\ue2de", "\ue2df");
      const arrows = heji[5] || 0;
      if (arrows && Math.abs(arrows) <= 3 && Math.abs(alt) <= 2) {
        t += String.fromCharCode(0xE2C0 + (Math.abs(arrows) - 1) * 10 + (arrows > 0 ? 5 : 0) + alt + 2);
      } else if (alt) t += STD[String(alt)] || "";
      else if (!t) t = STD["0"];
    } else {
      t = STD[String(alt)] || (alt > 0 ? STD["1"] : STD["-1"]);
    }
    let w = 0, up = 0, down = 0;
    for (const ch of t) {
      w += ADV[ch] || 1;
      const x = EXTENT[ch] || [1.5, -1.5];
      up = Math.max(up, x[0]); down = Math.min(down, x[1]);
    }
    return { text: t, width: w * GAP, up: up * GAP, down: -down * GAP };
  }

  // ---- roman numerals -----------------------------------------------------
  const TONIC = [0,7,2,9,4,11,5,10,3,8,1,6,6,1,8,3,10,5,0,4,11];
  const DEGREE = { 0:"I", 2:"II", 4:"III", 5:"IV", 7:"V", 9:"VI", 11:"VII" };
  const ALTERED = { 1:"\u266dII", 3:"\u266dIII", 6:"\u266fIV", 8:"\u266dVI", 10:"\u266dVII" };
  const QUALITY = {
    major:[0,""], minor:[1,""], seventh:[0,"7"], maj_seventh:[0,"maj7"],
    min_seventh:[1,"7"], dim:[1,"\u00b0"], aug:[0,"+"], maj_sixth:[0,"6"],
    min_sixth:[1,"6"], full_dim:[1,"\u00b07"], half_dim:[1,"\u00f87"],
    sus_fourth:[0,"sus4"], sus_second:[0,"sus2"], seventh_sus:[0,"7sus4"],
    major_ninth:[0,"maj9"], minor_ninth:[1,"9"], added_ninth:[0,"add9"], six_nine:[0,"6/9"],
  };
  // a chord over a bass note takes figured bass, not a second numeral
  const INVERSION = { 0:"", 4:"6", 3:"6", 7:"64", 10:"43", 11:"43" };

  function roman(rootPc, type, key, bassPc) {
    const semi = (((rootPc - TONIC[key]) % 12) + 12) % 12;
    let num = DEGREE[semi] || ALTERED[semi] || "?";
    const q = QUALITY[type] || QUALITY.major;
    if (q[0]) num = num.replace(/(I|V)+$/, m => m.toLowerCase());
    let out = num + q[1];
    if (bassPc != null && bassPc !== rootPc) {
      const fig = INVERSION[(((bassPc - rootPc) % 12) + 12) % 12];
      out += fig ? fig : "/" + (DEGREE[(((bassPc - TONIC[key]) % 12) + 12) % 12] || "?");
    }
    return out;
  }

  // ---- building -----------------------------------------------------------
  function el(name, attrs) {
    const n = document.createElementNS(SVG, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function create() {
    const root = document.createElement("div");
    root.className = "staff-panel";

    const svg = el("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: "staff-svg" });
    root.appendChild(svg);

    // one note-head definition, instanced by every <use>
    const defs = el("defs");
    const head = el("ellipse", { id: "sl-head", rx: 4.6, ry: 3.4, transform: "rotate(-20)" });
    defs.appendChild(head);
    svg.appendChild(defs);

    const staticLayer = el("g", { class: "staff-static" });
    const noteLayer = el("g", { class: "staff-notes" });
    svg.appendChild(staticLayer);
    svg.appendChild(noteLayer);

    // the ten staff lines and the brace
    for (let i = 0; i < 5; i++) {
      staticLayer.appendChild(el("line", { x1: CLEF_X - 4, x2: WIDTH - RIGHT_PAD, y1: TREBLE_TOP + i * GAP, y2: TREBLE_TOP + i * GAP, class: "staff-line" }));
      staticLayer.appendChild(el("line", { x1: CLEF_X - 4, x2: WIDTH - RIGHT_PAD, y1: BASS_TOP + i * GAP, y2: BASS_TOP + i * GAP, class: "staff-line" }));
    }
    staticLayer.appendChild(el("line", { x1: CLEF_X - 4, x2: CLEF_X - 4, y1: TREBLE_TOP, y2: BASS_TOP + 4 * GAP, class: "staff-brace" }));

    // Clefs come from the musical symbol block, but nothing about where a system
    // font puts them can be relied on: the glyph sits on the text baseline, and
    // its size and proportions vary. So each one is measured once it is on the
    // page and then scaled and shifted to fill a box defined in staff steps.
    // Whatever the font draws, it ends up spanning the right lines.
    //   treble: from a step below the bottom line to one above the top
    //   bass:   from the top line down to the second line from the bottom
    const clefs = [];
    function addClef(glyph, topStep, botStep, onTreble, refStep, boost) {
      const t = el("text", { x: 0, y: 0, class: "staff-clef" });
      t.textContent = glyph;
      staticLayer.appendChild(t);
      const yFn = onTreble ? trebleY : bassY;
      clefs.push({ el: t, top: yFn(topStep), bottom: yFn(botStep), ref: yFn(refStep), boost: boost || 1 });
      return t;
    }
    // The boost is applied about the reference line, so growing a clef keeps it
    // anchored. The bass glyph carries more empty space in its box than the
    // treble does, so fitting the boxes alike leaves it looking small.
    addClef("\uD834\uDD1E", 40, 25, true, 32, 1);      // treble, spiral on G4
    addClef("\uD834\uDD22", 27, 18, false, 24, 1.9);   // bass, dots astride F3

    // Measure and fit. Called once the panel is in the document, since a
    // detached element measures as zero.
    let clefsFitted = false;
    let keyLeft = 30, contentLeft = LEFT;   // recomputed once the clefs are measured
    function fitClefs() {
      let ok = false, right = CLEF_X;
      clefs.forEach(c => {
        let bb;
        try { bb = c.el.getBBox(); } catch (e) { return; }
        if (!bb || !bb.height) return;
        ok = true;
        const target = c.bottom - c.top;
        const base = target / bb.height;
        const k = base * c.boost;
        const tx = CLEF_X - bb.x * k;
        // fit the box, then grow about the reference line so it stays anchored
        const ty0 = c.top - bb.y * base;
        const ty = c.ref - (c.ref - ty0) * c.boost;
        c.el.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
        right = Math.max(right, CLEF_X + bb.width * k);
      });
      if (!ok) return;
      clefsFitted = true;
      // the key signature clears the widest clef
      keyLeft = right + 7;
      layoutForKey();
      drawKeySignature();
      refresh();
    }

    // The notes have to clear the key signature, and the signature's width
    // depends on the key — so this is not a one-off measurement. It was computed
    // only inside fitClefs, which runs at build, so changing from C to a key with
    // accidentals grew the signature rightwards while the notes stayed where no
    // accidentals had put them, and the two overlapped.
    function layoutForKey() {
      const [, count] = KEY_SIG[key] || KEY_SIG[0];
      contentLeft = keyLeft + Math.min(count, 7) * KEYACC_W + 12;
    }

    const keyLayer = el("g", { class: "staff-key" });
    staticLayer.appendChild(keyLayer);

    // note-head pool: seven chord voices and twelve strings is the ceiling
    const POOL = 20;
    const slots = [];
    for (let i = 0; i < POOL; i++) {
      const g = el("g", { class: "staff-note", display: "none" });
      const use = el("use", { href: "#sl-head" });
      use.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#sl-head");
      const acc = el("text", { class: "staff-acc" });
      const l1 = el("line", { class: "staff-ledger", visibility: "hidden" });
      const l2 = el("line", { class: "staff-ledger", visibility: "hidden" });
      const l3 = el("line", { class: "staff-ledger", visibility: "hidden" });
      g.append(l1, l2, l3, use, acc);
      noteLayer.appendChild(g);
      slots.push({ g, use, acc, ledgers: [l1, l2, l3], midi: null, role: null });
    }

    const ottavaT = el("text", { x: WIDTH - RIGHT_PAD - 26, y: TREBLE_TOP - 5, class: "staff-ottava", visibility: "hidden" });
    ottavaT.textContent = "8va";
    const ottavaB = el("text", { x: WIDTH - RIGHT_PAD - 26, y: BASS_TOP + 4 * GAP + 13, class: "staff-ottava", visibility: "hidden" });
    ottavaB.textContent = "8vb";
    staticLayer.append(ottavaT, ottavaB);

    const analysis = document.createElement("p");
    analysis.className = "staff-analysis";
    root.appendChild(analysis);

    const legend = document.createElement("div");
    legend.className = "staff-legend";
    legend.innerHTML = '<span class="k-chord">● <b>chord</b></span><span class="k-harp">● <b>harp</b></span>'
      + '<span class="k-rhythm">● <b>rhythm</b></span>';
    root.appendChild(legend);

    let key = 0;
    let speller = () => null;      // replaced by setSpeller once devicemap exists
    const sounding = { chord: new Map(), harp: new Map() };
    // Notes from the device's own rhythm engine arrive on the chord port and are
    // indistinguishable from played ones, so the app has to say which they are.
    // They stack and spell exactly like a chord; only the colour differs.
    let chordIsRhythm = false;

    function drawKeySignature() {
      while (keyLayer.firstChild) keyLayer.removeChild(keyLayer.firstChild);
      const [acc, count, drawnAs] = KEY_SIG[key] || KEY_SIG[0];
      const order = acc > 0 ? SHARP_STEPS_TREBLE : FLAT_STEPS_TREBLE;
      const glyph = acc > 0 ? STD["1"] : STD["-1"];
      for (let i = 0; i < count && i < 7; i++) {
        const t = el("text", { x: keyLeft + i * KEYACC_W, y: trebleY(order[i]), class: "staff-keyacc" });
        t.textContent = glyph;
        keyLayer.appendChild(t);
        // the same accidentals sit two octaves lower on the bass stave
        const b = el("text", { x: keyLeft + i * KEYACC_W, y: bassY(order[i] - 14), class: "staff-keyacc" });
        b.textContent = glyph;
        keyLayer.appendChild(b);
      }
      root.dataset.drawnAs = drawnAs || "";
    }

    // A chord sounds as one event, so its voices stack on a single x like a real
    // chord. The harp is strummed one string at a time, so those spread across.
    const chordX = () => contentLeft + 30;   // leaves room for three accidental columns
    function harpX(index, total) {
      const from = contentLeft + 74, to = WIDTH - RIGHT_PAD - 16;
      if (total <= 1) return (from + to) / 2;
      return from + (to - from) * (index / (total - 1));
    }

    // Two notes a step apart cannot share a column; notation nudges the upper one
    // right by a head width. Returns the x offset for each note of a stack.
    function seconds(steps) {
      const off = new Array(steps.length).fill(0);
      for (let i = 1; i < steps.length; i++) {
        if (steps[i] - steps[i - 1] === 1 && off[i - 1] === 0) off[i] = 9.2;
      }
      return off;
    }

    // Which stave a note belongs on, and whether it needs an octave sign. This
    // is decided by pitch, not by whether it came from the chord or the harp:
    // the minichord's chord voices sit above middle C, so putting them on the
    // bass stave by role would leave every one of them on ledger lines.
    //   treble comfortably holds steps 28-42 (C4 to C6)
    //   bass   comfortably holds steps 14-28 (C2 to C4)
    // Beyond that the note is drawn an octave in and marked 8va or 8vb.
    function assign(step) {
      if (step >= 43) return { treble: true, shift: -7, mark: "8va" };
      if (step >= 28) return { treble: true, shift: 0, mark: null };
      if (step >= 13) return { treble: false, shift: 0, mark: null };
      return { treble: false, shift: 7, mark: "8vb" };
    }

    function refresh() {
      const altered = keyAltered(key);
      const chord = [...sounding.chord.keys()].sort((a, b) => a - b);
      const harp = [...sounding.harp.keys()].sort((a, b) => a - b);
      let slot = 0;
      const marks = new Set();

      const draw = (list, role) => {
        const placed = list.map(m => place(m, key, speller(role, m)));
        // a chord sounds at once, so its voices share a column and any second is
        // nudged; the harp is strummed, so its notes spread across instead
        const isChord = role === "chord";
        const nudge = isChord ? seconds(placed.map(p => p.step)) : placed.map(() => 0);
        // Accidentals sit in their own column to the LEFT of the whole stack, so a
        // note nudged right by a second cannot cover the one belonging to the note
        // below it. Two share a column only if their glyphs clear each other
        // vertically, measured from the font's own bounding boxes: a flat reaches
        // almost two spaces above its note and a quarter-tone flat just as far,
        // so a stack of thirds needs a column each. Highest note first, as
        // engraving does.
        const accAt = placed.map(p => {
          const a = assign(p.step);
          const drawStep = p.step + a.shift;
          const need = !!p.heji || p.alt !== (altered.get(((drawStep % 7) + 7) % 7) || 0);
          return { drawStep, treble: a.treble, need, glyph: need ? accGlyphs(p.alt, p.heji) : null };
        });
        const accCol = new Array(placed.length).fill(0);
        const colW = [];   // each column's widest glyph, so the next sits clear of it
        if (isChord) {
          const cols = [];
          accAt.map((v, i) => i).filter(i => accAt[i].need)
            .sort((a, b) => accAt[b].drawStep - accAt[a].drawStep)
            .forEach(i => {
              // vertical extent in px, on the note's own stave (steps are HALF apart)
              const span = v => ({ top: -v.drawStep * HALF - v.glyph.up, bottom: -v.drawStep * HALF + v.glyph.down });
              const me = span(accAt[i]);
              let c = 0;
              while ((cols[c] || []).some(o => {
                if (o.treble !== accAt[i].treble) return false;
                const them = span(o);
                return me.top < them.bottom + 1 && them.top < me.bottom + 1;
              })) c++;
              (cols[c] = cols[c] || []).push(accAt[i]);
              accCol[i] = c;
              colW[c] = Math.max(colW[c] || 0, accAt[i].glyph.width);
            });
        }
        // the right edge of column c: clear of the notehead, then of every
        // column to its right
        const ACC_GAP = 2;
        const colRight = (c, x) => { let r = x - 7; for (let k = 0; k < c; k++) r -= (colW[k] || 0) + ACC_GAP; return r; };
        // chordX leaves 30px for accidentals; a wide stack of them (three columns
        // of three-quarter flats, or HEJI's compound signs) moves the chord right
        // rather than into the key signature
        const accReach = 7 + colW.reduce((sum, w) => sum + (w || 0) + ACC_GAP, 0);
        const cX = isChord ? chordX() + Math.max(0, accReach - 28) : 0;
        list.forEach((midi, i) => {
          if (slot >= POOL) return;
          const sl = slots[slot++];
          const { step } = placed[i];
          const a = assign(step);
          const drawStep = step + a.shift;
          if (a.mark) marks.add(a.mark + (a.treble ? "-t" : "-b"));
          const y = a.treble ? trebleY(drawStep) : bassY(drawStep);
          const x = (isChord ? cX : harpX(i, list.length)) + nudge[i];

          sl.use.setAttribute("x", x);
          sl.use.setAttribute("y", y);
          sl.g.setAttribute("class", "staff-note "
            + (isChord ? (chordIsRhythm ? "is-rhythm" : "is-chord") : "is-harp"));
          sl.g.setAttribute("display", "");

          const acc = accAt[i];
          if (acc.need) {
            sl.acc.textContent = acc.glyph.text;
            sl.acc.setAttribute("x", colRight(accCol[i], isChord ? cX : x) - acc.glyph.width);
            sl.acc.setAttribute("y", y);
            sl.acc.setAttribute("visibility", "visible");
          } else {
            sl.acc.setAttribute("visibility", "hidden");
          }

          const topStep = a.treble ? TREBLE_TOP_STEP : BASS_TOP_STEP;
          const botStep = topStep - 8;
          let n = 0;
          for (let ls = botStep - 2; ls >= drawStep && n < 3; ls -= 2) {
            const l = sl.ledgers[n++];
            const ly = a.treble ? trebleY(ls) : bassY(ls);
            l.setAttribute("x1", x - 8); l.setAttribute("x2", x + 8);
            l.setAttribute("y1", ly); l.setAttribute("y2", ly);
            l.setAttribute("visibility", "visible");
          }
          for (let ls = topStep + 2; ls <= drawStep && n < 3; ls += 2) {
            const l = sl.ledgers[n++];
            const ly = a.treble ? trebleY(ls) : bassY(ls);
            l.setAttribute("x1", x - 8); l.setAttribute("x2", x + 8);
            l.setAttribute("y1", ly); l.setAttribute("y2", ly);
            l.setAttribute("visibility", "visible");
          }
          for (let k = n; k < 3; k++) sl.ledgers[k].setAttribute("visibility", "hidden");
        });
      };

      draw(chord, "chord");
      draw(harp, "harp");
      for (let i = slot; i < POOL; i++) slots[i].g.setAttribute("display", "none");

      ottavaT.setAttribute("visibility", marks.has("8va-t") ? "visible" : "hidden");
      ottavaB.setAttribute("visibility", marks.has("8vb-b") ? "visible" : "hidden");
    }

    return {
      el: root,
      // whoever knows what is being played supplies (role, midi) -> {letter, alt}
      setSpeller(fn) { speller = typeof fn === "function" ? fn : (() => null); },
      // re-place the notes already sounding, for when the spelling has caught up
      reflow() { refresh(); },
      // the chord port is carrying the device's rhythm engine rather than
      // something being played. Safe to call on every reconcile: unchanged is free.
      setRhythm(on) {
        on = !!on;
        if (on === chordIsRhythm) return;
        chordIsRhythm = on;
        refresh();
      },
      // call once the panel is in the document so the clefs can be measured
      fit() { fitClefs(); if (!clefsFitted) requestAnimationFrame(fitClefs); },
      setKey(k) {
        const kk = Math.max(0, Math.min(20, k | 0));
        if (kk === key) return;
        key = kk;
        layoutForKey();       // a wider signature pushes the notes right
        drawKeySignature();
        refresh();
      },
      noteOn(role, midi) {
        const bag = role === "harp" ? sounding.harp : sounding.chord;
        bag.set(midi, (bag.get(midi) || 0) + 1);
        refresh();
      },
      noteOff(role, midi) {
        const bag = role === "harp" ? sounding.harp : sounding.chord;
        const n = (bag.get(midi) || 0) - 1;
        if (n > 0) bag.set(midi, n); else bag.delete(midi);
        refresh();
      },
      clear() { sounding.chord.clear(); sounding.harp.clear(); refresh(); },
      // the held chord, as devicemap identified it
      setChord(held) {
        if (!held) { analysis.textContent = ""; return; }
        const rootPc = ((held.rootPc % 12) + 12) % 12;
        const bassPc = held.bassPc == null ? null : (((held.bassPc % 12) + 12) % 12);
        analysis.textContent = roman(rootPc, held.type, key, bassPc);
      },
      _internals: { place, roman, keyAltered, KEY_SIG },
    };
  }

  window.Staff = { create };
})(window);

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
  const KEYACC_W = 7;            // width of one key-signature accidental
  const LEFT = 52;               // fallback content start, before the clefs are measured
  const RIGHT_PAD = 14;
  const WIDTH = 360;
  const HEIGHT = 172;

  const trebleY = step => TREBLE_TOP + (TREBLE_TOP_STEP - step) * HALF;
  const bassY = step => BASS_TOP + (BASS_TOP_STEP - step) * HALF;

  // ---- spelling -----------------------------------------------------------
  // letter index and alteration for each pitch class, sharp-side and flat-side
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

  function place(midi, key) {
    const pc = ((midi % 12) + 12) % 12;
    const [letter, alt] = (flatSide(key) ? FLAT_SPELL : SHARP_SPELL)[pc];
    // the octave the LETTER belongs to: B#3 and Cb4 cross the boundary
    let octave = Math.floor(midi / 12) - 1;
    if (alt > 0 && letter === 6) octave -= 1;        // B# belongs with the B below
    if (alt < 0 && letter === 0) octave += 1;        // Cb with the C above
    return { step: octave * 7 + letter, alt };
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
    legend.innerHTML = '<span class="k-chord">● <b>chord</b></span><span class="k-harp">● <b>harp</b></span>';
    root.appendChild(legend);

    let key = 0;
    const sounding = { chord: new Map(), harp: new Map() };

    function drawKeySignature() {
      while (keyLayer.firstChild) keyLayer.removeChild(keyLayer.firstChild);
      const [acc, count, drawnAs] = KEY_SIG[key] || KEY_SIG[0];
      const order = acc > 0 ? SHARP_STEPS_TREBLE : FLAT_STEPS_TREBLE;
      const glyph = acc > 0 ? "\u266f" : "\u266d";
      for (let i = 0; i < count && i < 7; i++) {
        const t = el("text", { x: keyLeft + i * KEYACC_W, y: trebleY(order[i]) + 3.4, class: "staff-keyacc" });
        t.textContent = glyph;
        keyLayer.appendChild(t);
        // the same accidentals sit two octaves lower on the bass stave
        const b = el("text", { x: keyLeft + i * KEYACC_W, y: bassY(order[i] - 14) + 3.4, class: "staff-keyacc" });
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
        const placed = list.map(m => place(m, key));
        // a chord sounds at once, so its voices share a column and any second is
        // nudged; the harp is strummed, so its notes spread across instead
        const isChord = role === "chord";
        const nudge = isChord ? seconds(placed.map(p => p.step)) : placed.map(() => 0);
        // Accidentals sit in their own column to the LEFT of the whole stack, so a
        // note nudged right by a second cannot cover the one belonging to the note
        // below it. Two accidentals a diatonic step apart cannot share a column
        // either — 4.5px of separation against a 12px glyph — so each collision
        // steps one column further left, highest note first, as engraving does.
        const accAt = placed.map(p => {
          const a = assign(p.step);
          const drawStep = p.step + a.shift;
          return { drawStep, treble: a.treble,
                   need: p.alt !== (altered.get(((drawStep % 7) + 7) % 7) || 0) };
        });
        const accCol = new Array(placed.length).fill(0);
        if (isChord) {
          const cols = [];
          accAt.map((v, i) => i).filter(i => accAt[i].need)
            .sort((a, b) => accAt[b].drawStep - accAt[a].drawStep)
            .forEach(i => {
              let c = 0;
              while ((cols[c] || []).some(o => o.treble === accAt[i].treble
                     && Math.abs(o.drawStep - accAt[i].drawStep) < 2)) c++;
              (cols[c] = cols[c] || []).push(accAt[i]);
              accCol[i] = c;
            });
        }
        list.forEach((midi, i) => {
          if (slot >= POOL) return;
          const sl = slots[slot++];
          const { step, alt } = placed[i];
          const a = assign(step);
          const drawStep = step + a.shift;
          if (a.mark) marks.add(a.mark + (a.treble ? "-t" : "-b"));
          const y = a.treble ? trebleY(drawStep) : bassY(drawStep);
          const x = (isChord ? chordX() : harpX(i, list.length)) + nudge[i];

          sl.use.setAttribute("x", x);
          sl.use.setAttribute("y", y);
          sl.g.setAttribute("class", "staff-note " + (isChord ? "is-chord" : "is-harp"));
          sl.g.setAttribute("display", "");

          const letter = ((drawStep % 7) + 7) % 7;
          const fromKey = altered.get(letter) || 0;
          if (alt !== fromKey) {
            sl.acc.textContent = alt === 0 ? "\u266e" : (alt > 0 ? "\u266f" : "\u266d");
            sl.acc.setAttribute("x", (isChord ? chordX() : x) - 13 - accCol[i] * 8);
            sl.acc.setAttribute("y", y + 3.6);
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

/* ============================================================================
 * profiler.js: minichord Sound Lab rule-based "Sound Profiler"
 *
 * Pure, deterministic functions over a patch ({ addr: value }). No audio, no
 * device. Produces plain-language tags, 0–100 feel-meters, and prose that names
 * the responsible parameters, so the read-out teaches the mapping.
 *
 *   SoundProfiler.overall(patch)        -> { tags, dimensions, summary }
 *   SoundProfiler.component(id, patch)  -> { tags, text }
 *
 * All thresholds/weights live in this file so they're easy to tune. Tuning
 * them is part of the learning.
 * ========================================================================== */

(function () {
  "use strict";

  const P = (patch, addr, d) => (patch && patch[addr] != null ? patch[addr] : d);
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const lin = (v, min, max) => clamp01((v - min) / (max - min));
  const rlin = (v, hi, lo) => clamp01((hi - v) / (hi - lo)); // 1 when v low, 0 when v high
  const bell = (v, c, w) => clamp01(1 - Math.abs(v - c) / w); // 1 at centre, 0 at +/-w
  // log-ish normalization for time/frequency params (fine at the low end)
  const logNorm = (v, min, max) => {
    const lo = Math.log(min + 1), hi = Math.log(max + 1);
    return clamp01((Math.log(Math.max(0, v) + 1) - lo) / (hi - lo));
  };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const uniq = a => a.filter((x, i) => a.indexOf(x) === i);
  const joinList = a =>
    a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

  // harmonic brightness of each waveform (0 dark .. 1 bright), device order
  const WAVE_BRIGHT = [0.05, 0.95, 0.6, 0.2, 0.8, 0.7, 0.95, 0.85, 0.35, 0.9, 0.9, 0.55];
  // timbral character of each waveform, device order
  const WAVE_CHAR = ["pure", "buzzy", "hollow", "round", "digital", "nasal",
    "buzzy", "crunchy", "edgy", "crisp", "crisp", "reedy"];
  const waveName = i => (window.WAVEFORMS && window.WAVEFORMS[i] ? window.WAVEFORMS[i].label : "tone");

  function describeCutoff(fc) {
    if (fc < 150) return "very dark";
    if (fc < 400) return "dark, mellow";
    if (fc < 800) return "warm";
    if (fc < 1400) return "open";
    return "bright";
  }

  // shared (global) reverb + pan addresses: both voices pass through these
  const SPACE = { size: 24, hiDamp: 25, lowpass: 27, diff: 28, pan: 29 };

  // per-voice address maps, so the same evaluation runs on harp and chord
  const HARP_V = {
    osc: "single", wave: 42, ampAddr: 41, lvlAddr: 97,
    env: { att: 43, hold: 44, dec: 45, sus: 46, rel: 47 },
    filt: { cutoff: 49, res: 51, sens: 58, fAtt: 52, fDec: 54 },
    trem: { rate: 60, depth: 61 }, vib: { rate: 63, amp: 64 },
    out: { lfoRate: 94, lfoAmp: 95, sens: 96 },
    delayMix: 84, crunch: 86, noise: null, octave: 99, strum: 40, chroma: 98, revSend: 85,
  };
  const CHORD_V = {
    osc: "stack", amps: [121, 124, 127], waves: [122, 125, 128], noise: 130, lvlAddr: 197,
    env: { att: 137, hold: 138, dec: 139, sus: 140, rel: 141 },
    filt: { cutoff: 143, res: 145, sens: 155, fAtt: 146, fDec: 148 },
    trem: { rate: 157, depth: 159 }, vib: { rate: 161, amp: 163 },
    out: null,   // the chord output filter has no LFO
    delayMix: 183, crunch: 185, octave: 198, revSend: 184,
  };

  // The five feel dimensions (0..100) for ONE voice, reading its address map.
  // Reverb/pan (space) is shared. Returns the meters plus the few raw values the
  // tags and summary read.
  function voiceDims(patch, V) {
    const f = V.filt;
    const cutoff = P(patch, f.cutoff, 500), res = P(patch, f.res, 0.7), sens = P(patch, f.sens, 0);
    const fAtt = P(patch, f.fAtt, 3), fDec = P(patch, f.fDec, 90);
    const att = P(patch, V.env.att, 8), dec = P(patch, V.env.dec, 12), rel = P(patch, V.env.rel, 1000),
      hold = P(patch, V.env.hold, 8), sus = P(patch, V.env.sus, 0.5);
    const size = P(patch, SPACE.size, 0.5), hiDamp = P(patch, SPACE.hiDamp, 0),
      lowpass = P(patch, SPACE.lowpass, 0.3), diff = P(patch, SPACE.diff, 0.3), pan = P(patch, SPACE.pan, 0.75);

    // waveB = harmonic brightness; waveChar = the dominant oscillator's timbre word
    let waveB, waveChar;
    if (V.osc === "stack") {
      let aw = 0, asum = 0, bestE = -1, domWv = 0;
      V.amps.forEach((aAddr, i) => {
        const a = P(patch, aAddr, 0), wv = Math.round(P(patch, V.waves[i], 0));
        const wb = WAVE_BRIGHT[wv] != null ? WAVE_BRIGHT[wv] : 0.4;
        aw += a * wb; asum += a;
        // character follows harmonic energy, not raw level: a brighter osc colors
        // the timbre more, so a buzzy layer isn't masked by a louder dark one
        const e = a * (0.15 + wb);
        if (a > 0.02 && e > bestE) { bestE = e; domWv = wv; }
      });
      const noise = V.noise ? P(patch, V.noise, 0) : 0;
      waveB = (asum + noise) > 0 ? (aw + noise * 0.85) / (asum + noise) : 0.4;
      waveChar = WAVE_CHAR[domWv] || "tone";
    } else {
      const wv = Math.round(P(patch, V.wave, 0));
      waveB = WAVE_BRIGHT[wv] != null ? WAVE_BRIGHT[wv] : 0.4;
      waveChar = WAVE_CHAR[wv] || "tone";
    }
    const noiseAmt = V.noise != null ? P(patch, V.noise, 0) : 0;

    const trRate = P(patch, V.trem.rate, 0), trDepth = P(patch, V.trem.depth, 0);
    const vibRate = P(patch, V.vib.rate, 0), vibAmp = P(patch, V.vib.amp, 0);
    const hasLfo = V.out && V.out.lfoRate != null;
    const ofLfoRate = hasLfo ? P(patch, V.out.lfoRate, 0) : 0;
    const ofLfoAmp = hasLfo ? P(patch, V.out.lfoAmp, 0) : 0;
    const ofSens = hasLfo ? P(patch, V.out.sens, 0) : 0;

    const cutoffN = logNorm(cutoff, 20, 2000);
    const resN = lin(res, 0.7, 5), sensN = lin(sens, 0, 5);
    const attN = logNorm(att, 0, 5000), decN = logNorm(dec, 0, 5000), relN = logNorm(rel, 0, 5000);
    const fAttN = logNorm(fAtt, 0, 5000), fDecN = logNorm(fDec, 0, 5000);
    const darkening = hiDamp * 0.5 + lowpass * 0.5;
    const filterSnap = sensN * (1 - fAttN);
    const tremN = trRate > 0.05 ? clamp01(trDepth) * clamp01(0.45 + trRate / 12) : 0;
    const vibN = vibRate > 0.05 ? clamp01(vibAmp) * clamp01(0.45 + vibRate / 12) : 0;
    const ofLfoN = ofLfoRate > 0.05 ? clamp01(ofLfoAmp) * lin(ofSens, 0, 3) * clamp01(0.45 + ofLfoRate / 12) : 0;

    // register shifts the mood: a higher octave reads brighter, a lower one darker
    const oct = V.octave != null ? Math.round(P(patch, V.octave, 2)) : 2;
    const brightness = clamp01(0.50 * cutoffN + 0.28 * waveB + 0.12 * filterSnap + 0.06 * resN - 0.14 * darkening + 0.04 + (oct - 2) * 0.07);
    const punch = clamp01(0.60 * (1 - attN) + 0.22 * (1 - decN) + 0.18 * filterSnap);
    const length = clamp01(0.50 * sus + 0.42 * relN + 0.08 * logNorm(hold, 0, 5000));
    const space = clamp01(0.55 * size + 0.25 * diff + 0.20 * (1 - pan));
    const filterMove = sensN * (0.7 + 0.3 * (1 - fDecN));
    const movement = clamp01(1 - (1 - filterMove) * (1 - tremN) * (1 - vibN) * (1 - ofLfoN));

    return {
      brightness: Math.round(brightness * 100), punch: Math.round(punch * 100),
      length: Math.round(length * 100), space: Math.round(space * 100), movement: Math.round(movement * 100),
      r: { cutoff, res, sus, hiDamp, att, dec, rel, hold },
      // normalized intermediates the material/vibe axes read (no extra patch reads)
      sig: {
        waveB, cutoffN, resN, sensN, darkening, tremN, vibN, ofLfoN, filterMove, oct,
        waveChar, noise: noiseAmt,
      },
    };
  }

  // How much a voice contributes to the heard sound (level × oscillator amount),
  // so a muted voice doesn't color the combined flavor.
  function presence(patch, V) {
    const lvl = clamp01(P(patch, V.lvlAddr, 1.5) / 1.5);
    const amp = V.osc === "stack"
      ? clamp01(P(patch, V.amps[0], 0) + P(patch, V.amps[1], 0) + P(patch, V.amps[2], 0) + 0.5 * P(patch, V.noise, 0))
      : clamp01(P(patch, V.ampAddr, 0.15));
    return amp * lvl;
  }

  // Extra descriptive tags from a voice's effects/modulation/register. These
  // refine the flavor so otherwise-identical patches read distinctly. Ordered by
  // salience so the strongest becomes the name's qualifier.
  function featureTags(patch, V) {
    const t = [];
    // how wet the voice actually is = reverb size × its reverb send
    const wet = P(patch, SPACE.size, 0) * (V.revSend != null ? P(patch, V.revSend, 0) : 0);
    if (wet >= 0.32) t.push("spacious");
    else if (wet <= 0.04 && V.revSend != null) t.push("dry");
    const trem = P(patch, V.trem.rate, 0) > 0.05 ? P(patch, V.trem.depth, 0) : 0;
    const vib = P(patch, V.vib.rate, 0) > 0.05 ? P(patch, V.vib.amp, 0) : 0;
    if (V.crunch != null && P(patch, V.crunch, 0) > 0.15) t.push("gritty");
    if (V.delayMix != null && P(patch, V.delayMix, 0) > 0.12) t.push("echoing");
    if (trem > 0.15) t.push("pulsing");
    if (vib > 0.10) t.push("wavering");
    if (V.noise != null && P(patch, V.noise, 0) > 0.15) t.push("breathy");
    if (V.octave != null && Math.round(P(patch, V.octave, 2)) <= 1) t.push("deep");
    // note-layout facts (lush sixths, chromatic run) are timbre-neutral, so they
    // live only in the harp_general per-component read-out, not the main profile.
    return t;
  }

  // Full harp read: keeps every raw value the per-component read-outs use. The
  // five meters are delegated to voiceDims so harp/chord stay consistent.
  function dims(patch) {
    const r = {
      wave: Math.round(P(patch, 42, 0)), amp: P(patch, 41, 0.15),
      att: P(patch, 43, 8), hold: P(patch, 44, 8), dec: P(patch, 45, 12),
      sus: P(patch, 46, 0.5), rel: P(patch, 47, 1000),
      cutoff: P(patch, 49, 500), keytrack: P(patch, 50, 0.4), res: P(patch, 51, 0.7),
      sens: P(patch, 58, 0), fAtt: P(patch, 52, 3), fDec: P(patch, 54, 90),
      size: P(patch, 24, 0.5), hiDamp: P(patch, 25, 0), lowpass: P(patch, 27, 0.3),
      diff: P(patch, 28, 0.3), pan: P(patch, 29, 0.75),
      tAmt: P(patch, 101, 0.1), tWave: Math.round(P(patch, 100, 0)),
      tAtt: P(patch, 102, 10), tHold: P(patch, 103, 10), tDec: P(patch, 104, 40), tLvl: Math.round(P(patch, 105, 0)),
      trWave: Math.round(P(patch, 59, 0)), trRate: P(patch, 60, 0), trDepth: P(patch, 61, 0),
      vibRate: P(patch, 63, 0), vibAmp: P(patch, 64, 0), vibAtt: P(patch, 65, 1), vibBend: P(patch, 71, 1), vibInt: P(patch, 76, 0.15),
      delMix: P(patch, 84, 0), delTime: P(patch, 77, 0), crunch: P(patch, 86, 0), revSend: P(patch, 85, 0.05),
      ofFreq: P(patch, 88, 1400), ofRes: P(patch, 89, 2), ofLp: P(patch, 90, 0.25), ofBp: P(patch, 91, 0.75), ofHp: P(patch, 92, 0.3),
      ofLfoRate: P(patch, 94, 0), ofLfoAmp: P(patch, 95, 0), ofSens: P(patch, 96, 0),
      octave: Math.round(P(patch, 99, 2)), strum: Math.round(P(patch, 40, 0)), chroma: Math.round(P(patch, 98, 0)),
    };
    const vd = voiceDims(patch, HARP_V);
    return { brightness: vd.brightness, punch: vd.punch, length: vd.length, space: vd.space, movement: vd.movement, r };
  }

  // ---- tags ----------------------------------------------------------------
  // Every candidate tag has an independent 0..1 score; all tags scoring >=
  // TAG_THRESHOLD are applied, strongest first. A few "implies" suppressions
  // drop a weaker tag when a more specific one is present.
  const TAG_THRESHOLD = 0.5;
  const TAG_MAX = 5;

  function tagScores(d) {
    const r = d.r, B = d.brightness, Pn = d.punch, L = d.length, S = d.space, M = d.movement;
    return {
      bright: lin(B, 58, 85),
      dark: rlin(B, 42, 12),
      mellow: bell(B, 40, 14),
      lofi: Math.min(clamp01((520 - r.cutoff) / 300), clamp01((r.hiDamp - 0.35) / 0.35)),
      plucky: lin(Pn, 45, 72),
      soft: rlin(Pn, 38, 8),
      percussive: Math.min(lin(Pn, 40, 75), clamp01((0.12 - r.sus) / 0.12)),
      sustained: Math.min(lin(L, 55, 85), lin(r.sus, 0.55, 0.82)),
      short: rlin(L, 32, 6),
      spacious: lin(S, 44, 72),
      dry: rlin(S, 20, 2),
      evolving: lin(M, 32, 66),
      resonant: lin(r.res, 2.2, 4.2),
    };
  }

  function tagsFor(d) {
    const scores = tagScores(d);
    let tags = Object.keys(scores)
      .filter(t => scores[t] >= TAG_THRESHOLD)
      .sort((a, b) => scores[b] - scores[a]);
    // suppress redundant weaker partners: a stronger tag already implies them
    if (tags.includes("lofi")) tags = tags.filter(t => t !== "dark");
    if (tags.includes("percussive")) tags = tags.filter(t => t !== "plucky");
    return tags.slice(0, TAG_MAX);
  }

  // merge dimension tags with feature tags, then drop "dry" when the voice is
  // actually wet from delay/chorus (echoing/wavering). "dry" only measures
  // reverb, and a watery, un-reverbed sound must not be labelled dry.
  function mergeTags(dimTags, extra) {
    let tags = uniq(dimTags.concat(extra || []));
    if (tags.indexOf("echoing") >= 0 || tags.indexOf("wavering") >= 0) tags = tags.filter(t => t !== "dry");
    return tags.slice(0, TAG_MAX + 2);
  }

  // ---- read-out builder (shared by overall + per-voice) --------------------
  function mkProfile(d, opts) {
    opts = opts || {};
    const r = d.r;
    const tags = mergeTags(tagsFor(d), opts.extraTags);
    const lead = tags.length ? cap(tags.slice(0, 2).join(" and ")) : "Balanced and neutral";

    const facts = [];
    if (d.punch >= 58) facts.push(`a fast ${Math.round(r.att)} ms attack`);
    else if (d.punch <= 30) facts.push(`a slow ${Math.round(r.att)} ms swell`);
    facts.push(`a ${describeCutoff(r.cutoff)} ${Math.round(r.cutoff)} Hz cutoff`);
    if (d.length >= 60) facts.push(`a long ${Math.round(r.rel)} ms tail`);
    else if (d.length <= 30) facts.push("a short tail");
    if (r.res >= 2.8) facts.push("a resonant filter peak");
    if (d.space >= 58) facts.push("a large reverb");
    if (d.movement >= 40) facts.push("an evolving filter sweep");

    const voice = opts.voice ? `, ${opts.voice}` : "";
    const summary = `${lead}${voice}. Driven by ${joinList(facts)}.`;

    return {
      tags, summary,
      dimensions: [
        { label: "Brightness", value: d.brightness },
        { label: "Punch", value: d.punch },
        { label: "Length", value: d.length },
        { label: "Space", value: d.space },
        { label: "Movement", value: d.movement },
      ],
    };
  }

  // ---- overall read-out: harp + chord blended by their presence ------------
  function overall(patch) {
    const dh = voiceDims(patch, HARP_V), dc = voiceDims(patch, CHORD_V);
    const ph = presence(patch, HARP_V), pc = presence(patch, CHORD_V);
    const wsum = ph + pc;
    const wh = wsum > 0 ? ph / wsum : 0.5, wc = wsum > 0 ? pc / wsum : 0.5;
    const mix = (a, b) => wh * a + wc * b;
    const louder = wh >= wc ? dh : dc;   // the louder voice sets the categorical signals
    const sh = dh.sig, sc = dc.sig;
    const d = {
      brightness: Math.round(mix(dh.brightness, dc.brightness)),
      punch: Math.round(mix(dh.punch, dc.punch)),
      length: Math.round(mix(dh.length, dc.length)),
      space: Math.round(mix(dh.space, dc.space)),
      movement: Math.round(mix(dh.movement, dc.movement)),
      r: {
        cutoff: mix(dh.r.cutoff, dc.r.cutoff), res: mix(dh.r.res, dc.r.res),
        sus: mix(dh.r.sus, dc.r.sus), hiDamp: dh.r.hiDamp,
        att: mix(dh.r.att, dc.r.att), rel: mix(dh.r.rel, dc.r.rel),
      },
      // blend the naming signals the same way the meters blend; categorical
      // values (register, waveform character) take the louder voice's.
      sig: {
        waveB: mix(sh.waveB, sc.waveB), cutoffN: mix(sh.cutoffN, sc.cutoffN),
        resN: mix(sh.resN, sc.resN), sensN: mix(sh.sensN, sc.sensN),
        darkening: mix(sh.darkening, sc.darkening), tremN: mix(sh.tremN, sc.tremN),
        vibN: mix(sh.vibN, sc.vibN), ofLfoN: mix(sh.ofLfoN, sc.ofLfoN),
        filterMove: mix(sh.filterMove, sc.filterMove), oct: louder.sig.oct,
        waveChar: louder.sig.waveChar, noise: mix(sh.noise, sc.noise),
      },
    };
    const voice = wsum <= 0 ? "" : (wh > 0.72 ? "harp-led" : wc > 0.72 ? "chord-led" : "harp + chord");
    const feats = uniq(featureTags(patch, HARP_V).concat(featureTags(patch, CHORD_V)));
    const prof = mkProfile(d, { voice, extraTags: feats });
    // Name the blended voice once, or the single audible voice when the other is
    // silent (its output level or all oscillators at 0 contribute nothing).
    if (ph <= SILENCE && pc <= SILENCE) {
      prof.word = "Silent";
      prof.tags = ["silent"];
      prof.summary = "Silent. Both voices are at zero output.";
      prof.theme = { material: null, vibe: null };
    } else {
      let target, tfeats;
      if (pc <= SILENCE) { target = dh; tfeats = featureTags(patch, HARP_V); }
      else if (ph <= SILENCE) { target = dc; tfeats = featureTags(patch, CHORD_V); }
      else { target = d; tfeats = feats; }
      const nv = nameVoice(target, mergeTags(tagsFor(target), tfeats));
      prof.word = nv.word;
      prof.theme = { material: nv.material, vibe: nv.vibe };
    }
    return prof;
  }

  const SILENCE = 0.01;   // presence below this = effectively silent

  // ---- per-voice read-out (for the Overview dashboard) ---------------------
  function voiceProfile(patch, which) {
    const V = which === "chord" ? CHORD_V : HARP_V;
    if (presence(patch, V) <= SILENCE) {
      return {
        tags: ["silent"], word: "Silent", theme: { material: null, vibe: null },
        summary: "Silent. This voice's output level (or all its oscillators) is at 0.",
        dimensions: [
          { label: "Brightness", value: 0 }, { label: "Punch", value: 0 }, { label: "Length", value: 0 },
          { label: "Space", value: 0 }, { label: "Movement", value: 0 },
        ],
      };
    }
    const d = voiceDims(patch, V);
    const prof = mkProfile(d, { extraTags: featureTags(patch, V) });
    const nv = nameVoice(d, prof.tags);
    prof.word = nv.word;
    prof.theme = { material: nv.material, vibe: nv.vibe };
    return prof;
  }

  // ---- waveform character: by inherent shape/sound, NOT current settings ----
  function waveTags(idx) {
    const b = WAVE_BRIGHT[idx] != null ? WAVE_BRIGHT[idx] : 0.4;
    const bw = b >= 0.7 ? "bright" : b >= 0.45 ? "warm" : b >= 0.25 ? "mellow" : "dark";
    return [bw, WAVE_CHAR[idx] || "tone"];
  }

  // ---- per-component read-out ----------------------------------------------
  // Tags use the same scored-threshold model: a guaranteed primary descriptor
  // plus any secondary tags scoring >= 0.5, so a component can carry up to 3.
  // Chord components reuse the harp read-outs by remapping their addresses into
  // the harp slots the case reads; the 3-osc stack and chord General are bespoke.
  const CHORD_COMP = {
    chord_amp_env: { as: "amp_env", map: { 43: 137, 44: 138, 45: 139, 46: 140, 47: 141 } },
    chord_filter: { as: "filter", map: { 49: 143, 50: 144, 51: 145 } },
    chord_tremolo: { as: "tremolo", map: { 59: 156, 60: 157, 61: 159 } },
    chord_vibrato: { as: "vibrato", map: { 62: 160, 63: 161, 64: 163, 65: 164, 71: 170, 76: 175 } },
    chord_delay: { as: "delay", map: { 77: 176, 84: 183, 85: 184, 86: 185 } },
    chord_output_filter: { as: "output_filter", map: { 88: 192, 89: 193, 90: 194, 91: 195, 92: 196 } },
  };
  function component(id, patch) {
    const rm = CHORD_COMP[id];
    if (rm) {
      const rp = {};
      Object.keys(rm.map).forEach(h => { rp[h] = patch[rm.map[h]]; });
      patch = rp; id = rm.as;
    }
    const d = dims(patch), r = d.r;
    const sec = cands => cands.filter(c => c.s >= 0.5).sort((a, b) => b.s - a.s).map(c => c.t);
    const cut3 = t => t.slice(0, 3);

    switch (id) {
      case "oscillator": {
        // tags describe the waveform's inherent shape/sound, not the current level
        const wb = WAVE_BRIGHT[r.wave] != null ? WAVE_BRIGHT[r.wave] : 0.4;
        const char = wb > 0.66 ? "bright and harmonically rich"
          : wb < 0.3 ? "soft, with few overtones" : "a balanced, middle tone";
        if (r.amp < 0.005) return { tags: waveTags(r.wave), text: `${cap(waveName(r.wave))}: ${char}, but silent right now (amplitude is at 0).` };
        const lvl = r.amp < 0.2 ? "low, with lots of headroom" : r.amp > 0.6 ? "high and fat" : "moderate";
        return { tags: waveTags(r.wave), text: `${cap(waveName(r.wave))}: ${char}. Level is ${lvl}.` };
      }
      case "amp_env": {
        const tail = r.rel > 1500 ? " with a long, ringing tail" : r.rel < 200 ? " and a tight, short tail" : "";
        let text;
        if (r.att < 30 && r.sus < 0.35) text = `Plucky and percussive: a fast ${Math.round(r.att)} ms attack and low sustain${tail}.`;
        else if (r.att > 300) text = `A slow, swelling pad: a gentle ${Math.round(r.att)} ms fade-in${r.sus > 0.6 ? ", held while you hold the note" : ""}${tail}.`;
        else text = `${r.sus > 0.6 ? "Sustained" : "Moderate"} shape: a ${Math.round(r.att)} ms attack${tail}.`;
        const cands = [
          { t: "plucky", s: rlin(r.att, 50, 2) },
          { t: "swelling", s: lin(r.att, 300, 1600) },
          { t: "sustained", s: lin(r.sus, 0.55, 0.85) },
          { t: "decaying", s: rlin(r.sus, 0.25, 0.02) },
          { t: "long tail", s: lin(r.rel, 1300, 3800) },
          { t: "tight", s: rlin(r.rel, 260, 25) },
        ];
        let tags = sec(cands);
        if (!tags.length) tags = [cands.slice().sort((a, b) => b.s - a.s)[0].t];
        if (tags.includes("sustained")) tags = tags.filter(t => t !== "decaying");
        if (tags.includes("plucky")) tags = tags.filter(t => t !== "swelling");
        return { tags: cut3(tags), text };
      }
      case "filter": {
        const resTxt = r.res >= 2.8 ? ", with a strong resonant peak (vocal/squelchy)"
          : r.res >= 1.3 ? ", lightly resonant" : "";
        const tags = [describeCutoff(r.cutoff).split(",")[0]].concat(sec([
          { t: "resonant", s: lin(r.res, 2.2, 4.2) },
          { t: "clean", s: rlin(r.res, 1.5, 0.7) },
          { t: "key-tracked", s: lin(r.keytrack, 0.9, 2.4) },
          { t: "fixed", s: rlin(r.keytrack, 0.12, 0) },
        ]));
        return {
          tags: cut3(tags),
          text: `${cap(describeCutoff(r.cutoff))} low-pass at ${Math.round(r.cutoff)} Hz${resTxt}. `
            + `Keytracking is ${r.keytrack < 0.1 ? "off (high notes stay dull)" : r.keytrack > 1.5 ? "strong" : "moderate"}.`,
        };
      }
      case "filter_env": {
        if (r.sens < 0.05) return { tags: ["static"], text: "The filter doesn't move. The cutoff stays at its base." };
        const depth = r.sens < 1 ? "Subtle" : r.sens < 2.5 ? "Moderate" : "Strong";
        const speed = r.fAtt < 20 ? "snaps open instantly" : r.fAtt > 600 ? "opens slowly (a filter 'wow')" : "opens quickly";
        const tags = [r.sens < 1.2 ? "subtle" : "sweeping"].concat(sec([
          { t: "snappy", s: rlin(r.fAtt, 40, 1) },
          { t: "slow", s: lin(r.fAtt, 500, 2500) },
        ]));
        return { tags: cut3(tags), text: `${depth} movement. The cutoff ${speed} at the start of each note.` };
      }
      case "space": {
        const room = r.size < 0.25 ? "A small, intimate space" : r.size < 0.6 ? "A moderate room" : "A large, washy space";
        const dark = r.hiDamp > 0.5 ? ", dark and muffled (lofi)" : r.hiDamp < 0.2 ? ", bright and airy" : "";
        const stereo = r.pan < 0.4 ? "wide" : r.pan > 0.8 ? "centred" : "moderately spread";
        const tags = [r.size > 0.6 ? "spacious" : r.size < 0.25 ? "tight" : "roomy"].concat(sec([
          { t: "dark", s: lin(r.hiDamp, 0.45, 0.85) },
          { t: "open", s: rlin(r.hiDamp, 0.18, 0) },
          { t: "wide", s: rlin(r.pan, 0.4, 0) },
          { t: "centred", s: lin(r.pan, 0.82, 1) },
          { t: "smooth", s: lin(r.diff, 0.6, 0.95) },
        ]));
        return { tags: cut3(tags), text: `${room}${dark}. Stereo image is ${stereo}.` };
      }
      case "transient": {
        if (r.tAmt < 0.02) return { tags: ["clean"], text: "No transient layer. A clean, click-free attack." };
        const wb = WAVE_BRIGHT[r.tWave] != null ? WAVE_BRIGHT[r.tWave] : 0.4;
        const tags = ["percussive"].concat(sec([
          { t: "short", s: rlin(r.tDec, 140, 20) },
          { t: "bright", s: lin(wb, 0.62, 0.95) },
          { t: "dark", s: rlin(wb, 0.3, 0.05) },
          { t: "crunchy", s: r.tWave === 7 ? 1 : 0 },   // sample & hold = noisy click
        ]));
        const strength = r.tAmt > 0.5 ? "A strong" : r.tAmt > 0.15 ? "A clear" : "A subtle";
        return {
          tags: cut3(tags),
          text: `${strength} attack click: a ${Math.round(r.tDec)} ms ${WAVE_CHAR[r.tWave] || "tick"} transient`
            + `${r.tLvl > 0 ? `, pitched ${r.tLvl} steps up` : ""}.`,
        };
      }
      case "tremolo": {
        if (r.trDepth < 0.02 || r.trRate < 0.05) return { tags: ["static"], text: "No tremolo. The volume holds steady." };
        const tags = ["pulsing"].concat(sec([
          { t: "shimmer", s: rlin(r.trDepth, 0.4, 0.05) },
          { t: "evolving", s: lin(r.trRate, 8, 20) },
        ]));
        const dep = r.trDepth > 0.6 ? "deeply" : r.trDepth > 0.2 ? "clearly" : "gently";
        const spd = r.trRate > 8 ? "flutters" : "pulses";
        return { tags: cut3(tags), text: `Volume ${spd} at ${r.trRate.toFixed(1)} Hz, ${dep}.` };
      }
      case "vibrato": {
        const bend = Math.abs(r.vibBend - 1) > 0.05;
        if (r.vibAmp < 0.02 || r.vibRate < 0.05) {
          if (bend) return { tags: ["wavering"], text: `Pitch ${r.vibBend < 1 ? "scoops down" : "bends up"} into each note.` };
          return { tags: ["static"], text: "No vibrato. The pitch holds steady." };
        }
        const tags = ["wavering"].concat(sec([
          { t: "subtle", s: rlin(r.vibAmp, 0.35, 0.03) },
          { t: "evolving", s: lin(r.vibRate, 8, 18) },
        ]));
        const dep = r.vibAmp > 0.5 ? "wide" : r.vibAmp > 0.15 ? "clear" : "gentle";
        return { tags: cut3(tags), text: `Pitch wavers at ${r.vibRate.toFixed(1)} Hz, ${dep}${r.vibAtt > 400 ? ", fading in" : ""}.` };
      }
      case "delay": {
        const tags = [];
        if (r.delMix > 0.02) tags.push("echoing");
        if (r.crunch > 0.05) tags.push("crunchy");
        if (r.revSend > 0.3) tags.push("spacious");
        if (!tags.length) tags.push("clean");
        let text;
        if (r.delMix > 0.02) text = `Echoes every ${Math.round(r.delTime)} ms${r.crunch > 0.05 ? `, with ${r.crunch > 0.5 ? "heavy" : "light"} crunch` : ""}.`;
        else if (r.crunch > 0.05) text = `Clean delay-wise, with ${r.crunch > 0.5 ? "heavy" : "light"} crunch.`;
        else text = "Clean. No delay or crunch.";
        return { tags: cut3(tags), text };
      }
      case "output_filter": {
        const mode = (r.ofBp > r.ofLp && r.ofBp > r.ofHp) ? "band-pass (hollow)"
          : (r.ofHp > r.ofLp ? "high-pass (thin)" : "low-pass (warm)");
        const swept = r.ofSens > 0.05 && r.ofLfoRate > 0.05;
        const tags = [describeCutoff(r.ofFreq).split(",")[0]].concat(sec([
          { t: "resonant", s: lin(r.ofRes, 2.2, 4.2) },
          { t: "hollow", s: lin(r.ofBp, 0.6, 1) * rlin(r.ofLp, 0.5, 0) },
          { t: "sweeping", s: swept ? lin(r.ofSens, 1, 4) : 0 },
        ]));
        return { tags: cut3(tags), text: `${cap(describeCutoff(r.ofFreq))} ${mode} output filter at ${Math.round(r.ofFreq)} Hz${swept ? ", swept by its LFO" : ""}.` };
      }
      case "harp_general": {
        const tags = [];
        if (r.octave <= 1) tags.push("deep");
        else if (r.octave >= 3) tags.push("bright");
        const strumTag = { 1: "full", 2: "open", 3: "lush", 4: "full", 5: "chromatic" }[r.strum];
        if (strumTag) tags.push(strumTag);
        if (r.chroma >= 1 && !tags.includes("chromatic")) tags.push("chromatic");
        if (!tags.length) tags.push("balanced");
        const octName = ["two octaves down", "one octave down", "at its normal octave", "one octave up", "two octaves up"][r.octave] || "at its normal octave";
        const strumName = ["the standard layout", "added seconds", "added fourths", "added sixths (lush)", "doubled octaves", "a chromatic run", "a Barry-Harris layout"][r.strum] || "the standard layout";
        return { tags: cut3(uniq(tags)), text: `Harp ${octName}, ${strumName}${r.chroma >= 1 ? ", in chromatic mode" : ""}.` };
      }
      case "chord_oscillator": {
        const amps = [P(patch, 121, 0), P(patch, 124, 0), P(patch, 127, 0)];
        const waves = [122, 125, 128].map(a => Math.round(P(patch, a, 0)));
        const noise = P(patch, 130, 0);
        const asum = amps[0] + amps[1] + amps[2];
        if (asum + noise < 0.005) return { tags: ["silent"], text: "All three oscillators and the noise layer are at 0, so it's silent." };
        let wb = 0; amps.forEach((a, i) => { wb += a * (WAVE_BRIGHT[waves[i]] != null ? WAVE_BRIGHT[waves[i]] : 0.4); });
        wb = asum > 0 ? wb / asum : 0.4;
        const bw = wb >= 0.7 ? "bright" : wb >= 0.45 ? "warm" : wb >= 0.25 ? "mellow" : "dark";
        const nActive = amps.filter(a => a > 0.02).length;
        const tags = [bw].concat(sec([
          { t: "full", s: lin(asum, 0.5, 1.2) },
          { t: "breathy", s: lin(noise, 0.15, 0.6) },
        ]));
        const desc = wb > 0.66 ? "bright and rich" : wb < 0.3 ? "soft and pure" : "a balanced tone";
        return { tags: cut3(tags), text: `${nActive > 1 ? `A ${nActive}-oscillator stack` : "One oscillator"}${noise > 0.05 ? " with noise" : ""}: ${desc}.` };
      }
      case "chord_general": {
        const oct = Math.round(P(patch, 198, 2)), glide = P(patch, 199, 0);
        const tags = [];
        if (oct <= 1) tags.push("deep"); else if (oct >= 3) tags.push("bright");
        if (!tags.length) tags.push("balanced");
        const octName = ["two octaves down", "one octave down", "at its normal octave", "one octave up", "two octaves up"][oct] || "at its normal octave";
        return { tags: cut3(uniq(tags)), text: `Chord ${octName}${glide > 80 ? `, gliding ${Math.round(glide)} ms between chords` : ""}.` };
      }
      default:
        return { tags: [], text: "" };
    }
  }

  // ---- material / vibe / theme naming --------------------------------------
  // A voice's headline name comes from two derived axes, MATERIAL (what the
  // sound seems made of) and VIBE (its energy/mood), composed into a theme,
  // unless a curated SIGNATURE fingerprint matches first. Every axis reads only
  // values already produced by voiceDims/tagScores/featureTags, so the name
  // stays explainable and fully deterministic (first match in priority wins).
  const titleCase = s => s.replace(/(^|[\s-])(\w)/g, (_, b, c) => b + c.toUpperCase());

  // last-resort qualifier when a vibe has no material to sit on
  function registerWord(d) {
    return d.brightness >= 60 ? "bright" : d.brightness <= 35 ? "dark" : "warm";
  }

  // MATERIAL: "what the sound is made of". Priority-ordered; first hit wins.
  function deriveMaterial(d, q) {
    const B = d.brightness, res = d.r.res, wc = d.sig.waveChar;
    const is = (...w) => w.indexOf(wc) >= 0;
    if (q.has("gritty") && B >= 55 && res >= 2.2) return "molten";
    if (B >= 52 && d.length >= 48 && res >= 2.2 && !q.has("gritty")) return "metallic";   // clean resonant ring (bell/chime)
    if (B >= 58 && is("pure", "digital") && res < 2.2 && !q.has("gritty")) return "glassy";   // only genuinely clean waves
    if (B >= 52 && is("buzzy", "reedy", "nasal", "crisp", "edgy") && !q.has("gritty")) return "brassy";  // saws/reeds: bright but buzzy, not smooth
    if (d.movement >= 40 && (q.has("echoing") || q.has("wavering")) && d.space >= 44) return "watery";
    if (B >= 30 && B <= 60 && is("hollow", "round") && q.has("plucky")) return "wooden";
    if (q.has("gritty") && B < 55) return "earthy";   // dark + real grit = rough, dirty
    if (q.has("lofi")) return "dusty";                // dark + damped, tape-like, little grit
    if (q.has("mellow") && d.space >= 44 && d.length >= 50 && d.movement < 40) return "smoky";
    if ((q.has("breathy") && d.punch < 55 && !q.has("gritty")) || (d.space >= 60 && q.has("soft") && B >= 45)) return "airy";   // breath, not an aggressive noisy hit
    return null;
  }

  // VIBE: energy/mood, orthogonal to material. Priority-ordered; first hit wins.
  // Distinctive character (scale, aggression, mood) is matched before incidental
  // texture (movement, rhythm), so a faint vibrato can't override an ambient pad.
  function deriveVibe(d, q) {
    const B = d.brightness;
    // low "bubbly": a slow, shining roar: deep + bubbling echo in a wide wet space,
    // with a bright glint (brightness or resonance) on the low body, and not popping.
    if (q.has("deep") && q.has("echoing") && d.space >= 50 && !q.has("plucky") && (B >= 45 || d.r.res >= 2.2)) return "subaquatic";
    // thunderous needs actual noise (grit or breath), the rumble of a storm; a
    // clean, powerful deep low end with no grain reads as "booming" instead.
    if (q.has("deep") && d.space >= 55 && (q.has("gritty") || q.has("breathy"))) return "thunderous";
    // a true boom is dark, low and STEADY: a warm/bright or wobbling low note
    // isn't a powerful boom (a moving one is "wobbly" instead)
    if (q.has("deep") && B < 42 && d.space >= 55 && d.length >= 40 && d.movement < 50 && !q.has("wavering")) return "booming";
    if (q.has("gritty") && (d.punch >= 45 || B >= 60)) return "electric";
    // high "bubbly": bright, popping effervescence: fast plucks trailing into echo,
    // and never deep (a low, roaring sound is not bubbly)
    if (q.has("plucky") && q.has("echoing") && B >= 50 && d.space < 60 && !q.has("deep")) return "bubbly";
    // split dark vs bright ambience by mood so both stay reachable (disjoint on B)
    if (B < 40 && d.length >= 50 && d.movement < 55 && !q.has("plucky") && !q.has("gritty")) return "mysterious";
    if (B >= 40 && d.space >= 55 && d.punch < 52 && d.movement < 52 && !q.has("wavering")) return "dreamy";   // floaty + still, not wobbling
    if (q.has("wavering") || d.movement >= 55) return "wobbly";   // audible pitch wobble IS wobbly, even if the meter is modest
    if (d.punch >= 55 && d.length <= 55) return "driving";   // fast attack AND not sustained = propulsion, not just a quick onset
    if (q.has("soft") || d.movement < 30) return "serene";
    return null;
  }

  // THEME: generated headline from the two axes (no lookup table). A characterful
  // vibe leads (mood), material follows: "bubbly watery", "electric glassy". But a
  // "weak" vibe (wobbly/driving/serene are common and low-identity) yields the
  // headline to a present material. The material is more distinctive, and the vibe
  // still shows in the axes sub-line. This keeps the preset list varied.
  const WEAK_VIBE = { wobbly: 1, driving: 1, serene: 1 };
  function composeTheme(material, vibe, d) {
    if (!material && !vibe) return null;
    if (!material) return vibe ? vibe + " " + registerWord(d) : null;
    if (!vibe || material === vibe || WEAK_VIBE[vibe]) return material;
    return vibe + " " + material;
  }

  // Curated whole-patch fingerprints: the focused/fun "signature" names. Each is
  // an object of AND-ed predicates; first match wins, so order specific -> general.
  // Predicates (all optional):
  //   tags:     ALL must be in the voice's top-3 tags (its dominant character)
  //   need:     ALL must be present anywhere in the tag list
  //   avoid:    NONE may be present
  //   material / vibe: the derived axis must equal this
  //   dims:     { brightness|punch|length|space|movement: [lo, hi] }  (0..100 windows)
  //   raw:      { res|cutoff|sus|...: [lo, hi] }  windows on raw values
  const SIGNATURE = [
    // -- named scenes (specific fingerprints, fire first) --
    // a deep, bright, dry brassy pad with delay + tremolo: classic synthwave
    { name: "synthwave", material: "brassy", need: ["sustained", "echoing", "deep"], dims: { space: [0, 22] } },
    // a dreamy, wide, bright wash: cosmic / Interstellar pads
    { name: "celestial", vibe: "dreamy", dims: { space: [58, 100], brightness: [52, 100] } },
    // hot, bright, sustained distortion: a screaming lead
    { name: "searing", need: ["gritty", "sustained"], dims: { brightness: [60, 100] } },
    // a clean, plucked bell/tine
    { name: "kalimba", material: "glassy", need: ["plucky"], dims: { length: [0, 62] } },
    // a very dark, low, dry bass with no air: deep underground
    { name: "subterranean", need: ["deep"], dims: { brightness: [0, 28], space: [0, 30] } },
    // detuned, bright, fat saws: a trance/EDM supersaw
    { name: "supersaw", wave: ["crisp", "buzzy"], need: ["wavering", "deep"], material: "brassy", dims: { brightness: [50, 100] } },
    // the noise oscillator played percussively and dry: an 8-bit drum kit
    { name: "8-bit", wave: ["crunchy"], dims: { punch: [48, 100], space: [0, 30] } },
    // a dry, bright, plucked square/pulse: a chiptune lead
    { name: "chiptune", wave: ["hollow", "nasal"], need: ["plucky"], avoid: ["gritty", "deep"], dims: { brightness: [52, 100], space: [0, 24] }, raw: { res: [0, 2] } },
    // a warm, plucked sine with tremolo: an electric piano (Rhodes)
    { name: "rhodes", wave: ["pure", "round"], need: ["plucky", "pulsing"], avoid: ["deep", "gritty", "spacious"], dims: { brightness: [22, 52] } },
    // deep, smooth, wet and wide: submerged (but not gritty/percussive/dark; a dark wet space is cavernous)
    { name: "underwater", material: "watery", need: ["deep"], avoid: ["gritty", "plucky", "dark"], dims: { space: [55, 100] } },
    // a wet, gritty, tumbling cascade
    { name: "waterfall", material: "watery", need: ["gritty", "deep", "plucky"], dims: { space: [55, 100] } },
    // a vast, dark, booming roar filling a huge space: a storm
    { name: "storm", vibe: "booming", dims: { space: [72, 100] } },
    // lo-fi, resonant and randomly evolving: glitched
    { name: "glitchy", need: ["lofi", "resonant", "evolving"] },
    // a sustained, detuned, gritty low growl: reese / neuro bass
    { name: "growling", need: ["deep", "gritty", "wavering", "sustained"] },
    // bright, ringing, long and spacious: ice
    { name: "glacial", material: "metallic", dims: { brightness: [62, 100], length: [58, 100], space: [45, 100] } },
    // -- abstract archetypes (fall through) --
    { name: "cavernous", tags: ["spacious", "echoing", "dark"] },
    { name: "subaquatic", tags: ["deep", "spacious", "dark"] },
    { name: "bubbly", tags: ["spacious", "echoing", "mellow"], avoid: ["deep"] },
    { name: "swirly", tags: ["wavering", "echoing"] },
    { name: "crackling", tags: ["gritty", "bright", "plucky"] },
    // dark, deep, spacious and brooding: mysterious and ominous (a prominent
    // wobble reads as swirly above, so this is for the still, brooding ones)
    { name: "ominous", vibe: "mysterious", need: ["deep", "spacious"] },
    // soft, sustained, spacious and dim: a calm night piece
    { name: "nocturne", vibe: "serene", need: ["sustained", "spacious"], dims: { brightness: [25, 55] } },
    // bright, sustained, spacious and moving: a shimmering sparkle
    { name: "glistening", avoid: ["gritty"], dims: { brightness: [60, 100], length: [50, 100], space: [45, 100], movement: [40, 100] } },
    // airy, wide and soft: gossamer
    { name: "ethereal", material: "airy", dims: { space: [55, 100] } },
    // a clean, held, static, dark sustained tone (a bright held note is a pad, not a drone)
    { name: "drone", need: ["sustained"], avoid: ["gritty", "wavering", "plucky", "echoing"], dims: { brightness: [0, 55], length: [60, 100], movement: [0, 28], punch: [0, 45] } },
    // soft, smooth and rounded with no edge: velvety
    { name: "silky", need: ["soft"], avoid: ["gritty", "resonant", "wavering"], dims: { brightness: [35, 70] }, raw: { res: [0, 1.6] } },
  ];
  function signatureHits(s, d, top, q, material, vibe) {
    if (s.tags && !s.tags.every(t => top.indexOf(t) >= 0)) return false;
    if (s.need && !s.need.every(t => q.has(t))) return false;
    if (s.avoid && s.avoid.some(t => q.has(t))) return false;
    if (s.wave && s.wave.indexOf(d.sig.waveChar) < 0) return false;   // dominant waveform character
    if (s.material && material !== s.material) return false;
    if (s.vibe && vibe !== s.vibe) return false;
    if (s.dims) for (const k in s.dims) { const v = d[k]; if (v < s.dims[k][0] || v > s.dims[k][1]) return false; }
    if (s.raw) for (const k in s.raw) { const v = d.r[k]; if (v == null || v < s.raw[k][0] || v > s.raw[k][1]) return false; }
    return true;
  }
  function matchSignature(d, tags, material, vibe) {
    const top = tags.slice(0, 3), q = new Set(tags);
    for (let k = 0; k < SIGNATURE.length; k++) if (signatureHits(SIGNATURE[k], d, top, q, material, vibe)) return SIGNATURE[k].name;
    return null;
  }

  // Resolve a voice to its headline word + the two axes that drove it: a curated
  // signature if one matches, else the composed material+vibe theme, else the
  // lead tag. The axes are always returned so the read-out can show them.
  function nameVoice(d, tags) {
    const q = new Set(tags);
    const material = deriveMaterial(d, q);
    const vibe = deriveVibe(d, q);
    const raw = matchSignature(d, tags, material, vibe) || composeTheme(material, vibe, d) || tags[0] || "neutral";
    return { word: titleCase(raw), material, vibe };
  }

  function signatureName(tags) {
    return (tags && tags.length) ? cap(tags[0]) : "Neutral";
  }

  window.SoundProfiler = { overall, component, signatureName, voiceProfile, waveTags };
})();

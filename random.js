/* ============================================================================
 * random.js: the randomize roll logic, pure and DOM-free
 *
 * Split out of soundlab.js so the SAME code can be validated headlessly
 * (profile-distribution checks roll thousands of patches through here).
 *
 * "Safe" rolls are NOT uniform noise: most rolls SAMPLE the preset catalog per
 * address (real settings cluster, noise sits near zero on purpose), with
 * light jitter on floats; the rest explore uniformly, but only inside the
 * span the catalog actually uses, intersected with playability bands
 * (loudness, screech and never-decays caps). "True" rolls are plain uniform
 * over each setting's full range.
 * ========================================================================== */

window.RandomRoll = (function () {
  "use strict";

  const FLOAT_MULT = 100;   // raw preset ints store floats ×100 (matches presets.js)
  const roundTo = (v, step) => (step ? Math.round(v / step) * step : v);

  // never randomized: section volumes (silence/blast), bank color, LED
  // brightness, and the whole MIDI + Knobs domains (channels and pot routing
  // are configuration, not sound design)
  const SKIP = new Set([2, 3, 20, 32]);
  const SKIP_DOMAINS = new Set(["midi", "knobs"]);
  // params that mute a whole section when 0: harp osc amplitude, chord osc 1
  // amplitude, the two section output levels, and the low-pass BASE cutoffs
  // (49/143): a ~0 Hz cutoff with zero keytrack and zero envelope sensitivity
  // is a permanently closed filter, silent no matter the amplitudes. Presets
  // pair low cutoffs with an opening envelope; rolls decorrelate them, so the
  // base must stay audible on its own.
  const NEVER_SILENT = new Set([41, 121, 97, 197, 49, 143]);

  // is this param fair game for a dice roll in this domain? (locks are the
  // caller's concern: they're a UI preference, not roll logic. The rhythm
  // pattern/settings are rollable too, but the CALLER must hold them while
  // the rhythm is audibly playing, see rhythmParam.)
  function eligible(p, domain) {
    return !SKIP_DOMAINS.has(domain) && !SKIP.has(p.addr) && !p.targetSelect;
  }

  // the rhythm engine's inputs: the step pattern (grid) + the tempo scalars.
  // Rolling these mid-playback yanks a running performance (and a rolled
  // pattern sounds immediately), they're auto-locked while the rhythm plays.
  const rhythmParam = p => !!p.grid || (p.addr >= 187 && p.addr <= 191);

  // self-sound guard: the HARD rule, applied to EVERY style including true
  // random: a roll must never produce a patch that makes sound on its own.
  // High resonance (≥3) self-oscillates, an output level over 1 amplifies the
  // ring into a feedback drone (worse through crunch), reverb at size ≈ 1
  // recirculates forever. Everything else may roll harsh; not autonomous.
  function quietBand(p) {
    if (p.name === "Resonance" || p.name === "Filter reso") return [p.min, Math.min(p.max, 2.5)];
    if (p.name === "Level") return [p.min, Math.min(p.max, 1)];
    if (p.name === "Reverb size") return [p.min, Math.min(p.max, 0.9)];
    return [p.min, p.max];
  }

  // playability guardrails: a full-range roll blasts ears (amplitudes), hangs
  // notes for seconds (5 s envelope tails) or screeches. Safe rolls stay
  // inside musical bands; manual control keeps the full range.
  function band(p) {
    if (p.name === "Amplitude") return [Math.min(p.max, 0.05), Math.min(p.max, 0.35)];
    if (p.name === "Level") return [p.min, Math.min(p.max, 1)];   // section output level: over 1 amplifies
    if (p.name === "Reverb size") return [p.min, Math.min(p.max, 0.8)];
    if (p.name === "Resonance" || p.name === "Filter reso") return [p.min, Math.min(p.max, 2.5)];   // ≥3 screams, 5 self-oscillates
    if (p.name.indexOf("ensitivity") > 0) return [p.min, Math.min(p.max, 2)];   // filter env amount: 3+ sweeps into screech
    if (p.name === "Amount" && p.card === "Delay & Crunch") return [p.min, Math.min(p.max, 0.35)];   // crunch drive: 0.9 is a fuzz pedal
    if (p.name === "Noise level") return [p.min, Math.min(p.max, 0.15)];   // presets keep noise low on purpose
    if (p.name === "Delay mix") return [p.min, Math.min(p.max, 0.5)];   // delay stacks ON TOP of the dry signal
    if (p.name === "Cutoff (base freq)") return [Math.max(p.min, 180), Math.min(p.max, 2600)];   // closed = silent, 5 kHz = piercing
    if (p.unit === "Hz") return [p.min, Math.min(p.max, 2600)];   // filter cutoffs: piercing up at 5 kHz
    if (p.unit === "ms" && p.max >= 4000) return [p.min, Math.min(p.max, 1800)];
    return [p.min, p.max];
  }

  const EXPLORE = 0.25;   // share of safe rolls that explore instead of sampling

  // one roll. refs = decoded preset value arrays (raw ints); style "safe"|"true"
  function value(p, refs, style) {
    const clamp = v => {
      if (!Number.isFinite(v)) return null;
      const c = Math.min(p.max, Math.max(p.min, v));
      return p.type === "float" ? roundTo(c, p.step) : Math.round(c);
    };
    if (style === "true") {   // true random: uniform, full range EXCEPT the self-sound guard
      const [qLo, qHi] = p.options ? [p.min, p.max] : quietBand(p);
      if (p.options || p.type === "int") return qLo + Math.floor(Math.random() * (qHi - qLo + 1));
      return roundTo(qLo + Math.random() * (qHi - qLo), p.step);
    }
    const silencer = NEVER_SILENT.has(p.addr);
    const [lo0, hi] = p.options ? [p.min, p.max] : band(p);
    // a 0 on a silencer mutes a whole section: silent-chord/silent-harp
    // presets must not donate their silencers, and rolls can't land there.
    // The floor: the band's own lo when it has one (cutoffs), else by name.
    const lo = silencer ? Math.max(lo0, p.name === "Level" ? 0.3 : 0.05) : lo0;

    let pool = [];   // the catalog's values for this address (UI units)
    if (refs) refs.forEach(vals => {
      const rv = vals ? vals[p.addr] : null;
      if (rv != null && Number.isFinite(rv)) pool.push(p.type === "float" ? rv / FLOAT_MULT : rv);
    });
    if (silencer) pool = pool.filter(v => v >= lo);

    if (pool.length && Math.random() >= EXPLORE) {
      let v = pool[Math.floor(Math.random() * pool.length)];
      if (!p.options && p.type === "float") v += (Math.random() * 2 - 1) * 0.04 * (p.max - p.min);
      // samples cap at the band top (no blasts) but keep deliberate lows:
      // a preset's osc-off 0 must stay 0 (silencers excepted, filtered above)
      return clamp(Math.min(hi, Math.max(silencer ? lo : p.min, v)));
    }
    // exploration roll: uniform, but inside the span the catalog actually uses
    // (slightly widened): a full-range roll lands on combinations no real
    // preset goes near (filter sensitivity 3+, screaming registers, …)
    let sLo = lo, sHi = hi;
    if (pool.length) {
      const pad = p.options ? 0 : 0.05 * (p.max - p.min);
      sLo = Math.max(lo, Math.min.apply(null, pool) - pad);
      sHi = Math.min(hi, Math.max.apply(null, pool) + pad);
      if (sLo > sHi) { sLo = lo; sHi = hi; }
    }
    if (p.options || p.type === "int") {
      const ilo = Math.ceil(sLo), ihi = Math.max(ilo, Math.floor(sHi));
      return ilo + Math.floor(Math.random() * (ihi - ilo + 1));
    }
    return roundTo(sLo + Math.random() * (sHi - sLo), p.step);
  }

  // the delay feedback path is THREE gains that SUM (harp 80/81/82, chord
  // 179/180/181, "how much X-filtered signal feeds back into the delay").
  // Individually innocent values can exceed unity together, and the loop then
  // regenerates from the noise floor: a drone with nothing touched. After a
  // roll, scale each trio's ROLLED members so the voice's total stays under 1.
  const FEEDBACK_TRIOS = [[80, 81, 82], [179, 180, 181]];
  const FEEDBACK_MAX = 0.85;
  function tameFeedback(rolled, current) {
    FEEDBACK_TRIOS.forEach(trio => {
      const mine = trio.filter(a => rolled[a] != null);
      if (!mine.length) return;
      const fixed = trio.reduce((s, a) => s + (rolled[a] == null ? ((current && current[a]) || 0) : 0), 0);
      const sum = mine.reduce((s, a) => s + rolled[a], 0);
      if (fixed + sum <= FEEDBACK_MAX) return;
      const k = Math.max(0, FEEDBACK_MAX - fixed) / sum;
      mine.forEach(a => { rolled[a] = Math.round(rolled[a] * k * 100) / 100; });
    });
  }

  return { SKIP, SKIP_DOMAINS, NEVER_SILENT, eligible, rhythmParam, band, value, tameFeedback };
})();

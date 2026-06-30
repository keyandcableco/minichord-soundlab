/* ============================================================================
 * graphs.js: minichord Sound Lab visualizations (canvas, dependency-free)
 *
 * One drawing routine per parameter group, keyed by group id. Each routine is
 * a pure function of (ctx, w, h, patch, palette, ref) and redraws on any
 * change, tab switch, or theme toggle. No external libraries.
 *
 * `ref` is an optional reference patch (a snapshot to compare against). When
 * present, each graph draws a faded "ghost" of the reference under the live
 * curve so you can see where the current settings sit relative to it.
 * ========================================================================== */

(function () {
  "use strict";

  // ---- helpers --------------------------------------------------------------

  function getPalette() {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return {
      accent: g("--accent"), accentLine: g("--accent-line"),
      panel2: g("--panel-2"), faint: g("--text-faint"),
      line: g("--line"), warm: g("--warm"), dim: g("--text-dim"),
      grid: g("--line-soft"),
    };
  }

  function withAlpha(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  const P = (patch, addr, dflt) => (patch && patch[addr] != null ? patch[addr] : dflt);

  function frame(ctx, w, h, pal, pad) {
    ctx.clearRect(0, 0, w, h);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    ctx.strokeStyle = withAlpha(pal.line, 0.55);
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
      const y = yBot - f * (yBot - yTop);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });
    ctx.strokeStyle = withAlpha(pal.dim, 0.75);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x0, yTop); ctx.lineTo(x0, yBot); ctx.lineTo(x1, yBot);
    ctx.stroke();
  }

  function label(ctx, text, x, y, color, align) {
    ctx.fillStyle = color;
    ctx.font = "700 12px 'Nunito Sans', system-ui, sans-serif";
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, y);
  }

  // shared style for the reference ghost: solid but transparent, sitting
  // clearly DIMMER than the axis (0.75). Drawn under the live curve and a touch
  // WIDER, so it reads as a soft halo behind it.
  const ghostColor = pal => withAlpha(pal.dim, 0.42);
  const MAIN_W = 2.5;     // live curve line width
  const GHOST_W = 3.25;   // reference line: a touch wider than the live line

  // ---- envelope (AHDSR) -----------------------------------------------------
  function envPoints(env, x0, x1, yTop, yBot) {
    const span = x1 - x0;
    const comp = t => Math.pow(Math.max(0, t), 0.45);
    const wa = comp(env.a), wh = comp(env.hold), wd = comp(env.d), wr = comp(env.r);
    const sustainW = span * 0.22;
    const tot = wa + wh + wd + wr || 1;
    const usable = span - sustainW;
    const pa = (wa / tot) * usable, ph = (wh / tot) * usable,
          pd = (wd / tot) * usable, pr = (wr / tot) * usable;
    const peak = env.depth != null ? env.depth : 1;
    const lvl = v => yBot - v * (yBot - yTop);
    let x = x0;
    const pts = [[x, lvl(0)]];
    x += pa; pts.push([x, lvl(peak)]);
    x += ph; pts.push([x, lvl(peak)]);
    x += pd; pts.push([x, lvl(env.s * peak)]);
    x += sustainW; pts.push([x, lvl(env.s * peak)]);
    x += pr; pts.push([x, lvl(0)]);
    return { pts, bounds: { pa, ph, pd, sustainW, pr } };
  }

  function drawEnvelope(ctx, w, h, pal, env, refEnv) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;

    // ghost (reference): line only, faded
    if (refEnv) {
      const { pts } = envPoints(refEnv, x0, x1, yTop, yBot);
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.strokeStyle = ghostColor(pal); ctx.lineWidth = GHOST_W; ctx.stroke();
    }

    const { pts, bounds } = envPoints(env, x0, x1, yTop, yBot);
    const { pa, ph, pd, sustainW, pr } = bounds;

    // phase boundary guides
    ctx.strokeStyle = withAlpha(pal.grid || pal.line, 0.7);
    ctx.setLineDash([2, 3]);
    [pa, pa + ph, pa + ph + pd, pa + ph + pd + sustainW].forEach(off => {
      ctx.beginPath(); ctx.moveTo(x0 + off, yTop); ctx.lineTo(x0 + off, yBot); ctx.stroke();
    });
    ctx.setLineDash([]);

    // filled area
    ctx.beginPath();
    ctx.moveTo(pts[0][0], yBot);
    pts.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(pts[pts.length - 1][0], yBot);
    ctx.closePath();
    ctx.fillStyle = withAlpha(pal.accent, 0.16);
    ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.strokeStyle = pal.accent; ctx.lineWidth = MAIN_W; ctx.stroke();

    const mids = [pa / 2, pa + ph / 2, pa + ph + pd / 2,
                  pa + ph + pd + sustainW / 2, pa + ph + pd + sustainW + pr / 2];
    ["A", "H", "D", "S", "R"].forEach((t, i) =>
      label(ctx, t, x0 + mids[i], yBot + 12, pal.dim, "center"));
  }

  // ---- waveform shape -------------------------------------------------------
  const SH = [0.3, -0.6, 0.85, -0.25, 0.55, -0.9, 0.15, -0.7];
  function waveValue(idx, p) {
    switch (idx) {
      case 0: return Math.sin(2 * Math.PI * p);
      case 1: return 2 * p - 1;
      case 2: return p < 0.5 ? 1 : -1;
      case 3: return p < 0.5 ? (-1 + 4 * p) : (3 - 4 * p);
      case 4: return p < 0.15 ? 1 : -1;
      case 5: return p < 0.25 ? 1 : -1;
      case 6: return 1 - 2 * p;
      case 7: return SH[Math.floor(p * SH.length) % SH.length];
      case 8: return p < 0.3 ? (-1 + (2 / 0.3) * p) : (1 - (2 / 0.7) * (p - 0.3));
      case 9: return 2 * p - 1;
      case 10: return 1 - 2 * p;
      case 11: return p < 0.5 ? 1 : -1;
      default: return Math.sin(2 * Math.PI * p);
    }
  }

  // y-axis spans -1.5..1.5 so amplitude (0..1) is visible with headroom.
  const WAVE_RANGE = 1.5;

  function strokeWave(ctx, x0, span, cy, unit, idx, amplitude, color, lw, dash) {
    ctx.beginPath();
    let started = false, prevV = null;
    for (let px = 0; px <= span; px++) {
      const p = ((px / span) * 2) % 1;          // two cycles
      const v = waveValue(idx, p) * amplitude;
      const x = x0 + px, y = cy - v * unit;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else {
        if (prevV !== null && Math.abs(v - prevV) > 0.4) ctx.lineTo(x, cy - prevV * unit);
        ctx.lineTo(x, y);
      }
      prevV = v;
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawWaveform(ctx, w, h, pal, patch, ref) {
    const pad = 16;
    ctx.clearRect(0, 0, w, h);
    const x0 = pad, x1 = w - pad, span = x1 - x0;
    const cy = h / 2, unit = (h / 2 - pad) / WAVE_RANGE; // px per unit value

    // gridlines at +/-1 (unity) and centre
    ctx.strokeStyle = withAlpha(pal.line, 0.55); ctx.lineWidth = 1;
    [1, -1].forEach(v => {
      const y = cy - v * unit;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });
    label(ctx, "+1.0", x0, cy - unit - 3, withAlpha(pal.dim, 0.7), "left");
    label(ctx, "-1.0", x0, cy + unit + 12, withAlpha(pal.dim, 0.7), "left");
    ctx.strokeStyle = withAlpha(pal.dim, 0.6); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();

    // ghost (reference) wave
    if (ref) {
      strokeWave(ctx, x0, span, cy, unit,
        Math.round(P(ref, 42, 0)), P(ref, 41, 0.15), ghostColor(pal), GHOST_W);
    }

    // live wave
    const idx = Math.round(P(patch, 42, 0));
    const amplitude = P(patch, 41, 0.15);
    strokeWave(ctx, x0, span, cy, unit, idx, amplitude, pal.accent, MAIN_W);

    label(ctx, `level ${amplitude.toFixed(2)}`, x1, pad + 2, pal.dim, "right");
  }

  // ---- low-pass filter response --------------------------------------------
  function strokeFilter(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, fc, Q, color, lw, dash) {
    ctx.beginPath();
    let first = true;
    for (let px = 0; px <= (x1 - x0); px++) {
      const f = Math.pow(10, logMin + (px / (x1 - x0)) * (logMax - logMin));
      const r = f / fc;
      const mag = 1 / Math.sqrt(Math.pow(1 - r * r, 2) + Math.pow(r / Q, 2));
      let db = 20 * Math.log10(mag);
      db = Math.max(dbMin, Math.min(dbMax, db));
      const x = x0 + px, y = yBot - ((db - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawFilter(ctx, w, h, pal, patch, ref) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    const fMin = 20, fMax = 20000;
    const logMin = Math.log10(fMin), logMax = Math.log10(fMax);
    const dbMax = 18, dbMin = -42;
    const xFor = f => x0 + ((Math.log10(f) - logMin) / (logMax - logMin)) * (x1 - x0);

    // 0 dB reference line
    const y0 = yBot - ((0 - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
    ctx.strokeStyle = withAlpha(pal.grid || pal.line, 0.7);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
    ctx.setLineDash([]);

    if (ref) {
      strokeFilter(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax,
        Math.max(20, P(ref, 49, 500)), P(ref, 51, 0.7), ghostColor(pal), GHOST_W);
    }

    const fc = Math.max(20, P(patch, 49, 500));
    const Q = P(patch, 51, 0.7);
    strokeFilter(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, fc, Q, pal.accent, MAIN_W);

    const cx = xFor(fc);
    ctx.strokeStyle = withAlpha(pal.warm, 0.9); ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(cx, yTop); ctx.lineTo(cx, yBot); ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `${Math.round(fc)} Hz`, Math.min(cx + 4, x1 - 2), yTop + 11, pal.warm,
      cx > (x0 + x1) / 2 ? "right" : "left");

    label(ctx, "20Hz", x0, yBot + 12, pal.dim, "left");
    label(ctx, "1k", xFor(1000), yBot + 12, pal.dim, "center");
    label(ctx, "20k", x1, yBot + 12, pal.dim, "right");
  }

  // ---- multimode output filter (LP/BP/HP blend) ----------------------------
  // The output filter sums the three 2nd-order outputs of a state-variable
  // filter, weighted by their mix amounts. Magnitude = |a·H_lp + b·H_bp + c·H_hp|
  // with H_lp=1/D, H_bp=s/D, H_hp=s²/D, D = (1-r²) + j(r/Q), s = jr, r = f/fc.
  // So numerator = (lp - hp·r²) + j(bp·r); resonance Q lifts the corner.
  function strokeMulti(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, fc, Q, lp, bp, hp, color, lw) {
    ctx.beginPath();
    let first = true;
    for (let px = 0; px <= (x1 - x0); px++) {
      const f = Math.pow(10, logMin + (px / (x1 - x0)) * (logMax - logMin));
      const r = f / fc;
      const nRe = lp - hp * r * r, nIm = bp * r;
      const dRe = 1 - r * r, dIm = r / Q;
      const mag = Math.sqrt(nRe * nRe + nIm * nIm) / Math.sqrt(dRe * dRe + dIm * dIm);
      let db = mag > 1e-6 ? 20 * Math.log10(mag) : dbMin;
      db = Math.max(dbMin, Math.min(dbMax, db));
      const x = x0 + px, y = yBot - ((db - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  }
  function drawMultiFilter(ctx, w, h, pal, patch, ref, A) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    const fMin = 20, fMax = 20000;
    const logMin = Math.log10(fMin), logMax = Math.log10(fMax);
    const dbMax = 18, dbMin = -42;
    const xFor = f => x0 + ((Math.log10(f) - logMin) / (logMax - logMin)) * (x1 - x0);

    // 0 dB reference line
    const y0 = yBot - ((0 - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
    ctx.strokeStyle = withAlpha(pal.grid || pal.line, 0.7);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
    ctx.setLineDash([]);

    const rd = pp => ({
      fc: Math.max(20, P(pp, A.fc, 1000)), Q: P(pp, A.q, 0.7),
      lp: P(pp, A.lp, 0), bp: P(pp, A.bp, 0), hp: P(pp, A.hp, 0),
    });
    if (ref) { const g = rd(ref); strokeMulti(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, g.fc, g.Q, g.lp, g.bp, g.hp, ghostColor(pal), GHOST_W); }
    const s = rd(patch);
    strokeMulti(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, s.fc, s.Q, s.lp, s.bp, s.hp, pal.accent, MAIN_W);

    const cx = xFor(s.fc);
    ctx.strokeStyle = withAlpha(pal.warm, 0.9); ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(cx, yTop); ctx.lineTo(cx, yBot); ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, `${Math.round(s.fc)} Hz`, Math.min(cx + 4, x1 - 2), yTop + 11, pal.warm, cx > (x0 + x1) / 2 ? "right" : "left");

    label(ctx, "20Hz", x0, yBot + 12, pal.dim, "left");
    label(ctx, "1k", xFor(1000), yBot + 12, pal.dim, "center");
    label(ctx, "20k", x1, yBot + 12, pal.dim, "right");
  }
  const HARP_OUT  = { fc: 88, q: 89, lp: 90, bp: 91, hp: 92 };
  const CHORD_OUT = { fc: 192, q: 193, lp: 194, bp: 195, hp: 196 };

  // ---- delay echo taps ------------------------------------------------------
  // The dry signal (t=0) then echoes spaced by the delay time. The feedback
  // filter's mix (low+band+high-pass return) sets the regeneration, so the tail
  // decays by that gain each repeat. Delay time 0 (or mix 0) = no echo.
  function delayTaps(pp, A) {
    const time = P(pp, A.time, 0);
    const mix = P(pp, A.mix, 0);
    const dry = P(pp, A.dry, 1);
    const g = Math.min(0.92, P(pp, A.fbLp, 0) + P(pp, A.fbBp, 0) + P(pp, A.fbHp, 0));
    const taps = [{ t: 0, a: dry }];
    if (time > 0 && mix > 0.001) {
      let a = mix;
      for (let n = 1; n <= 12 && a > 0.02; n++) { taps.push({ t: n * time, a }); a *= g; }
    }
    return { taps, time };
  }
  function drawDelay(ctx, w, h, pal, patch, ref, A) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    const live = delayTaps(patch, A);
    const lastT = live.taps[live.taps.length - 1].t;
    const span = Math.max(lastT * 1.12, 1);   // shared time axis (so ghost compares)
    const plot = (d, color, lw) => {
      d.taps.forEach(tp => {
        const x = x0 + (tp.t / span) * (x1 - x0);
        if (x > x1 + 1) return;
        const y = yBot - Math.min(1, tp.a) * (yBot - yTop);
        ctx.strokeStyle = color; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x, yBot); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, lw + 0.6, 0, Math.PI * 2); ctx.fill();
      });
    };
    if (ref) plot(delayTaps(ref, A), ghostColor(pal), GHOST_W);
    plot(live, pal.accent, MAIN_W);
    label(ctx, "level", x0, yTop + 4, pal.faint, "left");
    label(ctx, live.time > 0 ? `${Math.round(live.time)} ms spacing` : "no delay", x1, yTop + 4, pal.dim, "right");
    label(ctx, "time →", x1, yBot + 12, pal.dim, "right");
  }
  const HARP_DELAY  = { time: 77, mix: 84, dry: 83, fbLp: 80, fbBp: 81, fbHp: 82 };
  const CHORD_DELAY = { time: 176, mix: 183, dry: 182, fbLp: 179, fbBp: 180, fbHp: 181 };

  // ---- space (reverb tail + stereo field) ----------------------------------
  function tailPath(ctx, x0, x1, yBot, yTop, tau) {
    ctx.beginPath();
    let first = true;
    for (let px = 0; px <= (x1 - x0); px++) {
      const t = px / (x1 - x0);
      const env = Math.exp(-t / tau);
      const x = x0 + px, y = yBot - env * (yBot - yTop);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
  }

  function drawSpace(ctx, w, h, pal, patch, ref) {
    ctx.clearRect(0, 0, w, h);
    const pad = 16;
    const x0 = pad, x1 = w - pad;
    const cx = (x0 + x1) / 2, halfW = (x1 - x0) / 2 - 6;

    // --- stereo pan strip (top) ---
    const trackY = pad + 6;
    ctx.strokeStyle = withAlpha(pal.dim, 0.6); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, trackY); ctx.lineTo(x1, trackY); ctx.stroke();
    label(ctx, "L", x0, trackY - 5, pal.dim, "left");
    label(ctx, "C", cx, trackY - 5, pal.dim, "center");
    label(ctx, "R", x1, trackY - 5, pal.dim, "right");

    const dot = (x, color, r, txt) => {
      ctx.beginPath(); ctx.arc(x, trackY, r, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      if (txt) label(ctx, txt, x, trackY + 15, pal.dim, "center");
    };
    if (ref) {
      const rs = (1 - P(ref, 29, 0.75));
      dot(cx - rs * halfW, ghostColor(pal), 4);
      dot(cx + rs * halfW, ghostColor(pal), 4);
    }
    const spread = (1 - P(patch, 29, 0.75));
    dot(cx - spread * halfW, pal.accent, 5, "chord");
    dot(cx + spread * halfW, pal.warm, 5, "harp");

    // --- reverb tail (main plot, sitting on the bottom axis) ---
    const yTop = trackY + 30;
    const yBot = h - pad;
    const size = P(patch, 24, 0.5);
    const hiDamp = P(patch, 25, 0.0);
    const tau = 0.12 + size * 0.85;

    // faint reference gridlines + bottom axis
    ctx.strokeStyle = withAlpha(pal.line, 0.55); ctx.lineWidth = 1;
    [0.5].forEach(f => {
      const y = yBot - f * (yBot - yTop);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    });
    ctx.strokeStyle = withAlpha(pal.dim, 0.75); ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.moveTo(x0, yTop); ctx.lineTo(x0, yBot); ctx.lineTo(x1, yBot); ctx.stroke();

    // ghost tail
    if (ref) {
      const rtau = 0.12 + P(ref, 24, 0.5) * 0.85;
      tailPath(ctx, x0, x1, yBot, yTop, rtau);
      ctx.strokeStyle = ghostColor(pal); ctx.lineWidth = GHOST_W; ctx.stroke();
    }

    // live tail: fill and line share one smooth curve so they stay aligned
    tailPath(ctx, x0, x1, yBot, yTop, tau);   // build the curve
    ctx.lineTo(x1, yBot); ctx.lineTo(x0, yBot); ctx.closePath();
    ctx.fillStyle = withAlpha(pal.accent, 0.10 + (1 - hiDamp) * 0.12);
    ctx.fill();
    tailPath(ctx, x0, x1, yBot, yTop, tau);   // re-trace just the curve for the stroke
    ctx.strokeStyle = pal.accent; ctx.lineWidth = MAIN_W; ctx.stroke();
  }

  // ---- registry -------------------------------------------------------------
  const ampEnv  = pp => ({ a: P(pp, 43, 8), hold: P(pp, 44, 8), d: P(pp, 45, 12), s: P(pp, 46, 0.5), r: P(pp, 47, 1000) });
  const filtEnv = pp => ({ a: P(pp, 52, 3), hold: P(pp, 53, 35), d: P(pp, 54, 90), s: P(pp, 55, 0.5), r: P(pp, 56, 2500), depth: Math.min(1, P(pp, 58, 0) / 5) });
  // transient is a one-shot Attack-Hold-Decay (no sustain/release); height = its level
  const transEnv = pp => ({ a: P(pp, 102, 10), hold: P(pp, 103, 10), d: P(pp, 104, 40), s: 0, r: 0, depth: P(pp, 101, 0.1) });

  // ---- tremolo (amplitude LFO) ----------------------------------------------
  // volume over time as the LFO cycles it between (1 - depth) and 1. Rate sets
  // how many cycles span the view; at depth 0 it's a flat line (no tremolo).
  function tremoloCurve(pp) {
    return { wave: P(pp, 59, 0), rate: P(pp, 60, 0), depth: P(pp, 61, 0) };
  }
  function strokeTremolo(ctx, x0, x1, yTop, yBot, c, color, lw, fill, pal) {
    const span = x1 - x0;
    const cycles = (c.rate / 20) * 9;        // 0..20 Hz -> 0..9 cycles across the view
    const lvl = v => yBot - v * (yBot - yTop);
    const pts = [];
    for (let px = 0; px <= span; px++) {
      const phase = (px / span) * cycles;
      const wv = waveValue(c.wave, phase % 1);            // -1..1
      const amp = 1 - c.depth * (0.5 - 0.5 * wv);         // 1 .. 1-depth
      pts.push([x0 + px, lvl(amp)]);
    }
    if (fill) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], yBot);
      pts.forEach(p => ctx.lineTo(p[0], p[1]));
      ctx.lineTo(pts[pts.length - 1][0], yBot);
      ctx.closePath();
      ctx.fillStyle = withAlpha(pal.accent, 0.16); ctx.fill();
    }
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  }
  function drawTremolo(ctx, w, h, pal, patch, ref) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    if (ref) strokeTremolo(ctx, x0, x1, yTop, yBot, tremoloCurve(ref), ghostColor(pal), GHOST_W, false, pal);
    strokeTremolo(ctx, x0, x1, yTop, yBot, tremoloCurve(patch), pal.accent, MAIN_W, true, pal);
    label(ctx, "volume", x0, yTop + 4, pal.faint, "left");
    label(ctx, "time →", x1, yBot + 12, pal.dim, "right");
  }

  // ---- vibrato (pitch LFO) --------------------------------------------------
  // pitch deviation over time, oscillating around a centre line. Flat = off.
  function vibratoCurve(pp) { return { wave: P(pp, 62, 0), rate: P(pp, 63, 0), depth: P(pp, 64, 0) }; }
  function strokeVibrato(ctx, x0, x1, cy, halfH, c, color, lw) {
    const span = x1 - x0, cycles = (c.rate / 20) * 9, amp = c.depth * halfH * 0.92;
    ctx.beginPath();
    for (let px = 0; px <= span; px++) {
      const v = waveValue(c.wave, ((px / span) * cycles) % 1);
      const x = x0 + px, y = cy - v * amp;
      px ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  }
  function drawVibrato(ctx, w, h, pal, patch, ref) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad, cy = (yTop + yBot) / 2, halfH = (yBot - yTop) / 2;
    ctx.strokeStyle = withAlpha(pal.dim, 0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();   // pitch centre
    if (ref) strokeVibrato(ctx, x0, x1, cy, halfH, vibratoCurve(ref), ghostColor(pal), GHOST_W);
    strokeVibrato(ctx, x0, x1, cy, halfH, vibratoCurve(patch), pal.accent, MAIN_W);
    label(ctx, "pitch", x0, yTop + 4, pal.faint, "left");
    label(ctx, "time →", x1, yBot + 12, pal.dim, "right");
  }

  // ---- chord oscillator stack ----------------------------------------------
  // The chord voice blends three oscillators (each with its own amplitude, wave
  // shape and frequency multiplier) plus a noise layer. We plot the summed wave
  // over two cycles of the fundamental (the 1× component).
  function oscStack(pp) {
    return {
      o: [
        { amp: P(pp, 121, 0), wave: Math.round(P(pp, 122, 0)), mult: P(pp, 123, 1) },
        { amp: P(pp, 124, 0), wave: Math.round(P(pp, 125, 0)), mult: P(pp, 126, 1) },
        { amp: P(pp, 127, 0), wave: Math.round(P(pp, 128, 0)), mult: P(pp, 129, 1) },
      ],
      noise: P(pp, 130, 0),
    };
  }
  const frac = x => ((x % 1) + 1) % 1;
  function stackValue(s, p) {           // p spans 0..2 (two fundamental cycles)
    let v = 0;
    s.o.forEach(o => { v += o.amp * waveValue(o.wave, frac(p * o.mult)); });
    return v;
  }
  function strokeStack(ctx, x0, span, cy, unit, s, color, lw, withNoise) {
    ctx.beginPath();
    for (let px = 0; px <= span; px++) {
      const p = (px / span) * 2;
      let v = stackValue(s, p);
      if (withNoise && s.noise > 0) {
        const hsh = Math.sin(px * 12.9898) * 43758.5453;   // deterministic, no per-frame flicker
        v += s.noise * 0.5 * ((hsh - Math.floor(hsh)) - 0.5) * 2;
      }
      const x = x0 + px, y = cy - v * unit;
      px ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  }
  function waveAxes(ctx, w, h, pal) {
    const pad = 16;
    ctx.clearRect(0, 0, w, h);
    const x0 = pad, x1 = w - pad, span = x1 - x0, cy = h / 2, unit = (h / 2 - pad) / WAVE_RANGE;
    ctx.strokeStyle = withAlpha(pal.line, 0.55); ctx.lineWidth = 1;
    [1, -1].forEach(v => { const y = cy - v * unit; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); });
    label(ctx, "+1.0", x0, cy - unit - 3, withAlpha(pal.dim, 0.7), "left");
    label(ctx, "-1.0", x0, cy + unit + 12, withAlpha(pal.dim, 0.7), "left");
    ctx.strokeStyle = withAlpha(pal.dim, 0.6); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();
    return { x0, x1, span, cy, unit, pad };
  }
  function drawOscStack(ctx, w, h, pal, patch, ref) {
    const { x0, span, cy, unit, pad, x1 } = waveAxes(ctx, w, h, pal);
    if (ref) strokeStack(ctx, x0, span, cy, unit, oscStack(ref), ghostColor(pal), GHOST_W, false);
    const s = oscStack(patch);
    strokeStack(ctx, x0, span, cy, unit, s, pal.accent, MAIN_W, true);
    const sum = s.o[0].amp + s.o[1].amp + s.o[2].amp;
    label(ctx, `stack ${sum.toFixed(2)}${s.noise > 0 ? ` · noise ${s.noise.toFixed(2)}` : ""}`, x1, pad + 2, pal.dim, "right");
  }
  // a single oscillator from the stack (by index 0..2)
  const OSC_ADDRS = [[121, 122, 123], [124, 125, 126], [127, 128, 129]];
  function oscOne(pp, which) {
    const [a, wv, m] = OSC_ADDRS[which];
    return { o: [{ amp: P(pp, a, 0), wave: Math.round(P(pp, wv, 0)), mult: P(pp, m, 1) }], noise: 0 };
  }
  function drawOscOne(ctx, w, h, pal, patch, ref, which) {
    const { x0, span, cy, unit, pad, x1 } = waveAxes(ctx, w, h, pal);
    if (ref) strokeStack(ctx, x0, span, cy, unit, oscOne(ref, which), ghostColor(pal), GHOST_W, false);
    const s = oscOne(patch, which);
    strokeStack(ctx, x0, span, cy, unit, s, pal.accent, MAIN_W, false);
    label(ctx, `osc ${which + 1} · level ${s.o[0].amp.toFixed(2)}`, x1, pad + 2, pal.dim, "right");
  }

  // chord adapters: reuse the harp drawers by feeding them the chord addresses.
  // `remap` builds a patch-shaped object mapping the harp address a drawer reads
  // to the corresponding chord value.
  const remap = (pp, map) => { const o = {}; for (const k in map) o[k] = (pp && pp[map[k]] != null ? pp[map[k]] : undefined); return o; };
  const chordAmpEnv = pp => ({ a: P(pp, 137, 10), hold: P(pp, 138, 70), d: P(pp, 139, 400), s: P(pp, 140, 0.75), r: P(pp, 141, 1000) });
  const CHORD_FILT = { 49: 143, 51: 145 };       // drawFilter reads 49 (cutoff), 51 (Q)
  const CHORD_TREM = { 59: 156, 60: 157, 61: 159 };   // tremoloCurve reads 59/60/61 (wave/rate/depth)
  const CHORD_VIB  = { 62: 160, 63: 161, 64: 163 };   // vibratoCurve reads 62/63/64 (wave/rate/depth)
  // depth envelopes (secondary graphs): height = the section's depth/sensitivity
  const vibEnv       = pp => ({ a: P(pp, 65, 1), hold: P(pp, 66, 1), d: P(pp, 67, 1), s: P(pp, 68, 1), r: P(pp, 69, 1), depth: P(pp, 64, 0) });
  const chordVibEnv  = pp => ({ a: P(pp, 164, 1), hold: P(pp, 165, 1), d: P(pp, 166, 1), s: P(pp, 167, 0), r: P(pp, 168, 1), depth: P(pp, 163, 0) });
  const chordFiltEnv = pp => ({ a: P(pp, 146, 30), hold: P(pp, 147, 90), d: P(pp, 148, 30), s: P(pp, 149, 0.5), r: P(pp, 150, 50), depth: Math.min(1, P(pp, 155, 0) / 5) });

  // ---- voice overview (volume envelope + filter sweep on a shared axis) ----
  function drawVoiceShape(ctx, w, h, pal, patch, ref, ampFn, filtFn) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    const top = yTop + 20;   // headroom so the legend row sits clear of the curves
    const comp = t => Math.pow(Math.max(0, t), 0.45);
    const ct = e => comp(e.a) + comp(e.hold) + comp(e.d) + comp(e.r);
    const sustainPx = (x1 - x0) * 0.18;
    const usable = (x1 - x0) - sustainPx;
    const la = ampFn(patch), lf = filtFn(patch);
    const ra = ref ? ampFn(ref) : null, rf = ref ? filtFn(ref) : null;
    const totals = [ct(la), ct(lf)]; if (ref) { totals.push(ct(ra), ct(rf)); }
    const ppu = usable / Math.max.apply(null, totals.concat(0.0001));
    const lvl = v => yBot - Math.max(0, Math.min(1, v)) * (yBot - top);
    const pts = (e, peak) => {
      let x = x0; const p = [[x, lvl(0)]];
      x += comp(e.a) * ppu; p.push([x, lvl(peak)]);
      x += comp(e.hold) * ppu; p.push([x, lvl(peak)]);
      x += comp(e.d) * ppu; p.push([x, lvl(e.s * peak)]);
      x += sustainPx; p.push([x, lvl(e.s * peak)]);
      x += comp(e.r) * ppu; p.push([x, lvl(0)]);
      return p;
    };
    const stroke = (p, color, lw) => {
      ctx.beginPath(); p.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
    };
    const depthOf = e => (e.depth != null ? e.depth : 0);
    if (ref) { stroke(pts(ra, 1), ghostColor(pal), GHOST_W); stroke(pts(rf, depthOf(rf)), ghostColor(pal), GHOST_W); }
    // volume envelope: filled silhouette + line
    const ap = pts(la, 1);
    ctx.beginPath(); ctx.moveTo(ap[0][0], yBot); ap.forEach(q => ctx.lineTo(q[0], q[1])); ctx.lineTo(ap[ap.length - 1][0], yBot); ctx.closePath();
    ctx.fillStyle = withAlpha(pal.accent, 0.16); ctx.fill();
    stroke(ap, pal.accent, MAIN_W);
    // filter cutoff sweep: overlaid line (height = how far it moves)
    stroke(pts(lf, depthOf(lf)), pal.warm, MAIN_W);

    // legend key (swatch + label), kept in the headroom row above the curves
    const ly = yTop + 1, sw = 11, sh = 8;
    ctx.fillStyle = withAlpha(pal.accent, 0.5); ctx.fillRect(x0, ly, sw, sh);
    ctx.strokeStyle = pal.accent; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, ly + 0.75, sw - 1.5, sh - 1.5);
    label(ctx, "volume", x0 + sw + 5, ly + sh, pal.dim, "left");
    const lx2 = x0 + sw + 5 + 52;
    ctx.strokeStyle = pal.warm; ctx.lineWidth = MAIN_W;
    ctx.beginPath(); ctx.moveTo(lx2, ly + sh / 2); ctx.lineTo(lx2 + sw, ly + sh / 2); ctx.stroke();
    label(ctx, "filter sweep", lx2 + sw + 5, ly + sh, pal.dim, "left");
    label(ctx, "time →", x1, yBot + 12, pal.dim, "right");
  }

  // ---- voice tone: low-pass filter × multimode output filter, cascaded ------
  function readTone(pp, A) {
    return {
      lpFc: Math.max(20, P(pp, A.lpFc, 1000)), lpQ: P(pp, A.lpQ, 0.7),
      oFc: Math.max(20, P(pp, A.oFc, 1000)), oQ: P(pp, A.oQ, 0.7),
      oLp: P(pp, A.oLp, 0), oBp: P(pp, A.oBp, 0), oHp: P(pp, A.oHp, 0),
    };
  }
  function strokeCascade(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, v, color, lw) {
    ctx.beginPath();
    let first = true;
    for (let px = 0; px <= (x1 - x0); px++) {
      const f = Math.pow(10, logMin + (px / (x1 - x0)) * (logMax - logMin));
      const rl = f / v.lpFc;
      const lpMag = 1 / Math.sqrt(Math.pow(1 - rl * rl, 2) + Math.pow(rl / v.lpQ, 2));
      const ro = f / v.oFc;
      const nRe = v.oLp - v.oHp * ro * ro, nIm = v.oBp * ro;
      const outMag = Math.sqrt(nRe * nRe + nIm * nIm) / Math.sqrt(Math.pow(1 - ro * ro, 2) + Math.pow(ro / v.oQ, 2));
      const mag = lpMag * outMag;
      let db = mag > 1e-6 ? 20 * Math.log10(mag) : dbMin;
      db = Math.max(dbMin, Math.min(dbMax, db));
      const x = x0 + px, y = yBot - ((db - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  }
  function drawVoiceTone(ctx, w, h, pal, patch, ref, A) {
    const pad = 16;
    frame(ctx, w, h, pal, pad);
    const x0 = pad, x1 = w - pad, yBot = h - pad, yTop = pad;
    const logMin = Math.log10(20), logMax = Math.log10(20000);
    const dbMax = 18, dbMin = -48;
    const xFor = f => x0 + ((Math.log10(f) - logMin) / (logMax - logMin)) * (x1 - x0);
    const y0 = yBot - ((0 - dbMin) / (dbMax - dbMin)) * (yBot - yTop);
    ctx.strokeStyle = withAlpha(pal.grid || pal.line, 0.7);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
    ctx.setLineDash([]);
    if (ref) strokeCascade(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, readTone(ref, A), ghostColor(pal), GHOST_W);
    strokeCascade(ctx, x0, x1, yBot, yTop, logMin, logMax, dbMin, dbMax, readTone(patch, A), pal.accent, MAIN_W);
    label(ctx, "20Hz", x0, yBot + 12, pal.dim, "left");
    label(ctx, "1k", xFor(1000), yBot + 12, pal.dim, "center");
    label(ctx, "20k", x1, yBot + 12, pal.dim, "right");
  }
  const HARP_TONE  = { lpFc: 49, lpQ: 51, oFc: 88, oQ: 89, oLp: 90, oBp: 91, oHp: 92 };
  const CHORD_TONE = { lpFc: 143, lpQ: 145, oFc: 192, oQ: 193, oLp: 194, oBp: 195, oHp: 196 };

  const GRAPHS = {
    harp_overview: [
      {
        title: "Voice shape",
        caption: "Filled = the amplitude envelope over a note; line = the filter sweep. Shared time axis.",
        draw: (ctx, w, h, patch, pal, ref) => drawVoiceShape(ctx, w, h, pal, patch, ref, ampEnv, filtEnv),
      },
      {
        title: "Voice tone",
        caption: "The voice's frequency color: low-pass filter and multimode output filter cascaded.",
        draw: (ctx, w, h, patch, pal, ref) => drawVoiceTone(ctx, w, h, pal, patch, ref, HARP_TONE),
      },
    ],
    chord_overview: [
      {
        title: "Voice shape",
        caption: "Filled = the amplitude envelope over a chord; line = the filter sweep. Shared time axis.",
        draw: (ctx, w, h, patch, pal, ref) => drawVoiceShape(ctx, w, h, pal, patch, ref, chordAmpEnv, chordFiltEnv),
      },
      {
        title: "Voice tone",
        caption: "The chord voice's frequency color: low-pass filter and multimode output filter cascaded.",
        draw: (ctx, w, h, patch, pal, ref) => drawVoiceTone(ctx, w, h, pal, patch, ref, CHORD_TONE),
      },
    ],
    oscillator: {
      title: "Waveform",
      caption: "Two cycles of the selected waveform; height = amplitude. The ghost line is your reference.",
      draw: (ctx, w, h, patch, pal, ref) => drawWaveform(ctx, w, h, pal, patch, ref),
    },
    amp_env: {
      title: "Amplitude envelope",
      caption: "Amplitude over time (AHDSR). Steep front + short tail = a pluck; a slow rise = a pad.",
      draw: (ctx, w, h, patch, pal, ref) =>
        drawEnvelope(ctx, w, h, pal, ampEnv(patch), ref ? ampEnv(ref) : null),
    },
    filter: {
      title: "Filter response",
      caption: "Low-pass response: everything right of the cutoff rolls off; resonance lifts a peak there.",
      draw: (ctx, w, h, patch, pal, ref) => drawFilter(ctx, w, h, pal, patch, ref),
    },
    filter_env: {
      title: "Filter envelope",
      caption: "How the cutoff sweeps over time. Height = depth (sensitivity); at 0 it stays flat.",
      draw: (ctx, w, h, patch, pal, ref) =>
        drawEnvelope(ctx, w, h, pal, filtEnv(patch), ref ? filtEnv(ref) : null),
    },
    space: {
      title: "Reverb & stereo",
      caption: "Top: reverb tail length (size) and brightness (damping). Bottom: stereo placement vs. pan.",
      draw: (ctx, w, h, patch, pal, ref) => drawSpace(ctx, w, h, pal, patch, ref),
    },
    transient: {
      title: "Transient",
      caption: "The transient's one-shot attack, hold, decay. Height = level; at 0 it stays flat (no click).",
      draw: (ctx, w, h, patch, pal, ref) =>
        drawEnvelope(ctx, w, h, pal, transEnv(patch), ref ? transEnv(ref) : null),
    },
    tremolo: {
      title: "Tremolo",
      caption: "Amplitude over time as the LFO cycles it. Depth = dip size; rate = wobbles in view. Flat = off.",
      draw: (ctx, w, h, patch, pal, ref) => drawTremolo(ctx, w, h, pal, patch, ref),
    },
    vibrato: [
      {
        title: "Pitch LFO",
        caption: "Pitch over time as the LFO bends it around centre. Depth = swing; rate = wobbles in view. Flat = off.",
        draw: (ctx, w, h, patch, pal, ref) => drawVibrato(ctx, w, h, pal, patch, ref),
      },
      {
        title: "Depth envelope",
        caption: "Vibrato depth over time. Its envelope fades the wobble in and out. Flat at the top = always on.",
        draw: (ctx, w, h, patch, pal, ref) =>
          drawEnvelope(ctx, w, h, pal, vibEnv(patch), ref ? vibEnv(ref) : null),
      },
    ],
    output_filter: {
      title: "Filter response",
      caption: "Multimode output filter: low-pass, band-pass and high-pass blended by their mixes. Dashed = cutoff.",
      draw: (ctx, w, h, patch, pal, ref) => drawMultiFilter(ctx, w, h, pal, patch, ref, HARP_OUT),
    },
    delay: {
      title: "Echo taps",
      caption: "Dry signal at left, then echoes spaced by delay time. More feedback = a longer tail. Mix 0 = no echo.",
      draw: (ctx, w, h, patch, pal, ref) => drawDelay(ctx, w, h, pal, patch, ref, HARP_DELAY),
    },

    // ---- chord voice (reuse the harp drawers via remapped addresses) ----
    chord_oscillator: [
      {
        title: "Combined stack",
        caption: "The three oscillators summed, plus noise, over two cycles of the fundamental. You hear all of it combined.",
        draw: (ctx, w, h, patch, pal, ref) => drawOscStack(ctx, w, h, pal, patch, ref),
      },
      {
        title: "Oscillator 1",
        caption: "Oscillator 1 alone: its waveform, level (height) and tuning (cycle count). Flat when its level is 0.",
        draw: (ctx, w, h, patch, pal, ref) => drawOscOne(ctx, w, h, pal, patch, ref, 0),
      },
      {
        title: "Oscillator 2",
        caption: "Oscillator 2 alone: its waveform, level and tuning. Flat when its level is 0.",
        draw: (ctx, w, h, patch, pal, ref) => drawOscOne(ctx, w, h, pal, patch, ref, 1),
      },
      {
        title: "Oscillator 3",
        caption: "Oscillator 3 alone: its waveform, level and tuning. Flat when its level is 0.",
        draw: (ctx, w, h, patch, pal, ref) => drawOscOne(ctx, w, h, pal, patch, ref, 2),
      },
    ],
    chord_amp_env: {
      title: "Amplitude envelope",
      caption: "Amplitude over time (AHDSR). The chord voice usually wants a slower, more pad-like shape than the harp.",
      draw: (ctx, w, h, patch, pal, ref) =>
        drawEnvelope(ctx, w, h, pal, chordAmpEnv(patch), ref ? chordAmpEnv(ref) : null),
    },
    chord_filter: [
      {
        title: "Filter response",
        caption: "The chord's low-pass response: everything right of the cutoff rolls off; resonance lifts a peak there.",
        draw: (ctx, w, h, patch, pal, ref) =>
          drawFilter(ctx, w, h, pal, remap(patch, CHORD_FILT), ref ? remap(ref, CHORD_FILT) : null),
      },
      {
        title: "Filter envelope",
        caption: "How the envelope sweeps the cutoff per note. Height = sensitivity; flat = no movement.",
        draw: (ctx, w, h, patch, pal, ref) =>
          drawEnvelope(ctx, w, h, pal, chordFiltEnv(patch), ref ? chordFiltEnv(ref) : null),
      },
    ],
    chord_tremolo: {
      title: "Tremolo",
      caption: "Amplitude over time as the LFO cycles it. Depth = dip size; rate = wobbles in view. Flat = off.",
      draw: (ctx, w, h, patch, pal, ref) =>
        drawTremolo(ctx, w, h, pal, remap(patch, CHORD_TREM), ref ? remap(ref, CHORD_TREM) : null),
    },
    chord_vibrato: [
      {
        title: "Pitch LFO",
        caption: "Pitch over time as the LFO bends it around centre. Depth = swing; rate = wobbles in view. Flat = off.",
        draw: (ctx, w, h, patch, pal, ref) =>
          drawVibrato(ctx, w, h, pal, remap(patch, CHORD_VIB), ref ? remap(ref, CHORD_VIB) : null),
      },
      {
        title: "Depth envelope",
        caption: "Vibrato depth over time. Its envelope fades the wobble in and out. Flat at the top = always on.",
        draw: (ctx, w, h, patch, pal, ref) =>
          drawEnvelope(ctx, w, h, pal, chordVibEnv(patch), ref ? chordVibEnv(ref) : null),
      },
    ],
    chord_output_filter: {
      title: "Filter response",
      caption: "The chord's multimode output filter: low-pass, band-pass and high-pass blended by their mixes. Dashed = cutoff.",
      draw: (ctx, w, h, patch, pal, ref) => drawMultiFilter(ctx, w, h, pal, patch, ref, CHORD_OUT),
    },
    chord_delay: {
      title: "Echo taps",
      caption: "Dry signal at left, then echoes spaced by delay time. More feedback = a longer tail. Mix 0 = no echo.",
      draw: (ctx, w, h, patch, pal, ref) => drawDelay(ctx, w, h, pal, patch, ref, CHORD_DELAY),
    },
  };

  // A tab may register a single spec or an array of specs (primary first). This
  // normalises either form to an array so the middle panel can stack them.
  function specsFor(groupId) {
    const g = GRAPHS[groupId];
    return Array.isArray(g) ? g : (g ? [g] : []);
  }

  // Draw one spec's draw() into a canvas, handling devicePixelRatio. No-op if
  // the canvas isn't laid out yet (hidden tab / zero size).
  function drawSpec(canvas, drawFn, patch, ref) {
    if (!drawFn || !canvas) return;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, cssW, cssH, patch, getPalette(), ref || null);
  }

  window.Graphs = { specsFor, drawSpec };
})();

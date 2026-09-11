/* ============================================================================
 * params.js: minichord Sound Lab parameter catalog (v1, focused harp voice)
 *
 * DATA ONLY. No rendering, no MIDI. This file is the single place to edit the
 * parameters shown in the Lab and the explanations attached to them.
 *
 * Addresses, ranges, curves and defaults are taken verbatim from
 * json/parameters.json (the device's own catalog). The `explain` text is the
 * learning layer, written for this tool.
 *
 * Each parameter:
 *   addr     sysex address (the key used when talking to the device)
 *   name     short display name
 *   unit     suffix for the value readout ("ms", "Hz", "", ...)
 *   min/max  real-value range
 *   step     real-value step
 *   type     "int" | "float"
 *   curve    "linear" | "exponential"  (slider feel; see soundlab.js)
 *   def      default value
 *   options  (enum params only) array of choice labels, index = value
 *   explain  { is, does, tips }  the teaching text
 * ========================================================================== */

// Waveform names in device order (value 0..11), with a one-word character tag.
// `char` is the audio-character word and MUST stay in sync with profiler.js
// WAVE_CHAR (the single source of truth the material axis reads). Kept literal
// here to avoid load-order coupling on window.SoundProfiler.
const WAVEFORMS = [
  { label: "Sine",            char: "pure" },
  { label: "Sawtooth",        char: "buzzy" },
  { label: "Square",          char: "hollow" },
  { label: "Triangle",        char: "round" },
  { label: "Bandlimited pulse",char: "digital" },
  { label: "Pulse",           char: "nasal" },
  { label: "Reverse sawtooth",char: "buzzy" },
  { label: "Sample & hold",   char: "crunchy" },
  { label: "Variable triangle",char: "edgy" },
  { label: "Bandlimited saw", char: "crisp" },
  { label: "Rev. bandlimited saw", char: "crisp" },
  { label: "Bandlimited square",   char: "reedy" },
];

const PARAM_GROUPS = [
  /* ---------------------------------------------------------------------- */
  {
    id: "oscillator",
    domain: "harp",
    title: "Oscillator",
    blurb: "The raw oscillator tone before anything shapes it. The harp voice's starting timbre.",
    params: [
      {
        addr: 42, name: "Waveform", card: "Tone", unit: "", min: 0, max: 11, step: 1,
        type: "int", curve: "linear", def: 0,
        options: WAVEFORMS.map(w => w.label),
        autoReference: true, // snapshot the reference on change, so the ghost = previous waveform

        explain: {
          is: "The waveform of the oscillator, the fundamental color of the sound, from 12 options.",
          does: "Simple = sine and triangle, soft and dark. Rich = sawtooth, square and pulse, bright and buzzy.",
          tips: "Sine and triangle for mellow pads and bells; sawtooth for bright leads; square and pulse for reedy tones."
        }
      },
      {
        addr: 41, name: "Amplitude", card: "Tone", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.15,
        explain: {
          is: "The gain of the oscillator feeding the voice.",
          does: "Low = clean and quiet, with headroom. High = louder and fuller, driving later stages harder.",
          tips: "The default 0.15 leaves headroom; nudge up for a fatter core, keep moderate when stacking reverb."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "amp_env",
    domain: "harp",
    title: "Amplitude Envelope",
    blurb: "How each note's amplitude evolves over time. The AHDSR envelope behind a pluck or a swelling pad.",
    params: [
      {
        addr: 43, name: "Attack", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 8,
        explain: {
          is: "Time for a note to rise from silence to full volume after it's triggered.",
          does: "Short = an instant, plucky onset. Long = a slow, swelling pad.",
          tips: "Under ~20 ms for plucks and bells; 300 ms+ for slow swells."
        }
      },
      {
        addr: 44, name: "Hold", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 8,
        explain: {
          is: "Time the note stays at full volume after the attack, before decay begins.",
          does: "Short = decay starts right away. Long = the peak sustains, feeling solid up front."
        }
      },
      {
        addr: 45, name: "Decay", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 12,
        explain: {
          is: "Time to fall from the peak down to the sustain level after the hold.",
          does: "Short = a sharp, plucky drop. Long = a gradual settle into sustain.",
          tips: "Short decay with low sustain for plucks; longer for pad-like sustain."
        }
      },
      {
        addr: 46, name: "Sustain", card: "Sustain & release", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.5,
        explain: {
          is: "The level the note holds at while still held, after decay.",
          does: "0 = the note dies away while held, like a real harp. High = it rings on steadily, organ or pad.",
          tips: "Low or zero for plucked, harp-like notes; high for sustained pads. This is a level, not a time."
        }
      },
      {
        addr: 47, name: "Release", card: "Sustain & release", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 1000,
        explain: {
          is: "Time for the note to fade to silence after it's let go.",
          does: "Short = stops cleanly on release. Long = a lingering tail that rings out.",
          tips: "The default 1000 ms tail makes strums bloom and overlap; shorten for staccato, lengthen for washy strums."
        }
      },
      {
        addr: 48, name: "Retrigger release", card: "Sustain & release", unit: "ms", min: 0, max: 10, step: 1,
        type: "int", curve: "exponential", def: 1,
        explain: {
          is: "A tiny fade applied when the same note is retriggered quickly, so it restarts cleanly.",
          does: "Short = retriggers can click. Long = repeated notes cross-fade smoothly.",
          tips: "Leave at 1–2 ms; raise only if fast repeats click or pop."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "filter",
    domain: "harp",
    title: "Low-pass Filter",
    blurb: "A low-pass filter that removes brightness above the cutoff. The core tone control, from harsh to warm.",
    params: [
      {
        addr: 49, name: "Cutoff (base freq)", card: "Filter", unit: "Hz", min: 0, max: 2000, step: 1,
        type: "int", curve: "exponential", def: 500,
        explain: {
          is: "The cutoff of the filter, its resting point before the filter envelope moves it.",
          does: "Low = dark, muffled, mellow. High = open and bright, the oscillator's full character through.",
          tips: "A few hundred Hz for warm, dark tones; past ~1.5 kHz for bright, present sounds."
        }
      },
      {
        addr: 50, name: "Keytrack", card: "Filter", unit: "", min: 0, max: 3, step: 0.01,
        type: "float", curve: "linear", def: 0.4,
        explain: {
          is: "How much the cutoff follows the pitch of each note, keytracking.",
          does: "0 = a fixed cutoff, so high notes turn out duller. High = brightness tracks pitch, keeping the timbre consistent.",
          tips: "Around 0.3–0.5 keeps timbre even across the range; 0 for a darker top end."
        }
      },
      {
        addr: 51, name: "Resonance", card: "Filter", unit: "", min: 0.7, max: 5, step: 0.01,
        type: "float", curve: "linear", def: 0.7,
        explain: {
          is: "The resonance of the filter, a peak right at the cutoff.",
          does: "Low = a gentle, natural tone control. High = a ringing, vocal, squelchy whistle at the cutoff.",
          tips: "Near 0.7 for clean sounds; raise for squelchy basses and expressive filter sweeps."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "filter_env",
    domain: "harp",
    title: "Filter Envelope",
    blurb: "A second envelope that sweeps the filter cutoff over time, independent of amplitude. Bright then dark.",
    params: [
      {
        addr: 58, name: "Filter sensitivity", card: "Shape", unit: "", min: 0, max: 5, step: 0.01,
        type: "float", curve: "linear", def: 0.0,
        explain: {
          is: "How strongly the filter envelope sweeps the cutoff, the depth of the whole effect.",
          does: "0 = the envelope does nothing; the cutoff stays at its base. High = a wide sweep, a bright bloom at note onset.",
          tips: "The master switch for this section: at 0, none of the times below matter."
        }
      },
      {
        addr: 52, name: "Attack", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 3,
        explain: {
          is: "Time for the filter to sweep open to its peak brightness when a note starts.",
          does: "Short = a zappy, percussive snap of brightness. Long = a slow, swelling sweep open.",
          tips: "Short for snappy plucks; lengthen for evolving, swelling textures."
        }
      },
      {
        addr: 53, name: "Hold", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 35,
        explain: {
          is: "Time the filter stays at peak brightness before it starts closing.",
          does: "Short = starts closing soon after opening. Long = holds the bright phase before decay.",
          tips: "A short hold keeps the bright ping present before the tone darkens."
        }
      },
      {
        addr: 54, name: "Decay", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 90,
        explain: {
          is: "Time for the cutoff to fall from its peak down to the sustain level.",
          does: "Short = a bright-to-dark snap at the onset. Long = a slow, gradual darkening.",
          tips: "Short decay + low filter sustain gives a plucky filter snap; longer for slowly-closing pads."
        }
      },
      {
        addr: 55, name: "Sustain", card: "Sustain & release", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.5,
        explain: {
          is: "The cutoff level the filter envelope holds at while the note is held (relative to its sweep range).",
          does: "Low = after the initial sweep the tone settles dark. High = the filter stays open and bright for the held portion.",
          tips: "Low sustain gives a bright attack that settles into a darker body, very natural for plucked sounds."
        }
      },
      {
        addr: 56, name: "Release", card: "Sustain & release", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 2500,
        explain: {
          is: "Time for the filter to return to its base cutoff after the note is released.",
          does: "Short = brightness drops away quickly on release. Long = the filter keeps moving through the tail.",
          tips: "Match loosely to the amplitude release for a cohesive tail."
        }
      },
      {
        addr: 57, name: "Retrigger release", card: "Sustain & release", unit: "ms", min: 0, max: 100, step: 1,
        type: "int", curve: "exponential", def: 1,
        explain: {
          is: "Small smoothing applied to the filter envelope when a note is retriggered quickly.",
          does: "Short = fast retriggers can jump abruptly in tone. Long = filter movement is smoothed between quick repeated notes.",
          tips: "Leave low unless fast retriggers sound glitchy in the filter movement."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "transient",
    domain: "harp",
    title: "Transient",
    blurb: "A short percussive click layered at each note's onset. The attack of a pluck or hammer, with its own oscillator and AHD shape.",
    params: [
      {
        addr: 101, name: "Amount", card: "Mix & tone", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.1,
        explain: {
          is: "The level of the transient click relative to the note.",
          does: "Off = no transient. Full = a pronounced percussive tick at each onset.",
          tips: "The master switch here: at 0 nothing else matters. A little adds articulation; a lot reads as a distinct hit."
        }
      },
      {
        addr: 100, name: "Waveform", card: "Mix & tone", unit: "", min: 0, max: 11, step: 1,
        type: "int", curve: "linear", def: 0,
        options: WAVEFORMS.map(w => w.label),
        explain: {
          is: "The waveform of the transient click, the same 12 oscillators as the voice.",
          does: "Simple = a soft, rounded thud. Rich = a brighter, clickier, more percussive tick.",
          tips: "Sample & hold or pulse for a sharp click; sine or triangle for a soft thump."
        }
      },
      {
        addr: 102, name: "Attack", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 10,
        explain: {
          is: "Time for the transient to rise to its peak.",
          does: "Short = an instant tick. Long = the click softens into a quick swell.",
          tips: "A few ms for a true transient; longer blurs it into the note."
        }
      },
      {
        addr: 103, name: "Hold", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 10,
        explain: {
          is: "Time the transient stays at full level before decaying.",
          does: "Short = the click falls away at once. Long = it lingers briefly before fading."
        }
      },
      {
        addr: 104, name: "Decay", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1,
        type: "int", curve: "exponential", def: 40,
        explain: {
          is: "Time for the transient to fade back to silence after the hold.",
          does: "Short = a crisp tick. Long = the click smears into a percussive blip.",
          tips: "Under ~80 ms keeps the transient distinct from the body."
        }
      },
      {
        addr: 105, name: "Note level", card: "Mix & tone", unit: "", min: 0, max: 24, step: 1,
        type: "int", curve: "linear", def: 0,
        explain: {
          is: "How many scale steps above the note the transient is pitched.",
          does: "0 = the transient sits at the note's pitch. High = a brighter, bell-like ping up the scale.",
          tips: "0 for a neutral attack tick; raise for a pitched ping on each note."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "tremolo",
    domain: "harp",
    title: "Tremolo",
    blurb: "A repeating wobble in volume, an LFO cycling the loudness up and down. Depth sets how much, Rate sets how fast.",
    params: [
      {
        addr: 61, name: "Depth", card: "Shape", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.0,
        explain: {
          is: "How much the tremolo moves the amplitude, the depth of the effect.",
          does: "Off = no tremolo. Full = a strong, choppy on/off throb.",
          tips: "At 0 the rate and waveform do nothing; subtle depth adds life to held notes."
        }
      },
      {
        addr: 60, name: "Rate", card: "Shape", unit: "Hz", min: 0, max: 20, step: 0.1,
        type: "float", curve: "linear", def: 0.0,
        explain: {
          is: "How fast the amplitude wobbles, in cycles per second.",
          does: "Slow = a gentle swell in and out. Fast = a fluttering, buzzing shake.",
          tips: "Around 4–7 Hz is a classic musical tremolo; very fast rates blur to a buzz."
        }
      },
      {
        addr: 59, name: "Waveform", card: "Shape", unit: "", min: 0, max: 11, step: 1,
        type: "int", curve: "linear", def: 0,
        options: WAVEFORMS.map(w => w.label),
        explain: {
          is: "The shape the tremolo follows as it cycles the volume.",
          does: "Sine/triangle = smooth swells. Square = an abrupt on/off chop. Sawtooth = a ramp then a snap.",
          tips: "Sine for natural shimmer, square for rhythmic gating. Stepped shapes (sample & hold) can click."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "vibrato",
    domain: "harp",
    title: "Vibrato",
    blurb: "A repeating wobble in pitch: an LFO bending the note up and down, with its own envelope and a separate pitch-bend.",
    params: [
      { addr: 64, name: "Depth", card: "Movement", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How far the vibrato bends the pitch up and down, the depth of the effect.", does: "Off = no vibrato. Full = a wide, dramatic pitch wobble.", tips: "At 0 the rest of this section is silent; small amounts add expressive life." } },
      { addr: 63, name: "Rate", card: "Movement", unit: "Hz", min: 0, max: 20, step: 0.1, type: "float", curve: "linear", def: 0,
        explain: { is: "How fast the pitch wobbles, in cycles per second.", does: "Slow = a lazy, wide waver. Fast = a tight, nervous flutter.", tips: "Around 4–7 Hz is a natural musical vibrato. Pair with a fade-in envelope for a vocal feel." } },
      { addr: 62, name: "Waveform", card: "Movement", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The shape the pitch follows as it wobbles.", does: "Sine/triangle = smooth, natural vibrato. Square = an abrupt trill between two pitches. Saw = a repeating slide.", tips: "Sine for classic vibrato; square for a two-note trill effect." } },
      { addr: 76, name: "Intensity", card: "Movement", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.15,
        explain: { is: "An overall multiplier on the whole vibrato and pitch-bend section.", does: "Scales both the wobble and the bend together, a master amount for the pitch movement.", tips: "Leave near the default unless dialling the whole pitch-movement effect up or down at once." } },
      { addr: 65, name: "Attack", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato to fade in after a note starts.", does: "Short = vibrato is present immediately. Long = the note starts straight, then the wobble blooms in.", tips: "A 300–800 ms attack gives that expressive 'comes in as the note sustains' vocal/string feel." } },
      { addr: 66, name: "Hold", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time the vibrato stays at full depth before its envelope decays.", does: "Extends the full-depth phase before any fall-off." } },
      { addr: 67, name: "Decay", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato depth to fall from full to its sustain level.", does: "Short = quickly settles to the sustain depth. Long = a slow easing of the wobble.", tips: "Pair with a sustain below 1 to make vibrato ease off as the note holds." } },
      { addr: 68, name: "Sustain", card: "Envelope", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "The vibrato depth held while the note is held (relative to full).", does: "1 = vibrato stays at full depth. Lower = it settles to a gentler wobble after the decay.", tips: "Default is full. Lower for vibrato that fades back after blooming in." } },
      { addr: 69, name: "Release", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato to fade out after the note is released.", does: "Short = the wobble stops with the note. Long = it lingers into the release tail.", tips: "Match loosely to the amplitude release for a cohesive fade." } },
      { addr: 70, name: "Retrigger", card: "Envelope", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Smoothing of the vibrato envelope on quick retriggers.", does: "Keeps fast repeated notes from jumping the wobble abruptly.", tips: "Leave low unless fast retriggers sound glitchy." } },
      { addr: 71, name: "Amount", card: "Pitch bend", unit: "", min: 0, max: 2, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "A steady pitch offset on top of the vibrato: 1 is centre, below bends down, above bends up.", does: "Slides the pitch away from centre: a scoop or fall shaped by the bend envelope below.", tips: "Keep at 1 for none; set away from 1 with a short bend attack for a scoop into each note." } },
      { addr: 72, name: "Attack", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the pitch bend to reach its target after a note starts.", does: "Short = an instant bend. Long = a slow glide up/down into pitch.", tips: "A short attack gives a snappy scoop; long gives a portamento-like slide." } },
      { addr: 73, name: "Hold", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time the bend stays at its target before decaying back.", does: "Holds the bent pitch before it returns toward centre.", tips: "Short for a quick scoop-and-return." } },
      { addr: 74, name: "Decay", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the bend to return from its target back toward centre.", does: "Short = snaps back. Long = a slow drift back to pitch.", tips: "Controls how the scoop resolves." } },
      { addr: 75, name: "Retrigger", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Smoothing of the pitch-bend envelope on quick retriggers.", does: "Keeps repeated notes from snapping the bend abruptly.", tips: "Leave low unless fast retriggers click." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "delay",
    domain: "harp",
    title: "Delay & Crunch",
    blurb: "Post-voice harp effects: a delay with a multimode filter in its feedback path, a dry/wet balance, a reverb send, and a crunch stage.",
    params: [
      { addr: 84, name: "Delay mix", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much of the delayed (echoed) signal is in the output.", does: "0 = no echo. Higher = louder, more present repeats trailing each note.", tips: "This is the on/off for the delay. Balance it against Dry mix below." } },
      { addr: 77, name: "Time", card: "Delay & mix", unit: "ms", min: 0, max: 600, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "The time between echoes.", does: "Short = a tight slapback or comb effect. Long = distinct, spaced repeats.", tips: "Short (<80 ms) for thickening; longer for rhythmic echoes." } },
      { addr: 83, name: "Dry mix", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "How much of the original, un-delayed signal is in the output.", does: "1 = full dry signal. Lower = the dry sound recedes behind the echoes.", tips: "Lower it for a more washed, effected sound; keep at 1 to layer echoes on top." } },
      { addr: 85, name: "Reverb send", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.05,
        explain: { is: "How much of the harp is sent to the global reverb.", does: "0 = dry harp. Higher = more of the shared room reverb on the harp voice.", tips: "The reverb itself is shaped in the Space section (Global)." } },
      { addr: 78, name: "Filter freq", card: "Delay filter", unit: "Hz", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 0,
        explain: { is: "The cutoff of the filter inside the delay's feedback loop.", does: "Low = each echo repeats darker and warmer. High = the repeats keep their brightness.", tips: "Lower it for echoes that darken as they fade, classic dub delay." } },
      { addr: 79, name: "Filter reso", card: "Delay filter", unit: "", min: 0.7, max: 5, step: 0.01, type: "float", curve: "linear", def: 0.7,
        explain: { is: "Resonance of the delay's feedback filter.", does: "Higher adds a ringing emphasis to the echoes at the filter frequency.", tips: "Raise for whistling, resonant dub repeats." } },
      { addr: 80, name: "Low-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much low-pass-filtered signal feeds back into the delay.", does: "Emphasises the low/warm component of the echoes.", tips: "Mix with band-pass/high-pass to voice the feedback tone." } },
      { addr: 81, name: "Band-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much band-pass-filtered signal feeds back into the delay.", does: "Emphasises a midrange band of the echoes, hollow, telephone-like repeats.", tips: "Use for narrow, focused echo tones." } },
      { addr: 82, name: "High-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much high-pass-filtered signal feeds back into the delay.", does: "Emphasises the bright/thin component of the echoes.", tips: "Use for thin, airy repeats that don't build up mud." } },
      { addr: 86, name: "Amount", card: "Crunch", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Amount of waveshaping distortion applied to the harp.", does: "0 = clean. Higher = grittier, dirtier, more saturated.", tips: "A little adds warmth and edge; a lot gets aggressive and lofi." } },
      { addr: 87, name: "Type", card: "Crunch", unit: "", min: 0, max: 2, step: 1, type: "int", curve: "linear", def: 0, options: ["Soft", "Medium", "Hard"],
        optionNotes: ["A gentle, soft-clipping warmth.", "A moderate, fuzzier shape.", "A hard, heavily-distorted shape."],
        explain: { is: "Which distortion curve the crunch uses.", does: "Soft → Medium → Hard get progressively more distorted.", tips: "Pick the character here, then dial the amount with Crunch above." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "output_filter",
    domain: "harp",
    title: "Output filter",
    blurb: "A final multimode filter on the harp output: blend low-pass, band-pass and high-pass, optionally swept by its own LFO, plus the harp's output level.",
    params: [
      { addr: 88, name: "Frequency", card: "Filter & output", unit: "Hz", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1400,
        explain: { is: "The cutoff of the output filter.", does: "Low = a darker, more filtered output. High = brighter and more open.", tips: "Filters the whole harp after everything else, a final tone-shaping stage." } },
      { addr: 89, name: "Resonance", card: "Filter & output", unit: "", min: 0.7, max: 5, step: 0.01, type: "float", curve: "linear", def: 2,
        explain: { is: "The resonance of the output filter, a peak at the cutoff.", does: "Low = flat and natural. High = a ringing, vocal, squelchy peak.", tips: "Pair with the LFO for expressive auto-wah sweeps." } },
      { addr: 90, name: "Low-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.25,
        explain: { is: "How much low-pass output is blended in.", does: "Lets lows through and cuts highs, warm, rounded.", tips: "This filter is multimode: blend LP/BP/HP to taste." } },
      { addr: 91, name: "Band-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.75,
        explain: { is: "How much band-pass output is blended in.", does: "Keeps only a midrange band, hollow, nasal, focused.", tips: "High band-pass gives a vocal, mid-forward character." } },
      { addr: 92, name: "High-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.3,
        explain: { is: "How much high-pass output is blended in.", does: "Lets highs through and cuts lows, thin, airy, bright.", tips: "Raise to remove low-end weight from the output." } },
      { addr: 96, name: "Sensitivity", card: "LFO", unit: "", min: 0, max: 5, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How strongly the LFO moves the output filter, the depth of the sweep.", does: "0 = the filter sits still. Higher = the LFO sweeps the cutoff for an auto-wah / tremolo-filter effect.", tips: "At 0 the LFO controls below do nothing. Raise it to hear the sweep." } },
      { addr: 94, name: "Rate", card: "LFO", unit: "Hz", min: 0, max: 20, step: 0.1, type: "float", curve: "linear", def: 0,
        explain: { is: "How fast the output-filter LFO sweeps.", does: "Slow = a gradual wah. Fast = a fluttering filter shimmer.", tips: "Slow rates for evolving movement; fast for rhythmic texture." } },
      { addr: 95, name: "Depth", card: "LFO", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Amplitude of the output-filter LFO.", does: "Sets how far the LFO pushes the cutoff (alongside sensitivity).", tips: "Works together with LFO sensitivity to size the sweep." } },
      { addr: 93, name: "Waveform", card: "LFO", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The shape the output-filter LFO follows.", does: "Sine/triangle = smooth sweeps. Square = an abrupt two-state jump. Saw = a ramp.", tips: "Sine for classic auto-wah; square for rhythmic filter gating." } },
      { addr: 97, name: "Level", card: "Filter & output", unit: "", min: 0, max: 2, step: 0.01, type: "float", curve: "linear", def: 1.5,
        explain: { is: "The overall output gain of the harp.", does: "Low = attenuated and quiet. High = boosted, driving the output stage harder.", tips: "Use to balance the harp against the chord voice." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "harp_general",
    domain: "harp",
    title: "General",
    blurb: "Voice-wide settings for the harp section: its octave, the strumming pattern, and whether it plays chromatically.",
    params: [
      {
        addr: 99, name: "Octave", card: "Notes & layout", unit: "", min: 0, max: 4, step: 1,
        type: "int", curve: "linear", def: 2,
        options: ["−2 octaves", "−1 octave", "Normal", "+1 octave", "+2 octaves"],
        seg: ["−2", "−1", "0", "+1", "+2"],
        optionNotes: [
          "Two octaves down: deep and bass-like.",
          "One octave down: fuller, lower.",
          "The harp's normal register.",
          "One octave up: brighter, lighter.",
          "Two octaves up: high and chime-like.",
        ],
        explain: {
          is: "Shifts the whole harp section up or down in octaves.",
          does: "Down = deeper, heavier. Up = brighter, more delicate and bell-like.",
          tips: "'Normal' is the default centre. Use octave shifts to move the harp out of the way of the chord voice, or to reach bell/bass registers."
        }
      },
      {
        addr: 40, name: "Strum pattern", card: "Notes & layout", unit: "", min: 0, max: 6, step: 1,
        type: "int", curve: "linear", def: 0,
        options: ["Normal", "With second", "With fourth", "With sixth", "Octaves", "Chromatic", "Barry Harris (keymaster)"],
        optionNotes: [
          "Standard harp layout following the chord.",
          "Adds the second above each note.",
          "Adds the fourth above each note.",
          "Adds the sixth above each note: lush, harp-like.",
          "Doubles each note an octave up.",
          "Chromatic run across the strings.",
          "Layout tuned for a keymaster touchplate in Barry Harris mode.",
        ],
        explain: {
          is: "Which notes the harp strings lay out as you strum across them.",
          does: "Plain = the chord notes. Rich = stacked intervals like sixths and octaves, or chromatic runs.",
          tips: "'With sixth' is a classic lush harp; 'Octaves' thickens; 'Chromatic' is for runs."
        }
      },
      {
        addr: 98, name: "Chromatic mode", card: "Notes & layout", unit: "", min: 0, max: 1, step: 1,
        type: "int", curve: "linear", def: 0,
        options: ["Off: follows the chord", "On: fixed chromatic notes"],
        seg: ["Off", "On"],
        optionNotes: [
          "The harp's notes track the selected chord (the usual behaviour).",
          "The harp plays fixed chromatic notes, independent of the chord.",
        ],
        explain: {
          is: "Whether the harp notes follow the current chord or stay on fixed chromatic pitches.",
          does: "Off = strings re-tune to fit each chord you hold. On = the strings are a fixed chromatic set, ignoring the chord.",
          tips: "Leave Off for the usual chord-aware harp. Turn On for melodic playing where you want consistent, predictable pitches."
        }
      },
    ]
  },
  /* ===== CHORD VOICE ===================================================== */
  {
    id: "chord_oscillator",
    domain: "chord",
    title: "Oscillator",
    blurb: "The chord voice's raw tone: three stacked oscillators plus a noise layer, with the four chord notes voiced and strummed below.",
    params: [
      { addr: 121, name: "Amplitude", card: "Oscillator 1", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.15,
        explain: { is: "Level of the first oscillator in the stack.", does: "Sets how much of oscillator 1 is in the blend. 0 mutes it.", tips: "Osc 1 is the core tone by default. Balance the three amplitudes to mix timbres." } },
      { addr: 122, name: "Waveform", card: "Oscillator 1", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 8, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The waveform of oscillator 1.", does: "Simple = sine and triangle, soft and dark. Rich = saw, square and pulse, bright and buzzy.", tips: "The default 'Variable triangle' is a soft, shaped tone; a brighter shape adds harmonics." } },
      { addr: 123, name: "Frequency ×", card: "Oscillator 1", unit: "×", min: 0.5, max: 2, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "Tuning multiplier for oscillator 1 relative to the played pitch.", does: "1 = in tune. 0.5 = an octave down, 2 = an octave up. Values between detune it for beating/chorus.", tips: "Keep at 1 for the fundamental. Slight offsets (e.g. 1.01) add movement; 0.5/2 stack octaves." } },

      { addr: 124, name: "Amplitude", card: "Oscillator 2", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.15,
        explain: { is: "Level of the second oscillator in the stack.", does: "Sets how much of oscillator 2 is in the blend. 0 mutes it.", tips: "Bring osc 2 in (tuned an octave up by default) to fatten or brighten the stack." } },
      { addr: 125, name: "Waveform", card: "Oscillator 2", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The waveform of oscillator 2.", does: "Layers a contrasting shape against osc 1, e.g. a sine sub under a bright saw.", tips: "Mixing waveforms across the three oscillators gives the chord voice its richness." } },
      { addr: 126, name: "Frequency ×", card: "Oscillator 2", unit: "×", min: 0.5, max: 2, step: 0.01, type: "float", curve: "linear", def: 2,
        explain: { is: "Tuning multiplier for oscillator 2.", does: "1 = unison. Default 2 = an octave above, adding brightness and shimmer.", tips: "Octave stacking (2×) thickens; small detune adds chorus-like width." } },

      { addr: 127, name: "Amplitude", card: "Oscillator 3", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Level of the third oscillator in the stack.", does: "Sets how much of oscillator 3 is in the blend. Off by default.", tips: "Bring osc 3 in (tuned an octave down by default) for a sub-octave weight." } },
      { addr: 128, name: "Waveform", card: "Oscillator 3", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The waveform of oscillator 3.", does: "Often a sine or triangle for a clean sub layer beneath the others.", tips: "A pure sine on osc 3 at 0.5× makes a solid sub-octave foundation." } },
      { addr: 129, name: "Frequency ×", card: "Oscillator 3", unit: "×", min: 0.5, max: 2, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "Tuning multiplier for oscillator 3.", does: "1 = unison. Default 0.5 = an octave below, adding low-end weight.", tips: "0.5× is a sub-octave; raise toward 1 to fold it into the body." } },

      { addr: 131, name: "Note 1", card: "Voicing", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "Level of the chord's first (lowest) note.", does: "Sets how loud the root/lowest voice of the chord sits in the blend.", tips: "Balance the four note levels to shape the chord's voicing, emphasise the bass or the top." } },
      { addr: 132, name: "Note 2", card: "Voicing", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "Level of the chord's second note.", does: "Sets how loud the second voice of the chord sits in the blend.", tips: "Lower an inner voice to thin the chord; raise it to bring out a tension." } },
      { addr: 133, name: "Note 3", card: "Voicing", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "Level of the chord's third note.", does: "Sets how loud the third voice of the chord sits in the blend.", tips: "Useful for dialling how prominent the chord's color tones are." } },
      { addr: 134, name: "Note 4", card: "Voicing", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "Level of the chord's fourth (highest) note.", does: "Sets how loud the top voice of the chord sits in the blend.", tips: "Raise for a brighter, top-heavy voicing; lower for a darker, rootier one." } },
      { addr: 130, name: "Noise level", card: "Strum & noise", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Amount of noise mixed into the chord voice.", does: "0 = clean tonal sound. Higher = adds breath, air or grit on top of the oscillators.", tips: "A touch of noise adds texture and a lofi 'air'; a lot makes it breathy or percussive." } },
      { addr: 135, name: "Strum delay", card: "Strum & noise", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "Delay between successive chord notes when the chord sounds.", does: "0 = all notes hit together (a block chord). Higher = the notes arrive one after another, like a strum or roll.", tips: "Small values give a gentle strum; larger spreads it into a harp-like roll." } },
      { addr: 136, name: "Random delay", card: "Strum & noise", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "Random timing jitter added to each note's entry.", does: "Loosens the strum so notes don't land perfectly evenly, a more human, played feel.", tips: "A little humanises the chord; pair with Strum delay for a natural roll." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_amp_env",
    domain: "chord",
    title: "Amplitude Envelope",
    blurb: "How each chord's amplitude evolves over time. The AHDSR envelope, usually slower and more pad-like than the harp.",
    params: [
      { addr: 137, name: "Attack", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 10,
        explain: { is: "Time for a chord to rise from silence to full volume after it's triggered.", does: "Short = the chord jumps in instantly. Long = it swells in gradually, pad-like.", tips: "Short for stabs and rhythmic comping; long for evolving pads and washes." } },
      { addr: 138, name: "Hold", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 70,
        explain: { is: "Time the chord stays at full volume after the attack, before decay.", does: "Adds a brief plateau at the top before the level falls.", tips: "A little hold makes chords feel more solid before they settle." } },
      { addr: 139, name: "Decay", card: "Shape", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 400,
        explain: { is: "Time to fall from the peak down to the sustain level after the hold.", does: "Short = a quick settle to sustain. Long = a gradual easing down.", tips: "Pair short decay + low sustain for a plucked, decaying chord." } },
      { addr: 140, name: "Sustain", card: "Sustain & release", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.75,
        explain: { is: "The level the chord holds at while it's held, after decay.", does: "0 = the chord dies away even while held. High = it rings on steadily, organ or pad.", tips: "High for sustained pads; low for plucked, decaying chords. This is a level, not a time." } },
      { addr: 141, name: "Release", card: "Sustain & release", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1000,
        explain: { is: "Time for the chord to fade to silence after it's let go.", does: "Short = stops cleanly on release. Long = a lingering tail that rings out.", tips: "Longer releases overlap chord changes into a smooth, ambient wash." } },
      { addr: 142, name: "Retrigger release", card: "Sustain & release", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Quick fade applied when the same chord is retriggered.", does: "Smooths the jump when a held chord restarts, avoiding clicks.", tips: "Leave low unless fast retriggers click or glitch." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_filter",
    domain: "chord",
    title: "Low-pass Filter",
    blurb: "A low-pass filter shaping the chord's brightness, with its own envelope (so the cutoff can move per note) and an LFO (for auto-wah / sweeping movement).",
    params: [
      { addr: 143, name: "Cutoff (base freq)", card: "Filter", unit: "Hz", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 600,
        explain: { is: "The base cutoff frequency of the chord's low-pass filter.", does: "Low = dark and muffled, only lows pass. High = bright and open.", tips: "This is the resting cutoff; the envelope and LFO below move it around this point." } },
      { addr: 144, name: "Keytrack", card: "Filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.15,
        explain: { is: "How much the cutoff follows the pitch of the chord.", does: "0 = the cutoff is fixed. Higher = higher chords open the filter more, keeping brightness consistent across the range.", tips: "Raise so high voicings stay as bright as low ones." } },
      { addr: 145, name: "Resonance", card: "Filter", unit: "", min: 0.7, max: 5, step: 0.01, type: "float", curve: "linear", def: 1.5,
        explain: { is: "The resonance of the filter, a peak at the cutoff.", does: "Low = flat and natural. High = a ringing, vocal, squelchy peak.", tips: "Raise for expressive sweeps; very high can self-oscillate and whistle." } },
      { addr: 155, name: "Sensitivity", card: "Envelope", unit: "", min: 0, max: 5, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "How far the filter envelope moves the cutoff, the depth of the sweep.", does: "0 = the envelope does nothing. Higher = each note sweeps the cutoff further from the base frequency.", tips: "At 0 the envelope controls below are silent. Raise to hear the filter move per note." } },
      { addr: 146, name: "Attack", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 30,
        explain: { is: "Time for the filter envelope to rise after a note starts.", does: "Short = an instant filter snap. Long = a slow opening sweep.", tips: "Short attack gives a plucky filter 'zap'; long gives a swelling wah." } },
      { addr: 147, name: "Hold", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 90,
        explain: { is: "Time the filter envelope stays at its peak before decaying.", does: "Holds the open (or swept) cutoff briefly before it falls.", tips: "Usually short; extend to keep the filter open longer into the note." } },
      { addr: 148, name: "Decay", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 30,
        explain: { is: "Time for the filter to fall from peak to its sustain cutoff.", does: "Short = a quick filter pluck. Long = a gradual close.", tips: "Short decay + low sustain gives a classic plucky filter envelope." } },
      { addr: 149, name: "Sustain", card: "Sustain & release", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.5,
        explain: { is: "The cutoff level the filter holds at while the note is held.", does: "Sets where the filter settles after the decay (relative to the swept range).", tips: "Lower for a filter that closes down as the chord holds." } },
      { addr: 150, name: "Release", card: "Sustain & release", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 50,
        explain: { is: "Time for the filter envelope to fall back after the note is released.", does: "Short = the filter resets quickly. Long = it keeps moving into the tail.", tips: "Match loosely to the amplitude release for a cohesive fade." } },
      { addr: 151, name: "Retrigger release", card: "Sustain & release", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Quick smoothing of the filter envelope on retrigger.", does: "Avoids an abrupt cutoff jump when a held chord restarts.", tips: "Leave low unless retriggers sound glitchy." } },
      { addr: 152, name: "Waveform", card: "LFO", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The shape the filter LFO follows.", does: "Sine/triangle = smooth sweeps. Square = an abrupt two-state jump. Saw = a ramp.", tips: "Sine for classic auto-wah; square for rhythmic filter gating." } },
      { addr: 153, name: "Rate", card: "LFO", unit: "Hz", min: 0, max: 20, step: 0.1, type: "float", curve: "linear", def: 0,
        explain: { is: "How fast the filter LFO sweeps the cutoff.", does: "Slow = a gradual wah. Fast = a fluttering filter shimmer.", tips: "Slow rates for evolving movement; fast for rhythmic texture." } },
      { addr: 154, name: "Depth", card: "LFO", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How far the LFO pushes the cutoff.", does: "0 = the LFO does nothing. Higher = a wider filter sweep.", tips: "At 0 the rate and waveform are silent. Raise to hear the sweep." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_tremolo",
    domain: "chord",
    title: "Tremolo",
    blurb: "A repeating wobble in volume, an LFO modulating the chord's level up and down.",
    params: [
      { addr: 159, name: "Depth", card: "Shape", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.2,
        explain: { is: "How far the tremolo moves the amplitude, the depth of the effect.", does: "Off = no tremolo. Full = a deep, choppy throb.", tips: "At 0 the rest of this section is silent; subtle amounts add life to a held chord." } },
      { addr: 157, name: "Rate", card: "Shape", unit: "Hz", min: 0, max: 20, step: 0.1, type: "float", curve: "linear", def: 4,
        explain: { is: "How fast the volume wobbles, in cycles per second.", does: "Slow = a lazy swell. Fast = a fluttering chop.", tips: "A few Hz is a classic tremolo; faster gets buzzy and rhythmic." } },
      { addr: 156, name: "Waveform", card: "Shape", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The shape the volume follows as it wobbles.", does: "Sine/triangle = smooth pulsing. Square = an abrupt on/off chop. Saw = a repeating fade.", tips: "Sine for gentle tremolo; square for a gated, choppy effect." } },
      { addr: 158, name: "Keytrack", card: "Shape", unit: "", min: 0, max: 5, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much the tremolo rate follows the chord's pitch.", does: "0 = a fixed rate. Higher = higher chords wobble faster.", tips: "Leave at 0 for a steady tremolo; raise for a pitch-linked flutter." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_vibrato",
    domain: "chord",
    title: "Vibrato",
    blurb: "A repeating wobble in pitch: an LFO bending the chord up and down, with its own envelope and a separate pitch-bend that slides the pitch over each chord.",
    params: [
      { addr: 163, name: "Depth", card: "Movement", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How far the vibrato bends the pitch up and down, the depth of the effect.", does: "Off = no vibrato. Full = a wide, seasick wobble.", tips: "At 0 the rest of this section is silent; small amounts add expressive life." } },
      { addr: 161, name: "Rate", card: "Movement", unit: "Hz", min: 0, max: 20, step: 0.1, type: "float", curve: "linear", def: 0,
        explain: { is: "How fast the pitch wobbles, in cycles per second.", does: "Slow = a lazy, wide waver. Fast = a tight flutter.", tips: "Around 4–7 Hz is a natural musical vibrato." } },
      { addr: 160, name: "Waveform", card: "Movement", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0, options: WAVEFORMS.map(w => w.label),
        explain: { is: "The shape the pitch follows as it wobbles.", does: "Sine/triangle = smooth, natural vibrato. Square = a trill between two pitches.", tips: "Sine for classic vibrato; square for a two-note trill." } },
      { addr: 162, name: "Keytrack", card: "Movement", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much the vibrato rate follows the chord's pitch.", does: "0 = a fixed rate. Higher = higher chords waver faster.", tips: "Leave at 0 for a steady vibrato; raise for a pitch-linked flutter." } },
      { addr: 175, name: "Intensity", card: "Movement", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "An overall multiplier on the whole vibrato and pitch-bend section.", does: "Scales both the wobble and the bend together, a master amount for pitch movement.", tips: "Leave low unless dialling the whole pitch-movement effect up or down at once." } },
      { addr: 164, name: "Attack", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato to fade in after a chord starts.", does: "Short = vibrato is present immediately. Long = the chord starts straight, then the wobble blooms in.", tips: "A 300–800 ms attack gives an expressive, vocal feel." } },
      { addr: 165, name: "Hold", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time the vibrato stays at full depth before its envelope decays.", does: "Extends the full-depth phase before any fall-off." } },
      { addr: 166, name: "Decay", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato depth to fall from full to its sustain level.", does: "Short = quickly settles to the sustain depth. Long = a slow easing of the wobble.", tips: "Pair with a sustain below 1 for vibrato that eases off as the chord holds." } },
      { addr: 167, name: "Sustain", card: "Envelope", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "The vibrato depth held while the chord is held (relative to full).", does: "1 = vibrato stays at full depth. Lower = it settles to a gentler wobble after the decay.", tips: "Lower for vibrato that fades back after blooming in." } },
      { addr: 168, name: "Release", card: "Envelope", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the vibrato to fade out after the chord is released.", does: "Short = the wobble stops with the chord. Long = it lingers into the release tail.", tips: "Match loosely to the amplitude release for a cohesive fade." } },
      { addr: 169, name: "Retrigger", card: "Envelope", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Smoothing of the vibrato envelope on quick retriggers.", does: "Keeps fast repeated chords from jumping the wobble abruptly.", tips: "Leave low unless fast retriggers sound glitchy." } },
      { addr: 170, name: "Amount", card: "Pitch bend", unit: "", min: 0, max: 2, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "A steady pitch offset on top of the vibrato: 1 is centre, below bends down, above bends up.", does: "Slides the pitch away from centre: a scoop or fall shaped by the bend envelope below.", tips: "Keep at 1 for none; set away from 1 with a short attack for a scoop into each chord." } },
      { addr: 171, name: "Attack", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the pitch bend to reach its target after a chord starts.", does: "Short = an instant bend. Long = a slow glide into pitch.", tips: "Short for a snappy scoop; long for a portamento-like slide." } },
      { addr: 172, name: "Hold", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time the bend stays at its target before decaying back.", does: "Holds the bent pitch before it returns toward centre.", tips: "Short for a quick scoop-and-return." } },
      { addr: 173, name: "Decay", card: "Pitch bend", unit: "ms", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Time for the bend to return from its target back toward centre.", does: "Short = snaps back. Long = a slow drift back to pitch.", tips: "Controls how the scoop resolves." } },
      { addr: 174, name: "Retrigger", card: "Pitch bend", unit: "ms", min: 0, max: 100, step: 1, type: "int", curve: "exponential", def: 1,
        explain: { is: "Smoothing of the pitch-bend envelope on quick retriggers.", does: "Keeps repeated chords from snapping the bend abruptly.", tips: "Leave low unless fast retriggers click." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_delay",
    domain: "chord",
    title: "Delay & Crunch",
    blurb: "Post-voice chord effects: a delay with a multimode filter in its feedback path, a dry/wet balance, a reverb send, and a crunch stage.",
    params: [
      { addr: 183, name: "Delay mix", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much of the delayed (echoed) signal is in the output.", does: "0 = no echo. Higher = louder, more present repeats trailing each chord.", tips: "This is the on/off for the delay. Balance it against Dry mix." } },
      { addr: 176, name: "Time", card: "Delay & mix", unit: "ms", min: 0, max: 600, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "The time between echoes.", does: "Short = a tight slapback or comb effect. Long = distinct, spaced repeats.", tips: "Short (<80 ms) for thickening; longer for rhythmic echoes." } },
      { addr: 177, name: "Filter freq", card: "Delay filter", unit: "Hz", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 0,
        explain: { is: "The cutoff of the filter inside the delay's feedback loop.", does: "Low = each echo repeats darker and warmer. High = the repeats keep their brightness.", tips: "Lower it for echoes that darken as they fade, classic dub delay." } },
      { addr: 178, name: "Filter reso", card: "Delay filter", unit: "", min: 0.7, max: 5, step: 0.01, type: "float", curve: "linear", def: 0.7,
        explain: { is: "Resonance of the delay's feedback filter.", does: "Higher adds a ringing emphasis to the echoes at the filter frequency.", tips: "Raise for whistling, resonant dub repeats." } },
      { addr: 179, name: "Low-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much low-pass-filtered signal feeds back into the delay.", does: "Emphasises the low/warm component of the echoes.", tips: "Mix with band-pass/high-pass to voice the feedback tone." } },
      { addr: 180, name: "Band-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much band-pass-filtered signal feeds back into the delay.", does: "Emphasises a midrange band of the echoes, hollow, telephone-like repeats.", tips: "Use for narrow, focused echo tones." } },
      { addr: 181, name: "High-pass", card: "Delay filter", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "How much high-pass-filtered signal feeds back into the delay.", does: "Emphasises the bright/thin component of the echoes.", tips: "Use for thin, airy repeats that don't build up mud." } },
      { addr: 182, name: "Dry mix", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "How much of the original, un-delayed chord is in the output.", does: "1 = full dry signal. Lower = the dry sound recedes behind the echoes.", tips: "Lower it for a more washed sound; keep at 1 to layer echoes on top." } },
      { addr: 184, name: "Reverb send", card: "Delay & mix", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.7,
        explain: { is: "How much of the chord is sent to the global reverb.", does: "0 = dry chord. Higher = more of the shared room reverb on the chord voice.", tips: "The reverb itself is shaped in the Space section (Global)." } },
      { addr: 185, name: "Amount", card: "Crunch", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Amount of waveshaping distortion applied to the chord.", does: "0 = clean. Higher = grittier, dirtier, more saturated.", tips: "A little adds warmth and edge; a lot gets aggressive and lofi." } },
      { addr: 186, name: "Type", card: "Crunch", unit: "", min: 0, max: 2, step: 1, type: "int", curve: "linear", def: 0, options: ["Soft", "Medium", "Hard"],
        optionNotes: ["A gentle, soft-clipping warmth.", "A moderate, fuzzier shape.", "A hard, heavily-distorted shape."],
        explain: { is: "Which distortion curve the crunch uses.", does: "Soft → Medium → Hard get progressively more distorted.", tips: "Pick the character here, then dial the amount with Crunch above." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_output_filter",
    domain: "chord",
    title: "Output filter",
    blurb: "A final multimode filter on the chord output: blend low-pass, band-pass and high-pass, plus the chord's output level.",
    params: [
      { addr: 192, name: "Frequency", card: "Filter & output", unit: "Hz", min: 0, max: 5000, step: 1, type: "int", curve: "exponential", def: 500,
        explain: { is: "The cutoff of the output filter.", does: "Low = a darker, more filtered output. High = brighter and more open.", tips: "Filters the whole chord after everything else, a final tone-shaping stage." } },
      { addr: 193, name: "Resonance", card: "Filter & output", unit: "", min: 0.7, max: 5, step: 0.01, type: "float", curve: "linear", def: 0.7,
        explain: { is: "The resonance of the output filter, a peak at the cutoff.", does: "Low = flat and natural. High = a ringing, vocal, squelchy peak.", tips: "Raise for a more characterful, focused output." } },
      { addr: 194, name: "Low-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0.05,
        explain: { is: "How much low-pass output is blended in.", does: "Lets lows through and cuts highs, warm, rounded.", tips: "This filter is multimode: blend LP/BP/HP to taste." } },
      { addr: 195, name: "Band-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "How much band-pass output is blended in.", does: "Keeps only a midrange band, hollow, nasal, focused.", tips: "High band-pass gives a vocal, mid-forward character." } },
      { addr: 196, name: "High-pass mix", card: "Filter & output", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "How much high-pass output is blended in.", does: "Lets highs through and cuts lows, thin, airy, bright.", tips: "Raise to remove low-end weight from the output." } },
      { addr: 197, name: "Level", card: "Filter & output", unit: "", min: 0, max: 2, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "The overall output gain of the chord.", does: "Low = attenuated and quiet. High = boosted, driving the output stage harder.", tips: "Use to balance the chord against the harp voice." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_general",
    domain: "chord",
    title: "General",
    blurb: "Voice-wide settings for the chord section: its octave and register, how it glides between chords, and which chord each button combination plays in the alternate layout.",
    params: [
      { addr: 202, name: "Alt layout maj", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord the major button plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 203, name: "Alt layout min", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord the minor button plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 204, name: "Alt layout 7th", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord the seventh button plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 205, name: "Alt layout maj+7th", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord major and seventh together plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 206, name: "Alt layout min+7th", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord minor and seventh together plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 207, name: "Alt layout maj+min", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord major and minor together plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 208, name: "Alt layout all three", card: "Chord layout", unit: "", min: 0, max: 18, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "Major", "Minor", "Dominant 7", "Major 7", "Minor 7", "Diminished", "Augmented", "Major 6", "Minor 6", "Full diminished", "m7\u266d5", "sus4", "sus2", "7sus4", "maj9", "min9", "add9", "6/9"],
        explain: { is: "Which chord all three buttons plays in the alternate layout.", does: "Points that button combination at any of the eighteen chord types the instrument knows.", tips: "Only has an effect when chord layout is set to Alternate. Default gives this slot its built-in chord \u2014 the seven together make up the suspended and extended set. Use the others to reach chords the standard set does not have, or just to move a chord to a button that suits your hand better." } },
      { addr: 198, name: "Octave", card: "Voicing & glide", unit: "", min: 0, max: 4, step: 1, type: "int", curve: "linear", def: 2,
        options: ["−2 octaves", "−1 octave", "Normal", "+1 octave", "+2 octaves"],
        seg: ["−2", "−1", "0", "+1", "+2"],
        optionNotes: [
          "Two octaves down: deep and bass-like.",
          "One octave down: fuller, lower.",
          "The chord's normal register.",
          "One octave up: brighter, lighter.",
          "Two octaves up: high and chime-like.",
        ],
        explain: { is: "Shifts the whole chord section up or down in octaves.", does: "Down = deeper, heavier. Up = brighter, more delicate.", tips: "'Normal' is the default centre. Shift to move the chord out of the way of the harp, or to reach bass/chime registers." } },
      { addr: 120, name: "Chord register", card: "Voicing & glide", unit: "", min: 0, max: 5, step: 1, type: "int", curve: "linear", def: 2,
        options: ["Normal", "Octave up · extras 1", "Octave up · extras 2", "Octave up · extras 3", "Octave up · extras 4", "Two octaves up"],
        optionNotes: [
          "The standard chord layout.",
          "One octave up. The added notes are the 2nd, 4th and 6th.",
          "One octave up. The added notes drop to the register below.",
          "One octave up, with a different set of added notes.",
          "One octave up, with a fuller set of added notes.",
          "Two octaves up: bright and open.",
        ],
        explain: { is: "Which register the chord sits in, and which extra notes rythm mode adds.", does: "Moves the chord up an octave or two, and chooses the added notes used by the extra voices in rythm mode.", tips: "For the four main chord voices this only changes the octave, and settings 1 to 4 are identical \u2014 what separates them is the added notes, which are only heard in rythm mode. For how the chord itself is voiced, see chord inversion and chord spacing." } },
      { addr: 199, name: "Glide", card: "Voicing & glide", unit: "ms", min: 0, max: 1500, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "Glide (portamento) time between one chord and the next.", does: "0 = chords change instantly. Higher = the pitch slides smoothly from the old chord to the new one.", tips: "A little glide gives a smooth, connected feel; long glides are dramatic and synthy." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "chord_rhythm",
    domain: "play",   // data-only: surfaced in the Play tab's middle panel (buildPlayExtras), no standalone tab
    title: "Rhythm",
    rhythmGrid: true,   // renders the 16-step × 7-row sequencer in the middle pane
    blurb: "The chord rhythm sequencer, a 16-step × 7-row grid. Set tempo and feel with the controls, draw the pattern in the grid.",
    params: [
      { addr: 187, name: "BPM", card: "Tempo & feel", unit: "bpm", min: 30, max: 300, step: 1, type: "int", curve: "linear", def: 80,
        explain: { is: "Tempo of the rhythm mode, in beats per minute.", does: "Sets how fast the 16-step loop plays.", tips: "The Lab doesn't play audio. This is the value sent to the device." } },
      { addr: 188, name: "Cycle length", card: "Tempo & feel", unit: "steps", min: 1, max: 16, step: 1, type: "int", curve: "linear", def: 16,
        explain: { is: "How many of the 16 steps the loop uses before repeating.", does: "Shortens the pattern, e.g. 8 loops the first 8 steps. Steps beyond this are dimmed in the grid.", tips: "Use shorter cycles for tighter, more repetitive grooves." } },
      { addr: 189, name: "Measure update", card: "Tempo & feel", unit: "beats", min: 1, max: 8, step: 1, type: "int", curve: "linear", def: 4,
        explain: { is: "How often a newly-selected chord is taken into account.", does: "1 = the chord can change every beat; higher quantises chord changes to every N beats.", tips: "Higher values keep changes locked to the bar for a steadier feel." } },
      { addr: 190, name: "Shuffle", card: "Tempo & feel", unit: "", min: 0.5, max: 1.5, step: 0.01, type: "float", curve: "linear", def: 1,
        explain: { is: "Swing: makes the time between successive beats unequal.", does: "1 = straight (no swing). Away from 1 lengthens one beat and shortens the next for a shuffle feel.", tips: "Small offsets from 1 give a gentle swing; extremes get lurching." } },
      { addr: 191, name: "Note length", card: "Tempo & feel", unit: "ms", min: 20, max: 1000, step: 1, type: "int", curve: "linear", def: 700,
        explain: { is: "How long each triggered note is held on.", does: "Short = staccato, clipped hits. Long = notes ring into each other.", tips: "Shorten for tight rhythmic stabs; lengthen for a sustained, legato feel." } },
      // 16 step pattern values (7-bit fields). Rendered by the grid, not as sliders.
      { addr: 220, name: "Step 1",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 16 },
      { addr: 221, name: "Step 2",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
      { addr: 222, name: "Step 3",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 223, name: "Step 4",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 224, name: "Step 5",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 32 },
      { addr: 225, name: "Step 6",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
      { addr: 226, name: "Step 7",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 227, name: "Step 8",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
      { addr: 228, name: "Step 9",  grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 16 },
      { addr: 229, name: "Step 10", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
      { addr: 230, name: "Step 11", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 231, name: "Step 12", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 232, name: "Step 13", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 32 },
      { addr: 233, name: "Step 14", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
      { addr: 234, name: "Step 15", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 6 },
      { addr: 235, name: "Step 16", grid: true, min: 0, max: 128, step: 1, type: "int", curve: "linear", def: 0 },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "space",
    domain: "space",
    title: "Space (Reverb & Pan)",
    blurb: "Ambience and stereo placement applied after the voice. The global room reverb and the stereo spread, where the sound 'sits'.",
    params: [
      {
        addr: 24, name: "Reverb size", card: "Reverb", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.5,
        explain: {
          is: "The size of the simulated reverb room.",
          does: "Small = a tight, close ambience. Large = a long, expansive tail that makes notes wash together and bloom.",
          tips: "Larger sizes + long amplitude release = lush, ambient lofi. Smaller keeps things intimate and defined."
        }
      },
      {
        addr: 25, name: "High damping", card: "Reverb", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.0,
        explain: {
          is: "How quickly high frequencies fade inside the reverb tail.",
          does: "Low = a bright, shimmery tail. High = the tail loses its highs fast and becomes dark and muffled.",
          tips: "High damping is the secret to a warm, dark, 'tape' lofi reverb. Low damping for airy, glassy spaces."
        }
      },
      {
        addr: 26, name: "Low damping", card: "Reverb", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.5,
        explain: {
          is: "How quickly low frequencies fade inside the reverb tail.",
          does: "Low = a full, boomy tail. High = the lows clear out, keeping the tail tidy and less muddy.",
          tips: "Raise if the reverb feels boomy or washes out the low end; lower for a fuller, warmer body."
        }
      },
      {
        addr: 27, name: "Low pass", card: "Reverb", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.3,
        explain: {
          is: "An extra low-pass filter on the reverb, rolling off its overall brightness.",
          does: "Low = a bright, present reverb. High = a darker, more filtered reverb that sits further back behind the dry sound.",
          tips: "Use together with high damping to push the reverb into a soft, distant, lofi haze."
        }
      },
      {
        addr: 28, name: "Diffusion", card: "Reverb", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.3,
        explain: {
          is: "How smeared and dense the reverb reflections are.",
          does: "Low = you can hear individual echoes/grain in the tail. High = the reflections blur into a smooth, continuous wash.",
          tips: "High diffusion for smooth pads and ambience. Lower can add a subtle grainy texture."
        }
      },
      {
        addr: 29, name: "Pan", card: "Stereo", unit: "", min: 0, max: 1, step: 0.01,
        type: "float", curve: "linear", def: 0.75,
        explain: {
          is: "Stereo placement of the chord and harp, from fully separated across the field to both centred.",
          does: "Separated = a wide stereo image with chord and harp on opposite sides. Centred = a focused, mono-like image with both in the middle.",
          tips: "Wider feels spacious and immersive on headphones; centred is safer for mono playback and a tighter focus."
        }
      },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "performance",
    domain: "play",   // data-only: note settings surface in the Play right panel (PLAY_SETTING_CARDS); LED brightness moves to the device card
    title: "Performance",
    blurb: "Whole-instrument musical settings: transpose, key signature, chord behaviour and the front-panel buttons. These shape how you play more than the raw tone.",
    params: [
      { addr: 30, name: "Transpose", card: "Scale & harmony", unit: "st", min: 0, max: 12, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "Shifts every sound up by a number of semitones.", does: "Moves the whole instrument's pitch without changing fingering, 12 = a full octave up.", tips: "Use to match a song's key without relearning chord shapes." } },
      { addr: 35, name: "Key signature", card: "Scale & harmony", unit: "", min: 0, max: 20, step: 1, type: "int", curve: "linear", def: 0, segmented: true,
        options: ["C", "G", "D", "A", "E", "B", "F", "B♭", "E♭", "A♭", "D♭", "G♭",
          "F♯", "C♯", "G♯", "D♯", "A♯", "E♯", "B♯", "F♭", "C♭"],
        explain: { is: "Automatically sharpens/flattens chords to fit a chosen key.", does: "Picks the key the chord buttons are interpreted in, so the right accidentals come out.", tips: "Set this to your song's key and the chord buttons stay diatonic." } },
      { addr: 36, name: "Harp scale mode", card: "Scale & harmony", unit: "", min: 0, max: 11, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Follow chord", "Major", "Major pentatonic", "Minor pentatonic", "Diminished 6th",
          "Relative natural minor", "Relative harmonic minor", "Relative minor pentatonic",
          "Scale per chord", "Scale per chord \u00b7 pentatonic", "Custom \u00b7 on the key", "Custom \u00b7 on the chord"],
        optionNotes: [
          "The strings follow the chord you are holding, as they always have.",
          "A plain major scale rooted on the key signature, whatever chord you play.",
          "Five notes, no semitones. Hard to play a wrong note.",
          "The blues-leaning five-note scale.",
          "Barry Harris's eight-note scale: a major scale with an added flat sixth.",
          "The natural minor a third below the key.",
          "Natural minor with a raised seventh, for a stronger pull home.",
          "The five-note version of the relative minor.",
          "The scale changes to suit each chord: Lydian on major sevenths, Mixolydian on dominants, Dorian on minor sevenths, octatonic on diminished, whole tone on augmented.",
          "The same idea, but pentatonic, so fewer notes and less to avoid.",
          "Your own scale, rooted on the key signature. Set it below.",
          "Your own scale, rooted on whichever chord you are holding.",
        ],
        explain: { is: "What the harp strings play.", does: "Either follows the chord as before, runs a fixed scale from the key, picks a scale to suit each chord, or plays a scale you define yourself.", tips: "Modes 8 and 9 are the interesting ones for improvising: hold any chord and the strings are already the right notes for it." } },
      { addr: 236, name: "Custom scale", card: "Scale & harmony", unit: "", min: 0, max: 4095, step: 1, type: "degrees", curve: "linear", def: 2741,
        degrees: ["1", "\u266d2", "2", "\u266d3", "3", "4", "\u266d5", "5", "\u266d6", "6", "\u266d7", "7"],
        explain: { is: "A scale of your own, one tick per chromatic degree.", does: "Defines the notes used by harp scale modes 10 and 11. Everything else ignores it.", tips: "Try 1 \u266d2 4 5 \u266d7 for in sen, or 1 \u266d2 3 4 5 \u266d6 \u266d7 for hijaz. Ticking nothing leaves just the root." } },
      { addr: 38, name: "Chord spacing", card: "Scale & harmony", unit: "", min: 0, max: 4, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Close", "Drop 2", "Drop 3", "Drop 2+4", "Spread"],
        optionNotes: [
          "The four voices sit as close together as the chord allows. This is how the minichord has always played chords.",
          "The second voice from the top drops an octave. The standard way to open a chord out a little.",
          "The third voice from the top drops instead, which opens the bottom of the chord further.",
          "Two voices drop, giving the most even spread: on a major seventh the gaps go from 4-3-4 to 7-9-7, across two octaves.",
          "The lowest voice drops and the highest rises. Very wide, but the middle two stay together, so it reads as two extremes around a cluster. Good for pads.",
        ],
        explain: { is: "How far apart the four chord voices sit.", does: "Moves voices by an octave to open the chord out, without changing which notes are in it.", tips: "Drop 2+4 is the one that sounds most like a pianist voicing a chord. Drop 2 and drop 3 also move the bass note, since the voice they drop lands below everything else; drop 2+4 and spread do not. Combined with chord inversion this gives twenty distinct voicings of any chord. A drop that would push a voice below the instrument's range, or below a slash chord's bass, is not made." } },
      { addr: 37, name: "Chord inversion", card: "Scale & harmony", unit: "", min: 0, max: 3, step: 1, type: "int", curve: "linear", def: 0, segmented: true,
        options: ["Root position", "1st inversion", "2nd inversion", "3rd inversion"],
        optionNotes: [
          "The chord in its usual shape, root at the bottom.",
          "The lowest note moves to the top: the third is now in the bass.",
          "Again: the fifth is now in the bass.",
          "On sixth and seventh chords, the fourth note takes the bass. On triads this is root position an octave up.",
        ],
        explain: { is: "Which note of the chord sits at the bottom.", does: "Revoices the four chord buttons without changing the chord itself.", tips: "Inversions move chords closer together, so progressions sound smoother and less jumpy. You can change this while a chord is sustaining. Chord spacing is the other half of this: inversion picks which note is at the bottom, spacing decides how far apart the voices sit." } },
      { addr: 255, name: "Master tuning", card: "Scale & harmony", unit: "Hz", min: 4320, max: 4460, step: 1, type: "int", curve: "linear", def: 4400,
        display: v => (v / 10).toFixed(1),
        toRaw: v => Math.round(v * 10),
        displayStep: 0.1,
        explain: { is: "The reference pitch the whole instrument is tuned to, A4 in tenths of a Hz.", does: "Reads and edits in Hz: 440.0 is standard. Drop to 432.0, or go as high as 446.0 to match an ensemble that tunes sharp.", tips: "This is stored separately from your presets, so it stays put when you change preset and survives a power cycle. Changing it retunes a sustaining chord as you turn." } },
      { addr: 39, name: "Chord layout", card: "Scale & harmony", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0, segmented: true,
        options: ["Standard", "Alternate"],
        optionNotes: [
          "The seven chord types the minichord has always played.",
          "A second set on the same buttons, which you choose below. It starts out as the suspended and extended chords.",
        ],
        explain: { is: "Which set of chords the buttons play.", does: "Switches between the standard seven and an alternate seven you assign yourself.", tips: "Three buttons give seven combinations and all seven are already used, so a second set is the only way to reach suspended and ninth chords. Assign the double tap to this and you can switch sets mid-phrase." } },
      { addr: 34, name: "Chord frame shift", card: "Scale & harmony", unit: "", min: 0, max: 6, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Default", "D lowest", "E lowest", "F lowest", "G lowest", "A lowest", "B lowest"],
        explain: { is: "Shifts the register frame so a different note sits lowest.", does: "Rotates which note is at the bottom of the chord layout (1 = D lowest, 2 = E lowest, …).", tips: "Use to move the chord voicings into a higher or lower register." } },
      { addr: 33, name: "Barry Harris mode", card: "Scale & harmony", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Off", "On (6th / dim)"],
        explain: { is: "Reworks the chords into a Barry-Harris-style 6th-diminished system.", does: "Major → major 6, minor → minor 6, diminished → fully diminished.", tips: "Pairs well with harp strum pattern 4 (in the harp General tab)." } },
      { addr: 31, name: "Sharp / flat button", card: "Scale & harmony", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Sharp button", "Flat button"],
        explain: { is: "Whether the accidental button raises (sharp) or lowers (flat).", does: "Flips the front-panel accidental between # and ♭.", tips: "Choose whichever matches how you think about the current key." } },
      { addr: 21, name: "Retrigger chords", card: "Chord behaviour", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Off", "On"],
        explain: { is: "Whether chords re-trigger when you modulate the current chord or play continuously.", does: "On = each modulation restarts the chord envelope; Off = it rings through.", tips: "On for rhythmic re-articulation; Off for smooth, sustained changes." } },
      { addr: 22, name: "Change held strings", card: "Chord behaviour", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Keep held note", "Re-pitch to chord"],
        explain: { is: "Whether a held harp note re-pitches when you change chord.", does: "Keep = the note stays put; Re-pitch = held notes follow the new chord.", tips: "Re-pitch for legato lines that track chord changes." } },
      { addr: 23, name: "Slash level", card: "Chord behaviour", unit: "", min: 0, max: 2, step: 1, type: "int", curve: "linear", def: 0,
        explain: { is: "Which scale level slash chords affect.", does: "Sets how deep into the voicing a slash (bass-note) chord reaches.", tips: "Leave at 0 unless you use slash chords and want a different bass behaviour." } },
      { addr: 32, name: "LED brightness", card: "Hardware", unit: "", min: 0, max: 1, step: 0.01, type: "float", curve: "linear", def: 0,
        explain: { is: "Dims the device's LED. 0 = full brightness; higher = dimmer.", does: "Attenuates the LED only, purely cosmetic, no effect on sound.", tips: "Raise it if the LED is too bright in a dark room." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "midi",
    domain: "midi",   // own top-level tab
    title: "MIDI",
    blurb: "How the chord and harp sections appear over USB MIDI.",
    // beginner explainer rendered in the middle pane (the tab has no graph):
    // what MIDI is, what the minichord actually sends, and how the Play
    // mirror works backwards from it
    middleNote:
      "<h3>How the minichord talks to this app</h3>" +
      "<ul>" +
      "<li><b>MIDI is notes, not sound:</b> over USB the minichord sends tiny messages like " +
      "“note E3 started” and “note E3 stopped”. No audio travels over the cable, " +
      "just which pitches are sounding, the moment they start and stop.</li>" +
      "<li><b>Two ports, one per section:</b> chord notes arrive on port 1 and harp notes on port 2, " +
      "so the app (or a DAW) can tell the sections apart. The channels below choose how each section " +
      "is numbered inside its port. 'Single port mode' folds both onto port 1, fine for some hosts, " +
      "but then the Play tab can no longer tell harp notes from chord notes.</li>" +
      "<li><b>The minichord never says which button you pressed:</b> only the notes. So the Play tab " +
      "works backwards: knowing your current settings, it computes the exact notes every button and " +
      "string <i>would</i> play, then matches what's arriving against that map to light the right ones.</li>" +
      "<li><b>That's why some reads are a best guess:</b> several settings produce the same notes from " +
      "different shapes, and a knob can change settings without reporting it. The mirror infers what " +
      "you're holding from the evidence and self-corrects as you play.</li>" +
      "<li><b>Helping it lock on:</b> a chord button press settles things instantly: it sends the whole " +
      "chord at once. The rhythm section is harder to read (one note at a time), so while it plays, a " +
      "quick harp strum is the best clue you can give. Busier rhythm patterns also read more easily " +
      "than sparse ones.</li>" +
      "<li><b>Settings travel separately:</b> when the app connects, the device sends its full settings " +
      "as one data dump, and every control you move here is sent straight back. Notes and settings never " +
      "interfere with each other.</li>" +
      "<li><b>Most changes are instant, some wait for a note:</b> sound settings update live as you " +
      "drag. Settings that change <i>which notes</i> the buttons and strings play only take effect " +
      "on the next chord press or strum. If nothing seems to happen, play a note.</li>" +
      "</ul>",
    params: [
      { addr: 106, name: "Chord channel", card: "Channels & routing", unit: "", min: 1, max: 16, step: 1, type: "int", curve: "linear", def: 1,
        explain: { is: "The MIDI channel the chord section sends/receives on.", does: "Sets which of the 16 MIDI channels carries the chord voice.", tips: "Give chord and harp different channels to address them separately in a DAW." } },
      { addr: 107, name: "Harp channel", card: "Channels & routing", unit: "", min: 1, max: 16, step: 1, type: "int", curve: "linear", def: 1,
        explain: { is: "The MIDI channel the harp section sends/receives on.", does: "Sets which of the 16 MIDI channels carries the harp voice.", tips: "Keep distinct from the chord channel to split them in a DAW." } },
      { addr: 108, name: "Single port mode", card: "Channels & routing", unit: "", min: 0, max: 1, step: 1, type: "int", curve: "linear", def: 0,
        options: ["Separate ports", "Single port"],
        optionNotes: [
          "Chord and harp each get their own MIDI port: required for the Play tab's live mirror.",
          "Both sections share one port (the channel tells them apart): the Play tab can't separate harp notes from chords in this mode.",
        ],
        explain: { is: "Whether chord and harp share one MIDI port or use two.", does: "Single = both on one port (channel tells them apart); Separate = two ports.", tips: "Single-port is simpler for many hosts; separate can be cleaner for routing. The Play tab's mirror needs Separate ports to tell harp notes from chord notes." } },
    ]
  },
  /* ---------------------------------------------------------------------- */
  {
    id: "knobs",
    domain: "knobs",   // own top-level tab
    title: "Knob assignments",
    blurb: "Assign what the physical potentiometers control. Each knob's 'target' picks a parameter to sweep; its 'range' sets how far the knob moves it. Targets and ranges are heard by turning the knob on the device.",
    // beginner explainer rendered in the middle pane (the tab has no graph):
    // behaviour verified against the firmware (potentiometer.cpp / main.cpp)
    middleNote:
      "<h3>How the knobs work</h3>" +
      "<ul>" +
      "<li><b>Main vs alt:</b> every knob has two jobs. Turned normally, the chord and harp knobs set their " +
      "section's volume and the mod knob runs its <i>main</i> assignment. <b>Hold the sharp (♯) button while " +
      "turning</b> to use a knob's <i>alt</i> assignment instead.</li>" +
      "<li><b>Target:</b> the setting the knob sweeps. <b>Range:</b> how far. The knob covers a window " +
      "<i>around the setting's saved value</i>, from −range% to +range% of it. At 100% that's 0 up to double " +
      "the saved value; smaller ranges give finer control around it.</li>" +
      "<li><b>The zero trap:</b> because the range scales the saved value, a setting saved at 0 can't move " +
      "at all (any percentage of 0 is 0). Give the setting a mid-way value with its slider first, then the " +
      "knob can sweep around it.</li>" +
      "<li><b>Knob moves aren't saved:</b> turning a knob changes the sound live but never overwrites the " +
      "saved value, so this editor keeps showing the setting as it was stored.</li>" +
      "</ul>",
    params: [
      { addr: 200, name: "Double tap target", card: "Double tap", unit: "", min: 0, max: 219, step: 1, type: "int", curve: "linear", def: 0, targetSelect: true,
        explain: { is: "Which setting two quick taps of the modifier button toggle.", does: "Zero leaves the gesture switched off. Any other address is toggled between its stored value and the one below, and back again on the next double tap.", tips: "Set it to 39 to flip chord layouts while playing, or point it at Barry Harris mode, an inversion, a harp scale \u2014 anything with an address. The LED breathes slowly while a toggle is engaged." } },
      { addr: 201, name: "Double tap value", card: "Double tap", unit: "", min: 0, max: 4095, step: 1, type: "int", curve: "linear", def: 1,
        explain: { is: "The value the double tap applies.", does: "Tapping again puts back whatever was there before, so it toggles away from your setting and back rather than to a fixed default.", tips: "With the target set to 39, a value of 1 switches to the alternate chord layout." } },
      { addr: 14, name: "Target", card: "Mod knob (main)", unit: "", min: 0, max: 219, step: 1, type: "int", curve: "linear", def: 0, targetSelect: true,
        explain: { is: "Which parameter the modulation knob's main function controls.", does: "Picks the target the mod knob sweeps as you turn it. 'None' leaves it unassigned.", tips: "Assign an expressive parameter (filter cutoff, vibrato depth…) for live control." } },
      { addr: 15, name: "Range", card: "Mod knob (main)", unit: "%", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 100,
        explain: { is: "How much of the target's range the mod knob sweeps.", does: "100% = the knob covers the full range; lower = a narrower, finer sweep.", tips: "Lower the range for subtle, controllable expression." } },
      { addr: 16, name: "Target", card: "Mod knob (alt)", unit: "", min: 0, max: 219, step: 1, type: "int", curve: "linear", def: 0, targetSelect: true,
        explain: { is: "Which parameter the modulation knob's alternate function controls.", does: "The second target the mod knob can sweep (alternate mode).", tips: "Pair a main + alternate target for two assignments on one knob." } },
      { addr: 17, name: "Range", card: "Mod knob (alt)", unit: "%", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 100,
        explain: { is: "Sweep range of the mod knob's alternate function.", does: "100% = full range; lower = a finer sweep.", tips: "Match to how much movement the alternate target needs." } },
      { addr: 10, name: "Target", card: "Chord knob (alt)", unit: "", min: 0, max: 219, step: 1, type: "int", curve: "linear", def: 0, targetSelect: true,
        explain: { is: "Which parameter the chord knob's alternate function controls.", does: "Picks the target the chord knob sweeps in its alternate mode.", tips: "Useful for tweaking a chord-voice parameter live." } },
      { addr: 11, name: "Range", card: "Chord knob (alt)", unit: "%", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 100,
        explain: { is: "Sweep range of the chord knob's alternate function.", does: "100% = full range; lower = a finer sweep.", tips: "Lower for fine control." } },
      { addr: 12, name: "Target", card: "Harp knob (alt)", unit: "", min: 0, max: 219, step: 1, type: "int", curve: "linear", def: 0, targetSelect: true,
        explain: { is: "Which parameter the harp knob's alternate function controls.", does: "Picks the target the harp knob sweeps in its alternate mode.", tips: "Assign a harp-voice parameter for live tweaking." } },
      { addr: 13, name: "Range", card: "Harp knob (alt)", unit: "%", min: 0, max: 100, step: 1, type: "int", curve: "linear", def: 100,
        explain: { is: "Sweep range of the harp knob's alternate function.", does: "100% = full range; lower = a finer sweep.", tips: "Lower for fine control." } },
    ]
  },
];

/* ----------------------------------------------------------------------------
 * Per-value descriptors: the live "what does THIS value sound like" line shown
 * under each control. Kept here (data) so they're easy to refine.
 *   - waveform: one note per option (index = value)
 *   - ranged params: ascending bands; the first band whose `max` >= value wins
 * -------------------------------------------------------------------------- */
const WAVEFORM_NOTES = [
  "A pure tone with almost no overtones: the softest, darkest option.",
  "Every harmonic present: bright, buzzy and full. Classic synth string/lead.",
  "Only odd harmonics: hollow and reedy, a touch clarinet-like.",
  "A few soft harmonics: mellow and rounded, like a warmer sine.",
  "A narrow, clean pulse: bright and thin, without aliasing.",
  "A 25% pulse: nasal and hollow, thinner than a square.",
  "Same bright, buzzy spectrum as a saw, mirrored in shape.",
  "Stepped random levels: noisy and unpitched; good for texture/FX.",
  "An asymmetric triangle: soft, but with a little more edge.",
  "A clean sawtooth without aliasing: bright and full, smooth top end.",
  "Clean saw spectrum, mirrored: bright and buzzy.",
  "A clean square: hollow and reedy, without harsh aliasing.",
];

const VALUE_BANDS = {
  41: [ // amplitude
    { max: 0.001, text: "Silent: the oscillator is off." },
    { max: 0.1, text: "Very quiet: clean, lots of headroom." },
    { max: 0.3, text: "Low level: the default range; leaves room before later stages." },
    { max: 0.6, text: "Moderate: a fuller, more present core tone." },
    { max: 0.85, text: "Strong: loud and fat, drives later stages harder." },
    { max: Infinity, text: "Very hot: maximum drive; can feel washed-out." },
  ],
  43: [ // amp attack
    { max: 10, text: "Near-instant: percussive, plucky onset." },
    { max: 50, text: "Quick attack: snappy with a softened edge." },
    { max: 300, text: "Soft onset: notes ease in gently." },
    { max: 1200, text: "Slow swell: pad-like fade-in." },
    { max: Infinity, text: "Very slow swell: a long, ambient bloom." },
  ],
  44: [ // amp hold
    { max: 1, text: "No hold: decay begins immediately." },
    { max: 60, text: "Brief plateau at full volume: adds punch up front." },
    { max: 400, text: "Short hold: the peak sustains momentarily." },
    { max: Infinity, text: "Long hold: sits at full volume before decaying." },
  ],
  45: [ // amp decay
    { max: 40, text: "Snappy: drops to sustain almost instantly, plucky." },
    { max: 250, text: "Quick: a fast fall to the sustain level." },
    { max: 1000, text: "Moderate: settles into sustain." },
    { max: Infinity, text: "Slow: a gradual fall toward sustain." },
  ],
  46: [ // amp sustain
    { max: 0.02, text: "No sustain: the note dies while held, like a real harp." },
    { max: 0.25, text: "Mostly plucked: fades to a low held level." },
    { max: 0.6, text: "Partial sustain: some body remains while held." },
    { max: 0.9, text: "Strong sustain: holds at a high level." },
    { max: Infinity, text: "Full sustain: organ-like, holds at full volume." },
  ],
  47: [ // amp release
    { max: 60, text: "Tight: stops almost immediately (staccato)." },
    { max: 350, text: "Short tail: a quick fade after release." },
    { max: 1200, text: "Medium tail: notes ring on a little (default harp feel)." },
    { max: 3000, text: "Long tail: strums bloom and overlap." },
    { max: Infinity, text: "Very long tail: a washy, ambient ring-out." },
  ],
  48: [ // amp retrigger release
    { max: 0, text: "None: fast retriggers may click." },
    { max: 3, text: "Clean: smooths quick retriggers." },
    { max: Infinity, text: "Soft: noticeable cross-fade on repeats." },
  ],
  49: [ // filter cutoff
    { max: 150, text: "Very dark: almost all brightness removed, deeply muffled." },
    { max: 400, text: "Dark and mellow: warm, lofi character." },
    { max: 800, text: "Warm: some presence, still rounded." },
    { max: 1400, text: "Open: bright and clear, most harmonics through." },
    { max: Infinity, text: "Fully open: the oscillator's full brightness." },
  ],
  50: [ // keytrack
    { max: 0.05, text: "Fixed cutoff: high notes come out duller than low ones." },
    { max: 0.6, text: "Mild tracking: brightness follows pitch a little." },
    { max: 1.5, text: "Even: timbre stays consistent across the range." },
    { max: Infinity, text: "Strong tracking: high notes get noticeably brighter." },
  ],
  51: [ // resonance
    { max: 1.0, text: "Clean: a gentle, natural tone control." },
    { max: 2.0, text: "Slight emphasis at the cutoff: extra character." },
    { max: 3.5, text: "Vocal / squelchy: a pronounced peak, great for sweeps." },
    { max: Infinity, text: "Ringing: a sharp whistle at the cutoff." },
  ],
  58: [ // filter sensitivity (depth)
    { max: 0.02, text: "Off: the filter envelope does nothing; cutoff stays put." },
    { max: 1, text: "Subtle: a gentle bloom of brightness at note start." },
    { max: 2.5, text: "Moderate: a clear filter sweep on each note." },
    { max: Infinity, text: "Strong: a dramatic, wide-open filter sweep." },
  ],
  52: [ // filter env attack
    { max: 10, text: "Instant: zappy, percussive brightening." },
    { max: 100, text: "Quick: brightens at the note's start." },
    { max: 800, text: "Gradual: an audible filter sweep." },
    { max: Infinity, text: "Slow: the tone opens over a long time." },
  ],
  53: [ // filter env hold
    { max: 1, text: "No hold: the filter starts closing right away." },
    { max: 80, text: "Brief: holds the bright peak momentarily." },
    { max: Infinity, text: "Long: stays open and bright before closing." },
  ],
  54: [ // filter env decay
    { max: 50, text: "Snappy: a quick bright-to-dark snap." },
    { max: 300, text: "Quick: darkens soon after the opening." },
    { max: Infinity, text: "Slow: the tone closes gradually." },
  ],
  55: [ // filter env sustain
    { max: 0.2, text: "Settles dark: after the sweep the tone stays closed." },
    { max: 0.6, text: "Partly open: some brightness remains while held." },
    { max: Infinity, text: "Stays bright: the filter holds open while held." },
  ],
  56: [ // filter env release
    { max: 60, text: "Tight: brightness drops away at once on release." },
    { max: 350, text: "Short: the tone closes soon after release." },
    { max: 1500, text: "Medium: the filter keeps moving through the tail." },
    { max: Infinity, text: "Long: the fade-out slowly changes tone." },
  ],
  57: [ // filter env retrigger release
    { max: 1, text: "Minimal: fast retriggers may jump in tone." },
    { max: 20, text: "Clean: smooths filter movement on retriggers." },
    { max: Infinity, text: "Soft: noticeable filter smoothing between notes." },
  ],
  24: [ // reverb size
    { max: 0.2, text: "Tight: a small, intimate ambience." },
    { max: 0.5, text: "Room: a natural, moderate space." },
    { max: 0.8, text: "Hall: a large, expansive tail." },
    { max: Infinity, text: "Huge: a long, washy space that blurs notes together." },
  ],
  25: [ // reverb high damping
    { max: 0.2, text: "Bright tail: shimmery and airy highs." },
    { max: 0.6, text: "Balanced: natural decay of the high end." },
    { max: Infinity, text: "Dark tail: highs fade fast; warm, muffled, lofi." },
  ],
  26: [ // reverb low damping
    { max: 0.3, text: "Full lows: a boomy, weighty tail." },
    { max: 0.7, text: "Balanced low end in the tail." },
    { max: Infinity, text: "Tidy lows: the bottom clears out, less mud." },
  ],
  27: [ // reverb low pass
    { max: 0.3, text: "Open: a bright, present reverb." },
    { max: 0.6, text: "Softened: the reverb sits back a little." },
    { max: Infinity, text: "Dark: a distant, filtered haze behind the sound." },
  ],
  28: [ // reverb diffusion
    { max: 0.3, text: "Grainy: individual echoes audible in the tail." },
    { max: 0.7, text: "Semi-smooth: reflections blur together." },
    { max: Infinity, text: "Smooth: a dense, continuous wash." },
  ],
  29: [ // pan
    { max: 0.05, text: "Fully separated: chord and harp hard left/right, widest image." },
    { max: 0.4, text: "Wide: clear stereo separation." },
    { max: 0.8, text: "Moderate: gently spread around centre (default)." },
    { max: Infinity, text: "Centred: both in the middle, focused and mono-safe." },
  ],
  101: [ // transient amount
    { max: 0.001, text: "Off: no transient layer." },
    { max: 0.15, text: "Subtle: a touch of attack definition." },
    { max: 0.5, text: "Present: a clear percussive tick on each note." },
    { max: Infinity, text: "Strong: a pronounced click/hit at the front." },
  ],
  102: [ // transient attack
    { max: 5, text: "Instant: a sharp tick." },
    { max: 40, text: "Quick: a soft click." },
    { max: Infinity, text: "Slow: the click swells in." },
  ],
  103: [ // transient hold
    { max: 5, text: "None: falls away at once." },
    { max: 50, text: "Brief: lingers a moment." },
    { max: Infinity, text: "Held: stays up before fading." },
  ],
  104: [ // transient decay
    { max: 30, text: "Crisp: a tight tick." },
    { max: 120, text: "Short: a brief blip." },
    { max: Infinity, text: "Smeared: blurs into the note." },
  ],
  105: [ // transient note level
    { max: 0, text: "Unison: at the note's own pitch." },
    { max: 7, text: "Slight: a few steps up, lightly pitched." },
    { max: 14, text: "Higher: a clear pitched ping." },
    { max: Infinity, text: "Well above: a bright bell on top." },
  ],
  61: [ // tremolo depth
    { max: 0.001, text: "Off: no tremolo." },
    { max: 0.2, text: "Gentle: a soft pulsing shimmer." },
    { max: 0.6, text: "Clear: obvious pulsing." },
    { max: Infinity, text: "Strong: a choppy throb." },
  ],
  60: [ // tremolo rate
    { max: 0.05, text: "Stopped: no movement." },
    { max: 3, text: "Slow: a swell in and out." },
    { max: 8, text: "Classic: musical tremolo (≈4–7 Hz)." },
    { max: Infinity, text: "Fast: a flutter or buzz." },
  ],
  64: [ // vibrato depth
    { max: 0.001, text: "Off: no vibrato." },
    { max: 0.2, text: "Gentle: a singing waver." },
    { max: 0.6, text: "Clear: expressive vibrato." },
    { max: Infinity, text: "Wide: a dramatic pitch wobble." },
  ],
  63: [ // vibrato rate
    { max: 0.05, text: "Stopped: no wobble." },
    { max: 3, text: "Slow: a lazy waver." },
    { max: 8, text: "Natural: musical vibrato (≈4–7 Hz)." },
    { max: Infinity, text: "Fast: a nervous flutter." },
  ],
  71: [ // pitch bend (1 = centre)
    { max: 0.9, text: "Bends down: a downward scoop/fall." },
    { max: 1.05, text: "Centred: no pitch bend." },
    { max: Infinity, text: "Bends up: an upward scoop." },
  ],
  84: [ // delay mix
    { max: 0.001, text: "Off: no echo." },
    { max: 0.25, text: "Subtle: quiet repeats behind the note." },
    { max: 0.6, text: "Present: clear, audible echoes." },
    { max: Infinity, text: "Strong: washy, prominent repeats." },
  ],
  77: [ // delay time
    { max: 80, text: "Slapback: tight thickening, comb-like." },
    { max: 300, text: "Short: rhythmic echoes." },
    { max: Infinity, text: "Long: distinct, spaced repeats." },
  ],
  86: [ // crunch
    { max: 0.001, text: "Clean: no distortion." },
    { max: 0.3, text: "Warm: a little edge and grit." },
    { max: 0.7, text: "Driven: clearly gritty." },
    { max: Infinity, text: "Heavy: aggressive distortion." },
  ],
  88: [ // output filter frequency
    { max: 300, text: "Very dark: heavily filtered output." },
    { max: 900, text: "Warm: rounded, gently filtered." },
    { max: 2500, text: "Open: clear and present." },
    { max: Infinity, text: "Bright: barely filtered." },
  ],
  96: [ // output filter LFO sensitivity
    { max: 0.02, text: "Off: the output filter stays still." },
    { max: 1.5, text: "Subtle: gentle auto-wah movement." },
    { max: Infinity, text: "Strong: a wide filter sweep." },
  ],
  94: [ // output filter LFO rate
    { max: 0.05, text: "Stopped: no sweep." },
    { max: 3, text: "Slow: a gradual wah." },
    { max: Infinity, text: "Fast: a fluttering shimmer." },
  ],
  97: [ // output level
    { max: 0.8, text: "Attenuated: a quieter harp." },
    { max: 1.3, text: "Unity: around the original level." },
    { max: Infinity, text: "Boosted: louder, drives the output harder." },
  ],
  30: [ // transpose
    { max: 0, text: "None: concert pitch." },
    { max: 6, text: "Low: up a few semitones." },
    { max: 11, text: "Mid: up most of an octave." },
    { max: Infinity, text: "Octave: up a full octave." },
  ],
  23: [ // slash level
    { max: 0, text: "Off: slash chords unaffected." },
    { max: 1, text: "Level 1: shallow reach." },
    { max: Infinity, text: "Level 2: deepest reach." },
  ],
  32: [ // led brightness (attenuation)
    { max: 0.001, text: "Full: maximum brightness." },
    { max: 0.5, text: "Dim: slightly reduced." },
    { max: Infinity, text: "Faint: strongly dimmed." },
  ],

  // ---- chord voice: mirror the harp's value descriptions ----
  137: [ // chord amp attack
    { max: 10, text: "Near-instant: percussive, stabby onset." },
    { max: 50, text: "Quick attack: snappy with a softened edge." },
    { max: 300, text: "Soft onset: the chord eases in gently." },
    { max: 1200, text: "Slow swell: pad-like fade-in." },
    { max: Infinity, text: "Very slow swell: a long, ambient bloom." },
  ],
  138: [ // chord amp hold
    { max: 1, text: "No hold: decay begins immediately." },
    { max: 60, text: "Brief plateau at full volume: adds punch up front." },
    { max: 400, text: "Short hold: the peak sustains momentarily." },
    { max: Infinity, text: "Long hold: sits at full volume before decaying." },
  ],
  139: [ // chord amp decay
    { max: 40, text: "Snappy: drops to sustain almost instantly, plucky." },
    { max: 250, text: "Quick: a fast fall to the sustain level." },
    { max: 1000, text: "Moderate: settles into sustain." },
    { max: Infinity, text: "Slow: a gradual fall toward sustain." },
  ],
  140: [ // chord amp sustain
    { max: 0.02, text: "No sustain: the chord dies away even while held." },
    { max: 0.25, text: "Mostly plucked: fades to a low held level." },
    { max: 0.6, text: "Partial sustain: some body remains while held." },
    { max: 0.9, text: "Strong sustain: holds at a high level." },
    { max: Infinity, text: "Full sustain: organ-like, holds at full volume." },
  ],
  141: [ // chord amp release
    { max: 60, text: "Tight: stops almost immediately (staccato)." },
    { max: 350, text: "Short tail: a quick fade after release." },
    { max: 1200, text: "Medium tail: chords ring on a little (default feel)." },
    { max: 3000, text: "Long tail: chords bloom and overlap." },
    { max: Infinity, text: "Very long tail: a washy, ambient ring-out." },
  ],
  142: [ // chord amp retrigger release
    { max: 0, text: "None: fast retriggers may click." },
    { max: 3, text: "Clean: smooths quick retriggers." },
    { max: Infinity, text: "Soft: noticeable cross-fade on repeats." },
  ],
  143: [ // chord filter cutoff
    { max: 150, text: "Very dark: almost all brightness removed, deeply muffled." },
    { max: 400, text: "Dark and mellow: warm, lofi character." },
    { max: 800, text: "Warm: some presence, still rounded." },
    { max: 1400, text: "Open: bright and clear, most harmonics through." },
    { max: Infinity, text: "Fully open: the oscillators' full brightness." },
  ],
  144: [ // chord filter keytrack
    { max: 0.05, text: "Fixed cutoff: high chords come out duller than low ones." },
    { max: 0.6, text: "Mild tracking: brightness follows pitch a little." },
    { max: 1.5, text: "Even: timbre stays consistent across the range." },
    { max: Infinity, text: "Strong tracking: high chords get noticeably brighter." },
  ],
  145: [ // chord filter resonance
    { max: 1, text: "Clean: a gentle, natural tone control." },
    { max: 2, text: "Slight emphasis at the cutoff: extra character." },
    { max: 3.5, text: "Vocal / squelchy: a pronounced peak, great for sweeps." },
    { max: Infinity, text: "Ringing: a sharp whistle at the cutoff." },
  ],
  155: [ // chord filter sensitivity (depth)
    { max: 0.02, text: "Off: the filter envelope does nothing; cutoff stays put." },
    { max: 1, text: "Subtle: a gentle bloom of brightness at note start." },
    { max: 2.5, text: "Moderate: a clear filter sweep on each note." },
    { max: Infinity, text: "Strong: a dramatic, wide-open filter sweep." },
  ],
  146: [ // chord filter env attack
    { max: 10, text: "Instant: zappy, percussive brightening." },
    { max: 100, text: "Quick: brightens at the note's start." },
    { max: 800, text: "Gradual: an audible filter sweep." },
    { max: Infinity, text: "Slow: the tone opens over a long time." },
  ],
  147: [ // chord filter env hold
    { max: 1, text: "No hold: the filter starts closing right away." },
    { max: 80, text: "Brief: holds the bright peak momentarily." },
    { max: Infinity, text: "Long: stays open and bright before closing." },
  ],
  148: [ // chord filter env decay
    { max: 50, text: "Snappy: a quick bright-to-dark snap." },
    { max: 300, text: "Quick: darkens soon after the opening." },
    { max: Infinity, text: "Slow: the tone closes gradually." },
  ],
  149: [ // chord filter env sustain
    { max: 0.2, text: "Settles dark: after the sweep the tone stays closed." },
    { max: 0.6, text: "Partly open: some brightness remains while held." },
    { max: Infinity, text: "Stays bright: the filter holds open while held." },
  ],
  150: [ // chord filter env release
    { max: 60, text: "Tight: brightness drops away at once on release." },
    { max: 350, text: "Short: the tone closes soon after release." },
    { max: 1500, text: "Medium: the filter keeps moving through the tail." },
    { max: Infinity, text: "Long: the fade-out slowly changes tone." },
  ],
  151: [ // chord filter env retrigger release
    { max: 1, text: "Minimal: fast retriggers may jump in tone." },
    { max: 20, text: "Clean: smooths filter movement on retriggers." },
    { max: Infinity, text: "Soft: noticeable filter smoothing between notes." },
  ],
  159: [ // chord tremolo depth
    { max: 0.001, text: "Off: no tremolo." },
    { max: 0.2, text: "Gentle: a soft pulsing shimmer." },
    { max: 0.6, text: "Clear: obvious pulsing." },
    { max: Infinity, text: "Strong: a choppy throb." },
  ],
  157: [ // chord tremolo rate
    { max: 0.05, text: "Stopped: no movement." },
    { max: 3, text: "Slow: a swell in and out." },
    { max: 8, text: "Classic: musical tremolo (≈4–7 Hz)." },
    { max: Infinity, text: "Fast: a flutter or buzz." },
  ],
  163: [ // chord vibrato depth
    { max: 0.001, text: "Off: no vibrato." },
    { max: 0.2, text: "Gentle: a singing waver." },
    { max: 0.6, text: "Clear: expressive vibrato." },
    { max: Infinity, text: "Wide: a dramatic pitch wobble." },
  ],
  161: [ // chord vibrato rate
    { max: 0.05, text: "Stopped: no wobble." },
    { max: 3, text: "Slow: a lazy waver." },
    { max: 8, text: "Natural: musical vibrato (≈4–7 Hz)." },
    { max: Infinity, text: "Fast: a nervous flutter." },
  ],
  170: [ // chord vibrato pitch-bend amount (1 = centre)
    { max: 0.9, text: "Bends down: a downward scoop/fall." },
    { max: 1.05, text: "Centred: no pitch bend." },
    { max: Infinity, text: "Bends up: an upward scoop." },
  ],
  183: [ // chord delay mix
    { max: 0.001, text: "Off: no echo." },
    { max: 0.25, text: "Subtle: quiet repeats behind the chord." },
    { max: 0.6, text: "Present: clear, audible echoes." },
    { max: Infinity, text: "Strong: washy, prominent repeats." },
  ],
  176: [ // chord delay time
    { max: 80, text: "Slapback: tight thickening, comb-like." },
    { max: 300, text: "Short: rhythmic echoes." },
    { max: Infinity, text: "Long: distinct, spaced repeats." },
  ],
  185: [ // chord crunch
    { max: 0.001, text: "Clean: no distortion." },
    { max: 0.3, text: "Warm: a little edge and grit." },
    { max: 0.7, text: "Driven: clearly gritty." },
    { max: Infinity, text: "Heavy: aggressive distortion." },
  ],
  192: [ // chord output filter frequency
    { max: 300, text: "Very dark: heavily filtered output." },
    { max: 900, text: "Warm: rounded, gently filtered." },
    { max: 2500, text: "Open: clear and present." },
    { max: Infinity, text: "Bright: barely filtered." },
  ],
  197: [ // chord output level
    { max: 0.8, text: "Attenuated: a quieter chord." },
    { max: 1.3, text: "Unity: around the original level." },
    { max: Infinity, text: "Boosted: louder, drives the output harder." },
  ],

  // ---- chord oscillator stack (chord-only controls) ----
  121: [ { max: 0.001, text: "Muted: this oscillator is off." }, { max: 0.2, text: "Low: a quiet layer in the blend." }, { max: 0.6, text: "Present: a clear part of the tone." }, { max: Infinity, text: "Loud: dominates the stack." } ],
  124: [ { max: 0.001, text: "Muted: this oscillator is off." }, { max: 0.2, text: "Low: a quiet layer in the blend." }, { max: 0.6, text: "Present: a clear part of the tone." }, { max: Infinity, text: "Loud: dominates the stack." } ],
  127: [ { max: 0.001, text: "Muted: this oscillator is off." }, { max: 0.2, text: "Low: a quiet layer in the blend." }, { max: 0.6, text: "Present: a clear part of the tone." }, { max: Infinity, text: "Loud: dominates the stack." } ],
  123: [ { max: 0.55, text: "Sub: an octave below (0.5×)." }, { max: 0.97, text: "Detuned down: slightly flat, adds width." }, { max: 1.03, text: "In tune: at the played pitch." }, { max: 1.95, text: "Detuned up: slightly sharp, adds width." }, { max: Infinity, text: "Octave up: bright and shimmery (2×)." } ],
  126: [ { max: 0.55, text: "Sub: an octave below (0.5×)." }, { max: 0.97, text: "Detuned down: slightly flat, adds width." }, { max: 1.03, text: "In tune: at the played pitch." }, { max: 1.95, text: "Detuned up: slightly sharp, adds width." }, { max: Infinity, text: "Octave up: bright and shimmery (2×)." } ],
  129: [ { max: 0.55, text: "Sub: an octave below (0.5×)." }, { max: 0.97, text: "Detuned down: slightly flat, adds width." }, { max: 1.03, text: "In tune: at the played pitch." }, { max: 1.95, text: "Detuned up: slightly sharp, adds width." }, { max: Infinity, text: "Octave up: bright and shimmery (2×)." } ],
  130: [ { max: 0.001, text: "Off: no noise." }, { max: 0.2, text: "A touch of air or breath." }, { max: 0.5, text: "Clearly breathy: noise in the blend." }, { max: Infinity, text: "Heavy: noise dominates, percussive." } ],

  // ---- output filter & mix (both voices) ----
  89: [ // harp output filter resonance
    { max: 1, text: "Clean: a flat, natural output filter." },
    { max: 2, text: "Slight emphasis at the cutoff." },
    { max: 3.5, text: "Vocal / squelchy: a pronounced peak." },
    { max: Infinity, text: "Ringing: a sharp whistle at the cutoff." },
  ],
  193: [ // chord output filter resonance
    { max: 1, text: "Clean: a flat, natural output filter." },
    { max: 2, text: "Slight emphasis at the cutoff." },
    { max: 3.5, text: "Vocal / squelchy: a pronounced peak." },
    { max: Infinity, text: "Ringing: a sharp whistle at the cutoff." },
  ],
  83: [ // harp dry mix
    { max: 0.05, text: "No dry: only the delayed/wet signal." },
    { max: 0.5, text: "Quiet dry: echoes dominate." },
    { max: 0.9, text: "Balanced: the dry note with its echoes." },
    { max: Infinity, text: "Full dry: the direct note at full level." },
  ],
  182: [ // chord dry mix
    { max: 0.05, text: "No dry: only the delayed/wet signal." },
    { max: 0.5, text: "Quiet dry: echoes dominate." },
    { max: 0.9, text: "Balanced: the dry chord with its echoes." },
    { max: Infinity, text: "Full dry: the direct chord at full level." },
  ],
  85: [ // harp reverb send
    { max: 0.001, text: "Dry: no reverb on the harp." },
    { max: 0.3, text: "A little space behind the note." },
    { max: 0.6, text: "Clearly reverberant: roomy." },
    { max: Infinity, text: "Drenched: a big wash of reverb." },
  ],
  184: [ // chord reverb send
    { max: 0.001, text: "Dry: no reverb on the chord." },
    { max: 0.3, text: "A little space behind the chord." },
    { max: 0.6, text: "Clearly reverberant: roomy." },
    { max: Infinity, text: "Drenched: a big wash of reverb." },
  ],
  90: [ { max: 0.05, text: "Off: no low-pass in the blend." }, { max: 0.5, text: "Blended: low-pass partly mixed in." }, { max: Infinity, text: "Full: low-pass dominates (warm, rounded)." } ],
  194: [ { max: 0.05, text: "Off: no low-pass in the blend." }, { max: 0.5, text: "Blended: low-pass partly mixed in." }, { max: Infinity, text: "Full: low-pass dominates (warm, rounded)." } ],
  91: [ { max: 0.05, text: "Off: no band-pass in the blend." }, { max: 0.5, text: "Blended: band-pass partly mixed in." }, { max: Infinity, text: "Full: band-pass dominates (hollow)." } ],
  195: [ { max: 0.05, text: "Off: no band-pass in the blend." }, { max: 0.5, text: "Blended: band-pass partly mixed in." }, { max: Infinity, text: "Full: band-pass dominates (hollow)." } ],
  92: [ { max: 0.05, text: "Off: no high-pass in the blend." }, { max: 0.5, text: "Blended: high-pass partly mixed in." }, { max: Infinity, text: "Full: high-pass dominates (thin, airy)." } ],
  196: [ { max: 0.05, text: "Off: no high-pass in the blend." }, { max: 0.5, text: "Blended: high-pass partly mixed in." }, { max: Infinity, text: "Full: high-pass dominates (thin, airy)." } ],
};

// Minimum firmware version each parameter needs to take effect on the device
// (its `introduction_version` in parameters.json). Anything not listed is v2,
// the Lab's baseline. Used to warn when a connected device is too old.
const PARAM_FIRMWARE = {
  99: 3, 98: 3, 31: 3, 32: 3,            // octave, chromatic, sharp/flat, LED brightness
  33: 4,                                  // Barry-Harris
  101: 5, 102: 5, 103: 5, 104: 5, 105: 5, // transient envelope
  100: 6, 35: 6, 34: 6,                   // transient waveform, key signature, chord frame shift
  106: 8, 107: 8, 108: 8,                 // MIDI channels, single-port
  198: 3,                                 // chord octave change
  199: 7,                                 // chord glide
  36: 9, 37: 9, 38: 9, 39: 9, 236: 9, 255: 9,
  200: 9, 201: 9, 202: 9, 203: 9, 204: 9, 205: 9, 206: 9, 207: 9, 208: 9,           // harp scale modes, chord inversion, custom scale, master tuning
};

// "Inert" gates: when a gating control is turned all the way down, the whole
// sub-component it feeds does nothing. We surface that on the affected CARD (the
// group of related sliders) rather than each slider. Each gate: { addr (the
// gating control, inert when at its min), card (the card title to flag, "" =
// the group's untitled card), msg }. Attached to groups as `gates` below.
const PARAM_GATES = {
  // (no amplitude-at-0 gates: a silent oscillator is a normal mixing choice,
  // osc 2/3 sit at 0 in many presets, so flagging it is noise, not signal)
  filter_env:       [{ addr: 58, card: "Shape", msg: "Filter sensitivity is at 0, the envelope doesn't move the cutoff" },
                     { addr: 58, card: "Sustain & release", msg: "Filter sensitivity is at 0, the envelope doesn't move the cutoff" }],
  transient:        [{ addr: 101, card: "Mix & tone", msg: "Amount is at 0, no transient" },
                     { addr: 101, card: "Shape", msg: "Amount is at 0, no transient" }],
  tremolo:          [{ addr: 61, card: "Shape", msg: "Depth is at 0, no tremolo" },
                     { addr: 60, card: "Shape", msg: "Rate is at 0, no tremolo" }],
  vibrato:          [{ addr: 64, card: "Envelope", msg: "Vibrato depth is at 0, the envelope has nothing to shape" }],
  delay:            [{ addr: 84, card: "Delay & mix", msg: "Delay mix is at 0, no echo" },
                     { addr: 84, card: "Delay filter", msg: "Delay mix is at 0, no echo" },
                     { addr: 86, card: "Crunch", msg: "Crunch is at 0, no distortion" }],
  output_filter:    [{ addr: 96, card: "LFO", msg: "LFO sensitivity is at 0, the LFO doesn't move the filter" }],
  chord_tremolo:    [{ addr: 159, card: "Shape", msg: "Depth is at 0, no tremolo" },
                     { addr: 157, card: "Shape", msg: "Rate is at 0, no tremolo" }],
  chord_vibrato:    [{ addr: 163, card: "Envelope", msg: "Vibrato depth is at 0, the envelope has nothing to shape" }],
  chord_filter:     [{ addr: 155, card: "Envelope", msg: "Sensitivity is at 0, the envelope doesn't move the cutoff" },
                     { addr: 155, card: "Sustain & release", msg: "Sensitivity is at 0, the envelope doesn't move the cutoff" },
                     { addr: 154, card: "LFO", msg: "LFO depth is at 0, the LFO doesn't move the filter" }],
  chord_delay:      [{ addr: 183, card: "Delay & mix", msg: "Delay mix is at 0, no echo" },
                     { addr: 183, card: "Delay filter", msg: "Delay mix is at 0, no echo" },
                     { addr: 185, card: "Crunch", msg: "Crunch is at 0, no distortion" }],
};

// attach descriptors to their parameters by address
PARAM_GROUPS.forEach(g => g.params.forEach(p => {
  // waveform dropdowns (main osc, transient, tremolo) share the per-shape notes,
  // unless the param already defines its own option notes
  if ([42, 59, 62, 93, 100, 122, 125, 128, 152, 156, 160].includes(p.addr) && !p.optionNotes) p.optionNotes = WAVEFORM_NOTES;
  if (VALUE_BANDS[p.addr] && !p.bands) p.bands = VALUE_BANDS[p.addr];
  if (PARAM_FIRMWARE[p.addr]) p.fw = PARAM_FIRMWARE[p.addr];
}));
PARAM_GROUPS.forEach(g => { if (PARAM_GATES[g.id]) g.gates = PARAM_GATES[g.id]; });

// Fallback display names for every assignable parameter address, taken from the
// device's own catalog (parameters.json). The Lab's grouped catalog (PARAM_GROUPS)
// only covers Harp + Global so far; this fills in the Chord voice (and anything
// else) so knob-target pickers can name an address instead of showing "Address N".
const ADDR_NAMES = {
  36: "Scale & harmony · harp scale mode",
  37: "Scale & harmony · chord inversion",
  38: "Scale & harmony · chord spacing",
  39: "Scale & harmony · chord layout",
  202: "Chord layout · alt maj",
  203: "Chord layout · alt min",
  204: "Chord layout · alt 7th",
  205: "Chord layout · alt maj+7th",
  206: "Chord layout · alt min+7th",
  207: "Chord layout · alt maj+min",
  208: "Chord layout · alt all three",
  200: "Chord layout · double tap target",
  201: "Chord layout · double tap value",
  236: "Scale & harmony · custom scale",
  255: "Settings · master tuning",
  21: "Settings · retrigger chords",
  22: "Settings · change held strings",
  23: "Settings · slash level",
  24: "Effects · reverb size",
  25: "Effects · reverb high damping",
  26: "Effects · reverb low damping",
  27: "Effects · reverb low pass",
  28: "Effects · reverb diffusion",
  29: "Effects · pan",
  30: "Settings · transpose",
  31: "Settings · sharp function",
  32: "Settings · led attenuation",
  33: "Settings · barry harris mode",
  34: "Settings · chord frame shift",
  35: "Settings · chord key signature",
  40: "Harp General · harp shuffling",
  41: "Harp Oscillator · amplitude",
  42: "Harp Oscillator · waveform",
  43: "Harp Envelope · attack",
  44: "Harp Envelope · hold",
  45: "Harp Envelope · decay",
  46: "Harp Envelope · sustain",
  47: "Harp Envelope · release",
  48: "Harp Envelope · retrigger release",
  49: "Harp Low pass filter · base frequency",
  50: "Harp Low pass filter · keytrack value",
  51: "Harp Low pass filter · resonance",
  52: "Harp Low pass filter · attack",
  53: "Harp Low pass filter · hold",
  54: "Harp Low pass filter · decay",
  55: "Harp Low pass filter · sustain",
  56: "Harp Low pass filter · release",
  57: "Harp Low pass filter · retrigger release",
  58: "Harp Low pass filter · filter sensitivity",
  59: "Harp Tremolo · waveform",
  60: "Harp Tremolo · frequency",
  61: "Harp Tremolo · amplitude",
  62: "Harp Vibrato · waveform",
  63: "Harp Vibrato · frequency",
  64: "Harp Vibrato · amplitude",
  65: "Harp Vibrato · attack",
  66: "Harp Vibrato · hold",
  67: "Harp Vibrato · decay",
  68: "Harp Vibrato · sustain",
  69: "Harp Vibrato · release",
  70: "Harp Vibrato · retrigger release",
  71: "Harp Vibrato · pitch bend",
  72: "Harp Vibrato · attack bend",
  73: "Harp Vibrato · hold bend",
  74: "Harp Vibrato · decay bend",
  75: "Harp Vibrato · retrigger release bend",
  76: "Harp Vibrato · intensity",
  77: "Harp Effects · delay length",
  78: "Harp Effects · delay filter frequency",
  79: "Harp Effects · delay filter resonance",
  80: "Harp Effects · delay lowpass",
  81: "Harp Effects · delay bandpass",
  82: "Harp Effects · delay highpass",
  83: "Harp Effects · dry mix",
  84: "Harp Effects · delay mix",
  85: "Harp Effects · reverb level",
  86: "Harp Effects · crunch level",
  87: "Harp Effects · crunch type",
  88: "Harp Output filter · frequency",
  89: "Harp Output filter · resonance",
  90: "Harp Output filter · lowpass",
  91: "Harp Output filter · bandpass",
  92: "Harp Output filter · highpass",
  93: "Harp Output filter · LFO waveform",
  94: "Harp Output filter · LFO frequency",
  95: "Harp Output filter · LFO amplitude",
  96: "Harp Output filter · filter LFO sensitivity",
  97: "Harp Output filter · output amplifier",
  98: "Harp General · chromatic mode",
  99: "Harp General · octave change",
  100: "Harp Transient · waveform",
  101: "Harp Transient · amplitude",
  102: "Harp Transient · attack",
  103: "Harp Transient · hold",
  104: "Harp Transient · decay",
  105: "Harp Transient · note level",
  106: "MIDI · chord channel",
  107: "MIDI · harp channel",
  108: "MIDI · single port mode",
  120: "Chord General · chord shuffling",
  121: "Chord Oscillator · amplitude 1",
  122: "Chord Oscillator · waveform 1",
  123: "Chord Oscillator · frequency multiplier 1",
  124: "Chord Oscillator · amplitude 2",
  125: "Chord Oscillator · waveform 2",
  126: "Chord Oscillator · frequency multiplier 2",
  127: "Chord Oscillator · amplitude 3",
  128: "Chord Oscillator · waveform 3",
  129: "Chord Oscillator · frequency multiplier 3",
  130: "Chord Oscillator · noise",
  131: "Chord Oscillator · first note",
  132: "Chord Oscillator · second note",
  133: "Chord Oscillator · third note",
  134: "Chord Oscillator · fourth note",
  135: "Chord Oscillator · inter-note delay",
  136: "Chord Oscillator · random note delay",
  137: "Chord Envelope · attack",
  138: "Chord Envelope · hold",
  139: "Chord Envelope · decay",
  140: "Chord Envelope · sustain",
  141: "Chord Envelope · release",
  142: "Chord Envelope · retrigger release",
  143: "Chord Low pass filter · base frequency",
  144: "Chord Low pass filter · keytrack value",
  145: "Chord Low pass filter · resonance",
  146: "Chord Low pass filter · attack",
  147: "Chord Low pass filter · hold",
  148: "Chord Low pass filter · decay",
  149: "Chord Low pass filter · sustain",
  150: "Chord Low pass filter · release",
  151: "Chord Low pass filter · retrigger release",
  152: "Chord Low pass filter · LFO waveform",
  153: "Chord Low pass filter · LFO frequency",
  154: "Chord Low pass filter · LFO amplitude",
  155: "Chord Low pass filter · filter sensitivity",
  156: "Chord Tremolo · waveform",
  157: "Chord Tremolo · frequency",
  158: "Chord Tremolo · keytrack value",
  159: "Chord Tremolo · amplitude",
  160: "Chord Vibrato · waveform",
  161: "Chord Vibrato · frequency",
  162: "Chord Vibrato · keytrack value",
  163: "Chord Vibrato · amplitude",
  164: "Chord Vibrato · attack",
  165: "Chord Vibrato · hold",
  166: "Chord Vibrato · decay",
  167: "Chord Vibrato · sustain",
  168: "Chord Vibrato · release",
  169: "Chord Vibrato · retrigger release",
  170: "Chord Vibrato · pitch bend",
  171: "Chord Vibrato · attack bend",
  172: "Chord Vibrato · hold bend",
  173: "Chord Vibrato · decay bend",
  174: "Chord Vibrato · retrigger release bend",
  175: "Chord Vibrato · intensity",
  176: "Chord Effects · delay length",
  177: "Chord Effects · delay filter frequency",
  178: "Chord Effects · delay filter resonance",
  179: "Chord Effects · delay lowpass",
  180: "Chord Effects · delay bandpass",
  181: "Chord Effects · delay highpass",
  182: "Chord Effects · dry mix",
  183: "Chord Effects · delay mix",
  184: "Chord Effects · reverb level",
  185: "Chord Effects · crunch level",
  186: "Chord Effects · crunch type",
  187: "Chord Rhythm · default bpm",
  188: "Chord Rhythm · cycle length",
  189: "Chord Rhythm · measure update",
  190: "Chord Rhythm · shuffle value",
  191: "Chord Rhythm · note pushed duration",
  192: "Chord Output filter · frequency",
  193: "Chord Output filter · resonance",
  194: "Chord Output filter · lowpass",
  195: "Chord Output filter · bandpass",
  196: "Chord Output filter · highpass",
  197: "Chord Output filter · output amplifier",
  198: "Chord General · octave change",
  199: "Chord General · glide chords",
};

// Expose for non-module scripts.
if (typeof window !== "undefined") {
  window.PARAM_GROUPS = PARAM_GROUPS;
  window.WAVEFORMS = WAVEFORMS;
  window.ADDR_NAMES = ADDR_NAMES;
}

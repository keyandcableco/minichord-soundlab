/* ============================================================================
 * glossary.js: minichord Sound Lab inline audio-term tooltips
 *
 * Game-style highlighted keywords. Known audio terms in any text surface are
 * wrapped in <dfn class="term"> and reveal a definition on hover / focus / tap,
 * with cross-linked "see also" terms. Data-driven and offline.
 *
 *   Glossary.apply(rootElement)   // highlight terms within a subtree
 *
 * Engine attaches one shared popover to <body> and listens via delegation, so
 * it works for dynamically-added terms too.
 * ========================================================================== */

(function () {
  "use strict";

  // ---- term data ----------------------------------------------------------
  // key -> { short, long?, see? }
  const TERMS = {
    // envelope
    attack: { short: "The envelope stage setting how long a note takes to rise to full amplitude after it's triggered.", see: ["envelope", "amplitude", "decay"] },
    hold: { short: "The envelope stage that keeps a note at full amplitude after the attack, before the decay begins.", see: ["envelope", "attack", "decay"] },
    decay: { short: "The envelope stage that falls from the peak to the sustain level, after the attack and hold.", see: ["envelope", "sustain", "hold"] },
    sustain: { short: "The amplitude an envelope holds while a key is held down, a level, not a time.", see: ["envelope", "amplitude", "release"] },
    release: { short: "The envelope stage setting how long a note takes to fade to silence after the key is let go.", see: ["envelope", "decay", "tail"] },
    envelope: { short: "A contour that shapes a value across a note's life: here attack, hold, decay, sustain and release.", long: "One envelope shapes amplitude (volume); a second shapes the filter cutoff.", see: ["AHDSR", "attack", "filter envelope"] },
    AHDSR: { short: "Attack, Hold, Decay, Sustain, Release: the five stages of an envelope.", see: ["envelope", "attack", "sustain"] },
    // oscillator & waveform
    oscillator: { short: "The source that generates a raw, repeating waveform, the starting tone before any filter or envelope.", see: ["waveform", "harmonic", "filter"] },
    waveform: { short: "The shape of one cycle of an oscillator (sine, sawtooth, square, triangle), which sets its harmonic content.", see: ["oscillator", "harmonic", "timbre"] },
    harmonic: { short: "A frequency at a whole-number multiple of the pitch. More harmonics make a brighter timbre.", see: ["frequency", "waveform", "timbre"] },
    sine: { short: "The purest waveform, a single frequency with no harmonics, so it sounds soft and dark.", see: ["waveform", "harmonic", "frequency"] },
    sawtooth: { short: "A bright, buzzy waveform containing every harmonic, the classic synth string or lead tone.", see: ["waveform", "harmonic"] },
    square: { short: "A hollow waveform with only odd harmonics, woody and clarinet-like.", see: ["waveform", "harmonic", "pulse"] },
    triangle: { short: "A soft waveform with few, quiet harmonics, like a rounded sine.", see: ["waveform", "sine", "harmonic"] },
    pulse: { short: "A narrow, square-like waveform with a thinner, more nasal set of harmonics.", see: ["waveform", "square", "harmonic"] },
    noise: { short: "A pitch-less waveform, random energy across all frequencies, used for breath, percussion and texture.", see: ["waveform", "frequency"] },
    partial: { short: "Any single frequency in a sound, the fundamental pitch or one of its harmonics.", see: ["harmonic", "frequency", "pitch"] },
    inharmonic: { short: "Partials that aren't whole-number multiples of the pitch, the source of metallic, bell-like clang.", see: ["harmonic", "partial", "timbre"] },
    frequency: { short: "How many times a waveform repeats each second (in Hertz), heard as pitch.", see: ["pitch", "harmonic", "waveform"] },
    pitch: { short: "How high or low a note sounds, set by its waveform's frequency.", see: ["frequency", "octave", "oscillator"] },
    // filter
    cutoff: { short: "The frequency where a filter starts cutting the harmonics above it. Lower cutoff, darker tone.", see: ["filter", "harmonic", "resonance"] },
    filter: { short: "A circuit that removes part of a sound's frequency content to shape its timbre.", see: ["cutoff", "resonance", "low-pass"] },
    "low-pass": { short: "A filter that passes the lows and cuts the harmonics above the cutoff.", see: ["filter", "cutoff", "high-pass"] },
    "high-pass": { short: "A filter that cuts the lows below the cutoff and passes the highs, thin and airy.", see: ["filter", "cutoff", "low-pass"] },
    "band-pass": { short: "A filter that passes a band around the cutoff and cuts above and below it, hollow.", see: ["filter", "cutoff", "low-pass"] },
    multimode: { short: "A filter that morphs between low-pass, band-pass and high-pass response.", see: ["filter", "low-pass", "band-pass"] },
    resonance: { short: "A boost right at the cutoff that makes a filter ring or whistle.", see: ["cutoff", "filter"] },
    keytracking: { short: "Making the filter cutoff follow each note's pitch, so timbre stays even across the range.", see: ["cutoff", "pitch", "filter"] },
    "filter envelope": { short: "A second envelope that sweeps the filter cutoff over time, independent of amplitude.", see: ["envelope", "cutoff", "sweep"] },
    sweep: { short: "A smooth movement of the filter cutoff over time, usually from a filter envelope or LFO.", see: ["cutoff", "filter envelope", "LFO"] },
    // music theory & harmony
    root: { short: "The note a chord is named after and built up from, its anchor, and usually its bass.", see: ["pitch", "slash chord", "interval"] },
    interval: { short: "The distance in pitch between two notes (a third, a fifth, a sixth), counted in scale steps.", see: ["semitone", "octave", "root"] },
    voicing: { short: "How a chord's notes are arranged: which octaves they sit in, their order, and which extras are added.", see: ["root", "interval", "octave"] },
    transpose: { short: "Shifting every note up or down by the same number of semitones, same shapes, different pitch.", see: ["semitone", "octave", "key signature"] },
    register: { short: "A broad zone of pitch: low, mid or high.", see: ["octave", "pitch"] },
    "key signature": { short: "The set of sharps or flats that defines a song's key: which notes are 'in' by default.", see: ["accidental", "diatonic", "transpose"] },
    accidental: { short: "A sharp (♯) or flat (♭), a note raised or lowered a semitone from the key's default.", see: ["key signature", "semitone"] },
    diatonic: { short: "Using only the notes that belong to the current key, nothing outside it.", see: ["key signature", "chromatic", "accidental"] },
    chromatic: { short: "Using all twelve semitones, ignoring the key or chord, every note available.", see: ["semitone", "diatonic"] },
    major: { short: "The bright-sounding chord quality. Its third sits four semitones above the root.", see: ["minor", "root", "interval"] },
    minor: { short: "The darker chord quality. Its third sits three semitones above the root, one lower than major.", see: ["major", "root", "interval"] },
    diminished: { short: "A tense, unstable chord quality, stacked minor thirds that pull towards resolving.", see: ["major", "minor", "interval"] },
    "slash chord": { short: "A chord played over a different bass note, written like C/G: a C chord with a G underneath.", see: ["root", "voicing"] },
    "Barry Harris": { short: "Jazz pianist and teacher whose 'sixth-diminished' system swaps each chord for its 6th version and pairs it with a diminished chord, so harmony moves in smooth, even steps.", see: ["diminished", "voicing", "diatonic"] },
    keymaster: { short: "A harp layout made for Barry Harris playing (named for a touchplate instrument): neighbouring strings climb the same chord note through rising octaves.", see: ["Barry Harris", "octave", "touchplate"] },
    legato: { short: "Smoothly connected notes, each one flows into the next with no gap.", see: ["staccato", "glide", "sustain"] },
    // rhythm & sequencing
    tempo: { short: "The speed of the music, measured in BPM.", see: ["BPM", "swing"] },
    BPM: { short: "Beats Per Minute: how many beats fit in one minute; 120 BPM is two every second.", see: ["tempo"] },
    swing: { short: "An uneven, long-short timing between alternating beats, the lilt of a shuffle or jazz feel.", see: ["tempo", "BPM"] },
    sequencer: { short: "A feature that plays a stored pattern of notes in time, step by step. Here, the 16-step rhythm grid.", see: ["tempo", "BPM", "playhead"] },
    playhead: { short: "The moving marker showing which step of a pattern is sounding right now.", see: ["sequencer", "tempo"] },
    stab: { short: "A short, sharp chord hit, punchy and clipped.", see: ["staccato", "pluck"] },
    // MIDI & device
    MIDI: { short: "Musical Instrument Digital Interface, the standard language instruments use to talk to computers: tiny messages naming which notes start and stop, not audio.", see: ["channel", "port", "DAW"] },
    DAW: { short: "Digital Audio Workstation: music recording and production software, such as Ableton Live, Logic or GarageBand.", see: ["MIDI", "host"] },
    host: { short: "The software on the computer end of a MIDI connection, a DAW, or this app.", see: ["DAW", "MIDI"] },
    port: { short: "One MIDI connection lane over the USB cable. The minichord uses port 1 for chords and port 2 for the harp.", see: ["MIDI", "channel"] },
    channel: { short: "An independent stream within a connection. MIDI carries 16 numbered channels per port; stereo audio uses two (left and right).", see: ["MIDI", "port", "stereo"] },
    firmware: { short: "The program running inside the device itself. Updating it adds features and fixes.", see: ["MIDI"] },
    potentiometer: { short: "The rotating electrical component inside each knob, 'pot' for short.", see: ["sweep"] },
    touchplate: { short: "A flat, touch-sensitive playing surface. The minichord's harp strip is one; you brush it rather than press keys.", see: ["keymaster"] },
    bank: { short: "One of the minichord's saved settings slots. Each bank holds a complete sound and glows its own color.", see: ["preset"] },
    preset: { short: "A complete saved collection of settings. Load one to change every parameter at once.", see: ["bank"] },
    ground: { short: "The shared zero-volt reference all electrical gear measures its signals against, and the path current returns through. Audio and USB cables both carry one.", see: ["ground loop", "mains hum"] },
    "ground loop": { short: "A buzz that appears when gear is tied to ground through more than one path. A small current circulates around the loop and leaks into the audio.", long: "Typical recipe: the minichord's audio cable runs to powered speakers while its USB cable runs to a computer: two ground paths, one loop.", see: ["ground", "mains hum", "USB isolator"] },
    "mains hum": { short: "The 50/60 Hz tone of wall power leaking into audio, often with a digital whine on top when a computer is involved, the classic ground-loop sound.", see: ["ground loop", "USB isolator"] },
    "USB isolator": { short: "A small adapter that passes USB data while electrically separating the two ends, breaking a ground loop on the USB side.", see: ["ground loop", "mains hum"] },
    // effects
    reverb: { short: "Simulated room ambience, many fading reflections that add space and depth behind a sound.", see: ["damping", "diffusion", "tail"] },
    damping: { short: "How fast a reverb's high frequencies fade in its tail. More damping is darker and muffled.", see: ["reverb", "tail", "frequency"] },
    diffusion: { short: "How smeared a reverb's reflections are. High gives a smooth wash, low gives grainy echoes.", see: ["reverb", "wash", "echo"] },
    delay: { short: "An effect that replays a sound after a set time, creating echoes.", see: ["echo", "feedback", "reverb"] },
    echo: { short: "A delayed repeat of a sound, trailing the original.", see: ["delay", "feedback"] },
    feedback: { short: "How much of a delay's output feeds back into it. Sets how many echoes repeat, and for how long.", see: ["delay", "echo"] },
    chorus: { short: "A shimmering thickening made by layering slightly detuned copies of a sound.", see: ["detune", "unison"] },
    saturation: { short: "Gentle overdrive that rounds and thickens a signal and adds harmonics, the crunch stage.", see: ["drive", "harmonic", "gain"] },
    // modulation
    LFO: { short: "Low-Frequency Oscillator: a slow oscillator, below hearing, that modulates another value over time.", see: ["oscillator", "modulation", "tremolo"] },
    modulation: { short: "Using an LFO or envelope to vary another value (pitch, amplitude or cutoff) over time.", see: ["LFO", "envelope", "vibrato"] },
    tremolo: { short: "A steady wobble in amplitude, driven by an LFO.", see: ["LFO", "amplitude", "vibrato"] },
    vibrato: { short: "A steady wobble in pitch, driven by an LFO.", see: ["LFO", "pitch", "tremolo"] },
    // pitch & tuning
    semitone: { short: "The smallest step in Western tuning, one key; twelve semitones make an octave.", see: ["octave", "pitch"] },
    octave: { short: "A doubling of frequency, twelve semitones; the same pitch, higher or lower.", see: ["semitone", "frequency", "pitch"] },
    detune: { short: "Shifting one oscillator slightly off-pitch from another, adding beating, width and a chorus shimmer.", see: ["oscillator", "pitch", "chorus"] },
    unison: { short: "Stacking copies of the same note, often detuned, for a fatter, wider sound.", see: ["detune", "oscillator"] },
    glide: { short: "A smooth slide in pitch from one note to the next (portamento).", see: ["pitch", "octave"] },
    // level & space
    amplitude: { short: "The level, or loudness, of a signal.", see: ["gain", "envelope"] },
    gain: { short: "How much a signal is amplified.", see: ["amplitude", "headroom", "drive"] },
    headroom: { short: "The spare level between the current signal and the maximum before it distorts or washes out.", see: ["gain", "amplitude", "drive"] },
    drive: { short: "How hard a signal is pushed into the next stage. More drive is louder and dirtier.", see: ["gain", "saturation", "stage"] },
    pan: { short: "Stereo placement of a sound, from hard left or right to centred.", see: ["stereo", "amplitude"] },
    stereo: { short: "Using two channels, left and right, to spread sound across a width.", see: ["pan", "mono"] },
    mono: { short: "A single audio channel, both speakers play exactly the same thing.", see: ["stereo", "pan", "channel"] },
    dry: { short: "The signal with no effect added, the bare, original sound (for reverb, no room at all).", see: ["wet", "delay", "reverb"] },
    wet: { short: "The effected part of the signal, the echoes or room sound, as opposed to the dry original.", see: ["dry", "reverb", "delay"] },
    "reverb send": { short: "A tap that routes part of a voice's signal into the shared reverb. More send, more room.", see: ["reverb", "dry", "wet"] },
    // general
    timbre: { short: "The color of a sound, what makes two notes of the same pitch sound different.", see: ["harmonic", "waveform", "pitch"] },
    transient: { short: "The short, loud burst at a note's onset, its click or pluck before the body settles.", see: ["onset", "attack", "body"] },
    retrigger: { short: "Restarting a note's envelope when the same note is replayed quickly.", see: ["envelope", "attack"] },
    stage: { short: "A distinct step a sound passes through, one phase of an envelope, or a point in the signal chain.", see: ["envelope", "drive"] },
    core: { short: "The main body of the raw tone, from the oscillator before filtering and effects.", see: ["oscillator", "body", "timbre"] },
    pad: { short: "A sustained, slowly-evolving sound that fills space behind a melody, with a slow attack.", see: ["sustain", "attack", "reverb"] },
    pluck: { short: "A short, picked note: fast attack, quick decay, often a ringing tail.", see: ["attack", "decay", "tail"] },
    voice: { short: "One playable sound of the synth, a harp or chord's oscillator, envelopes and filter together.", see: ["oscillator", "envelope", "filter"] },
    body: { short: "The fullness and weight of a sound, mostly in its low harmonics.", see: ["timbre", "harmonic", "core"] },
    bloom: { short: "A gradual swell in amplitude or brightness just after a note's attack.", see: ["attack", "amplitude"] },
    wash: { short: "A smeared, continuous blur of sound, usually from heavy reverb.", see: ["reverb", "diffusion"] },
    tail: { short: "The fading end of a note after its release, often lengthened by reverb.", see: ["release", "reverb", "decay"] },
    staccato: { short: "Short, detached notes with quick releases.", see: ["release", "pluck"] },
    onset: { short: "The very beginning of a note, where its transient lives.", see: ["attack", "transient"] },
    tone: { short: "The overall color of a sound, set by its harmonics and timbre.", see: ["timbre", "harmonic"] },
    shape: { short: "The form of a waveform or an envelope, what its line traces over time.", see: ["waveform", "envelope"] },
    grain: { short: "A rough, sandy texture, from broken-up reflections or saturation.", see: ["diffusion", "saturation"] },
    lofi: { short: "Dark and damped, with a dusty, tape-like character.", see: ["saturation", "damping"] },
    Hz: { short: "Hertz: cycles per second, the unit of frequency and pitch.", see: ["frequency", "pitch"] },
    ms: { short: "Milliseconds: thousandths of a second, the unit for envelope and delay times.", see: ["envelope", "delay"] },
    signal: { short: "The waveform flowing through the synth, from oscillator to output.", see: ["waveform", "gain", "amplitude"] },
    circuit: { short: "A signal-processing block in the synth, such as a filter or amplifier.", see: ["filter", "signal", "stage"] },
    fundamental: { short: "The lowest, strongest partial of a sound, its base pitch.", see: ["partial", "harmonic", "pitch"] },
  };

  // alias (as it may appear in text) -> canonical key. Simple plurals are
  // generated automatically (see the LOOKUP build below); this table is for
  // synonyms, multi-word spellings, and irregular -ing/-ed inflections.
  const ALIASES = {
    overtone: "harmonic", overtones: "harmonic", overdrive: "saturation",
    distortion: "saturation", crunch: "saturation", portamento: "glide",
    saw: "sawtooth", saws: "sawtooth", hertz: "Hz",
    "low-pass filter": "low-pass", "low pass": "low-pass", lowpass: "low-pass",
    "high pass": "high-pass", highpass: "high-pass", "band pass": "band-pass", bandpass: "band-pass",
    keytrack: "keytracking", "key-tracked": "keytracking", "key tracking": "keytracking",
    "sawtooth wave": "sawtooth", "square wave": "square", "triangle wave": "triangle",
    "sine wave": "sine", "pulse wave": "pulse", "filter envelopes": "filter envelope",
    ADSR: "AHDSR",
    sweeping: "sweep", swept: "sweep", driving: "drive", driven: "drive",
    blooming: "bloom", plucked: "pluck", detuned: "detune", gliding: "glide",
    modulate: "modulation", modulating: "modulation", modulated: "modulation", echoes: "echo",
    "Barry-Harris": "Barry Harris", "Barry-Harris-style": "Barry Harris",
    "slash chords": "slash chord", slash: "slash chord",
    waveshaping: "saturation", waveshaper: "saturation",
    shuffle: "swing", chromatically: "chromatic", washed: "wash",
    pot: "potentiometer", pots: "potentiometer", "lo-fi": "lofi",
    transposed: "transpose", transposing: "transpose",
  };

  // canonical lookup for any matchable string
  const LOOKUP = {};
  Object.keys(TERMS).forEach(k => { LOOKUP[k.toLowerCase()] = k; });
  Object.keys(ALIASES).forEach(a => { LOOKUP[a.toLowerCase()] = ALIASES[a]; });
  // auto-register the plural of every single-word term (skip multi-word keys and
  // acronyms), so "sweeps" / "tails" / "voices" resolve without hand-written aliases.
  const pluralize = w =>
    /(s|x|z|ch|sh)$/i.test(w) ? w + "es"
      : /[^aeiou]y$/i.test(w) ? w.slice(0, -1) + "ies"
        : w + "s";
  Object.keys(TERMS).forEach(k => {
    if (/[\s-]/.test(k) || k === k.toUpperCase()) return;   // skip "filter envelope", "low-pass", LFO, AHDSR
    const p = pluralize(k).toLowerCase();
    if (!LOOKUP[p]) LOOKUP[p] = k;
  });

  // definitions for the profiler's real-word tags (shown on chip hover only,
  // deliberately NOT in the auto-highlighter, so prose isn't flooded). Made-up
  // signature coinages (plinky, swooshy…) have no entry and stay non-hoverable.
  const TAGDEFS = {
    bright: "Lots of high-frequency content, open and present.",
    dark: "Little high-frequency content, muffled and mellow.",
    "very dark": "Almost no highs, deeply muffled.",
    mellow: "Gently rolled-off highs, soft and warm.",
    lofi: "Dark and damped, with a dusty, tape-like character.",
    warm: "Rounded, with a soft but present top end.",
    open: "Bright and unfiltered, the full tone comes through.",
    plucky: "Fast attack and quick decay, a percussive, picked feel.",
    soft: "A slow, gentle onset rather than a sharp attack.",
    percussive: "A sharp, transient-heavy hit.",
    sustained: "Holds at a steady level for as long as the note is held.",
    "long tail": "Rings out for a while after the note ends.",
    short: "Stops quickly, tight and staccato.",
    decaying: "Falls away while held, like a plucked string.",
    swelling: "Fades in slowly, a pad-like onset.",
    full: "A loud, fat core with plenty of body.",
    clean: "Low level and low resonance, uncolored and tidy.",
    resonant: "A pronounced peak at the filter cutoff, vocal or squelchy.",
    "key-tracked": "Filter brightness follows the note's pitch across the range.",
    fixed: "Filter cutoff stays put regardless of pitch.",
    spacious: "A large, roomy sense of space.",
    dry: "No reverb, a close, bare, unprocessed sound.",
    roomy: "A moderate, natural room ambience.",
    tight: "A small, close, intimate space.",
    wide: "A broad stereo image, spread left and right.",
    centred: "A focused, near-mono image.",
    smooth: "Dense, blurred reverb reflections, a continuous wash.",
    evolving: "The tone moves over time, usually via the filter.",
    sweeping: "A strong filter sweep on each note.",
    subtle: "A gentle, understated amount of movement.",
    snappy: "The filter opens almost instantly.",
    slow: "The filter opens gradually, a slow 'wow'.",
    static: "No movement, the filter stays still.",
    balanced: "An even, middle-of-the-road tone.",
    // waveform character
    pure: "A clean tone with almost no overtones.",
    buzzy: "Bright and harmonically rich, with a raspy edge.",
    hollow: "Only odd harmonics, woody and clarinet-like.",
    round: "Soft and smooth, with gentle harmonics.",
    digital: "Clean and precise, a slightly clinical tone.",
    nasal: "Thin and pinched, like a reed or kazoo.",
    crunchy: "Rough and noisy, with a gritty texture.",
    edgy: "Asymmetric and a little aggressive.",
    crisp: "Clean and bright, with sharp definition.",
    reedy: "Thin and buzzy, like a reed instrument.",
    // transient / tremolo / general flavours
    pulsing: "Volume rising and falling in a steady rhythm, tremolo.",
    shimmer: "A gentle, quick tremble in volume.",
    deep: "Shifted to a low register, heavy and bass-like.",
    lush: "Rich and full, with extra intervals stacked on each note.",
    chromatic: "Fixed chromatic pitches, independent of the held chord.",
    silent: "No output, amplitude is at zero, so the voice makes no sound.",
    wavering: "A regular wobble in pitch, vibrato.",
    echoing: "Repeating echoes trailing the note, from the delay line.",
    gritty: "A distorted, saturated edge from the crunch stage.",
    breathy: "Airy noise blended in alongside the pitched tone.",
    // materials: "what the sound is made of" (the headline's substance word)
    glassy: "Bright and clean with a hard, pure sheen, like struck glass.",
    metallic: "Bright and ringing, with an inharmonic, bell- or chime-like edge.",
    brassy: "Bright and bold with a buzzy, reedy edge, brass- or reed-like.",
    wooden: "A mid, hollow, mallet-like body, kalimba or marimba in feel.",
    watery: "Moving and wet, modulation and echo over a spacious wash.",
    airy: "Light and breathy, with open space and little resonance.",
    earthy: "Dark and gritty, a rough, dirty, grounded texture.",
    dusty: "Dark and damped, a soft, tape-like haze, with little grit.",
    smoky: "Mellow and hazy, soft highs drifting in a roomy space.",
    molten: "Bright, gritty and resonant, a hot, saturated glow.",
    // vibes: the energy/mood word (the headline's lead)
    thunderous: "Huge and stormy, deep and spacious, with a noisy, grainy rumble.",
    booming: "Huge and clean, a deep, powerful, sustained low boom, with no grit.",
    electric: "Aggressive and energised, bright, gritty and punchy.",
    bubbly: "Bright, popping effervescence, fast plucks trailing into echo.",
    subaquatic: "A slow, shining roar, deep bubbling echo in a wide, wet space.",
    mysterious: "Dark and brooding, low, sustained and unhurried.",
    dreamy: "Floaty and gentle, bright, spacious and still.",
    wobbly: "Woozy and unsteady, pitch or filter in constant motion.",
    driving: "Propulsive and rhythmic, punchy or pulsing, with forward energy.",
    serene: "Calm and settled, soft, still and untroubled.",
    // signatures: curated whole-patch fingerprints
    cavernous: "A vast, dark, echoing space, huge and hollow.",
    ominous: "Dark, deep, spacious and brooding, mysterious and foreboding.",
    nocturne: "Soft, sustained and dim in a wide space, a calm night piece.",
    swirly: "Wavering pitch smeared through echo, a liquid, rotating motion.",
    crackling: "Bright, gritty plucks that spit and snap, an electric fizz.",
    synthwave: "A bright, dry, sustained saw pad with delay and tremolo, neon retro-future.",
    celestial: "A dreamy, wide, bright wash, cosmic and weightless.",
    searing: "Hot, bright, sustained distortion, a screaming lead.",
    kalimba: "A clean, plucked bell or tine, bright and ringing.",
    subterranean: "A very dark, low, dry bass with no air, deep underground.",
    supersaw: "Detuned, bright, fat stacked saws, a trance / EDM lead.",
    "8-bit": "The noise oscillator played short, punchy and dry, a chiptune drum kit.",
    chiptune: "A dry, bright, plucked square or pulse, a chiptune lead.",
    rhodes: "A warm, plucked tone with tremolo, an electric piano.",
    underwater: "Deep, smooth, wet and wide, submerged and bubbling.",
    waterfall: "A wet, gritty, tumbling cascade, bright spray over a deep roar.",
    storm: "A vast, dark, booming roar filling a huge space, thundery.",
    glitchy: "Lo-fi, resonant and randomly evolving, glitched and unstable.",
    growling: "A sustained, detuned, gritty low growl, a reese / neuro bass.",
    glacial: "Bright, ringing, long and spacious, like ice.",
    glistening: "Bright and sustained with a moving, spacious sparkle, shimmering.",
    ethereal: "Airy, wide and soft, gossamer and weightless.",
    drone: "A clean, held, static dark tone, a sustained, unchanging note.",
    silky: "Soft, smooth and rounded with no edge, velvety.",
    neutral: "No strong character, an even, middle-of-the-road tone.",
  };

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // longest first so multi-word/hyphenated terms win over their parts
  const PATTERN = Object.keys(LOOKUP).sort((a, b) => b.length - a.length).map(esc).join("|");
  const RE = new RegExp("(?<![\\w-])(" + PATTERN + ")(?![\\w-])", "gi");

  const SKIP = ".term, input, select, button, a, .tab, .tag-chip, .sig-chip, " +
    ".flavor-term, .theme-axes, .meter-label, .meter-val, .param-name, .unit, .gloss-term, .gloss-see, .gloss-back";

  // ---- enable switch ------------------------------------------------------
  // Off: new content stays un-wrapped, existing dfn.term highlights are
  // neutralised by CSS (body.gloss-off), and prose-term clicks are ignored.
  // Tag chips / flavor terms keep their click-to-define: they're deliberate
  // UI, not inline highlighting.
  let enabled = true;
  function setEnabled(v) {
    enabled = !!v;
    document.body.classList.toggle("gloss-off", !enabled);
    if (!enabled) hide();
  }

  // ---- highlighter --------------------------------------------------------
  // skipKey: a canonical term to NOT link (so a definition never links to itself)
  function apply(root, skipKey) {
    if (!enabled || !root) return;
    const seenBy = new Map(); // first-occurrence dedupe is per parent block, not per whole subtree
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let cur;
    while ((cur = walker.nextNode())) nodes.push(cur);

    nodes.forEach(node => {
      const text = node.nodeValue;
      const block = node.parentElement;
      let seen = seenBy.get(block);
      if (!seen) { seen = new Set(); seenBy.set(block, seen); }
      const matches = [];
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(text))) {
        const key = LOOKUP[m[0].toLowerCase()];
        if (!key || key === skipKey || seen.has(key)) continue;
        seen.add(key);
        matches.push({ start: m.index, end: m.index + m[0].length, key, raw: m[0] });
      }
      if (!matches.length) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      matches.forEach(mt => {
        if (mt.start > last) frag.appendChild(document.createTextNode(text.slice(last, mt.start)));
        const dfn = document.createElement("dfn");
        dfn.className = "term";
        dfn.dataset.term = mt.key;
        dfn.tabIndex = 0;
        dfn.textContent = mt.raw;
        frag.appendChild(dfn);
        last = mt.end;
      });
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ---- popover ------------------------------------------------------------
  let pop, anchor = null;
  let navStack = [], curKey = null;   // history of terms visited within the popover

  function ensurePop() {
    if (pop) return;
    pop = document.createElement("div");
    pop.id = "gloss-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Glossary definition");
    document.body.appendChild(pop);
  }

  // mode: undefined = fresh open from the page (reset history); "nav" = followed a
  // link inside the popover (remember where we were); "back" = returning via Back.
  function showFor(key, anchorEl, pin, mode) {
    const t = TERMS[key] || (TAGDEFS[key] ? { short: TAGDEFS[key] } : null);
    if (!t) return;
    ensurePop();
    anchor = anchorEl;
    if (mode === "nav") { if (curKey && curKey !== key) navStack.push(curKey); }
    else if (mode !== "back") { navStack = []; }   // fresh open
    curKey = key;
    pop.innerHTML =
      (navStack.length ? "<a class=\"gloss-back\" data-back tabindex=\"0\" role=\"button\">← back</a>" : "") +
      `<div class="gloss-term">${key}</div><div class="gloss-def">${t.short}</div>` +
      (t.long ? `<div class="gloss-long">${t.long}</div>` : "") +
      (t.see && t.see.length
        ? `<div class="gloss-see">see also: ${t.see.map(s => `<a data-see="${s}" tabindex="0" role="button">${s}</a>`).join(", ")}</div>`
        : "");
    apply(pop, key);   // cross-link other terms in the definition, but never the term itself
    pop.classList.add("open");
    position();
  }

  function position() {
    if (!anchor) return;
    // measure invisibly: with motion off there's no fade-from-transparent to
    // hide a frame painted at the (0,0) measuring spot
    pop.style.visibility = "hidden";
    pop.style.left = "0px"; pop.style.top = "0px";
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, top) + "px";
    pop.style.visibility = "";
  }

  function hide() { if (pop) pop.classList.remove("open"); anchor = null; navStack = []; curKey = null; }

  // click to define (no hover). Clicks inside the popover keep the same anchor.
  document.addEventListener("click", e => {
    const back = e.target.closest && e.target.closest("[data-back]");
    if (back) { const prev = navStack.pop(); if (prev != null) showFor(prev, anchor, true, "back"); e.preventDefault(); e.stopPropagation(); return; }
    const see = e.target.closest && e.target.closest("[data-see]");
    if (see) { showFor(see.dataset.see, anchor, true, "nav"); e.preventDefault(); e.stopPropagation(); return; }
    const term = e.target.closest && e.target.closest("[data-term]");
    if (term && (enabled || !term.matches("dfn.term"))) {
      const inPop = term.closest("#gloss-pop");
      showFor(term.dataset.term, inPop ? anchor : term, true, inPop ? "nav" : undefined);
      e.stopPropagation();
      return;
    }
    if (e.target.closest && e.target.closest("#gloss-pop")) return;
    hide();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { hide(); return; }
    if (e.key === "Enter" || e.key === " ") {
      // mirror the click delegation: back / see-also links inside the popover,
      // then terms (a term inside the popover keeps its anchor + history)
      const back = e.target.closest && e.target.closest("[data-back]");
      if (back) { const prev = navStack.pop(); if (prev != null) showFor(prev, anchor, true, "back"); e.preventDefault(); return; }
      const see = e.target.closest && e.target.closest("[data-see]");
      if (see) { showFor(see.dataset.see, anchor, true, "nav"); e.preventDefault(); return; }
      const t = e.target.closest && e.target.closest("[data-term]");
      if (t && (enabled || !t.matches("dfn.term"))) {
        const inPop = t.closest("#gloss-pop");
        showFor(t.dataset.term, inPop ? anchor : t, true, inPop ? "nav" : undefined);
        e.preventDefault();
      }
    }
  });
  window.addEventListener("scroll", () => { if (pop && pop.classList.contains("open")) position(); }, true);
  window.addEventListener("resize", () => { if (pop && pop.classList.contains("open")) position(); });

  window.Glossary = { apply, setEnabled, hide, TERMS, TAGDEFS };
})();

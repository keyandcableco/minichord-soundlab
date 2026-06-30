# minichord Technical Reference

A complete technical reference for the **minichord**: how the instrument computes its
notes, talks over USB, stores its settings and makes its sound, assembled from the
firmware source and from behaviour verified against real hardware while building Sound
Lab. The final chapter (§10) specifies the inference engine Sound Lab layers on top:
how the Play tab reconstructs what you're physically doing from MIDI notes alone.

**Sources (ground truth):**
- `minichord/firmware/src/main.cpp`: the control loop, note math, chord/harp handling,
  rhythm sequencer, bank save/load. (Repo: [github.com/BenjaminPoilve/minichord](https://github.com/BenjaminPoilve/minichord))
- `minichord/firmware/include/sysex_handler.h`: the sysex address → action dispatch
  (auto-generated from `generator/parameters.json`).
- `minichord/firmware/generator/parameters.json`: the authoritative table: address,
  name, range, default, data type and `introduction_version` for every parameter.
- `minichord/firmware/lib/`: potentiometer, harp touch sensor, button matrix drivers.
- `soundlab/devicemap.js`: Sound Lab's port of the note math + the inference engine.

Firmware citations are given as `main.cpp:NNN` (line numbers in the v8 source).

---

## 1. Overview

The minichord is a pocket chord synthesizer: one hand presses a chord on a 7×3 button
grid, the other strums a 12-zone touch harp whose strings are always voiced from the
held chord. It is an open-source instrument by Benjamin Poilvé. Hardware (CC BY-NC 4.0)
and firmware (3-clause BSD) are published at the repo above; user documentation lives at
[minichord.com](https://minichord.com/).

Internally it is a Teensy running the Teensy Audio library. Everything configurable is a
**sysex parameter**: a 256-slot array of 16-bit values (`current_sysex_parameters`,
`main.cpp:126`) addressed 0–235. Twelve **banks** persist complete parameter sets to
flash. A host (Sound Lab, or the official minicontrol) edits the live array over USB
MIDI sysex; the device applies each change immediately through one generated dispatch
function, `apply_audio_parameter(adress, value)` (§8).

**Firmware versions.** The source declares `version_ID = 8` (`main.cpp:15`), readable at
address 7. Every parameter in `parameters.json` carries an `introduction_version`;
parameters newer than a device's firmware are silently ignored by it. The version map:

| Version | Added parameters |
|:--:|:--|
| 2 | the baseline: everything not listed below |
| 3 | sharp function (31), LED attenuation (32), chromatic mode (98), octave change (99/198) |
| 4 | Barry Harris mode (33) |
| 5 | harp transient amplitude/attack/hold/decay/note level (101–105) |
| 6 | chord frame shift (34), key signature (35), harp transient waveform (100) |
| 7 | chord glide (199) |
| 8 | MIDI channels (106/107), single port mode (108) |

---

## 2. Hardware controls

| Control | Hardware | Firmware entry point |
|:--|:--|:--|
| 21 chord buttons + sharp | shift-register button matrix, 22 debounced inputs (`chord_matrix`, index 0 = sharp) | `handle_chords_button()` `main.cpp:885` |
| 12-string touch harp | AT42QT2120 capacitive touch strip, 12 debounced zones | `handle_harp()` `main.cpp:908`, `lib/harp/` |
| 3 potentiometers | chord / harp / mod analog pots | `update_parameter()` per loop, `lib/potentiometer/` (§6) |
| hold button | short press: toggle continuous-chord latch; **long press (>800 ms): toggle rhythm mode**; short press *in* rhythm mode: tap-tempo | `handle_hold_button()` `main.cpp:1068` |
| up / down buttons | previous/next bank (auto-saves unsaved edits first, unless a sysex controller is connected) | `handle_preset_change()` `main.cpp:1109` |
| RGB LED | bank color: hue = addr 20, brightness = 1 − addr 32; sine-blinks on low battery | `set_led_color()` `main.cpp:300`, `handle_low_battery()` `main.cpp:1131` |
| rhythm LED | flashes the sequencer's beat grouping (brighter on chord-update steps) | `rythm_tick_function()` `main.cpp:659` |

**Button grid indexing.** Matrix index 0 is the sharp button. Buttons 1–21 form 7 lines
of 3: `line = (i − 1) / 3` with the three entries of a line being the **maj / min / 7th**
rows (`main.cpp:1207-1209`). Lines are in the firmware's button order **B E A D G C F**
(left to right on the faceplate this reads F C G D A E B, the reverse).

**The mute gesture.** In normal (non-latched) play, pressing three or more buttons in
the same row across different lines clears the current chord and inhibits buttons until
all are released (`handle_continuous_mode()` `main.cpp:1048`): a panic/mute swipe.

---

## 3. The chord engine

### 3.1 From buttons to a chord

Each loop pass, the firmware (`main.cpp:1204-1214`):

1. Sets `fundamental = current_line`: the first line pressed is the **root** and stays
   the root while held.
2. `detect_slash()` (`main.cpp:965`): any pressed button on a *different* line sets
   `slash_chord = true` and `slash_value` to that line: a slash/split bass.
3. Reads the root line's three buttons and picks the interval table
   (`handle_chord_type()` `main.cpp:943`):

   | Buttons held | Chord | With Barry Harris mode (addr 33) |
   |:--|:--|:--|
   | maj | major | maj_sixth |
   | min | minor | min_sixth |
   | 7th | seventh | — |
   | maj+7th | maj_seventh | — |
   | min+7th | min_seventh | — |
   | maj+min | dim | full_dim |
   | maj+min+7th | aug | — |

   Barry Harris mode is **baked into `current_chord` at press time**: the pointer keeps
   the substituted table until the next press, even if addr 33 changes meanwhile.
4. `update_chord_notes()` recomputes all 7 chord-table notes; `update_harp_notes()`
   recomputes the 12 strings (§4); `trigger_chord_notes()` fires the voices.

### 3.2 The chord note formula

`calculate_note_chord(voice, slashed, sharp)` (`main.cpp:601`):

```
level = chord_shuffling_array[chord_shuffling_selection][voice]   // addr 120 picks the row
octave = level / 10,  noteIndex = level % 10

if (slashed && noteIndex == note_slash_level)                     // addr 23
    note = 12*octave + get_root_button(key, shift, slash_value) ± sharp
else
    note = 12*octave + get_root_button(key, shift, fundamental) ± sharp
           + (*current_chord)[noteIndex]
```

`± sharp` is +1 while the sharp button is held, or −1 when the sharp *function*
(addr 31, `flat_button_modifier`) makes it a flat.

`get_root_button(key, shift, button)` (`main.cpp:565`) produces the root's semitone
offset from C:

```
note  = base_notes[button]                  // B=11 E=4 A=9 D=2 G=7 C=0 F=5
note += 12 if musical_index[button] < shift // chord frame shift, addr 34: scale degrees
                                            //   below the shift point move up an octave
note ± 1 per the key signature              // addr 35: sharps (keys C..B) raise the
                                            //   affected buttons, flats (F..Gb) lower them
```

### 3.3 Voicing: `chord_shuffling_array` (addr 120)

Seven slots per row; slots 0–3 drive the four live voices, slots 4–6 exist for the
rhythm sequencer's extra bits (§7). `level = octave*10 + chordNoteIndex`:

| Row | Meaning | Contents |
|:--:|:--|:--|
| 0 | close position | `0,1,2,3,4,5,6` |
| 1 | one octave up (with color tones) | `10,11,12,13,14,15,16` |
| 2 | octave up, low chord notes behind | `10,11,12,13,0,2,3` |
| 3 | octave up, low fifth + low colors | `10,11,12,13,2,5,6` |
| 4 | octave up, low fifth + high colors | `10,11,12,13,2,15,16` |
| 5 | two octaves up | `20,21,22,23,24,25,26` |

### 3.4 Triggering, retrigger, glide, latch

- `trigger_chord_notes()` (`main.cpp:1145`) starts the four voices on **staggered
  timers**: voice 0 immediately, voices 1–3 after `inter-note delay` (addr 135) ×1/2/3
  plus a random spread (addr 136): the built-in micro-strum.
- **Retrigger** (addr 21): when on, changing chords inside the same line re-fires the
  envelopes; when off, the new pitches glide in under the running envelope
  (`update_chord_notes()` calls `set_chord_voice_frequency` directly).
- **Glide** (addr 199, ms): when non-zero, each voice's oscillators sit at a fixed
  "middle note" and a DC ramp bends ±1 octave to the target over the glide time
  (`set_chord_voice_frequency()` `main.cpp:504`). MIDI out sends a clean
  NoteOff/NoteOn pair when the pitch lands on a new note.
- **Hold latch** (`continuous_chord`): the hold button latches the chord so it keeps
  sounding after release.

### 3.5 Chord MIDI out

Each voice send is `midi_base_note_transposed + current_applied_chord_notes[i]` on the
chord channel (addr 106) / chord port (§11), with NoteOff for the voice's previous note
first (`play_single_note()` `main.cpp:456`). `midi_base_note = 48` (C3);
`midi_base_note_transposed = 48 + transpose` (addr 30).

---

## 4. The harp engine

> The harp's **MIDI output** and its **audio pitch** are computed by two different
> formulas. The Play mirror cares only about the MIDI note number sent over USB.
> Several settings change the sound but **not** the MIDI note. See §4.3.

### 4.1 The harp MIDI formula

`handle_harp()` (`main.cpp:908`) sends, per strummed string `i`:

```c
usbMIDI.sendNoteOn(midi_base_note_transposed + current_harp_notes[i], ...)
```

So:

```
MIDI_harp(i) = midi_base_note(48) + transpose_semitones + current_harp_notes[i]
```

`current_harp_notes[i]` is `calculate_note_harp(i, slash_chord, sharp_active)`
(`main.cpp:620`):

```c
uint8_t calculate_note_harp(string, slashed, sharp):
  if (chromatic_harp_mode)            // addr 98
      return string + 24;             // fixed chromatic run; chord is ignored

  level = harp_shuffling_array[harp_shuffling_selection][string];   // addr 40 picks the row
  // level encodes octave and chord-note index:  octave = level / 10,  noteIndex = level % 10

  if (slashed && level % 10 == note_slash_level)                    // addr 23
      note = 12*(level/10) + get_root_button(key, frame_shift, slash_value) ± sharp;
  else
      note = 12*(level/10) + get_root_button(key, frame_shift, fundamental) ± sharp
             + (*current_chord)[level % 10];
  return note;
```

The same `get_root_button` as the chord engine (§3.2) supplies the root.

#### Worked example (matches a real capture)

Preset **Underwater** has `transpose = 3`. The **F button** is held with the harp on
**"with fourth"** (`harp_shuffling_selection = 2`), no key/shift/sharp,
`current_chord = major`.

- `fundamental` = F = button index **6**; `get_root_button(0, 0, 6) = base_notes[6] = 5`.
- `major = {0,4,7,12,2,5,9}`, `harp_shuffling_array[2] = {5,2,0,1,15,12,10,11,25,22,20,21}`.

| string | level | oct | idx | `major[idx]` | note | **MIDI = 48+3+note** |
|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 0 | 5  | 0 | 5 | 5 | 10 | **61** C#4 |
| 1 | 2  | 0 | 2 | 7 | 12 | **63** D#4 |
| 2 | 0  | 0 | 0 | 0 | 5  | **56** G#3 |
| 3 | 1  | 0 | 1 | 4 | 9  | **60** C4 |
| 4 | 15 | 1 | 5 | 5 | 22 | **73** C#5 |
| 5 | 12 | 1 | 2 | 7 | 24 | **75** D#5 |
| 6 | 10 | 1 | 0 | 0 | 17 | **68** G#4 |
| 7 | 11 | 1 | 1 | 4 | 21 | **72** C5 |
| 8 | 25 | 2 | 5 | 5 | 34 | **85** C#6 |
| 9 | 22 | 2 | 2 | 7 | 36 | **87** D#6 |
| 10 | 20 | 2 | 0 | 0 | 29 | **80** G#5 |
| 11 | 21 | 2 | 1 | 4 | 33 | **84** C6 |

The device emitted exactly `{61,63,56,60,73,75,68,72,85,87,80,84}`: every string matches.

### 4.2 Settings that change the harp MIDI note

| Addr | Name (editor) | Firmware variable | Ver | How it enters the formula |
|:--:|:--|:--|:--:|:--|
| 30 | transpose | `transpose_semitones` (→ `midi_base_note_transposed`) | 2 | `+value` semitones to **every** chord & harp MIDI note |
| 40 | harp shuffling | `harp_shuffling_selection` | 2 | selects the `harp_shuffling_array` **row** → the per-string `level` (octave + chord-note index) |
| 23 | slash level | `note_slash_level` | 2 | which chord level a slash chord replaces with the slash root |
| 31 | sharp function | `flat_button_modifier` | 3 | makes the sharp button subtract 1 (flat) instead of add 1 |
| 98 | chromatic mode | `chromatic_harp_mode` | 3 | overrides everything: `note = string + 24` (chord ignored) |
| 33 | barry harris mode | `barry_harris_mode` | 4 | swaps the chord table: major→maj_sixth, minor→min_sixth, dim→full_dim |
| 34 | chord frame shift | `chord_frame_shift` | 6 | raises low roots an octave (`musical_index < shift`) inside `get_root_button` |
| 35 | chord key signature | `key_signature_selection` | 6 | applies sharps/flats to roots inside `get_root_button` |
| — | sharp button (live) | `sharp_active` | — | ±1 on every harp note while held |
| — | **held chord** | `fundamental`, `current_chord` | — | the root button + interval table the strings are built from |

The **held chord** is the big one: the harp follows whatever chord is currently pressed
(§5). The Play mirror has to detect it from incoming chord MIDI to know `fundamental` +
`current_chord`.

### 4.3 What does NOT change the harp MIDI note

Keep these out of the note math:

| Addr | Name | Why it doesn't affect the harp MIDI note |
|:--:|:--|:--|
| 99 | harp octave change | **Audio frequency only.** `set_harp_voice_frequency` does `pow(2, harp_octave_change) * …`; the MIDI note has no octave term. A non-default value shifts the *sound*, not the note number. |
| 198 | chord octave change | Chord **audio** only, and a chord-section parameter; never touches the harp. |
| 120 | chord shuffling | Changes the **chord voice's** emitted notes (octave voicing). It does *not* enter the harp formula. It matters to the mirror **only** for chord *detection*, and like addr 40 for the harp, **a pot can drive it** (the dump then reports a stale value), octave-shifting the chord notes. `buildChordLookup` handles this by registering each chord at **every reachable voicing** (`shuffleRows(s.potTargets, 120, …)`), so `matchChord` recovers the grid at whatever octave the knob selects. |
| 106 / 107 / 108 | chord channel / harp channel / single-port mode | MIDI **routing** (cable/channel), not pitch. `harp_port = 1 - value` for addr 108. |
| 21 / 22 | retrigger chords / change held strings | Affect **when** notes re-fire on a chord change, not the pitch formula. |
| 41–97, 100–105, 121–197 … | all timbre params (osc, envelope, filter, FX) | Sound only. |

> Verified on hardware: a preset with `chord octave = 1` still emits chord notes at the
> base octave. Octave change is audio-only.

### 4.4 The tables (firmware ↔ devicemap.js, all verified identical)

#### `harp_shuffling_array[7][12]`: `HARP_SHUF`
`level = octave*10 + chordNoteIndex`. Row = `harp_shuffling_selection` (addr 40).

| Row | Editor name | Contents |
|:--:|:--|:--|
| 0 | normal | `0,1,2, 10,11,12, 20,21,22, 30,31,32` |
| 1 | with second | `4,1,0,2, 14,11,10,12, 24,21,20,22` |
| 2 | with fourth | `5,2,0,1, 15,12,10,11, 25,22,20,21` |
| 3 | with sixth | `6,2,0,1, 16,12,10,11, 26,22,20,21` |
| 4 | octaves | `0,1,2,3, 10,11,12,13, 20,21,22,23` |
| 5 | chromatic | `0,4,1,5,2,6, 10,14,11,15,12,16` |
| 6 | keymaster (Barry Harris) | `0,10,20, 1,11,21, 2,12,22, 3,13,23` |

#### Chord interval tables: `CHORD`
Per the firmware comment, the first four entries are the chord's own notes:
`0`=fundamental, `1`=third, `2`=fifth (or seventh), `3`=octave, and the last three are
`4`=second, `5`=fourth, `6`=sixth. (In a 6th chord the octave/6th land in slots 3 & 6.)

| Type | Intervals |
|:--|:--|
| major | `0,4,7,12,2,5,9` |
| minor | `0,3,7,12,1,5,8` |
| maj_sixth | `0,4,7,9,2,5,12` |
| min_sixth | `0,3,7,9,1,5,12` |
| seventh | `0,4,10,7,2,5,9` |
| maj_seventh | `0,4,11,7,2,5,9` |
| min_seventh | `0,3,10,7,1,5,8` |
| aug | `0,4,8,12,2,5,9` |
| dim | `0,3,6,12,2,5,9` |
| full_dim | `0,3,6,9,2,5,12` |

#### Root tables: `get_root_button` / `rootButton`
- `base_notes[7] = {11,4,9,2,7,0,5}`: button order **B, E, A, D, G, C, F** (semitones rel. C).
- `musical_index`: B=6, E=2, A=5, D=1, G=4, C=0, F=3 (scale degree, for frame shift).
- `key_signatures[12] = {0,1,2,3,4,5, 1,2,3,4,5,6}`: # accidentals per key.
- `sharp_notes` (keys C…B, in button order): adds # to F, then C, G, D, A, E.
- `flat_notes` (keys F…Gb): adds ♭ to B, then E, A, D, G, C.
- `midi_base_note = 48` (C3).

(The chord voicing table is in §3.3.)

---

## 5. Chord ↔ harp coupling

The harp is built from the **currently held chord**:

- `fundamental = current_line`: the button line being pressed (0–6 = B,E,A,D,G,C,F).
- `current_chord` is set by `handle_chord_type` (§3.1), Barry Harris already baked in.
- **Slash chord:** pressing a button on a *different* line sets `slash_chord` +
  `slash_value` (the other line's root). For strings whose `level % 10 ==
  note_slash_level` (addr 23), the root is taken from `slash_value` instead of
  `fundamental`.
- **Update timing:** `update_harp_notes()` (`main.cpp:996`) recomputes
  `current_harp_notes[]` only while a chord is held (`button_pushed`). `change held
  strings` (addr 22) re-pitches strings that are still ringing when the chord changes;
  otherwise they keep their old pitch until re-struck.
- **Default resting context:** firmware boots with `fundamental = 0` (**B**) and
  `current_chord = &major` until the first chord is pressed.
- **Offline click-preview mirrors this composition.** When disconnected, clicking grid
  cells in Sound Lab builds a chord exactly like the hardware: the **first column
  clicked is the root** (`current_line`/`fundamental`); further clicks in that column
  toggle maj/min/7th into a combo (`handle_chord_type`, e.g. major + 7th →
  `maj_seventh`); a click in a **second** column is the split/slash bass
  (`detect_slash`, line-only; row ignored). Clicks accumulate (no auto-deselect); the
  preview clears and restarts only on a click it can't combine: a **third** distinct
  column (the chord model carries one root + one slash). `devicemap.js` `previewChord` /
  `renderPreview` + `comboType` (reverse of `COMBOS`).

---

## 6. Potentiometers

Three pots: **chord**, **harp**, **mod**. Each has a **main** and an **alternate**
function; **holding the sharp button switches a pot to its alternate** (`main.cpp:1193`,
`alternate = chord_matrix_array[0].read_value()`).

| Pot | Main target | Alternate target |
|:--|:--|:--|
| chord | addr 3 (chord gain, hardwired) | the address stored in **addr 10** (range addr 11) |
| harp | addr 2 (harp gain, hardwired) | the address stored in **addr 12** (range addr 13) |
| mod | the address stored in **addr 14** (range addr 15) | the address stored in **addr 16** (range addr 17) |

So the assignable targets live at addresses 10/12/14/16, each paired with a percentage
range at 11/13/15/17. Assignable targets are restricted to addresses 21–219 (a pot may
not target the pot configuration itself).

### 6.1 The range window

From `lib/potentiometer/src/potentiometer.cpp:63-67`: the knob maps to a window
**centred on the target's stored value**, not 0–max:

```
min = stored × (1 − range/100)
max = stored × (1 + range/100)
output = constrain(map(reading, dead_zone … 1024−dead_zone, min, max))
```

Two practical consequences:

- **The zero trap.** Any percentage of a stored 0 is 0; a target whose stored value is
  0 cannot move at all. Give it a mid-way stored value first.
- **The out-of-bounds trap.** A 100 % range on stored value *N* sweeps `0 … 2N`. If the
  target is a table selector (e.g. addr 40, rows 0–6, stored 4), the top of the travel
  drives the selection past the end of the table and the firmware reads out of bounds;
  the harp emits undefined notes there. Usable travel is whatever maps inside the
  table.

The reading is smoothed (10:1 IIR), has a 20-count dead zone at both ends and a
20-count change threshold (`potentiometer.h`).

### 6.2 Applied but not saved ⚠️

The pot's **main** function is applied through `apply_audio_parameter` but **never
written back** to `current_sysex_parameters[]` (`potentiometer.cpp:69`, *"note:
applied but not saved. So we can still read the initial value"*). So:

- the device *plays* the knob's value, but
- a sysex dump still reports the preset's **stored** value for that address.

**The dump cannot report anything a pot's main function controls.** Requesting a fresh
dump doesn't help; the live value is unreadable over sysex by design. The Play mirror
therefore must *infer* pot-driven note settings from the notes themselves (§10).

The **alternate** function is different: its raw knob position (0–1024) is saved to the
pot's storage address (4/5/6) and restored on bank load (`set_alternate_default` +
`force_update`), so alternate settings persist.

Two more behaviours worth knowing:

- **Editor edits win, knob position notwithstanding.** When a host writes a new stored
  value to a pot's main target, the pot notices the register change and re-applies its
  window around the new value (`update_parameter`'s `old_main_adress_value` check).
- **Sound Lab recentres the pickup on every dump** (as does the official minicontrol;
  the controller code is shared): it writes 512 (dead centre) to the alternate position
  memories (addrs 4–6) and 0.5 to the section gains (addrs 2–3). Why: on bank load the
  firmware re-applies each alternate target from its saved knob position, and an
  off-centre position means the device is already playing an *offset* version of that
  parameter while the dump reports the plain stored value; the editor and the sound
  would disagree before anything is touched. Because the window is centred on the
  stored value, position 512 contributes exactly zero offset, aligning the audible
  state with the dump. The 0.5 gains give the hardwired volume knobs a full,
  predictable 0→1 sweep across presets. The deliberate tradeoff: connecting an editor
  resets the player's saved alternate-knob nuance to neutral for the session.

### 6.3 What the Play tab tells the user

When a pot targets a note-shaping address (`POT_AFFECTED` in `devicemap.js`), the
mirror shows a warning chip naming the knob's target. The copy distinguishes:

- **Inferable: addr 40 (harp row) and 120 (chord voicing).** These rearrange/octave-
  shift notes into sets that don't alias with a different chord, so the emitted notes
  pin them down. It's still a best guess from what's played, with no guaranteed
  lock-in time.
- **Not inferable: transpose 30, key 35, frame shift 34, barry 33, sharp-fn 31,
  slash 23, chromatic 98.** These shift the tuning **uniformly or ambiguously**: a
  transposed (or re-keyed) chord is byte-identical over MIDI to a *different* chord
  that's already a valid grid position (the 7 buttons cover the naturals; sharp + key
  reach all 12 roots; "+1 semitone" *is* the sharp button). The offset is unobservable;
  it matches a *wrong* button with no "unmatched" signal to infer from.

Octave knobs 99/198 are audio-only (§4.3) → no warning needed.

---

## 7. The rhythm sequencer

A 16-step × 7-voice pattern sequencer over the held chord. Entered by **long-pressing
the hold button** (`main.cpp:1088`); a short press while running tap-sets the BPM.

### 7.1 Parameters

| Addr | Name | Range | Meaning |
|:--:|:--|:--|:--|
| 187 | BPM | 30–300 | step rate (two steps per beat) |
| 188 | cycle length | 1–16 | loop length in steps (`rythm_loop_length`) |
| 189 | measure update | 1–8 | adopt chord changes only every N steps (`rythm_limit_change_to_every`) |
| 190 | shuffle | 0.5–1.5 (×100 on the wire) | swing: lengthens one step of each pair, shortens the other |
| 191 | note duration | 20–1000 ms | how long each triggered note holds before NoteOff |
| 220–235 | pattern step 0–15 | 0–127 | a 7-bit voice mask per step |

### 7.2 How a step plays: `rythm_tick_function()` (`main.cpp:643`)

- Each step reads `rythm_pattern[step]`; **bit i (0–6) = chord-table slot i** of the
  current voicing row: the full 7-slot chord (§3.3), not just the 4 live voices.
- Only 4 physical voices exist, so bits 4–6 are folded onto voices 1–3
  (`current_voice = i − 3`): a high slot **steals** that voice for the step.
- **Chord freeze:** the sounding notes come from `rythm_freeze_current_chord_notes[]`,
  refreshed from the live chord only on steps where `step % rythm_limit_change_to_every
  == 0`: chord changes land on the next musical boundary, not mid-figure.
- Each triggered note sends MIDI NoteOn (chord channel/port) and is NoteOff'd after
  `note duration` ms by `handle_rhythm_mode()` (`main.cpp:1032`).

### 7.3 Timing and swing

The timer alternates a **long** and a **short** period per step pair
(`main.cpp:253-254`, `recalculate_timer()`):

```
long  = shuffle × (60·10⁶ µs) / (2 × BPM)
short = 2 × (60·10⁶) / (2 × BPM) − long
```

`shuffle = 1` is straight time; away from 1, one step of each pair lengthens and the
other shortens: swing.

### 7.4 External MIDI clock

The device also follows an incoming MIDI clock while in rhythm mode (`processMIDI()`
`main.cpp:418-451`): Start resets to step 0; the BPM is a running average of the
24-ppqn clock; once per 24 clocks the internal timer is re-phased to the clock, and it
free-runs between syncs so the shuffle feel survives external sync.

---

## 8. Sysex protocol & address space

### 8.1 Wire format

Every message is a 6-byte sysex (`processMIDI()` `main.cpp:399-417`):

```
F0  addrLo  addrHi  valueLo  valueHi  F7      // 7-bit pairs: x = lo + 128*hi
```

- `address ≠ 0`: write `value` to `current_sysex_parameters[address]` and apply it
  immediately via `apply_audio_parameter(address, value)`.
- `address = 0`: a **control command**. `valueLo` is the command, `valueHi` its
  parameter (`control_command()` `main.cpp:362`):

| Cmd | Action |
|:--:|:--|
| 0 | **dump request**: replies with one 512-byte sysex: the 256 parameters as lo/hi byte pairs |
| 1 | wipe memory (reformat flash, reload bank 0) |
| 2 | save the live parameters to bank *parameter* |
| 3 | reset bank *parameter* to its factory default |

Values are 16-bit ints. **Float parameters travel ×100** (the generated method divides
by 100, e.g. `main_reverb.size(value/100.0)`); Sound Lab multiplies/divides at its end
(`FLOAT_MULT` in `soundlab.js`).

Receiving any valid sysex marks a controller as connected
(`sysex_controler_connected`), which suspends the auto-save-on-bank-change behaviour so
the editor stays authoritative.

### 8.2 Address space map

| Range | Contents |
|:--|:--|
| 0 | control command (never a parameter) |
| 1 | bank id (set in saved files; tells a host which bank a dump describes) |
| 2–3 | harp / chord section gain (the hardwired pot mains; "hidden" in the catalog) |
| 4–6 | chord / harp / mod pot **alternate position memory** (raw 0–1024) |
| 7 | firmware revision (read-only; writes are overwritten with `version_ID`) |
| 10–17 | pot config: alternate target/range (chord 10/11, harp 12/13), mod main 14/15, mod alternate 16/17 |
| 20–35 | global settings: bank color 20, retrigger 21, held strings 22, slash level 23, reverb 24–28, pan 29, transpose 30, sharp function 31, LED attenuation 32, barry 33, frame shift 34, key signature 35 |
| 40–105 | **harp section**: row 40, oscillator 41–42, amp envelope 43–48, low-pass filter 49–58, tremolo 59–61, vibrato 62–76, effects (delay/reverb/crunch) 77–87, output filter 88–97, chromatic 98, octave 99, transient 100–105 |
| 106–108 | MIDI: chord channel, harp channel, single port mode |
| 120–199 | **chord section**: voicing 120, oscillators 121–136, amp envelope 137–142, low-pass filter 143–155, tremolo 156–159, vibrato 160–175, effects 176–186, rhythm scalars 187–191, output filter 192–197, octave 198, glide 199 |
| 220–235 | rhythm pattern steps 0–15 |

The complete per-address table (name, range, default, version, group) is
`firmware/generator/parameters.json`; `sysex_handler.h` is generated from it, and Sound
Lab's `params.js` catalog mirrors it with teaching copy.

`pan` (addr 29) is a coupling quirk: applying it re-applies the two reverb-level
parameters (85/184) because the stereo gains bake the pan into their values.

### 8.3 Banks: save & load

- Twelve banks persist as CSV text files `a.txt` … `l.txt` on LittleFS program flash
  (`serialize`/`deserialize`, `save_config`, `load_config`, `main.cpp:692-797`).
- Factory defaults are hardcoded (`default_bank_sysex_parameters[12][256]`,
  `main.cpp:112`); a missing file is recreated from them on load.
- `load_config` re-runs `apply_audio_parameter` for **every** address, re-arms the three
  pots, then issues itself a dump (`control_command(0, 0)`) so any attached host
  refreshes too. Sound Lab therefore receives a fresh dump whenever the user changes
  banks on the device.
- The up/down buttons auto-save unsaved knob tweaks before switching banks **unless** a
  sysex controller is connected (the editor owns the state then).

---

## 9. The audio signal chain

Defined in `include/audio_definition.h` as a Teensy Audio graph (≈180 objects). The
shape, per section:

**Harp: 12 independent string voices.** Each string: a `AudioSynthWaveformModulated`
oscillator (12 selectable waveforms, addr 42) plus a separate **transient** oscillator
(a short pitched attack blip, addrs 100–105), each through its own
`AudioEffectEnvelope`; a per-string state-variable **low-pass filter** with its own
filter envelope (addrs 49–58, keytrackable). The 12 strings mix down, pass a shared
**vibrato** LFO (62–76, with pitch-bend envelope), then a **waveshaper** ("crunch",
86–87), a **delay** line with a multimode filter in its feedback path (77–84), the
**output filter** with its own LFO (88–96), and an output amplifier (97).

**Chord: 4 voices.** Each voice: **three oscillators** (independent waveform +
amplitude + frequency-multiplier trios at 121–129) plus a **white-noise** source (130),
mixed; a state-variable filter with filter envelope (143–155); a **tremolo** multiplier
(156–159); the amp envelope (137–142). Per-voice level trims live at 131–134 ("first
note" … "fourth note"). A shared vibrato LFO with pitch-bend envelope (160–175) feeds
the oscillators' FM inputs; glide is a DC ramp into the same FM input (§3.4). The voice
mix then passes crunch (185–186), delay (176–183), output filter (192–197) and the
output amplifier.

**Global.** Both sections send into one **stereo plate reverb**
(`AudioEffectPlateReverb`; size/damping/lowpass/diffusion at 24–28, per-section send
levels at 85/184). `pan` (29) sets the dry signal's stereo placement; a fixed
`reverb_dry_proportion = 0.6` keeps some dry signal at full reverb so volume doesn't
collapse. The result goes to **both** the I2S DAC (headphone jack) and `AudioOutputUSB`
. The minichord is also a USB audio interface.

**Audio pitch vs MIDI pitch.** Audio frequencies include the octave-change parameters:
`chord: 2^octave × C3/8 × 2^((note+transpose)/12)` (`main.cpp:505`),
`harp: 2^octave × C3/4 × 2^((note+transpose)/12)` (`main.cpp:555`). MIDI notes do not
(§4.3). The two pipelines only share `note` and `transpose`.

---

## 10. What Sound Lab infers vs what the firmware reports

The minichord transmits only **notes**, never which button or string produced them,
and (per §6.2) its dumps can't report pot-driven values. `devicemap.js` therefore
forward-simulates the firmware's note math (§3–§5) and runs an inference layer that
maps incoming notes back to buttons, strings and the settings the dump can't tell it.
This chapter is the specification of that layer; code comments cite these sections.

### 10.1 The canonical chord descriptor & the one note generator

Every chord the engine reasons about is one shape: `{ button: 0..6, type: <resolved
CHORD key>, sharp: bool, slash: {button}|null }`, mirroring the firmware's live
`fundamental` + `current_chord` (Barry Harris baked into `type` at build time, as the
firmware bakes it into `current_chord` at press time). Everything display needs is
DERIVED, never stored: faceplate **column** = `colOf(button) = 6 − button` (the
F C G D A E B reversal, an involution; `buttonOfCol` is the same map), **lit rows** =
`typeRows(type)` (barry-aware via `BARRY_BASE`), root pitch-class and label likewise.
`buildChordLookup` candidates, `held`, `identifyChord`'s output and the rhythm tint all
speak this one descriptor.

**One note generator.** `voiceSet(button, table, s, {count, row, off, sharp, slash})`
is the single "what notes does this chord emit" function (a thin wrapper over
`chordVoiceNote`). The grid lookup, the rhythm base table and any voice list go through
it. There is no second copy of the formula.

### 10.2 The device-mapping pipeline: `rebuild()`, on every patch change

```
on rebuild():
  prevShuf = s.harpShuf
  s = readSettings(patch)                         // §4.2 settings + clamps, plus:
      s.potTargets = { patch[10], patch[12], patch[14], patch[16] }   // §6 live pot targets
  // effHarpShuf tracks the dump's stored row. PRESERVE an inferred row only when a pot can
  // drive addr 40 (dump can't report it) AND it didn't change; otherwise trust the patch.
  if (not potTargets.has(40)) or (s.harpShuf != prevShuf):  effHarpShuf = s.harpShuf
  recentHarp = []                                 // settings changed → drop strum history
  rebuildLookups()                                // chordLookup + lookupList + rhythmBases, together
  relabel()                                       // chord-grid + harp-string text labels
  paintChord()                                    // re-evaluate the currently-held chord
```

`readSettings` is the single source of truth for the note formula: only addresses that
change the **MIDI note** are read (§4.2), never the audio-only ones (§4.3).
`rebuildLookups()` is the one helper that rebuilds all three derived tables from `s`
together, used at all its call sites (init, `rebuild`, the transpose-adopt in
`chordNoteOn`) so they can never drift apart:

- `buildChordLookup(s)` → the grid detection table: canonical-descriptor candidates
  keyed by emitted note set, built over `shuffleRows(s.potTargets, 120, s.chordShuf, 6)`
  just the stored voicing normally, **every voicing** when a pot drives addr 120 (so
  `matchChord` recovers the grid at whatever octave the knob selects). `listFromLookup`
  flattens it to `{counts, cands}`.
- `buildRhythmBases(s)` → the rhythm identifier's precomputed bases: one `{b, type,
  press, row, notes}` per (button × CHORD type × reachable voicing), over the **same**
  `shuffleRows(..., 120, ...)`.

`shuffleRows` is the one pot-aware row searcher, shared by the grid voicing search, the
rhythm voicing search and the harp's row search (`reinferHarp`).

**Why rebuild must reset `effHarpShuf` (the absorption trap).** Inference only re-fires
on a *miss*, but a wrong row can silently *absorb* a strum, e.g. **normal** (row 0)
produces the chord triad at every octave, so it can place every note an **octaves**
(row 4) strum emits, just collapsing the doubled strings. No note ever misses, so
inference never self-corrects. Switching to a preset whose row is *not* pot-driven must
therefore adopt the stored row outright (the `effHarpShuf` reset above) rather than
waiting for a miss that never comes. Symptom prevented: loading a pot-on-40 preset and
then a no-pot preset that stores the same row would otherwise keep the first preset's
inferred row and show *normal* while the device strums *octaves*.

### 10.3 Grid chord detection: `matchChord` & frozen transpose

The grid learns a chord all at once: the held note set (plus recently dropped notes,
the "soup") is matched by containment against `lookupList` (held ⊆ candidate ⊆
held ∪ dropped). The winner is committed through `applyChord` as the canonical
descriptor; a real chord trigger also resyncs the harp context and clears any desync
badge (retriggers of the same chord re-apply without wiping a live desync).

**Frozen transpose for the grid.** Transpose (addr 30) is added at NoteOn *send time*
(`midi_base_note_transposed`), not into the interval tables, and the sysex method sets
it immediately. It is **not** button-gated. A held chord's NoteOns are already out, so
changing addr 30 does not move them: the chord stays at its press-time transpose until
the next press. The harp is the opposite: each string's NoteOn is sent live at
strum-time, so it always carries the current transpose. The mirror therefore freezes
only the chord side: `effChordTranspose` lags `s.transpose` while a chord is held (the
lookup is built from it), adopting the live value on a chord press or when nothing is
held; the harp keeps live `s.transpose`. Without this, nudging transpose while holding
a chord lights the *wrong* grid button (every candidate shifts uniformly, so the
still-held notes match a different one). Display labels use the same frozen value, and
a slash bass is named with the **same** transpose as its root (`chordLabel`).

### 10.4 Rhythm chord identification: `identifyChord(pitches, prev)`

The other side of the coin from `matchChord`: rhythm mode plays an **arpeggio** (one
note at a time), so no single burst contains the chord. The identifier instead works
from a **rolling onset history sized to one full pattern cycle** (see below), matching
its distinct pitches, corroborated by recent harp pitch-classes, against the
precomputed `rhythmBases`. The mirror's live held/dropped notes are deliberately NOT
folded in: in rhythm mode those are the arpeggio's own still-ringing voices, and
trusting them would poison the read across a chord change. (A held grid chord still
registers naturally. The arpeggio plays its notes, so they arrive as onsets.)

```
identifyChord(onsets, prev):                 // onsets: the caller's cycle-sized history, each
                                             //   {p, vs: the step's fired voice indices, m: burst multiplicity}
  want   = distinct onset pitches            // octave-exact
  harpPc = pitch-classes of recentHarp within EVID_TTL    // harp corroboration (spans octaves)
  if want and harpPc both empty: return null
  positional = any onset carries fired-voice tags (vs)    // phase locked + no pot on the pattern
  allowShift = harpPc ≥ HARP_MIN             // a transpose Δ is searched only with real harp
                                             //   corroboration — never guessed from the arpeggio alone
  for cand in rhythmBases (button × type × reachable voicing):
    skip colored types (7/maj7/m7/dim/aug/m6) whose signature tone isn't currently heard
    for off in (allowShift ? −DMAX..DMAX : {0}):
      exact = |want ∩ (cand.notes + off)|    // octave-exact onset coverage
      hc    = |harpPc ∩ pitch-classes(cand.notes + off)|
      seq   = onsets landing on a voice their step actually FIRED (voice-structure agreement)
      score = positional ? [−seq, −(exact+hc), −exact, press, |off|, isPrev]  // the pattern is authoritative
                         : [−(exact+hc), −exact, −seq, press, |off|, isPrev]  // fuzzy + sticky
      keep the lexLess-smallest
  fuzzy stickiness: prev keeps the read unless beaten by > STICK_MARGIN — overridden by
    explanation dominance (below); positional mode skips stickiness (momentary by design:
    a ♭7 onset IS a 7th while it sounds)
  gates: exact ≥ |want|−1 (≤1 stray) ; exact+hc ≥ 2 ; exact ≥ 2 unless hc ≥ HARP_MIN
  slash refinement: adopt X/Y only when the bass is genuinely among the onsets and improves
    coverage, or resolves a multiset violation (a pitch sounded on more voices than the
    plain chord carries it)
  return { notes[7], button, type, transposeOffset, slashButton }   // soundlab voiceMask contract
```

A sparse rhythm, even a lone root, can still be named when a harp strum corroborates
it (12 strings cover most of the scale); alone, a single note never names a chord (the
playhead still locks on timing). A pot-driven voicing identifies exactly like the grid:
the two matchers share the descriptor, the generator (`voiceSet`), the voicing search
(`shuffleRows`) and the comparator (`lexLess`); they differ only in how the evidence
arrives (all at once on a press vs accumulated across the cycle) and in the
positional/Δ machinery.
Transpose/key stay un-inferable (§6.3). Δ is a *corroborated* search, never a guess
from a lone note.

**The caller's evidence window spans one full pattern cycle.** The controller
(`createRhythmSync` in `soundlab.js`) keeps a rolling onset history and feeds
`identifyChord` the last `cycleOnsets()` of it, the number of notes one cycle of the
step pattern fires (clamped 6–24). A repeating pattern shows everything it will ever
show in one cycle, so once a clean cycle is in evidence the lex-best guess is the best
guess over *all* the data, and the dominance rule above (a rival must place all-but-one
of the distinct onsets) can no longer be satisfied by a partial-fragment rival; the
read holds steady instead of drifting as a shorter window slides past the
distinguishing notes. Re-identification is only attempted at all when a burst contains
something the current guess can't place; a real chord change re-opens it through that
outsider path (one outsider → re-identify with dominance; two consecutive → the
history is wiped and the lock rebuilt from the new chord's notes alone).

Three rules keep the read stable without going stale:

- **Δ-twin resolution.** Far-shifted transpose twins are note-identical (F7 at Δ−3 ≡ D7
  at Δ0), so "last match wins" would hand the sticky hold a far-shifted twin's button.
  The previous chord's fit is kept at the candidate **nearest Δ = 0**.
- **Dominance rival root tie-break.** The dominance rival (below) is the lex-best
  candidate that *places the anchor onset*; on a full tie it keeps the previous chord's
  **root**. Dominance is about color flips (D6↔D7, F6↔Fmaj7); a root change must win
  on real evidence, not enumeration order.
- **Explanation dominance.** The sticky margin may only arbitrate between candidates
  that both PLACE the evidence. If the previous chord cannot place an onset at all
  (octave-exact) while some candidate places it plus all-but-≤1 of the distinct onsets,
  that candidate takes the read immediately, no margin. Two chords can differ in
  exactly one pitch, and the margin would swallow precisely that distinguishing onset.
  All-but-one (not all) because the rolling onset window straddles a chord change, so
  the outgoing chord's tone lingers. Judged on octave-exact onsets only. Harp
  pitch-classes aren't octave-exact, so they stay advisory and never grant or veto a
  dominance flip. Momentary flips are correct here: they mirror what the pattern is
  actually playing.

### 10.5 Harp lighting + inference: per incoming harp note

```
on harp note-on(note):
  recentHarp.push({note, t}) ; keep last 12             // ≈ one strum, with timing
  matches = noteStrings(note, held, effHarpShuf)         // strings carrying note now
  if matches is empty:                                   // ← re-infer ONLY on a miss
      reinferHarp(note)
      matches = noteStrings(note, held, effHarpShuf)
  if matches is empty:  return                           // unexplained → don't light
  want = min(activeHarp[note], matches.length)           // # strings physically sounding this pitch
  light the `want` matches that FOLLOW THE FINGER (heat-map): candidates ahead of the strum
        front in the direction of travel win (nearest first), then the ones behind; with no
        fresh direction (first note / pause > HARP_DIR_MS) plain nearest to the front.
        // a re-plucked twin advances WITH the sweep (C/G carries G on two strings — raw
        // nearest distance ties and would snap back); an octave double lights both plates
        // and moves the front to the FAR plate; direction updates from the front's movement
on harp note-off(note):  decrement activeHarp[note]; unlight only when it hits 0 (another
        string may still sound the pitch). fades over the release tail
```

```
reinferHarp(note):                                       // called only on a miss
  if chromatic: return                                   // fixed notes, no context
  chordActive = heldNotes nonempty                       // a chord is down on the chord port
  if not chordActive and not potTargets.has(40):
      return settleHarp(note)                            // closed-search settle — §10.6
  contexts = chordActive ? [held]                        //   trust it — infer ROW only
                         : every { button 0..6 × the 10 RESOLVED chord tables,
                                   sharp:false, slash:null }   // major vs maj_sixth: notes decide
  rows = potTargets.has(40) ? [0..6] : [s.harpShuf]      // §6: row uncertain only if a pot drives 40
  (diagnostic-tone gate when inferring: a colored table — 7/maj7/m7/dim/aug/m6 — is skipped
   unless its signature tone was strummed; the current context is exempt)
  for each (ctx, row):                                   // fit = candFit(ctx,row), shared with settleHarp
      map = note → [string indices]  for the 12 strings under (ctx, row)
      coverage = Σ min(playedCount[n], |map[n]|)         // multiset occurrences placeable
      overplay = Σ max(0, playedCount[n] − |map[n]|)     // played more often than strings exist
      pathLen  = Σ |Δ string| over the played order, counting only steps ≤ FAST_MS apart
      extra    = # notes the candidate makes that weren't emitted
      spotDist = mid-swipe only: distance from where the finger's momentum says the missed
                 note should land (last lit position + direction, fresh within HARP_DIR_MS);
                 13 if the candidate can't place it at all; 0 for everyone when momentum is
                 stale, so non-swipe inference is unaffected
      btns     = button simplicity: presses needed to play the candidate (+1 for a slash)
      score    = [ −coverage, overplay, spotDist, pathLen, btns, extra, (candidate == current ? 0 : 1) ]
      keep the lexicographically smallest score (first seen wins ties)   // = lexLess()
  slash refinement on the winner (inferring only): adopt X/Y only if the bass places MORE notes
  if a best exists and it differs from (held, effHarpShuf): commit + relabelHarp()
```

The scoring uses order + distance + speed + occurrence count, not just the note *set*,
so it locks in well before all 12 strings are played: a strum hits *adjacent* strings in
*quick* succession, so the right `(button, type, row)` traces a smooth near-monotonic
path while a wrong guess scatters; and counting note *occurrences* as a multiset (a
note on N strings is strummed N times) separates rows that repeat notes (*octaves*,
*keymaster*) from rows that don't. The momentum-spot term sharpens this mid-swipe: the
finger's next position is predictable (last lit string + travel direction), so the row
that carries the missed note exactly *there* is almost certainly the live one, which
is what re-locks a pot-driven row change in the middle of a single strum.

**What gets inferred, by state:**

| Chord held on port? | A pot drives addr 40? | Infer chord (button+type)? | Infer row? |
|:--:|:--:|:--:|:--:|
| yes | no  | no: trusts the port | no: row = `patch[40]` (note just won't light if unplaceable) |
| yes | yes | no: trusts the port | **yes**: all 7 rows |
| no  | no  | **yes**: settled suffix search: 7×10 tables **+ slash variants** (§10.6) | no: row = `patch[40]` |
| no  | yes | **yes**: 70 contexts (fuzzy coverage) | **yes**: 70 × 7 |

**Edits win, re-syncs don't.** A real control edit (the editor changing `patch[40]`) is
adopted immediately; a same-value dump re-sync never clobbers an inferred row.

### 10.6 The settled search: `settleHarp`

With **no chord held and no pot on addr 40**, every candidate's 12-string layout is
EXACT. A context either CAN or CANNOT emit a note, so one inexplicable note disproves
it. (A fuzzy coverage-margin comparison is the wrong tool in this state: over a sliding
window it flips through ambiguous runs, fragments of two chords each "win" briefly,
while never searching slash layouts at all. The settled search makes slash variants
first-class candidates and lets a rival take the read only by *perfectly* explaining
the trailing strum.)

```
settleHarp(note):
  segment    = trailing recentHarp notes with no inter-onset gap > SEG_MS (a new gesture
               is a new segment)
  candidates = the gated plain contexts (7 buttons × 10 tables) + slash variants whose
               BASS pitch-class was strummed (slash strings carry the bass, so a real
               slash strum emits it; the current slash is exempt from that prune);
               row is fixed at s.harpShuf; plains are scored first so a tie prefers the
               simpler reading
  for each candidate:
      suffix = how many newest-first segment notes it carries (multiset: a note repeats up to
               its string count; a note placeable by NOBODY — glitch/out-of-range — is
               transparent: skipped (≤2), it glows but can neither cause nor block a switch;
               the trigger note itself must be placed)
      score  = [ −suffix, −coverage, overplay, pathLen, btns, extra, isCur ]
               // btns = button simplicity: presses needed (+1 for a slash) — on tied evidence
               // plain Dm beats Dm/F and Am beats Eaug; with the plains-first enumeration this
               // is what makes a tie prefer the simpler reading
  if best.suffix == 0: return                            // nobody places the trigger → it glows
  cold = the current context places NOTHING of the segment and best explains ALL of it
  if best.suffix ≥ HARP_SUFFIX_MIN or cold:
      commit best — chord AND slash AND row — then relabelHarp()
  else: hold the current context (the miss glows); an ambiguous run that fits fragments
        of two chords stops flicking the context
```

The **cold-start** clause makes the very first strum light correctly with no chord
press and no threshold wait.

### 10.7 Lazy settings: what only takes effect on the next note

`update_harp_notes()` rewrites `current_harp_notes[]` **only on a button push**
(`main.cpp:997`), and the sysex methods for **40** (row) and **99** (octave) also
recompute inline, but **98 (chromatic)**, 35 (key), 34 (shift), 33 (barry), 31
(sharp-fn) and 23 (slash) just set their variable. So toggling chromatic changes the
*flag* but the **emitted** harp doesn't change until the next chord. The mirror matches
this for chromatic: `effChromatic` lags `s.chromatic` (the harp renders with
`effChromatic`) and only adopts the new value when the row changes (addr 40 → device
recomputed) or a chord note arrives (`chordNoteOn`). Barry is handled differently:
it's baked into `held.type` at set time (§10.1), so it likewise doesn't move the harp
until the next chord. Key/shift/slash share the same lazy nature in the firmware; the
mirror doesn't currently defer them (it would matter only if they're edited mid-ring).

Transpose's lazy behaviour (chord frozen, harp live) is in §10.3.

### 10.8 Display behaviour

- **Readout history.** Each reading is tagged with its chord's root button; a new
  reading pushes the old into history only when the **button** changes; re-readings of
  the same chord (a transpose/type refinement getting better) replace in place.
- **Tint debounce.** Rapid back-to-back rhythm-tint changes reset a short timer
  (`TINT_DEBOUNCE`), so only the settled tint ever paints; a chord that lights and
  clears within the window never starts an animation.
- **Fades.** A previous chord's buttons and released strings fade over the patch's
  release tail; a string stays lit while *any* string still sounds its pitch
  (`activeHarp` reference counts).
- **Barry survives preset changes.** A strum carried over from a non-barry preset into
  a barry preset still reads as major: the notes decide major-vs-6th, not the new
  preset's barry flag (the resolved type lives in the descriptor, §10.1).
- **Desync badge.** A fast combo press can briefly split the two sections. Each loop the
  firmware recomputes chord and harp notes from the same `current_chord`, but
  `trigger_chord_notes` (`main.cpp:1145`) strums the four chord voices on staggered timers
  (`note_timer[0..3]`), so a second button landing a loop later leaves already-sent chord
  voices on the old chord while `update_harp_notes` (`main.cpp:996`) has moved the harp to
  the new one. Confirmed on hardware: hold a major, add the 7th, and the chord port keeps
  voicing the triad while the harp plays the seventh, until the next clean trigger resyncs
  them. The mirror keeps the grid and readout on the chord-port reading but lets the harp
  adopt its own divergent context, and floats a small badge naming the chord the harp is
  actually playing until a real trigger clears it.

### 10.9 Deliberate limitations

Harp notes alone can't reveal these reliably:

- `sharp` is inferred **only** when a chord is actively held (taken from chord
  detection); with no chord held, inference assumes `sharp:false`. `slash` IS inferred
  with no chord held (slash variants are first-class in the settled search: a real
  slash strum emits its bass pitch-class). Under a pot-driven row, slash is only
  adopted by the post-hoc refinement on the winner.
- A mid-strum context flip leaves strings lit *before* the flip at their old positions
  until they fade; inference locks within the first few notes, so this is rare and
  self-clears.
- Inference never moves the chord-grid highlight (that follows the chord port only):
  with no chord held the grid stays dark while the harp still lights from the inferred
  context.
- Transpose/key/frame-shift/sharp-function offsets are unobservable (§6.3); the mirror
  shows the un-shifted reading and warns via the pot chip instead.

---

## 11. Appendix

### 11.1 MIDI routing

| | Cable / port | Channel | Note number |
|:--|:--|:--|:--|
| Chord voice | `chord_port = 0` ("minichord Port 1", also carries sysex) | addr 106 (default 1) | `midi_base_note_transposed + current_applied_chord_notes[i]` |
| Harp voice | `harp_port = 1` ("minichord Port 2") | addr 107 (default 1) | `midi_base_note_transposed + current_harp_notes[i]` |

**Single-port mode** (addr 108): `harp_port = 1 - value`, so value `1` puts the harp on
port 0 alongside the chord, and the Play mirror can no longer tell harp notes from
chord notes. Sound Lab attaches to all minichord input ports and tags each by name
(`"…2"` → harp, else chord).

Velocities are fixed per section: attack velocity = section gain × 127, release
velocity 20 (`main.cpp:276-282`).

### 11.2 firmware ↔ devicemap.js symbol map

| Firmware | `devicemap.js` |
|:--|:--|
| `calculate_note_chord` | `chordVoiceNote(voice, button, table, s, slash, row)`, wrapped by the shared `voiceSet(button, table, s, opts)` generator (the grid lookup + rhythm bases both go through it) |
| `calculate_note_harp` | `harpStringNote(string, held, s, rowOverride)` (`rowOverride` lets inference test a row ≠ `s.harpShuf`) |
| `get_root_button` | `rootButton(s, button)` |
| `harp_shuffling_array` / `harp_shuffling_selection` | `HARP_SHUF` / `s.harpShuf` (addr 40) |
| chord interval tables | `CHORD[...]` |
| `handle_chord_type` + Barry swaps | `COMBOS` (+ `COMBO_BY_ROWS`/`comboType` reverse) + `resolveTable(type, barry)`; the canonical descriptor stores the **resolved** `type`, so a barry chord carries `maj_sixth` everywhere (grid, harp, rhythm) |
| firmware button order ↔ faceplate columns | `colOf(button) = 6 - button` / `buttonOfCol(col) = 6 - col` (the F C G D A E B reversal, an involution) |
| `chord_shuffling_array` / `chord_shuffling_selection` | `CHORD_SHUF` / `s.chordShuf` (addr 120); pot-driven → both `buildChordLookup` (grid) **and** `buildRhythmBases` (rhythm) search all voicings via `shuffleRows` (same pattern as the harp row) |
| `base_notes` / `musical_index` | `BASE_NOTES` / `MUSICAL_INDEX` |
| `key_signatures` / `sharp_notes` / `flat_notes` | `KEY_SIGNATURES` / `SHARP_BTNS` / `FLAT_BTNS` |
| `transpose_semitones` / `midi_base_note(48)` | `s.transpose` / `MIDI_BASE` (addr 30); harp uses live `s.transpose`, the chord grid uses `s.chordTranspose` (frozen at press time while a chord is held, §10.3); rhythm infers a corroborated Δ |
| `fundamental` / `current_chord` | `held.button` / `held.type`, the canonical descriptor `{button, type, sharp, slash}` |
| chord detection (grid vs rhythm) | `matchChord` (held+dropped pool → `lookupList`, containment) vs `identifyChord` (full-cycle onset window + harp PCs → `rhythmBases`, coverage/positional + Δ), the same match over differently gathered evidence (§10.3/§10.4) |
| `note_slash_level` / `flat_button_modifier` / `chromatic_harp_mode` | `s.slashLevel` / `s.flat` / `s.chromatic` (addr 23 / 31 / 98) |
| `chord_frame_shift` / `key_signature_selection` / `barry_harris_mode` | `s.shift` / `s.key` / `s.barry` (addr 34 / 35 / 33) |

**Resting context (matches firmware boot):** before any chord is pressed,
`devicemap.js` seeds `held.button = 0` (**B** major), exactly like the firmware
(`fundamental = 0`, `current_chord = &major`).

> **Important:** the note engine is verified against this firmware. When the Play
> mirror shows the wrong strings, the cause is the app's `patch` disagreeing with the
> device's live state, **not** the note math. Two sources of that gap, two mitigations:
> 1. **Hardware-side preset/setting changes** the device doesn't auto-report → the Play
>    tab re-requests a full dump on open (`controller.requestCurrentData()`).
> 2. **A pot mapped to a note-shaping address** (§6.2) → unreadable over sysex, so it
>    is **inferred from the emitted notes** (§10.5–§10.6).
>
> The `[Play] effective:` console line shows the exact settings the labels were
> computed from, and flags the harp row as `[inferred; pot-driven]` when it had to
> override the dump.

# Local testing harness

A small node-based regression harness for `devicemap.js`, the Play-tab engine that
maps incoming MIDI notes back to the minichord's buttons and strings. The engine is
the most algorithm-heavy part of the app, so changes to it are checked by replaying
fixed event scripts and diffing the resulting transcript. It runs on plain node and
needs no frameworks or other dependencies.

There's also `smoke.js`, a whole-app boot test: it serves the repo on a throwaway
local server, loads the page in headless Chrome and asserts the load-bearing DOM
(grid, harp, painted graphs, About cards, zero page errors). `node smoke.js`, or
`CHROME=path/to/chrome node smoke.js` if Chrome isn't in the default location.

## Commands

```sh
# Replay the scripted chord/harp/rhythm scenarios and compare against the
# known-good transcript. Any diff is a behaviour change.
node run.js > out.txt
diff out.txt golden.txt

# Replay a real device capture (PLAY_DEBUG log) through the rhythm-chord
# identifier and print what it decides for each note burst.
node replay.js            # reads log.txt (a bundled real-device capture)
node replay.js mylog.txt  # or any capture you save from the browser console
```

`run.js` uses a virtual clock (deterministic `setTimeout`/`Date.now`), so transcripts
are byte-for-byte reproducible.

## Environment overrides

- `DM=path/to/devicemap.js node run.js`: test an alternative engine build.
- `P23=2 node replay.js log.txt`: override a sysex parameter (here addr 23,
  slash level) for the replayed patch, when the capture was recorded with
  non-default settings.

## When to regenerate `golden.txt`

Only when a behaviour change in `devicemap.js` is *intentional* and has been
verified by hand (in the browser, ideally against hardware):

```sh
node run.js > golden.txt
```

Commit the new golden together with the engine change so the diff documents it.

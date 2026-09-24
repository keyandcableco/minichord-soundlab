#!/usr/bin/env python3
"""Snapshot the firmware's tables for the divided octaves into firmware-edo.json.

The EDO harness (edo.js) checks the Play mirror against this snapshot rather
than against devicemap's own copy of the tables, so a port that drifts from the
firmware is caught. Regenerate whenever the firmware's tables change:

    python3 __harness__/extract-edo.py ~/minichord/firmware/src/main.cpp
"""
import json, os, re, sys

src = open(sys.argv[1]).read()
nums = lambda t: [int(x) for x in re.findall(r"-?\d+", t)]

chords = {}
for m in re.finditer(r"const uint8_t edo_(\w+)\[3\]\[7\]\s*=\s*\{(.*?)\};", src):
    v = nums(m.group(2))
    chords[m.group(1)] = [v[0:7], v[7:14], v[14:21]]
v = nums(re.search(r"const int8_t edo_base_notes\[3\]\[7\]\s*=\s*\{(.*?)\};", src, re.S).group(1))
base = [v[0:7], v[7:14], v[14:21]]
cat = re.search(r"chord_catalogue\[\d+\]\)\[7\]\s*=\s*\{(.*?)\n\};", src, re.S).group(1)
catalogue = re.findall(r"&(\w+)", re.sub(r"//[^\n]*", "", cat))

v = nums(re.search(r"const int8_t edo_scale_root_offsets\[3\]\[21\]\s*=\s*\{(.*?)\};", src, re.S).group(1))
roots = [v[0:21], v[21:42], v[42:63]]
lens = nums(re.search(r"const uint8_t scale_lengths\[7\]\s*=\s*\{(.*?)\}", src).group(1))
v = nums(re.search(r"const uint8_t edo_scale_intervals\[3\]\[7\]\[8\]\s*=\s*\{(.*?)\n\};", src, re.S).group(1))
scales = [[v[d * 56 + i * 8: d * 56 + i * 8 + lens[i]] for i in range(7)] for d in range(3)]

out = {"steps": [12, 19, 31], "sharp": [1, 1, 2], "base_notes": base,
       "scale_root_offsets": roots, "scale_intervals": scales,
       "catalogue": catalogue, "chords": chords}
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "firmware-edo.json")
with open(dest, "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(f"{len(chords)} chord tables, a catalogue of {len(catalogue)}, written to {dest}")

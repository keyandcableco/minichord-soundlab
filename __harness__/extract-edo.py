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

# how many divisions the firmware has (12, 19 and 31; from firmware 18, 24 as well), in its own
# edo_index order, which is the order of every table below
steps = nums(re.search(r"const uint8_t edo_steps\[(\d+)\]\s*=\s*\{(.*?)\};", src).group(2))
D = len(steps)
sharp = nums(re.search(r"const uint8_t edo_sharp\[\d+\]\s*=\s*\{(.*?)\};", src).group(1))
m = re.search(r"const uint8_t edo_modifier\[\d+\]\s*=\s*\{(.*?)\};", src)
modifier = nums(m.group(1)) if m else sharp        # before 24 the modifier moved a sharp's worth
rows = lambda v, n: [v[k * n:(k + 1) * n] for k in range(D)]

chords = {}
for m in re.finditer(r"const uint8_t edo_(\w+)\[%d\]\[7\]\s*=\s*\{(.*?)\};" % D, src, re.S):
    chords[m.group(1)] = rows(nums(m.group(2)), 7)
base = rows(nums(re.search(r"const int8_t edo_base_notes\[%d\]\[7\]\s*=\s*\{(.*?)\};" % D, src, re.S).group(1)), 7)
cat = re.search(r"chord_catalogue\[\d+\]\)\[7\]\s*=\s*\{(.*?)\n\};", src, re.S).group(1)
catalogue = re.findall(r"&(\w+)", re.sub(r"//[^\n]*", "", cat))

roots = rows(nums(re.search(r"const int8_t edo_scale_root_offsets\[%d\]\[21\]\s*=\s*\{(.*?)\};" % D, src, re.S).group(1)), 21)
lens = nums(re.search(r"const uint8_t scale_lengths\[7\]\s*=\s*\{(.*?)\}", src).group(1))
v = nums(re.search(r"const uint8_t edo_scale_intervals\[%d\]\[7\]\[8\]\s*=\s*\{(.*?)\n\};" % D, src, re.S).group(1))
scales = [[v[d * 56 + i * 8: d * 56 + i * 8 + lens[i]] for i in range(7)] for d in range(D)]

out = {"steps": steps, "sharp": sharp, "modifier": modifier, "base_notes": base,
       "scale_root_offsets": roots, "scale_intervals": scales,
       "catalogue": catalogue, "chords": chords}
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "firmware-edo.json")
with open(dest, "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(f"{len(chords)} chord tables, a catalogue of {len(catalogue)}, written to {dest}")

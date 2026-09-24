#!/usr/bin/env python3
"""Rebuild the staff's accidental font from Steinberg's Bravura.

    git clone --depth 1 https://github.com/steinbergmedia/bravura.git /tmp/bravura
    pip install fonttools brotli
    python3 fonts/subset-accidentals.py /tmp/bravura

Writes soundlab-accidentals-staff.woff2, the engraving cut of Bravura cut down
to the seven SMuFL accidentals the staff draws (U+E260-E266: flat, natural,
sharp, double sharp, double flat, triple sharp, triple flat), and
accidentals.css, which inlines it so the app works from file://.

Bravura is under the SIL Open Font License with "Bravura" as a Reserved Font
Name, and a subset is a modified version, so it is renamed.
OFL-soundlab-accidentals.txt is the licence.
"""
import base64, os, sys
from fontTools import subset
from fontTools.ttLib import TTFont

here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bravura"
cps = list(range(0xE260, 0xE267))
family, ps, out = "Sound Lab Accidentals Staff", "SoundLabAccidentalsStaff-Regular", "soundlab-accidentals-staff.woff2"

opts = subset.Options()
opts.flavor = "woff2"
opts.layout_features = ["*"]
opts.name_IDs = ["*"]
opts.notdef_outline = True
f = TTFont(os.path.join(src, "redist", "otf", "Bravura.otf"))
s = subset.Subsetter(opts)
s.populate(unicodes=cps)
s.subset(f)
for rec in f["name"].names:
    if rec.nameID in (1, 4, 16, 21):
        rec.string = family
    elif rec.nameID == 6:
        rec.string = ps
    elif rec.nameID == 3:
        rec.string = family + "; subset of Bravura"
f.flavor = "woff2"
f.save(os.path.join(here, out))

b = base64.b64encode(open(os.path.join(here, out), "rb").read()).decode()
with open(os.path.join(here, "accidentals.css"), "w") as css:
    css.write("/* The staff's accidentals, self-contained for file://. A subset of Steinberg's\n"
              " * Bravura (the engraving cut): the seven SMuFL accidentals U+E260-E266. SIL\n"
              " * Open Font License 1.1; a modified version, so renamed, as the Reserved Font\n"
              " * Name \"Bravura\" requires. See OFL-soundlab-accidentals.txt. Regenerate with\n"
              " * fonts/subset-accidentals.py. */\n")
    css.write("@font-face{font-family:'%s';font-style:normal;font-weight:400 800;font-display:block;"
              "src:url(data:font/woff2;base64,%s) format('woff2');}\n" % (family, b))
print("wrote", out, "and accidentals.css")

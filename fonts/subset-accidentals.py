#!/usr/bin/env python3
"""Rebuild the accidental fonts from Steinberg's Bravura.

    git clone --depth 1 https://github.com/steinbergmedia/bravura.git /tmp/bravura
    pip install fonttools brotli
    python3 fonts/subset-accidentals.py /tmp/bravura

Writes soundlab-accidentals.woff2 (from Bravura Text, for labels) and
soundlab-accidentals-staff.woff2 (from Bravura, the engraving cut, for the
staff), and accidentals.css, which inlines both so the app works from file://.

The subsets hold 51 SMuFL glyphs: U+E260-E266 (flat to triple flat), E280-E285
(Stein-Zimmermann quarter tones) and E2C0-E2E5 (Helmholtz-Ellis). Bravura is
under the SIL Open Font License with "Bravura" as a Reserved Font Name, and a
subset is a modified version, so both are renamed. OFL-soundlab-accidentals.txt
is the licence.
"""
import base64, os, sys
from fontTools import subset
from fontTools.ttLib import TTFont

here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bravura"
cps = list(range(0xE260, 0xE267)) + list(range(0xE280, 0xE286)) + list(range(0xE2C0, 0xE2E6))

def build(otf, family, ps, out):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    f = TTFont(os.path.join(src, "redist", "otf", otf))
    s = subset.Subsetter(opts)
    s.populate(unicodes=cps)
    s.subset(f)
    for rec in f["name"].names:
        if rec.nameID in (1, 4, 16, 21):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = family + "; subset of " + otf[:-4]
    f.flavor = "woff2"
    f.save(os.path.join(here, out))
    return out

def face(family, path):
    b = base64.b64encode(open(os.path.join(here, path), "rb").read()).decode()
    return ("@font-face{font-family:'%s';font-style:normal;font-weight:400 800;font-display:block;"
            "src:url(data:font/woff2;base64,%s) format('woff2');}\n" % (family, b))

text = build("BravuraText.otf", "Sound Lab Accidentals", "SoundLabAccidentals-Regular", "soundlab-accidentals.woff2")
staff = build("Bravura.otf", "Sound Lab Accidentals Staff", "SoundLabAccidentalsStaff-Regular", "soundlab-accidentals-staff.woff2")
with open(os.path.join(here, "accidentals.css"), "w") as out:
    out.write("/* Accidentals for the divided octaves and HEJI, self-contained for file://.\n"
              " * Subsets of Steinberg's Bravura (text and engraving cuts), 51 SMuFL glyphs:\n"
              " * U+E260-E266 standard, E280-E285 Stein-Zimmermann quarter tones, E2C0-E2E5\n"
              " * Helmholtz-Ellis just intonation. SIL Open Font License 1.1; a modified\n"
              " * version, so renamed, as the Reserved Font Name \"Bravura\" requires. See\n"
              " * OFL-soundlab-accidentals.txt. Regenerate with fonts/subset-accidentals.py. */\n")
    out.write(face("Sound Lab Accidentals", text))
    out.write(face("Sound Lab Accidentals Staff", staff))
print("wrote", text, staff, "and accidentals.css")

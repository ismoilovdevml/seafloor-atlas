"""Turn the 2x PNG screenshots from web/scripts/readme_shots.mjs into compact JPEGs for the README.

usage: .venv/bin/python pipeline/readme_images.py [dir=docs/img] [width=1600]
Each docs/img/<name>.png becomes <name>.jpg (quality 84, progressive) and the PNG is removed.
"""
import sys
from pathlib import Path

from PIL import Image

d = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/img")
w = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
for p in sorted(d.glob("*.png")):
    im = Image.open(p).convert("RGB")
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    out = p.with_suffix(".jpg")
    im.save(out, quality=84, optimize=True, progressive=True)
    print(f"{out.name} {im.size[0]}x{im.size[1]} {out.stat().st_size / 1e3:.0f} KB")
    p.unlink()

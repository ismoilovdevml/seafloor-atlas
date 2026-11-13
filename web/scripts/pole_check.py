"""Measure the polar 'fan' artifact in QA screenshots.

For each pole, sample screen luminance on rings of radius 15..60 px around the projected pole point and
report the mean angular std (0..255). A radial fan gives large spokes (high std); a smooth cap is low.
usage: python scripts/pole_check.py qa-out
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

out = Path(sys.argv[1] if len(sys.argv) > 1 else "qa-out")
s = json.loads((out / "summary.json").read_text())
res = {}
for name, p in s["poles"].items():
    img = np.asarray(Image.open(out / f"pole-{name}.png").convert("L"), dtype=float)
    stds = []
    for r in range(15, 61, 5):
        a = np.linspace(0, 2 * np.pi, 360, endpoint=False)
        x = np.clip(np.rint(p["x"] + r * np.cos(a)).astype(int), 0, img.shape[1] - 1)
        y = np.clip(np.rint(p["y"] + r * np.sin(a)).astype(int), 0, img.shape[0] - 1)
        stds.append(img[y, x].std())
    res[name] = round(float(np.mean(stds)), 2)
print(json.dumps(res))

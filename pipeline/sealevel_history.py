"""Global sea level since the Last Glacial Maximum, for the viewer's time slider.

Source: Lambeck, Rouby, Purcell, Sun & Sambridge (2014) PNAS 111(43), 15296-15303, doi:10.1073/pnas.1411762111,
SI Appendix Table S3: the best estimate of the ice-volume equivalent sea-level function (esl) 0-35 ka and its
2-sigma accuracy. The table is read from the authors' copy of the paper + SI (ANU, 44 pages) with `pdftotext`.

  python pipeline/sealevel_history.py          download (if needed), parse, write web/public/data/sea-level-history.json
  python pipeline/sealevel_history.py check    re-read the JSON and print the spot checks

esl is a GLOBAL ice-volume number (what the sea would do if the water were spread evenly). Relative sea level at a
given coast differs by up to tens of metres (glacial isostatic adjustment: ice loading, ocean loading,
geoid change), so the viewer's flat sea-level shading is an approximation, not a local reconstruction.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/sealevel"
PDF = RAW / "Lambeck-etal-2014.pdf"
PDF_URL = "http://rses.anu.edu.au/~malcolm/papers/pdf/Lambeck-etal-2014.pdf"
PDF_SHA256 = "f4beb735320548c20c0f1b9ac5291b1ef8cdbcf223217dc2bfd0b03fd402d905"
OUT = ROOT / "web/public/data/sea-level-history.json"
MAX_KA = 26.0  # the viewer's range: LGM and a little before
ROW = re.compile(r"^\s*(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$")

CITATION = ("Lambeck, K., Rouby, H., Purcell, A., Sun, Y. & Sambridge, M. (2014). Sea level and global ice volumes "
            "from the Last Glacial Maximum to the Holocene. Proceedings of the National Academy of Sciences "
            "111(43), 15296-15303. doi:10.1073/pnas.1411762111. SI Appendix, Table S3.")


def fetch() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    if not PDF.exists():
        subprocess.run(["curl", "-sL", "-m", "300", "-o", str(PDF), PDF_URL], check=True)
    h = hashlib.sha256(PDF.read_bytes()).hexdigest()
    assert h == PDF_SHA256, f"unexpected PDF ({h}); the table position may have moved"


def parse_table_s3(text: str) -> list[tuple[float, float, float, float]]:
    """Rows (time_ka, nominal_esl_m, esl_m, two_sigma_m) of Table S3, in file order."""
    start = text.index("Table S3.")
    rows = []
    for line in text[start:].splitlines():
        m = ROW.match(line)
        if m:
            rows.append(tuple(float(v) for v in m.groups()))
        elif rows and line.strip() and not re.fullmatch(r"\s*\d+\s*", line):
            # first non-numeric, non-page-number line after the table: done
            if not line.strip().startswith(("Table S3", "Best", "(2 sigma", "column", "nominal", "time")):
                break
    return rows


def build() -> dict:
    fetch()
    text = subprocess.run(["pdftotext", "-layout", str(PDF), "-"], capture_output=True, text=True,
                          check=True).stdout
    rows = parse_table_s3(text)
    t = [r[0] for r in rows]
    assert t[0] == 0 and all(b > a for a, b in zip(t, t[1:])), "time column must start at 0 and increase"
    assert len(rows) > 300 and t[-1] >= 30, (len(rows), t[-1])
    pts = [{"years_bp": int(round(ka * 1000)), "sea_level_m": esl,
            "lo": round(esl - s2, 2), "hi": round(esl + s2, 2)}
           for ka, _nominal, esl, s2 in rows if ka <= MAX_KA + 0.2]
    lgm = min(pts, key=lambda p: p["sea_level_m"])
    out = {
        "title": "Global mean sea level since the Last Glacial Maximum (ice-volume equivalent)",
        "quantity": "esl: ice-volume equivalent sea level relative to present (m); lo/hi = esl -/+ 2 sigma",
        "years_bp_reference": "years before present, present = 1950 CE (Lambeck et al. use calibrated ka BP)",
        "citation": CITATION,
        "source_url": PDF_URL,
        "source_sha256": PDF_SHA256,
        "licence": "Values from the PNAS SI Appendix (article free to read through the PNAS open access option). "
                   "No separate open data licence is attached to the table; the numbers are reproduced as factual "
                   "scientific data with full citation.",
        "attribution": "Sea level: Lambeck et al. (2014) PNAS, doi:10.1073/pnas.1411762111",
        "n": len(pts),
        "lgm": {"years_bp": lgm["years_bp"], "sea_level_m": lgm["sea_level_m"]},
        "caveats": [
            "Global ice-volume equivalent, not relative sea level at a coast: glacial isostatic adjustment makes "
            "local sea level differ by up to tens of metres (near former ice sheets the land itself was depressed "
            "or uplifted).",
            "Present-day topography is used for past coastlines in the viewer; sedimentation, erosion, reef "
            "growth and tectonics since then are ignored.",
            "The 2-sigma band is Lambeck et al.'s accuracy estimate of the esl function, not the spread "
            "between different reconstructions (which is larger, e.g. LGM -120 to -135 m).",
            "Time steps are irregular (about 70-170 years); interpolate linearly between points.",
        ],
        "points": pts,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    return out


def at(pts: list[dict], years_bp: float) -> float:
    for a, b in zip(pts, pts[1:]):
        if a["years_bp"] <= years_bp <= b["years_bp"]:
            w = (years_bp - a["years_bp"]) / (b["years_bp"] - a["years_bp"])
            return a["sea_level_m"] + w * (b["sea_level_m"] - a["sea_level_m"])
    raise ValueError(years_bp)


def check() -> None:
    d = json.loads(OUT.read_text())
    p = d["points"]
    for y in (0, 7000, 11700, 13000, 14000, 14300, 14650, 16000, 19000, 21000, 24000, 26000):
        print(f"{y:>6} BP  {at(p, y):8.2f} m")
    print("LGM minimum", d["lgm"])
    rise = at(p, 14000) - at(p, 14600)
    print(f"14.6 -> 14.0 ka (Meltwater Pulse 1A window): +{rise:.1f} m in 600 yr")
    print(d["n"], "points,", OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        check()
    else:
        build()
        check()

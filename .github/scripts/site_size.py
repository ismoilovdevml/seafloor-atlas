"""Site-size guard for GitHub Pages (published sites may be at most 1 GB).

Sums the real file sizes under a built site (not disk blocks), prints the largest folders, and
fails above --fail-mb / warns above --warn-mb (decimal MB). Used by .github/workflows/pages.yml.
What to do when it warns: README "Site size" (move big raster sets to PMTiles on Hugging Face).

usage: python3 .github/scripts/site_size.py web/dist [--warn-mb 750] [--fail-mb 950] [--top 15]
"""
import argparse
import os
import sys
from collections import Counter
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dist", type=Path)
    ap.add_argument("--warn-mb", type=float, default=750)
    ap.add_argument("--fail-mb", type=float, default=950)
    ap.add_argument("--top", type=int, default=15)
    a = ap.parse_args()
    if not a.dist.is_dir():
        sys.exit(f"::error::{a.dist} is not a directory (build first)")
    total, files, folders = 0, 0, Counter()
    for root, _dirs, names in os.walk(a.dist):
        rel = Path(root).relative_to(a.dist).parts
        for n in names:
            s = (Path(root) / n).stat().st_size
            total += s
            files += 1
            # e.g. "tiles" and "tiles/dem"; a file directly in "chl" counts once, not for depth 1 and depth 2
            for key in {"/".join(rel[:depth]) or "(top level)" for depth in (1, 2)}:
                folders[key] += s
    mb = total / 1e6
    print(f"site: {mb:,.1f} MB in {files:,} files (warn at {a.warn_mb:g} MB, fail at {a.fail_mb:g} MB, Pages limit 1 GB)")
    print("largest folders:")
    for name, s in folders.most_common(a.top):
        print(f"  {s / 1e6:9,.1f} MB  {name}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(f"### Site size: {mb:,.1f} MB of 1,000 MB\n\n| MB | Folder |\n|---:|---|\n"
                    + "".join(f"| {s / 1e6:,.1f} | `{n}` |\n" for n, s in folders.most_common(a.top)) + "\n")
    if mb > a.fail_mb:
        print(f"::error::site is {mb:,.0f} MB, above {a.fail_mb:g} MB (Pages limit 1 GB). "
              "Move the largest raster sets to PMTiles on Hugging Face, see README 'Site size'.")
        sys.exit(1)
    if mb > a.warn_mb:
        print(f"::warning::site is {mb:,.0f} MB, above {a.warn_mb:g} MB. Plan the PMTiles move (README 'Site size').")


if __name__ == "__main__":
    main()

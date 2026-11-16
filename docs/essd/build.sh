#!/usr/bin/env bash
# Build docs/essd/manuscript.pdf (Copernicus LaTeX package 7.16, ESSD manuscript layout).
# Needs: tectonic (runs bibtex with copernicus.bst automatically). Figures: run figures.py first if fig/ is empty.
#   .venv/bin/python docs/essd/figures.py && docs/essd/build.sh
set -euo pipefail
cd "$(dirname "$0")"
for f in fig/fig01_first_measured_map.png fig/fig02_share_by_release.pdf fig/fig03_recoded_by_destination.pdf \
         fig/fig04_cellsize_latitude.pdf fig/fig05_depth_2019_2026.pdf; do
  [ -f "$f" ] || { echo "missing $f: run .venv/bin/python docs/essd/figures.py from the repository root" >&2; exit 1; }
done
tectonic --keep-logs manuscript.tex
# fail on unresolved references or citations
if grep -E "Citation .* undefined|Reference .* undefined|There were undefined" manuscript.log; then
  echo "unresolved references (see above)" >&2; exit 1
fi
grep -E "Overfull \\\\hbox" manuscript.log || true
echo "built $(pwd)/manuscript.pdf"

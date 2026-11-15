#!/usr/bin/env bash
# Build docs/paper/manuscript.md -> manuscript.pdf (pandoc + citeproc + a Unicode LaTeX engine).
#
#   docs/paper/build.sh            PDF (needs pandoc and one of xelatex / lualatex / tectonic)
#   docs/paper/build.sh html       standalone HTML (needs pandoc only), for a quick read-through
#
# Install on macOS:  brew install pandoc  and  brew install --cask basictex  (then: sudo tlmgr install fancyhdr)
#                    or  brew install tectonic
# The manuscript uses Unicode (″ ′ ≥ − ×), so pdflatex is not used. Font: MAINFONT (default "STIX Two Text",
# shipped with macOS). Figures are read from ../../figures/ relative to this folder.
# Exit codes: 0 built, 2 a required tool is missing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
MODE="${1:-pdf}"
MAINFONT="${MAINFONT:-STIX Two Text}"

if ! command -v pandoc >/dev/null 2>&1; then
  echo "pandoc not found. Install it (macOS: brew install pandoc) and run again." >&2
  exit 2
fi
pandoc --version | head -1

COMMON=(manuscript.md --citeproc --bibliography=references.bib --resource-path=".:../../figures:../.."
        --metadata link-citations=true)

if [ "$MODE" = "html" ]; then
  pandoc "${COMMON[@]}" --standalone --embed-resources -o manuscript.html
  echo "wrote $HERE/manuscript.html"
  exit 0
fi

ENGINE=""
for e in xelatex lualatex tectonic; do
  if command -v "$e" >/dev/null 2>&1; then ENGINE="$e"; break; fi
done
if [ -z "$ENGINE" ]; then
  echo "No Unicode LaTeX engine found (xelatex, lualatex or tectonic)." >&2
  echo "Install one (macOS: brew install --cask basictex, or brew install tectonic), or run: $0 html" >&2
  exit 2
fi

pandoc "${COMMON[@]}" --pdf-engine="$ENGINE" -V mainfont="$MAINFONT" -V colorlinks=true -o manuscript.pdf
echo "wrote $HERE/manuscript.pdf (engine: $ENGINE)"

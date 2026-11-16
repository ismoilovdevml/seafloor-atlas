#!/usr/bin/env bash
# Download the inputs into data/raw/ (~920 MB in total). Resumable; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
G=data/raw/gebco_2026; P=data/raw/plates
mkdir -p "$G" "$P"

# 1' elevation = overview level 1 of a COG mirror of GEBCO_2026 (checked by pipeline/verify_mirror.py)
if [ ! -f "$G/gebco_2026_elev_1arcmin.tif" ]; then
  GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR GDAL_HTTP_MULTIRANGE=YES GDAL_HTTP_MAX_RETRY=10 GDAL_HTTP_RETRY_DELAY=5 \
  gdal_translate -ovr 1 -co COMPRESS=DEFLATE -co TILED=YES -co PREDICTOR=2 \
    /vsicurl/https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/gebco/GEBCO_2026.tif \
    "$G/gebco_2026_elev_1arcmin.tif"
fi

# Full 15" copy of the same mirror object (3.3 GB): used by pipeline/build_dataset.py for the connectivity of the
# ocean mask (inland_below_sea_level); its overview level 1 is the 1' file above
if [ ! -f "$G/GEBCO_2026_15s.tif" ]; then
  U="https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/ausantarctic/gebco/GEBCO_2026.tif"
  for i in $(seq 1 30); do curl -fL -C - --max-time 3600 -o "$G/GEBCO_2026_15s.tif" "$U" && break; sleep 5; done
fi

# TID grid: official file from BODC/CEDA (99 MB zip)
if [ ! -f "$G/gebco_2026_tid.tif" ]; then
  U="https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/type_identifier_grid/netcdf/gebco_2026_tid.zip?download=1"
  for i in $(seq 1 30); do curl -fL -C - --max-time 900 -o "$G/gebco_2026_tid.zip" "$U" && break; sleep 3; done
  (cd "$G" && unzip -o -q gebco_2026_tid.zip)
  gdal_translate -co COMPRESS=DEFLATE -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 \
    "$G/GEBCO_2026_TID.nc" "$G/gebco_2026_tid.tif"
fi

# GEBCO_2025 TID grid, for the 2025 -> 2026 comparison (pipeline/change.py), 98 MB zip
G25=data/raw/gebco_2025; mkdir -p "$G25"
if [ ! -f "$G25/gebco_2025_tid.tif" ]; then
  U="https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2025/type_identifier_grid/netcdf/gebco_2025_tid.zip?download=1"
  for i in $(seq 1 30); do curl -fL -C - --max-time 900 -o "$G25/gebco_2025_tid.zip" "$U" && break; sleep 3; done
  (cd "$G25" && unzip -o -q gebco_2025_tid.zip)
  gdal_translate -co COMPRESS=DEFLATE -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 \
    "$G25/GEBCO_2025_TID.nc" "$G25/gebco_2025_tid.tif"
fi

# PB2002 plate boundaries (Bird 2003), ODC-By 1.0
for f in PB2002_steps.json PB2002_plates.json; do
  [ -f "$P/$f" ] || curl -fL -o "$P/$f" "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/$f"
done
# Global Shipping Traffic Density (World Bank / IMF, CC BY 4.0), 535 MB zip; pipeline/shipping.py reads the
# 9.8 GB GeoTIFF straight out of the zip, so it is never extracted
S=data/raw/shipping; mkdir -p "$S"
if [ ! -f "$S/shipdensity_global.zip" ]; then
  U="https://datacatalogfiles.worldbank.org/ddh-published/0037580/DR0045406/shipdensity_global.zip"
  for i in $(seq 1 30); do curl -fL -C - --max-time 1800 -o "$S/shipdensity_global.zip" "$U" && break; sleep 5; done
fi
[ -f "$S/readme.txt" ] || curl -fL -o "$S/readme.txt" "https://datacatalogfiles.worldbank.org/ddh-published/0037580/DR0084213/readme.txt"

# Submarine cables: last CC BY-NC-SA 3.0 snapshot of TeleGeography's repository (commit 91265d81,
# 2022-11-14). The upstream repository no longer exists; a fork kept the commit, and the tarball's
# README.md + LICENSE carry TeleGeography's own licence statement (checked by pipeline/cables.py).
C=data/raw/cables; mkdir -p "$C"
if [ ! -d "$C/www.submarinecablemap.com-91265d81" ]; then
  curl -fL -o "$C/tg_91265d81.tar.gz" \
    "https://codeload.github.com/jordi-farrpoint/www.submarinecablemap.com/tar.gz/91265d81"
  tar -xzf "$C/tg_91265d81.tar.gz" -C "$C"
fi
# The gazetteer is fetched and cached by pipeline/features.py; Wikidata shipwrecks by pipeline/wrecks.py.
echo "inputs ready"

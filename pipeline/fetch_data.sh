#!/usr/bin/env bash
# Download the inputs into data/raw/ (~370 MB in total). Resumable; safe to re-run.
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

# TID grid: official file from BODC/CEDA (99 MB zip)
if [ ! -f "$G/gebco_2026_tid.tif" ]; then
  U="https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/type_identifier_grid/netcdf/gebco_2026_tid.zip?download=1"
  for i in $(seq 1 30); do curl -fL -C - --max-time 900 -o "$G/gebco_2026_tid.zip" "$U" && break; sleep 3; done
  (cd "$G" && unzip -o -q gebco_2026_tid.zip)
  gdal_translate -co COMPRESS=DEFLATE -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512 \
    "$G/gebco_2026_tid.nc" "$G/gebco_2026_tid.tif"
fi

# PB2002 plate boundaries (Bird 2003), ODC-By 1.0
for f in PB2002_steps.json PB2002_plates.json; do
  [ -f "$P/$f" ] || curl -fL -o "$P/$f" "https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/$f"
done
# The gazetteer is fetched and cached by pipeline/features.py.
echo "inputs ready"

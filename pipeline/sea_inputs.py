"""Fetch only the inputs that the small overlay scripts need (offshore.py, wrecks.py, cables_osm.py).

For CI (.github/workflows/refresh-data.yml) and fresh clones; needs only Python + rasterio, no system GDAL.
Each file is skipped when it already exists (the workflow keeps them in the Actions cache, never in git):

  data/raw/gebco_2026/gebco_2026_elev_1arcmin.tif  ~215 MB  overview level 1 of the 15" COG mirror, the same
                                                            pixels `gdal_translate -ovr 1` writes in fetch_data.sh
  data/raw/gebco_2026/gebco_2026_tid.tif           ~86 MB   official TID zip from BODC/CEDA (99 MB download,
                                                            3.7 GB netCDF extracted temporarily, then deleted)
  data/raw/regions/eez/*.geojson.gz                ~10 MB   Marine Regions World EEZ v12 via WMS (pipeline/regions.py)

usage: python pipeline/sea_inputs.py [--check]   (--check: only report what is present)
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import rasterio
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parents[1]
G = ROOT / "data/raw/gebco_2026"
ELEV = G / "gebco_2026_elev_1arcmin.tif"
TID = G / "gebco_2026_tid.tif"
EEZ_DIR = ROOT / "data/raw/regions/eez"
ELEV_COG = ("/vsicurl/https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/"
            "ausantarctic/gebco/GEBCO_2026.tif")
TID_ZIP = ("https://dap.ceda.ac.uk/bodc/gebco/global/gebco_2026/type_identifier_grid/netcdf/"
           "gebco_2026_tid.zip?download=1")
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"
GDAL_HTTP = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MULTIRANGE": "YES",
             "GDAL_HTTP_MAX_RETRY": "10", "GDAL_HTTP_RETRY_DELAY": "5", "GDAL_HTTP_USERAGENT": UA}
ROWS = 1024


def copy_raster(src, dst: Path, **creation) -> None:
    """Row-block copy (bounded memory) into a tiled DEFLATE GeoTIFF; written to .part, then renamed."""
    prof = {"driver": "GTiff", "dtype": src.dtypes[0], "count": 1, "width": src.width, "height": src.height,
            "crs": src.crs, "transform": src.transform, "nodata": src.nodata, "tiled": True,
            "compress": "deflate", **creation}
    tmp = dst.with_suffix(".part.tif")
    t0 = time.time()
    with rasterio.open(tmp, "w", **prof) as out:
        for r in range(0, src.height, ROWS):
            h = min(ROWS, src.height - r)
            out.write(src.read(1, window=Window(0, r, src.width, h)), 1, window=Window(0, r, src.width, h))
            print(f"\r  {dst.name}: rows {r + h}/{src.height} ({time.time() - t0:.0f} s)", end="", flush=True)
    print()
    tmp.rename(dst)


def fetch_elev() -> None:
    with rasterio.Env(**GDAL_HTTP), rasterio.open(ELEV_COG, overview_level=1) as src:
        assert (src.width, src.height) == (21600, 10800), (src.width, src.height)
        copy_raster(src, ELEV, predictor=2, blockxsize=256, blockysize=256)


def download(url: str, dst: Path) -> None:
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=900) as r, open(dst, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            return
        except OSError as e:
            print(f"  download failed ({e}); retry {attempt + 1} in 30 s")
            time.sleep(30)
    raise SystemExit(f"could not download {url}")


def fetch_tid() -> None:
    with rasterio.Env() as env:
        if "netCDF" not in env.drivers():
            raise SystemExit("this rasterio build has no netCDF driver: needed to convert the official TID file")
    zp = G / "gebco_2026_tid.zip"
    if not zp.exists() or not zipfile.is_zipfile(zp):
        download(TID_ZIP, zp)
    with zipfile.ZipFile(zp) as z:
        member = next(n for n in z.namelist() if n.lower().endswith(".nc"))
        nc = Path(z.extract(member, G))
    try:
        with rasterio.open(nc) as src:
            assert (src.width, src.height) == (86400, 43200), (src.width, src.height)
            copy_raster(src, TID, blockxsize=512, blockysize=512)
    finally:
        nc.unlink(missing_ok=True)
        zp.unlink(missing_ok=True)


def fetch_eez() -> None:
    import regions  # noqa: PLC0415 - light import (numpy, rasterio); fetches 72 tiles, cached, resumable

    regions.fetch("eez")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only, fetch nothing")
    args = ap.parse_args()
    G.mkdir(parents=True, exist_ok=True)
    n_eez = len(list(EEZ_DIR.glob("*.geojson.gz"))) if EEZ_DIR.exists() else 0
    todo = {"elevation 1'": (ELEV.exists(), fetch_elev), "TID 15\"": (TID.exists(), fetch_tid),
            f"EEZ tiles ({n_eez}/72)": (n_eez == 72, fetch_eez)}
    for name, (have, fn) in todo.items():
        print(f"{name}: {'present' if have else 'missing'}")
        if not have and not args.check:
            t0 = time.time()
            fn()
            print(f"  {name} fetched in {time.time() - t0:.0f} s")
    if args.check and not all(h for h, _ in todo.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()

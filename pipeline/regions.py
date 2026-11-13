"""How much of the seafloor is directly measured, per ocean basin and per Exclusive Economic Zone.

Input : data/derived/coverage_1arcmin.tif (from pipeline/coverage.py; see docs/data-contract.md)
        Marine Regions layers, fetched once into data/raw/regions/ (gitignored):
          goas      Global Oceans and Seas v01 (2021)       doi:10.14284/542
          eez       World EEZ v12 (2023)                     doi:10.14284/632
          high_seas World High Seas v2 (2024)               doi:10.14284/696
        All CC-BY 4.0, Flanders Marine Institute (VLIZ), https://www.marineregions.org/
Output: data/derived/regions.json           per-ocean / per-EEZ / high-seas numbers
        data/derived/regions_ids_4arcmin.npz  4' id grids for the figure (gitignored)
        docs/regions.md                      tables
        figures/fig6_regions.png

Method: every 1' cell carries f = measured fraction of its 4x4 block of 15" cells (TID 10-17).
The polygons are burned onto the same 1' grid (rasterio.features.rasterize, all_touched=False,
so a cell belongs to the polygon containing its centre) and measured area = sum(A * f),
ocean area = sum(A) over ocean cells, with A the exact cell area on the authalic sphere.

The layers are fetched from the Marine Regions GeoServer as WMS GeoJSON (vector output) in 30 x 30
degree tiles at 1' pixel size: the server clips each polygon to the tile (so nothing crosses the
antimeridian) and may generalise it below one pixel. This avoids the 90-120 MB shapefiles, and every
request finishes well inside the server's ~300 s limit.
Ocean cells that no polygon covers (coastline mismatch, inland seas below sea level such as the
Caspian) are reported as "unassigned", never silently re-labelled.

Usage: .venv/bin/python pipeline/regions.py            # fetch (cached) + compute + docs + figure
       .venv/bin/python pipeline/regions.py --figure   # figure only, from regions.json + npz
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import from_bounds

ROOT = Path(__file__).resolve().parents[1]
COV = ROOT / "data/derived/coverage_1arcmin.tif"
STATS = ROOT / "data/derived/stats.json"
RAW = ROOT / "data/raw/regions"
OUT_JSON = ROOT / "data/derived/regions.json"
OUT_NPZ = ROOT / "data/derived/regions_ids_4arcmin.npz"
OUT_MD = ROOT / "docs/regions.md"
OUT_FIG = ROOT / "figures/fig6_regions.png"

R_KM = 6371.0072  # authalic radius (km)
WMS = "https://geo.vliz.be/geoserver/MarineRegions/wms"
TILE_DEG = 30  # the world is fetched as 12 x 6 tiles of 30 x 30 degrees, 1800 x 1800 px at 1'
MIN_EEZ_KM2 = 100_000
# The Caspian Sea is a lake (surface -28 m), so GEBCO's elevation < 0 keeps it (and low ground around
# it) as "ocean", and EEZ v12 draws national sectors on it. The box holds no real sea, so its "ocean"
# cells stay in the global check (to match stats.json) but are excluded from every regional number.
CASPIAN_BOX = (46.0, 36.0, 55.5, 47.5)  # lon0, lat0, lon1, lat1
# Lake beds below sea level that the GEBCO ocean mask (TID != 0 and elevation < 0) keeps; used only to
# explain the "unassigned" ocean cells.
INLAND_BOXES = {"Caspian Sea": CASPIAN_BOX, "Laurentian Great Lakes": (-93.0, 41.0, -75.0, 49.5),
                "Lake Baikal": (103.0, 51.0, 110.0, 56.0), "Dead Sea": (35.3, 31.0, 35.7, 32.0)}

SOURCES = {
    "goas": {
        "title": "Global Oceans and Seas, version 1",
        "cite": "Flanders Marine Institute (2021). Global Oceans and Seas, version 1. "
                "Available online at https://www.marineregions.org/. https://doi.org/10.14284/542",
        "props": ["name", "area_km2"],
    },
    "eez": {
        "title": "Maritime Boundaries Geodatabase: Maritime Boundaries and Exclusive Economic Zones (200NM), version 12",
        "cite": "Flanders Marine Institute (2023). Maritime Boundaries Geodatabase: Maritime Boundaries and "
                "Exclusive Economic Zones (200NM), version 12. Available online at https://www.marineregions.org/. "
                "https://doi.org/10.14284/632",
        "props": ["mrgid", "geoname", "pol_type", "territory1", "iso_ter1", "sovereign1", "iso_sov1", "area_km2"],
    },
    "high_seas": {
        "title": "Maritime Boundaries Geodatabase: High Seas, version 2",
        "cite": "Flanders Marine Institute (2024). Maritime Boundaries Geodatabase: High Seas, version 2. "
                "Available online at https://www.marineregions.org/. https://doi.org/10.14284/696",
        "props": ["name"],
    },
}
LICENCE = "CC-BY 4.0 (https://www.marineregions.org/disclaimer.php)"
CITE_GEBCO = "GEBCO Compilation Group (2026) GEBCO_2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa"


# ---------------------------------------------------------------- fetch

def tile_bounds() -> list[tuple[float, float, float, float]]:
    return [(x, y, x + TILE_DEG, y + TILE_DEG) for x in range(-180, 180, TILE_DEG) for y in range(-90, 90, TILE_DEG)]


def tile_path(layer: str, b: tuple[float, float, float, float]) -> Path:
    return RAW / layer / f"{b[0]:+04d}_{b[1]:+03d}.geojson.gz"


def fetch_tile(layer: str, b: tuple) -> Path:
    p = tile_path(layer, b)
    if p.exists():
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    w, h = round((b[2] - b[0]) * 60), round((b[3] - b[1]) * 60)
    url = (f"{WMS}?service=WMS&version=1.1.1&request=GetMap&layers=MarineRegions:{layer}&styles="
           f"&srs=EPSG:4326&bbox={b[0]},{b[1]},{b[2]},{b[3]}&width={w}&height={h}"
           f"&format=application/json;type=geojson")
    for attempt in range(6):
        try:
            t0 = time.time()
            req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "seafloor-atlas"})
            with urllib.request.urlopen(req, timeout=600) as r:
                data = r.read()
            if data[:2] != b"\x1f\x8b":
                data = gzip.compress(data)
            fc = json.loads(gzip.decompress(data))  # must parse as a FeatureCollection, else retry
            assert fc.get("type") == "FeatureCollection", str(fc)[:200]
            tmp = p.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.rename(p)
            print(f"  {layer}/{p.name}: {len(fc['features'])} features, {len(data) / 1e6:.2f} MB, "
                  f"{time.time() - t0:.0f} s", file=sys.stderr)
            return p
        except Exception as e:  # noqa: BLE001 - network: retry, then fail loudly
            print(f"  {layer}/{p.name}: attempt {attempt + 1} failed: {e}", file=sys.stderr)
            time.sleep(15)
    raise SystemExit(f"could not fetch {layer} tile {b}")


def fetch(layer: str) -> list[Path]:
    """Download one Marine Regions layer as GeoJSON tiles (cached in data/raw/regions/<layer>/)."""
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(3) as ex:
        return list(ex.map(lambda b: fetch_tile(layer, b), tile_bounds()))


def load_tiles(layer: str) -> list[tuple[tuple, list[dict]]]:
    return [(b, json.loads(gzip.decompress(tile_path(layer, b).read_bytes()))["features"]) for b in tile_bounds()]


# ---------------------------------------------------------------- grids

def cell_area_rows(transform, height: int) -> np.ndarray:
    """Exact area (km2) of one cell in each row, on the authalic sphere."""
    top = transform.f + np.arange(height) * transform.e
    bot = top + transform.e
    dlon = np.radians(transform.a)
    return R_KM ** 2 * dlon * np.abs(np.sin(np.radians(top)) - np.sin(np.radians(bot)))


def burn(layer: str, key, shape, transform, dtype="uint16", select=None) -> tuple[np.ndarray, np.ndarray, dict]:
    """Rasterise a tiled layer onto the global grid. key(props) -> stable feature key.
    select(props) -> bool keeps only some features (default: all).

    Returns (id grid, overlap-count grid, {key: (id, props)}). Ids start at 1; 0 = no polygon.
    Each tile is burned only into its own window, so the server's clip buffer is not counted twice.
    """
    ids = np.zeros(shape, dtype=dtype)
    count = np.zeros(shape, dtype=np.uint8)
    table: dict = {}
    for b, feats in load_tiles(layer):
        win = rasterio.windows.from_bounds(*b, transform=transform).round_offsets().round_lengths()
        t = rasterio.windows.transform(win, transform)
        shp = (int(win.height), int(win.width))
        geoms = []
        for f in feats:
            if not f.get("geometry") or (select and not select(f["properties"])):
                continue
            k = key(f["properties"])
            if k not in table:
                table[k] = (len(table) + 1, f["properties"])
            geoms.append((f["geometry"], table[k][0]))
        if not geoms:
            continue
        sl = (slice(int(win.row_off), int(win.row_off + win.height)),
              slice(int(win.col_off), int(win.col_off + win.width)))
        ids[sl] = features.rasterize(geoms, out_shape=shp, transform=t, fill=0, all_touched=False, dtype=dtype)
        count[sl] = features.rasterize(((g, 1) for g, _ in geoms), out_shape=shp, transform=t, fill=0,
                                       all_touched=False, dtype="uint8", merge_alg=features.MergeAlg.add)
    return ids, count, table


class Grid:
    """Ocean mask, measured fraction f and per-row cell area; sums without full float64 area grids."""

    def __init__(self, ocean: np.ndarray, f: np.ndarray, arow: np.ndarray, band: int = 1080):
        self.ocean, self.f, self.arow, self.band = ocean, f, arow, band

    def total(self, mask: np.ndarray | None = None) -> tuple[float, float]:
        """(ocean km2, measured km2) inside mask (None = everywhere)."""
        o = self.ocean if mask is None else self.ocean & mask
        fm = self.f if mask is None else np.where(mask, self.f, 0)
        return float(o.sum(axis=1) @ self.arow), float(fm.sum(axis=1, dtype=np.float64) @ self.arow)

    def by_id(self, ids: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Per id 0..n: ocean km2, measured km2, total polygon km2 (incl. land cells)."""
        o, m, a = np.zeros(n + 1), np.zeros(n + 1), np.zeros(n + 1)
        for r0 in range(0, ids.shape[0], self.band):
            sl = slice(r0, r0 + self.band)
            i = ids[sl].ravel()
            w = np.broadcast_to(self.arow[sl, None], ids[sl].shape).ravel()
            o += np.bincount(i, weights=w * self.ocean[sl].ravel(), minlength=n + 1)
            m += np.bincount(i, weights=w * self.f[sl].ravel(), minlength=n + 1)
            a += np.bincount(i, weights=w, minlength=n + 1)
        return o, m, a


def block_mode_ids(a: np.ndarray, k: int) -> np.ndarray:
    """Nearest-style downsample for id grids: take the centre-ish cell of each k x k block."""
    return a[k // 2::k, k // 2::k]


# ---------------------------------------------------------------- compute

def entry(name: str, ocean: float, meas: float, **extra) -> dict:
    return {"name": name, **extra, "ocean_area_km2": round(ocean, 1), "measured_area_km2": round(meas, 1),
            "measured_fraction": (meas / ocean) if ocean > 0 else None}


def box_mask(shape, transform, box) -> np.ndarray:
    m = np.zeros(shape, bool)
    w = rasterio.windows.from_bounds(*box, transform=transform).round_offsets().round_lengths()
    m[int(w.row_off):int(w.row_off + w.height), int(w.col_off):int(w.col_off + w.width)] = True
    return m


def inland_breakdown(grid, mask, shape, transform) -> dict:
    return {k: round(grid.total(mask & box_mask(shape, transform, b))[0], 1) for k, b in INLAND_BOXES.items()}


def eez_label(p: dict) -> str:
    if p.get("pol_type") == "200NM":
        ter, sov = p.get("territory1") or "", p.get("sovereign1") or ""
        return ter if ter == sov or not sov else f"{ter} ({sov})"
    return p.get("geoname") or "?"


def compute() -> dict:
    for layer in SOURCES:
        print(f"fetch {layer}", file=sys.stderr)
        fetch(layer)

    with rasterio.open(COV) as s:
        cov = s.read(1)
        transform, shape = s.transform, s.shape
    assert shape == (10800, 21600), shape
    ocean = cov > 0
    f = np.where(ocean, (cov.astype(np.float32) - 1) / 254, 0).astype(np.float32)
    del cov
    arow = cell_area_rows(transform, shape[0]).astype(np.float64)
    grid = Grid(ocean, f, arow)

    # ---- global check against stats.json (computed from the 15" TID grid)
    sphere = float(arow.sum() * shape[1])
    ocean_km2, meas_km2 = grid.total()
    ref = json.loads(STATS.read_text())["measured_fraction_area"] if STATS.exists() else None
    check = {"sphere_area_km2": sphere, "sphere_area_expected_km2": 4 * np.pi * R_KM ** 2,
             "ocean_area_km2": ocean_km2, "measured_area_km2": meas_km2,
             "measured_fraction": meas_km2 / ocean_km2, "stats_json_measured_fraction": ref,
             "abs_diff_points": None if ref is None else 100 * (meas_km2 / ocean_km2 - ref)}
    print(f"global: ocean {ocean_km2 / 1e6:.2f} M km2, measured {100 * check['measured_fraction']:.2f}% "
          f"(stats.json {100 * ref:.2f}%)", file=sys.stderr)
    assert abs(sphere / check["sphere_area_expected_km2"] - 1) < 1e-9
    if ref is not None:
        assert abs(check["abs_diff_points"]) < 0.2, check  # coarse guard: 1' aggregate vs 15" source

    # ---- regional numbers exclude the Caspian box (see CASPIAN_BOX)
    casp = box_mask(shape, transform, CASPIAN_BOX) & ocean
    caspian = entry("Caspian Sea box (lake below sea level; excluded from regional numbers)", *grid.total(casp))
    grid = Grid(ocean & ~casp, np.where(casp, 0, f).astype(np.float32), arow)

    # ---- oceans (GOaS)
    print("rasterise goas", file=sys.stderr)
    gid, gcount, gtab = burn("goas", lambda p: p["name"], shape, transform, "uint8")
    o, m, a = grid.by_id(gid, len(gtab))
    oceans = []
    for name, (i, p) in gtab.items():
        # GOaS v01 spells one name "South China and Easter Archipelagic Seas"; show it corrected
        shown = name.replace("Easter Archipelagic", "Eastern Archipelagic")
        oceans.append(entry(shown, o[i], m[i], source_name=name, polygon_area_km2=round(a[i], 1),
                            attr_area_km2=p.get("area_km2")))
    oceans.sort(key=lambda e: -e["ocean_area_km2"])
    combined = []
    for basin in ("Pacific", "Atlantic"):
        parts = [e for e in oceans if basin in e["name"]]
        combined.append(entry(f"{basin} Ocean (North + South)", sum(e["ocean_area_km2"] for e in parts),
                              sum(e["measured_area_km2"] for e in parts), parts=[e["name"] for e in parts]))
    goas_unassigned = entry("Ocean cells outside all GOaS polygons", o[0], m[0])
    goas_overlap = grid.total(gcount > 1)[0]
    goas_unassigned["inland_water_km2"] = inland_breakdown(grid, gid == 0, shape, transform)
    goas_unassigned["inland_water_km2"].pop("Caspian Sea")
    del gid, gcount

    # ---- EEZ + high seas
    print("rasterise eez", file=sys.stderr)
    # Joint regimes are drawn ON TOP of the parties' 200 NM zones in EEZ v12 (they overlap), while
    # 200 NM zones and overlapping claims tile the sea without overlap. Burn them as two layers so
    # every polygon keeps its full footprint and the national partition is not punched by joint regimes.
    is_joint = lambda p: p.get("pol_type") == "Joint regime"  # noqa: E731
    eid, ecount, etab = burn("eez", lambda p: p["mrgid"], shape, transform, "uint16",
                             select=lambda p: not is_joint(p))
    jid, jcount, jtab = burn("eez", lambda p: p["mrgid"], shape, transform, "uint16", select=is_joint)
    print("rasterise high_seas", file=sys.stderr)
    hid, _, _ = burn("high_seas", lambda p: p.get("name") or "high seas", shape, transform, "uint8")
    eez = []
    cw = rasterio.windows.from_bounds(*CASPIAN_BOX, transform=transform).round_offsets().round_lengths()
    cs = (slice(int(cw.row_off), int(cw.row_off + cw.height)), slice(int(cw.col_off), int(cw.col_off + cw.width)))
    cgrid = Grid(casp[cs], f[cs], arow[cs[0]])
    for ids, tab in ((eid, etab), (jid, jtab)):
        o, m, a = grid.by_id(ids, len(tab))
        oc = cgrid.by_id(ids[cs], len(tab))[0]
        for k, (i, p) in tab.items():
            e = entry(eez_label(p), o[i], m[i], polygon_area_km2=round(a[i], 1),
                      **{c: p.get(c) for c in SOURCES["eez"]["props"]})
            e["attr_area_km2"] = e.pop("area_km2")
            e["caspian_excluded_km2"] = round(oc[i], 1)
            eez.append(e)
    eez.sort(key=lambda e: -e["ocean_area_km2"])
    # antimeridian / geometry guard: rasterised polygon area vs the attribute area (both include land-free sea)
    suspicious = [(e["name"], e["polygon_area_km2"], e["attr_area_km2"]) for e in eez
                  if e["attr_area_km2"] and e["attr_area_km2"] > 20_000
                  and abs(e["polygon_area_km2"] / e["attr_area_km2"] - 1) > 0.05]
    joint_outside_national = grid.total((jid > 0) & (eid == 0))[0]
    in_eez = (eid > 0) | (jid > 0)
    in_hs = hid > 0
    zones = {
        "all_eez": entry("All EEZs (incl. overlapping claims and joint regimes)", *grid.total(in_eez)),
        "high_seas": entry("High seas (Marine Regions High Seas v2, outside every EEZ)", *grid.total(in_hs & ~in_eez)),
        "outside_eez": entry("All ocean cells outside every EEZ polygon", *grid.total(~in_eez)),
        "unassigned": entry("Ocean cells in neither an EEZ nor the high-seas polygon", *grid.total(~in_eez & ~in_hs)),
    }
    zones["unassigned"]["inland_water_km2"] = inland_breakdown(grid, ~in_eez & ~in_hs, shape, transform)
    zones["unassigned"]["inland_water_km2"].pop("Caspian Sea")
    zones["caspian_excluded"] = caspian
    eez_overlap = grid.total(ecount > 1)[0]  # among 200 NM zones + overlapping claims only
    joint_overlap_national = grid.total((jid > 0) & (eid > 0))[0]
    eez_hs_overlap = grid.total(in_eez & in_hs)[0]

    # ---- per sovereign (200NM polygons only; overlapping claims and joint regimes are not split)
    sov: dict[str, list[float]] = {}
    for e in eez:
        key = e["sovereign1"] if e["pol_type"] == "200NM" else "Overlapping claims and joint regimes"
        s = sov.setdefault(key, [0.0, 0.0, 0])
        s[0] += e["ocean_area_km2"]
        s[1] += e["measured_area_km2"]
        s[2] += 1
    sovereigns = sorted((entry(k, v[0], v[1], n_polygons=v[2]) for k, v in sov.items()),
                        key=lambda e: -e["ocean_area_km2"])

    # ---- 4' grids for the figure
    mrgid_of_id = np.zeros(len(etab) + 1, dtype=np.int64)
    for k, (i, _) in etab.items():
        mrgid_of_id[i] = k
    np.savez_compressed(OUT_NPZ, eez=block_mode_ids(eid, 4), hs=block_mode_ids(hid, 4).astype(bool),
                        ocean=block_mode_ids(ocean, 4), mrgid_of_id=mrgid_of_id)

    out = {
        "source": "data/derived/coverage_1arcmin.tif (GEBCO_2026 TID 10-17 at 15\", aggregated to 1')",
        "method": ("1' cells burned with rasterio.features.rasterize(all_touched=False); areas = exact cell "
                   f"area on the authalic sphere R = {R_KM} km; measured = sum(area * f), f = measured share "
                   "of the 4x4 block of 15\" cells. Polygons fetched as WMS GeoJSON in 30-degree tiles at 1' "
                   "pixel size (clipped per tile by the server)."),
        "global_check": check,
        "oceans": oceans,
        "oceans_combined": combined,
        "oceans_unassigned": goas_unassigned,
        "goas_overlap_ocean_km2": goas_overlap,
        "zones": zones,
        "eez_overlap_ocean_km2": eez_overlap,
        "joint_regime_ocean_km2_overlapping_national": joint_overlap_national,
        "joint_regime_ocean_km2_outside_national": joint_outside_national,
        "eez_high_seas_overlap_ocean_km2": eez_hs_overlap,
        "eez_area_check_outliers": suspicious,
        "eez": eez,
        "sovereigns": sovereigns,
        "sources": {k: {"title": v["title"], "citation": v["cite"], "licence": LICENCE,
                        "fetched_via": f"{WMS} GetMap format=application/json;type=geojson layer MarineRegions:{k}"}
                    for k, v in SOURCES.items()},
        "gebco_citation": CITE_GEBCO,
    }
    OUT_JSON.write_text(json.dumps(out, indent=1))
    return out


# ---------------------------------------------------------------- docs

def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f} %"


def mkm2(x: float) -> str:
    return f"{x / 1e6:.2f}"


def table(rows: list[dict], name_col: str = "Region", extra: str | None = None) -> str:
    head = f"| {name_col} | Ocean area (M km²) | Measured (M km²) | Measured |"
    sep = "|---|---:|---:|---:|"
    if extra:
        head = f"| {name_col} | {extra} | Ocean area (M km²) | Measured (M km²) | Measured |"
        sep = "|---|---|---:|---:|---:|"
    lines = [head, sep]
    for r in rows:
        cells = [r["name"]] + ([r.get("_extra", "")] if extra else []) + \
                [mkm2(r["ocean_area_km2"]), mkm2(r["measured_area_km2"]), pct(r["measured_fraction"])]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def eez_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        r = dict(r)
        r["name"] = r["name"] + ("" if r["pol_type"] == "200NM" else f" ({r['pol_type'].lower()})")
        out.append(r)
    return out


def write_md(d: dict) -> None:
    g = d["global_check"]
    z = d["zones"]
    big = [e for e in d["eez"] if e["ocean_area_km2"] >= MIN_EEZ_KM2 and e["measured_fraction"] is not None]
    casp = z["caspian_excluded"]
    casp_names = ", ".join(e["territory1"] for e in sorted(d["eez"], key=lambda e: -e["caspian_excluded_km2"])
                           if e["caspian_excluded_km2"] >= 1000)
    best = sorted(big, key=lambda e: -e["measured_fraction"])[:15]
    worst = sorted(big, key=lambda e: e["measured_fraction"])[:15]
    inl = {k: v for k, v in z["unassigned"]["inland_water_km2"].items() if v >= 1000}
    inland_txt = (f"{sum(inl.values()) / 1e3:,.0f} thousand km² ("
                  + ", ".join(f"{k} {v / 1e3:,.0f}" for k, v in inl.items()) + ")") if inl else "almost none"
    sov = [s for s in d["sovereigns"] if s["name"] != "Overlapping claims and joint regimes"][:10]
    md = f"""# How much of the seafloor is measured, by ocean and by EEZ

Generated by `pipeline/regions.py` from `data/derived/coverage_1arcmin.tif` (GEBCO_2026 TID grid) and
Marine Regions polygons. "Measured" = the seafloor cell has a direct depth measurement (TID 10–17:
single beam, multibeam, seismic, soundings, lidar, optical) at the 15″ (~460 m) grid; the rest is
predicted from satellite gravity, interpolated or of unknown source. Areas are true areas on the sphere.

**Global check:** the same 1′ grid gives {pct(g['measured_fraction'])} measured over
{g['ocean_area_km2'] / 1e6:.1f} M km² of ocean; `stats.json` (computed directly from the 15″ TID grid) gives
{pct(g['stats_json_measured_fraction'])} ({g['abs_diff_points']:+.3f} points; the 1′ grid stores f in 1/254 steps
and weights whole 1′ cells, which explains the small difference and the slightly larger ocean area
than the 361.7 M km² in the README).

## Oceans

Global Oceans and Seas v01 (Marine Regions), based on IHO *Limits of Oceans and Seas* (S-23, 1953).
Here the Southern Ocean is everything south of 60° S. (The `area_km2` attribute shipped with the
polygons disagrees with their own geometry for the southern basins, e.g. 6.8 M km² for the Southern
Ocean; the areas below are measured from the geometry.) {mkm2(d['oceans_unassigned']['ocean_area_km2'])} M km²
of GEBCO ocean cells fall outside every GOaS polygon (lake beds below sea level, coastline mismatch).

{table(d['oceans'], 'Ocean / sea')}

{table(d['oceans_combined'], 'Combined')}

## High seas vs national waters

{table([z['all_eez'], z['high_seas'], z['unassigned']], 'Zone')}

The high seas are {z['high_seas']['ocean_area_km2'] / g['ocean_area_km2'] * 100:.0f} % of the ocean
in this grid. Joint-regime polygons overlap the national 200 NM zones; the "All EEZs" row counts every
cell once. Of the {z['unassigned']['ocean_area_km2'] / 1e3:,.0f} thousand km² in "neither",
{inland_txt} is lake bed below sea level that the GEBCO ocean mask keeps; the rest are coastal cells where
the 1′ ocean mask and the EEZ coastline disagree.

**Caspian Sea, excluded.** It is a lake whose surface is 28 m below sea level, so the GEBCO ocean
mask (elevation < 0) keeps it and low ground around it as "ocean" ({casp['ocean_area_km2'] / 1e3:,.0f} thousand km²,
{pct(casp['measured_fraction'])} measured), and EEZ v12 draws national sectors on it ({casp_names}).
All regional numbers on this page leave the box {CASPIAN_BOX[0]:g}–{CASPIAN_BOX[2]:g}° E,
{CASPIAN_BOX[1]:g}–{CASPIAN_BOX[3]:g}° N out; the global check above keeps it, to match `stats.json`.

## Best-mapped EEZs (ocean area ≥ 100,000 km²)

Rows are Marine Regions territories: "France" is metropolitan France, "United States" the
contiguous US; overseas territories are separate rows. Ocean area excludes land cells.

{table(eez_rows(best), 'EEZ')}

## Least-mapped EEZs (ocean area ≥ 100,000 km²)

{table(eez_rows(worst), 'EEZ')}

## Largest national ocean areas (all EEZ polygons of one sovereign state, 200 NM zones only)

{table(sov, 'Sovereign')}

All {len(d['eez'])} EEZ polygons, the sovereign totals and the high-seas numbers are in
`data/derived/regions.json`.

## Caveats

* **EEZ boundaries are political and often contested.** Marine Regions lists overlapping claims and
  joint regimes as separate polygons; they are kept separate here and not added to any country (the
  sovereign table uses 200 NM zones only). The data "has no legal value" (Marine Regions terms) and
  neither do these numbers.
* **Measured = TID 10–17 at 15″.** One ship track through a 460 m cell marks it measured, so this is
  generous compared with Seabed 2030's "mapped to modern standards" ({pct(g['stats_json_measured_fraction'])} here vs 28.7 % official, globally).
* **Shared is not surveyed.** Many coastal states have surveyed their shelf and EEZ in detail but do not
  release the data to GEBCO. A low number means "not in the public grid", not necessarily "never surveyed".
* **Grid resolution.** Polygons are burned onto the 1′ grid by cell centre. They are fetched as
  GeoServer vector output at 1′ pixel size, which generalises them (spot check, Belgian EEZ: 4,136 →
  87 vertices, maximum shift 0.43′, area −0.24 %). Boundaries are accurate to about one 1′ cell (~1.9 km);
  small EEZs below ~10,000 km² carry a few % error.

## Sources and licences

* {CITE_GEBCO}. Open Government Licence v3.
* {d['sources']['goas']['citation']} {LICENCE}.
* {d['sources']['eez']['citation']} {LICENCE}.
* {d['sources']['high_seas']['citation']} {LICENCE}.
"""
    OUT_MD.write_text(md)


# ---------------------------------------------------------------- figure

def figure(d: dict) -> None:
    import cartopy.crs as ccrs
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from matplotlib.patches import Patch

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "savefig.dpi": 200, "savefig.bbox": "tight"})
    g = np.load(OUT_NPZ)
    eid, hs, ocean = g["eez"], g["hs"], g["ocean"]
    frac = {e["mrgid"]: e["measured_fraction"] for e in d["eez"]}
    lut = np.array([np.nan if frac.get(int(k)) is None else 100 * frac[int(k)] for k in g["mrgid_of_id"]])
    val = np.where((eid > 0) & ocean, lut[eid], np.nan)

    bounds = [0, 10, 20, 30, 40, 50, 60, 80, 100]
    cmap = ListedColormap(plt.get_cmap("magma_r")(np.linspace(0.1, 0.85, len(bounds) - 1)))
    norm = BoundaryNorm(bounds, cmap.N)
    hs_col, land_col, other_col = np.array([0.80, 0.85, 0.90]), np.array([0.97, 0.97, 0.97]), np.array([0.88] * 3)

    fig = plt.figure(figsize=(12, 10.8))
    ax = fig.add_axes([0.02, 0.385, 0.96, 0.58], projection=ccrs.EqualEarth(central_longitude=150))
    ax.set_global()
    ax.spines["geo"].set_linewidth(0.6)
    base = np.empty(eid.shape + (3,))
    base[:] = land_col
    base[ocean] = other_col
    base[ocean & hs & (eid == 0)] = hs_col
    ext = [-180, 180, -90, 90]
    ax.imshow(base, extent=ext, transform=ccrs.PlateCarree(), origin="upper", regrid_shape=(1800, 3600),
              interpolation="nearest")
    im = ax.imshow(np.ma.masked_invalid(val), extent=ext, transform=ccrs.PlateCarree(), origin="upper",
                   cmap=cmap, norm=norm, regrid_shape=(1800, 3600), interpolation="nearest")
    # EEZ outlines: cells whose id differs from a neighbour
    edge = np.zeros(eid.shape, bool)
    edge[:, 1:] |= eid[:, 1:] != eid[:, :-1]
    edge[1:, :] |= eid[1:, :] != eid[:-1, :]
    edge &= ocean
    ax.imshow(np.ma.masked_where(~edge, edge.astype(float)), extent=ext, transform=ccrs.PlateCarree(),
              origin="upper", cmap=ListedColormap(["#3a3a3a"]), vmin=0, vmax=1, regrid_shape=(1800, 3600),
              interpolation="nearest", alpha=0.55)
    z = d["zones"]
    cb = fig.colorbar(im, ax=ax, orientation="horizontal", fraction=0.04, pad=0.025, shrink=0.5,
                      ticks=bounds)
    cb.set_label("Directly measured share of each EEZ (%)")
    fig.legend(handles=[Patch(facecolor=hs_col, edgecolor="0.5", lw=0.5,
                              label=f"High seas (outside all EEZs): {pct(z['high_seas']['measured_fraction'])} measured"),
                        Patch(facecolor=other_col, edgecolor="0.5", lw=0.5,
                              label="Neither: lakes below sea level, coastal slivers; Caspian excluded")],
               loc="upper left", bbox_to_anchor=(0.04, 0.365), frameon=False, fontsize=9)
    ax.set_title(f"National waters (EEZs) are {pct(z['all_eez']['measured_fraction'])} measured, "
                 f"the high seas {pct(z['high_seas']['measured_fraction'])}", fontsize=13)

    # ---- bars per ocean
    b = fig.add_axes([0.27, 0.07, 0.6, 0.235])
    rows = sorted(d["oceans"], key=lambda e: e["measured_fraction"])
    names = [r["name"] for r in rows]
    vals = [100 * r["measured_fraction"] for r in rows]
    b.barh(range(len(rows)), vals, color="#b3367a", height=0.7)
    b.set_yticks(range(len(rows)), names)
    for i, r in enumerate(rows):
        b.text(vals[i] + 0.8, i, f"{vals[i]:.1f}%  ({r['ocean_area_km2'] / 1e6:.1f} M km²)", va="center",
               fontsize=8, color="0.25", zorder=3,
               bbox={"boxstyle": "square,pad=0.1", "facecolor": "white", "edgecolor": "none"})
    gm = 100 * d["global_check"]["measured_fraction"]
    b.axvline(gm, color="0.4", ls="--", lw=1, zorder=1)
    b.text(gm + 0.6, -0.75, f"world {gm:.1f}%", color="0.35", fontsize=8, va="center", ha="left")
    b.set_ylim(-1.1, len(rows) - 0.4)
    b.set_xlim(0, 112)
    b.set_xticks(range(0, 101, 20))
    b.spines["bottom"].set_bounds(0, 100)
    b.set_xlabel("Directly measured (% of ocean area)")
    b.set_title("By ocean and sea (Marine Regions Global Oceans and Seas)", fontsize=11)
    fig.text(0.5, 0.0, f"Data: {CITE_GEBCO} (TID 10–17).\nRegions: Flanders Marine Institute, Marine Regions "
             "World EEZ v12, High Seas v2, Global Oceans and Seas v01 (CC-BY 4.0). EEZ boundaries include disputed areas.",
             ha="center", va="bottom", fontsize=7, color="0.35")
    fig.savefig(OUT_FIG)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--figure", action="store_true", help="only redraw the figure from regions.json")
    a = ap.parse_args()
    if a.figure:
        d = json.loads(OUT_JSON.read_text())
    else:
        d = compute()
        write_md(d)
    figure(d)
    z = d["zones"]
    print(json.dumps({"global": d["global_check"]["measured_fraction"],
                      "oceans": {e["name"]: round(e["measured_fraction"], 4) for e in d["oceans"]},
                      "eez": z["all_eez"]["measured_fraction"], "high_seas": z["high_seas"]["measured_fraction"],
                      "unassigned_km2": z["unassigned"]["ocean_area_km2"]}, indent=1))


if __name__ == "__main__":
    main()

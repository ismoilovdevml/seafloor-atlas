"""Global seamount census -> web/public/data/seamounts.json (columnar) + figures/fig11_quakes_seamounts.png.

Sources (all fetched into data/raw/seamounts/, gitignored):
  * SDUST2026SM (Gao et al. 2026, Zenodo 10.5281/zenodo.23277209, CC BY 4.0): 67,374 visually accepted
    seamounts >= 100 m high from SWOT_04 vertical gravity gradient + GEBCO_2025, stored on a 1' grid
    (SDUST2026SM.nc). The most complete open census; it is the base of the layer.
  * SIO 2023 (Gevorgian et al. 2023, Zenodo 10.5281/zenodo.7718512, CC BY 4.0): the Kim & Wessel (2011)
    catalogue (24,643, ids KW-xxxxx) re-picked on VGG v32 plus 19,325 new seamounts (SIO-xxxxx);
    Seamounts_Modeled/all.xyhrdnc. The 514 KW picks the authors list in KW_badlist.txt (no VGG signal any
    more) are dropped, leaving 43,455. Every SDUST seamount with an SIO 2023 seamount within MATCH_KM gets
    that id (`cat`), and SIO 2023 seamounts with no SDUST seamount within MATCH_KM are added (src = 1), so
    the Kim & Wessel census is fully contained and traceable.
  * Kim & Wessel (2011) KWSMTSv01.txt from SOEST (https://www.soest.hawaii.edu/PT/SMTS/): only for counts
    and the original KW positions (the same catalogue is inside the SIO 2023 Zenodo record).
  * Yesson et al. (2020) PANGAEA 10.1594/PANGAEA.921688 (CC BY 4.0): 37,889 peaks from SRTM30_PLUS v11,
    a different (bathymetry-only) method; used only as a cross-check.

Per seamount, from GEBCO_2026 15": the summit = the shallowest 15" cell within a disc of radius
clamp(0.5 x basal semi-minor axis, 1.5 km, 5 km) around the catalogue centre (SDUST) or
clamp(0.3 x basal radius, 1.5, 5) km (SIO-only), its depth and its TID code (10-17 = directly measured).
Name: GEBCO gazetteer elevation features (Seamount, Guyot, Knoll, Hill, Bank, Peak, Tablemount and their
plurals): a seamount inside a gazetteer polygon (data/raw/gazetteer/layer2_polygon.geojson, from
pipeline/features.py) takes its name (singular names: only the tallest seamount inside); otherwise the
nearest seamount within NAME_KM of a point label (web/public/data/features.geojson) takes it (plural
names: every seamount within NAME_KM).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import struct
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/seamounts"
ELEV15 = ROOT / "data/raw/gebco_2026/GEBCO_2026_15s.tif"
TID = ROOT / "data/raw/gebco_2026/gebco_2026_tid.tif"
FEATURES = ROOT / "web/public/data/features.geojson"
OUT = ROOT / "web/public/data/seamounts.json"
STATS = ROOT / "data/derived/seamounts_stats.json"
FIG = ROOT / "figures/fig11_quakes_seamounts.png"
QUAKES = ROOT / "web/public/data/quakes.json"
QUAKE_STATS = ROOT / "data/derived/quakes_stats.json"
PLATES = ROOT / "web/public/data/plates.geojson"
UA = "seafloor-atlas-data-prep/0.1 (open-data ocean map; https://github.com/ismoilovdevml/seafloor-atlas)"
R_KM = 6371.0088
CELL_KM = 6371.0088 * math.pi / 180 / 240     # 15" in km along a meridian (0.463 km)
MATCH_KM = 10.0
NAME_KM = 10.0
SUMMIT_MIN_KM, SUMMIT_MAX_KM = 1.5, 5.0
NAME_KINDS = {"Seamount", "Seamounts", "Guyot", "Guyots", "Knoll", "Knolls", "Hill", "Hills", "Bank", "Banks",
              "Peak", "Peaks", "Tablemount", "Seamount Group"}
PLURAL = {"Seamounts", "Guyots", "Knolls", "Hills", "Banks", "Peaks", "Seamount Group"}

DOWNLOADS = {
    "sdust2026/SDUST2026SM.nc": "https://zenodo.org/api/records/23277209/files/SDUST2026SM.nc/content",
    "sdust2026/README.txt": "https://zenodo.org/api/records/23277209/files/README.txt/content",
    "gevorgian2023/SIO_Seamounts.zip": "https://zenodo.org/api/records/7718512/files/SIO_Seamounts.zip/content",
    "kw2011/KWSMTSv01.txt": "https://www.soest.hawaii.edu/PT/SMTS/kwsmts/KWSMTSv01.txt",
    "yesson2020/YessonEtAl2019-Seamounts-V2.zip":
        "https://download.pangaea.de/dataset/921688/files/YessonEtAl2019-Seamounts-V2.zip",
}
SIO_DIR = RAW / "gevorgian2023/unz/SIO_Seamounts/Seamounts_Modeled"

SOURCES = [
    {"key": "SDUST2026SM", "src": 0,
     "citation": "Gao, Y., Guo, J., Ya, S., Yu, D., Liu, X. & Hwang, C. (2026) SDUST2026SM: A Global Seamount Catalog "
                 "Based on Vertical Gradient of Gravity Anomaly and Bathymetric Data (v1.0). Zenodo. "
                 "doi:10.5281/zenodo.23277209. Paper: Earth Syst. Sci. Data Discuss., doi:10.5194/essd-2026-860 "
                 "(preprint, in review)", "licence": "CC BY 4.0"},
    {"key": "SIO2023", "src": 1,
     "citation": "Gevorgian, J., Sandwell, D. T., Yu, Y., Kim, S.-S. & Wessel, P. (2023) Global distribution and "
                 "morphology of small seamounts. Earth and Space Science 10, e2022EA002331, doi:10.1029/2022EA002331; "
                 "data: Zenodo doi:10.5281/zenodo.7718512", "licence": "CC BY 4.0"},
    {"key": "KW2011", "src": None,
     "citation": "Kim, S.-S. & Wessel, P. (2011) New global seamount census from altimetry-derived gravity data. "
                 "Geophys. J. Int. 186, 615-631, doi:10.1111/j.1365-246X.2011.05076.x (KWSMTS v0.1; contained in "
                 "SIO2023, ids KW-xxxxx)", "licence": "as redistributed in the SIO2023 Zenodo record (CC BY 4.0)"},
]
ATTRIBUTION = ("Seamounts: SDUST2026SM (Gao et al. 2026) and SIO 2023 / Kim & Wessel 2011 (Gevorgian et al. 2023), "
               "CC BY 4.0; summits from GEBCO_2026")


# --- inputs -------------------------------------------------------------------------------------------

def fetch() -> None:
    for rel, url in DOWNLOADS.items():
        f = RAW / rel
        if f.exists():
            continue
        f.parent.mkdir(parents=True, exist_ok=True)
        print(f"  fetching {url}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=900) as r:
            f.write_bytes(r.read())
    for z, d in (("gevorgian2023/SIO_Seamounts.zip", "gevorgian2023/unz"),
                 ("yesson2020/YessonEtAl2019-Seamounts-V2.zip", "yesson2020/unz")):
        if not (RAW / d).exists():
            with zipfile.ZipFile(RAW / z) as zf:
                zf.extractall(RAW / d)


def load_sdust() -> dict:
    """Accepted SDUST2026SM seamounts: the grid cells with visual_pass_flag == 1 (cached as .npy)."""
    cache = RAW / "sdust2026/accepted.npz"
    if cache.exists():
        return dict(np.load(cache))
    import netCDF4  # only needed once
    d = netCDF4.Dataset(RAW / "sdust2026/SDUST2026SM.nc")
    d.set_auto_mask(False)
    lat, lon = d["lat"][:], d["lon"][:]
    out = {k: [] for k in ("lon", "lat", "flag", "height", "base", "id", "major", "minor")}
    for r0 in range(0, len(lat), 1200):
        f = d["visual_pass_flag"][r0:r0 + 1200, :]
        ii, jj = np.nonzero(f >= 0)
        if not len(ii):
            continue
        out["lon"].append(lon[jj])
        out["lat"].append(lat[r0 + ii])
        out["flag"].append(f[ii, jj])
        for k, v in (("height", "seamount_height"), ("base", "base_depth"), ("id", "seamount_id"),
                     ("major", "major_axis"), ("minor", "minor_axis")):
            out[k].append(d[v][r0:r0 + 1200, :][ii, jj])
    a = {k: np.concatenate(v) for k, v in out.items()}
    a["n_candidates"] = np.array(len(a["flag"]))
    np.savez(cache, **a)
    return a


def load_sio() -> tuple[list[dict], int]:
    bad = set((SIO_DIR / "KW_badlist.txt").read_text().split())
    cls = {}
    for c in ("good", "shallow", "short", "tall"):
        for line in (SIO_DIR / f"{c}.xyhrdnc").read_text().splitlines():
            cls[line.split()[5]] = c
    rows, dropped = [], 0
    for line in (SIO_DIR / "all.xyhrdnc").read_text().splitlines():
        lo, la, h, rad, base, name, charted = line.split()
        if name in bad:
            dropped += 1
            continue
        rows.append({"lon": float(lo), "lat": float(la), "h": float(h), "radius_km": float(rad), "base": float(base),
                     "id": name, "charted": int(charted), "cls": cls[name]})
    return rows, dropped


def load_kw() -> np.ndarray:
    rows = [ln.split() for ln in (RAW / "kw2011/KWSMTSv01.txt").read_text().splitlines() if ln and ln[0] not in "#>"]
    return np.array([[float(r[0]), float(r[1]), float(r[5])] for r in rows])


def read_dbf(path: Path) -> list[dict]:
    """Minimal dBase III reader (the Yesson shapefile attributes; avoids a GIS dependency)."""
    b = path.read_bytes()
    n, hlen, rlen = struct.unpack("<IHH", b[4:12])
    fields, off = [], 32
    while b[off] != 0x0D:
        name = b[off:off + 11].split(b"\0")[0].decode()
        fields.append((name, b[off + 16]))
        off += 32
    out = []
    for i in range(n):
        rec, p, row = b[hlen + i * rlen: hlen + (i + 1) * rlen], 1, {}
        for name, ln in fields:
            row[name] = rec[p:p + ln].decode("latin-1").strip()
            p += ln
        out.append(row)
    return out


def load_yesson() -> np.ndarray:
    rows = read_dbf(RAW / "yesson2020/unz/YessonEtAl2019-Seamounts-V2.dbf")
    return np.array([[float(r["X"]), float(r["Y"]), float(r["Height"])] for r in rows])


# --- geometry -----------------------------------------------------------------------------------------

def unit(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.c_[np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)]


def gc_km(chord):
    return 2 * R_KM * np.arcsin(np.clip(chord / 2, 0, 1))


def km_to_chord(km: float) -> float:
    return 2 * math.sin(km / R_KM / 2)


def summits(lon: np.ndarray, lat: np.ndarray, radius_km: np.ndarray, block: int = 512, margin: int = 80):
    """Shallowest GEBCO_2026 15" cell within radius_km of each point: (elevation m, TID, lon, lat, n_measured_in_disc).

    Points are grouped by 512 x 512 source block so each block is decompressed once."""
    n = len(lon)
    elev = np.full(n, np.nan)
    tid = np.zeros(n, np.int16)
    slon, slat = np.full(n, np.nan), np.full(n, np.nan)
    any_meas = np.zeros(n, bool)
    with rasterio.open(ELEV15) as se, rasterio.open(TID) as st:
        H, W = se.height, se.width
        rows = np.clip(((90 - lat) * 240).astype(int), 0, H - 1)
        cols = np.clip(((lon + 180) * 240).astype(int), 0, W - 1)
        key = (rows // block) * (W // block + 1) + cols // block
        for k in np.unique(key):
            idx = np.nonzero(key == k)[0]
            br, bc = rows[idx[0]] // block * block, cols[idx[0]] // block * block
            r0, c0 = max(br - margin, 0), max(bc - margin, 0)
            r1, c1 = min(br + block + margin, H), min(bc + block + margin, W)
            win = Window(c0, r0, c1 - c0, r1 - r0)
            z = se.read(1, window=win).astype(np.float32)
            t = st.read(1, window=win)
            z[z == se.nodata] = np.nan
            for i in idx:
                dr = max(1, int(math.ceil(radius_km[i] / CELL_KM)))
                dc = max(1, int(math.ceil(radius_km[i] / (CELL_KM * max(math.cos(math.radians(lat[i])), 0.05)))))
                rr, cc = rows[i] - r0, cols[i] - c0
                ra, rb, ca, cb = max(rr - dr, 0), min(rr + dr + 1, z.shape[0]), max(cc - dc, 0), min(cc + dc + 1, z.shape[1])
                zz, tt = z[ra:rb, ca:cb], t[ra:rb, ca:cb]
                yy, xx = np.mgrid[ra:rb, ca:cb]
                disc = ((yy - rr) / dr) ** 2 + ((xx - cc) / dc) ** 2 <= 1
                zz = np.where(disc, zz, np.nan)
                if np.isnan(zz).all():
                    continue
                j = np.nanargmax(zz)
                jr, jc = np.unravel_index(j, zz.shape)
                elev[i] = zz[jr, jc]
                tid[i] = tt[jr, jc]
                slat[i] = 90 - (r0 + ra + jr + 0.5) / 240
                slon[i] = -180 + (c0 + ca + jc + 0.5) / 240
                any_meas[i] = bool(((tt >= 10) & (tt <= 17) & disc).any())
    return elev, tid, slon, slat, any_meas


def in_polygons(lon: np.ndarray, lat: np.ndarray, geom: dict) -> np.ndarray:
    from matplotlib.path import Path as MPath
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    inside = np.zeros(len(lon), bool)
    for poly in polys:
        ring = np.asarray(poly[0], float)
        x = lon
        if np.ptp(ring[:, 0]) > 180:  # crosses the antimeridian: test in 0..360
            ring = ring.copy()
            ring[:, 0] %= 360
            x = lon % 360
        bb = (x >= ring[:, 0].min()) & (x <= ring[:, 0].max()) & (lat >= ring[:, 1].min()) & (lat <= ring[:, 1].max())
        if not bb.any():
            continue
        hit = MPath(ring).contains_points(np.c_[x[bb], lat[bb]])
        for hole in poly[1:]:
            hit &= ~MPath(np.asarray(hole, float)).contains_points(np.c_[x[bb], lat[bb]])
        inside[np.nonzero(bb)[0][hit]] = True
    return inside


def names_for(lon: np.ndarray, lat: np.ndarray, h: np.ndarray) -> tuple[list[str], dict]:
    """Gazetteer names. (1) Polygon features (raw gazetteer layer, by FEATURE_ID): a singular name goes to the
    tallest catalogue seamount inside the polygon, a plural name to every one inside. (2) Point labels: a singular
    name goes to the nearest catalogue seamount within NAME_KM, a plural name to every one within NAME_KM.
    Singular beats plural; polygon beats point."""
    feats = [f for f in json.loads(FEATURES.read_text())["features"]
             if f["properties"]["kind"] in NAME_KINDS and f["properties"]["geom"] != "line"]
    by_id = {f["properties"]["id"]: f["properties"]["name"] for f in feats}
    t_smt = cKDTree(unit(lon, lat))
    best: dict[int, tuple[int, float, str]] = {}  # seamount -> (priority, distance, name); lower priority wins

    def offer(i: int, prio: int, dist: float, name: str) -> None:
        if i not in best or (prio, dist) < best[i][:2]:
            best[i] = (prio, dist, name)

    used = poly_used = 0
    poly_file = ROOT / "data/raw/gazetteer/layer2_polygon.geojson"
    poly_ids = set()
    if poly_file.exists():
        for f in json.loads(poly_file.read_text())["features"]:
            fid = f["properties"].get("FEATURE_ID")
            if fid not in by_id or not f["geometry"]:
                continue
            inside = np.nonzero(in_polygons(lon, lat, f["geometry"]))[0]
            if not len(inside):
                continue
            poly_ids.add(fid)
            poly_used += 1
            plural = (f["properties"].get("TYPE") or "").strip() in PLURAL
            for i in (inside if plural else [inside[np.argmax(h[inside])]]):
                offer(int(i), 2 if plural else 0, 0.0, by_id[fid])
    for f in feats:
        p = f["properties"]
        if p["id"] in poly_ids:
            continue
        u = unit([f["geometry"]["coordinates"][0]], [f["geometry"]["coordinates"][1]])[0]
        if p["kind"] in PLURAL:
            hits = t_smt.query_ball_point(u, km_to_chord(NAME_KM))
            for hh in hits:
                offer(int(hh), 3, float(gc_km(np.linalg.norm(t_smt.data[hh] - u))), p["name"])
            used += bool(hits)
        else:
            d, i = t_smt.query(u)
            if gc_km(d) <= NAME_KM:
                offer(int(i), 1, float(gc_km(d)), p["name"])
                used += 1
    out = [""] * len(lon)
    for i, (_, _, name) in best.items():
        out[i] = name
    sing = np.array([f["properties"]["kind"] in {"Seamount", "Guyot", "Tablemount"} for f in feats])
    flon = np.array([f["geometry"]["coordinates"][0] for f in feats])
    flat = np.array([f["geometry"]["coordinates"][1] for f in feats])
    d_all = gc_km(t_smt.query(unit(flon, flat))[0])
    info = {"gazetteer_labels_considered": len(feats), "gazetteer_polygons_used": poly_used,
            "gazetteer_point_labels_used": used, "gazetteer_seamount_guyot_labels": int(sing.sum()),
            "gazetteer_seamount_guyot_with_catalogue_seamount_within_10km_of_label":
                round(float((d_all[sing] <= NAME_KM).mean()), 4),
            "distinct_names_assigned": len(set(out) - {""})}
    return out, info


# --- build --------------------------------------------------------------------------------------------

def pct(x, qs=(10, 25, 50, 75, 90)):
    return {f"p{q}": round(float(np.percentile(x, q)), 0) for q in qs}


def build() -> dict:
    fetch()
    sd = load_sdust()
    acc = sd["flag"] == 1
    D = {k: sd[k][acc] for k in ("lon", "lat", "height", "base", "id", "major", "minor")}
    sio, dropped = load_sio()
    S = {k: np.array([r[k] for r in sio]) for k in sio[0]}
    print(f"SDUST2026SM: {int(sd['n_candidates'])} candidates, {acc.sum()} accepted; SIO2023: {len(sio)} kept, "
          f"{dropped} KW bad-list picks dropped")

    t_s = cKDTree(unit(S["lon"], S["lat"]))
    t_d = cKDTree(unit(D["lon"], D["lat"]))
    d_ds, i_ds = t_s.query(unit(D["lon"], D["lat"]))
    d_ds = gc_km(d_ds)
    d_sd = gc_km(t_d.query(unit(S["lon"], S["lat"]))[0])
    sio_only = d_sd > MATCH_KM
    rej = sd["flag"] == 0
    t_rej = cKDTree(unit(sd["lon"][rej], sd["lat"][rej]))
    sio_only_near_rejected = int((gc_km(t_rej.query(unit(S["lon"][sio_only], S["lat"][sio_only]))[0]) <= MATCH_KM).sum())

    n_d, n_s = len(D["lon"]), int(sio_only.sum())
    lon = np.r_[D["lon"], S["lon"][sio_only]].astype(float)
    lat = np.r_[D["lat"], S["lat"][sio_only]].astype(float)
    h = np.r_[D["height"], S["h"][sio_only]].astype(float)
    base = np.r_[D["base"], S["base"][sio_only]].astype(float)
    src = np.r_[np.zeros(n_d, np.int8), np.ones(n_s, np.int8)]
    cat = [S["id"][i] if d <= MATCH_KM else "" for d, i in zip(d_ds, i_ds)] + list(S["id"][sio_only])
    sid = np.r_[D["id"], np.zeros(n_s)].astype(int)
    radius = np.r_[np.clip(0.5 * D["minor"] / 1000, SUMMIT_MIN_KM, SUMMIT_MAX_KM),
                   np.clip(0.3 * S["radius_km"][sio_only], SUMMIT_MIN_KM, SUMMIT_MAX_KM)]

    print("sampling GEBCO_2026 15\" summits ...")
    z, tid, slon, slat, any_meas = summits(lon, lat, radius)
    names, name_info = names_for(lon, lat, h)

    measured = (tid >= 10) & (tid <= 17)
    ok = np.isfinite(z)
    named = np.array([bool(n) for n in names])
    island = ok & (z >= 0)

    # height check: catalogue height vs GEBCO_2026 relief (catalogue base depth - GEBCO summit)
    g_h = z - base
    chk = {}
    for name, k in (("SDUST2026SM", src == 0), ("SIO2023_only", src == 1)):
        kk = k & ok & ~island
        diff = g_h[kk] - h[kk]
        chk[name] = {"n": int(kk.sum()), "median_gebco_minus_catalogue_m": round(float(np.median(diff)), 0),
                     "median_abs_m": round(float(np.median(np.abs(diff))), 0),
                     "median_abs_m_measured_summit": round(float(np.median(np.abs(g_h[kk & measured] - h[kk & measured]))), 0)
                     if (kk & measured).any() else None}
    # SIO 2023 VGG model heights (all 43,455) vs GEBCO relief at the matched SDUST summit / own summit
    sio_m = d_ds <= MATCH_KM
    vgg_h = S["h"][i_ds[sio_m]]
    gh = (z[:n_d][sio_m] - D["base"][sio_m])
    good = np.array([S["cls"][i] == "good" for i in i_ds[sio_m]]) & np.isfinite(gh)
    mm = good & measured[:n_d][sio_m]
    chk["SIO2023_vgg_height_vs_gebco_relief"] = {
        "n_good_class": int(good.sum()), "median_abs_m_all": round(float(np.median(np.abs(gh[good] - vgg_h[good]))), 0),
        "median_abs_m_measured_summit": round(float(np.median(np.abs(gh[mm] - vgg_h[mm]))), 0), "n_measured": int(mm.sum()),
        "note": "paper: VGG height accuracy ~270 m; base = SDUST base depth (GEBCO_2025 foot of slope)"}

    hb = [100, 250, 500, 1000, 1500, 2000, 3000, 4000, 10000]
    by_h = []
    for a, b in zip(hb, hb[1:]):
        k = ok & (h >= a) & (h < b)
        by_h.append({"height_m": f"{a}-{b}", "n": int(k.sum()),
                     "summit_measured": round(float(measured[k].mean()), 4) if k.any() else None,
                     "named": round(float(named[k].mean()), 4) if k.any() else None})
    kw = load_kw()
    y = load_yesson()
    t_all = cKDTree(unit(lon, lat))
    kw_in = gc_km(t_all.query(unit(kw[:, 0], kw[:, 1]))[0]) <= MATCH_KM
    y_in = gc_km(t_all.query(unit(y[:, 0], y[:, 1]))[0]) <= MATCH_KM
    sdepth = -z
    stats = {
        "count": int(len(lon)), "from_SDUST2026SM": n_d, "from_SIO2023_only": n_s,
        "SDUST_candidates": int(sd["n_candidates"]), "SDUST_rejected": int(rej.sum()),
        "SIO2023_kept": len(sio), "KW_badlist_dropped": dropped,
        "SIO2023_with_SDUST_within_10km": round(float((d_sd <= MATCH_KM).mean()), 4),
        "SDUST_with_SIO2023_within_10km": round(float((d_ds <= MATCH_KM).mean()), 4),
        "SIO_only_near_SDUST_rejected_candidate": sio_only_near_rejected,
        "KW2011_with_layer_seamount_within_10km": round(float(kw_in.mean()), 4), "KW2011_count": int(len(kw)),
        "Yesson2020_count": int(len(y)), "Yesson2020_with_layer_seamount_within_10km": round(float(y_in.mean()), 4),
        "named_share": round(float(named.mean()), 4), "named_count": int(named.sum()), **name_info,
        "summit_cell_measured_share": round(float(measured[ok].mean()), 4),
        "summit_cell_measured_count": int(measured[ok].sum()),
        "any_measured_cell_in_summit_disc_share": round(float(any_meas[ok].mean()), 4),
        "summit_tid_counts": {int(k): int(v) for k, v in zip(*np.unique(tid[ok], return_counts=True))},
        "SIO2023_authors_charted_flag_share": round(float(S["charted"].mean()), 4),
        "summit_above_sea_level": int(island.sum()), "no_gebco_value": int((~ok).sum()),
        "height_m": {**pct(h), "min": float(h.min()), "max": float(h.max())},
        "summit_depth_m": pct(sdepth[ok]),
        "summit_shallower_than": {str(d): int((ok & (sdepth < d) & (sdepth > 0)).sum()) for d in (200, 500, 1000, 2000)},
        "by_height": by_h, "height_check": chk,
        "summit_radius_km": pct(radius),
    }
    write(lon, lat, h, base, sdepth, tid, src, cat, sid, names, stats)
    STATS.parent.mkdir(parents=True, exist_ok=True)
    STATS.write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats, indent=1))
    return {"lon": lon, "lat": lat, "h": h, "measured": measured, "ok": ok, "named": named}


def write(lon, lat, h, base, sdepth, tid, src, cat, sid, names, stats) -> None:
    order = np.argsort(-h, kind="stable")  # tallest first
    ok = np.isfinite(sdepth)
    col = {
        "lon": [round(float(v), 3) for v in lon[order]],
        "lat": [round(float(v), 3) for v in lat[order]],
        "height_m": [int(round(v)) for v in h[order]],
        "base_depth_m": [int(round(-v)) for v in base[order]],
        "summit_depth_m": [int(round(v)) if o else None for v, o in zip(sdepth[order], ok[order])],
        "tid": [int(v) for v in tid[order]],
        "src": [int(v) for v in src[order]],
        "cat": [cat[i] for i in order],
        "sdust_id": [int(sid[i]) for i in order],
        "name": [names[i] for i in order],
    }
    meta = {
        "title": "Global seamount census", "sources": SOURCES, "attribution": ATTRIBUTION,
        "licence": "CC BY 4.0 (catalogues); GEBCO_2026 summit depths and TID under the GEBCO terms (OGL v3)",
        "generated": dt.datetime.now(dt.timezone.utc).isoformat()[:19] + "Z", "count": int(len(lon)),
        "order": "height descending",
        "columns": {
            "lon": "catalogue centre longitude, degrees (SDUST: 1' cell centre; SIO: VGG maximum)",
            "lat": "catalogue centre latitude, degrees",
            "height_m": "catalogue height above the base, m (SDUST: from GEBCO_2025 foot-of-slope; SIO-only: VGG Gaussian "
                        "model, 100 m steps, 600 = below 700, 2600 = 2,600 or more)",
            "base_depth_m": "catalogue base depth, m, positive down",
            "summit_depth_m": "GEBCO_2026 15\" shallowest cell within the summit disc, m, positive down (negative = above "
                              "sea level); null = no grid value",
            "tid": "GEBCO_2026 TID of that summit cell (10-17 directly measured, 40 predicted from gravity, ...)",
            "src": "0 = SDUST2026SM, 1 = SIO2023 only (no SDUST seamount within 10 km)",
            "cat": "matched SIO 2023 id within 10 km: KW-xxxxx = Kim & Wessel 2011 census, SIO-xxxxx = new in 2023; "
                   "'' = none",
            "sdust_id": "SDUST2026SM seamount_id (0 for src = 1)",
            "name": "GEBCO gazetteer name (see docs/data-contract.md for the matching rule), '' = unnamed",
        },
        "stats": {k: stats[k] for k in ("count", "from_SDUST2026SM", "from_SIO2023_only", "named_share",
                                        "summit_cell_measured_share", "any_measured_cell_in_summit_disc_share",
                                        "height_m", "summit_depth_m")},
    }
    doc = {"metadata": meta, "n": int(len(lon)), **col}
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(lon)} seamounts, {OUT.stat().st_size / 1e6:.2f} MB")


# --- figure -------------------------------------------------------------------------------------------

def figure(sm: dict | None = None) -> None:
    import cartopy.crs as ccrs
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "savefig.dpi": 200, "savefig.bbox": "tight"})
    if sm is None:
        d = json.loads(OUT.read_text())
        t = np.array(d["tid"])
        sm = {"lon": np.array(d["lon"]), "lat": np.array(d["lat"]), "h": np.array(d["height_m"]),
              "measured": (t >= 10) & (t <= 17), "ok": np.array([v is not None for v in d["summit_depth_m"]]),
              "named": np.array([bool(n) for n in d["name"]])}
    q = json.loads(QUAKES.read_text())
    qs = json.loads(QUAKE_STATS.read_text())
    plates = json.loads(PLATES.read_text())

    fig = plt.figure(figsize=(15, 11.5))
    proj = ccrs.EqualEarth(central_longitude=150)
    pc = ccrs.PlateCarree()

    def base_map(ax):
        ax.set_global()
        ax.coastlines(lw=0.3, color="0.45")
        for f in plates["features"]:
            g = f["geometry"]
            lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            for c in lines:
                c = np.array(c)
                ax.plot(c[:, 0], c[:, 1], transform=ccrs.Geodetic(), lw=0.5,
                        color="#333333" if f["properties"]["type"] == "subduction" else "0.6", zorder=2)

    # (a) earthquakes
    ax = fig.add_axes([0.02, 0.555, 0.66, 0.42], projection=proj)
    base_map(ax)
    lon, lat, mag = np.array(q["lon"]), np.array(q["lat"]), np.array(q["mag"])
    dep = np.array([np.nan if v is None else v for v in q["depth_km"]], float)
    o = np.argsort(-dep)[::-1]  # shallow on top
    sc = ax.scatter(lon[o], lat[o], s=(mag[o] - 5.0) ** 2.6 * 1.6, c=dep[o], cmap="plasma_r", vmin=0, vmax=650,
                    transform=pc, lw=0, alpha=0.75, zorder=3)
    cb = fig.colorbar(sc, cax=fig.add_axes([0.22, 0.54, 0.26, 0.009]), orientation="horizontal")
    cb.set_label("Hypocentre depth (km)")
    pb = qs["plate_boundaries"]
    ax.set_title(f"(a) {q['n']:,} earthquakes M ≥ {q['metadata']['minmag']} since 1900 (USGS ComCat). "
                 f"{pb['within_100km_any'] * 100:.1f} % of M ≥ 6 lie within 100 km of a plate boundary\n"
                 f"(which covers {pb['earth_area_within_100km_any'] * 100:.1f} % of Earth's surface); "
                 f"{pb['within_100km_subduction'] * 100:.1f} % within 100 km of a subduction trench (dark lines).",
                 loc="left", fontsize=10)
    # Tonga cross-section
    tp = qs["tonga_profile"]
    axs = fig.add_axes([0.72, 0.56, 0.26, 0.38])
    tx, tz, tm = np.array(tp["x_km"]), np.array(tp["depth_km"]), np.array(tp["mag"])
    axs.scatter(tx, tz, s=(tm - 4.6) ** 2 * 3, c=tz, cmap="plasma_r", vmin=0, vmax=650, lw=0, alpha=0.6)
    ts = qs["tonga_slab"]
    fx = np.array([0, 750])
    f = ts["fit_depth_vs_distance_100km_plus"]
    axs.plot(fx, f["slope_km_per_km"] * fx + f["intercept_km"], "k--", lw=1)
    axs.set_xlim(-200, 900)
    axs.set_ylim(720, -10)
    axs.set_aspect("equal")
    axs.set_xlabel("Distance west of the Tonga Trench (km)")
    axs.set_ylabel("Depth (km)")
    axs.set_title(f"Tonga slab, 15–26° S: {ts['events']:,} events M ≥ 5\n(Wadati–Benioff zone; fit below 100 km: "
                  f"dip {f['apparent_dip_deg']:.0f}°, deepest {ts['deepest_km']:.0f} km)", fontsize=9, loc="left")
    axs.spines[["top", "right"]].set_visible(False)

    # (b) seamounts
    ax2 = fig.add_axes([0.02, 0.03, 0.66, 0.42], projection=proj)
    base_map(ax2)
    ok = sm["ok"]
    un = ok & ~sm["measured"]
    me = ok & sm["measured"]
    ax2.scatter(sm["lon"][un], sm["lat"][un], s=np.clip(sm["h"][un] / 900, 0.2, 5), c="#e07b39", lw=0,
                alpha=0.55, transform=pc, zorder=3)
    ax2.scatter(sm["lon"][me], sm["lat"][me], s=np.clip(sm["h"][me] / 900, 0.2, 5), c="#1f6fb2", lw=0,
                alpha=0.8, transform=pc, zorder=4)
    st = json.loads(STATS.read_text())
    ax2.legend(handles=[Line2D([], [], marker="o", ls="", color="#1f6fb2", label="summit cell measured (TID 10–17)"),
                        Line2D([], [], marker="o", ls="", color="#e07b39", label="summit not directly measured")],
               loc="lower left", fontsize=8, frameon=False)
    ax2.set_title(f"(b) {st['count']:,} seamounts (SDUST2026SM + SIO 2023 / Kim & Wessel 2011). Only "
                  f"{st['summit_cell_measured_share'] * 100:.1f} % have a directly measured summit cell in GEBCO_2026;\n"
                  f"{st['named_share'] * 100:.1f} % carry a gazetteer name.", loc="left", fontsize=10)
    # height distribution
    axh = fig.add_axes([0.73, 0.08, 0.25, 0.36])
    bins = np.arange(0, 6001, 100)
    h = sm["h"]
    axh.hist([h[me], h[un]], bins=bins, stacked=True, color=["#1f6fb2", "#e07b39"],
             label=["summit measured", "summit unmeasured"])
    axh.set_xlim(0, 4500)
    axh.set_xlabel("Seamount height above base (m)")
    axh.set_ylabel("Seamounts per 100 m")
    axh.legend(frameon=False, fontsize=8)
    axh.spines[["top", "right"]].set_visible(False)
    ax3 = axh.twinx()
    hb = st["by_height"]
    mids = [np.mean([float(x) for x in b["height_m"].split("-")]) if not b["height_m"].startswith("4000") else 4250
            for b in hb]
    ax3.plot(mids, [b["summit_measured"] * 100 if b["summit_measured"] is not None else np.nan for b in hb], "k.-")
    ax3.set_ylim(0, 100)
    ax3.set_ylabel("% with measured summit (line)")
    axh.set_title(f"Median height {st['height_m']['p50']:.0f} m", fontsize=9, loc="left")
    fig.text(0.02, 0.005, "Data: USGS ANSS ComCat (public domain); Bird (2003) PB2002; Gao et al. (2026) SDUST2026SM "
             "doi:10.5281/zenodo.23277209; Gevorgian et al. (2023) doi:10.5281/zenodo.7718512; Kim & Wessel (2011); "
             "GEBCO Compilation Group (2026) GEBCO_2026 Grid.", fontsize=7, color="0.35")
    FIG.parent.mkdir(exist_ok=True)
    fig.savefig(FIG)
    print(f"wrote {FIG.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--figure-only", action="store_true", help="redraw fig11 from the written files")
    a = ap.parse_args()
    figure(None if a.figure_only else build())


if __name__ == "__main__":
    main()

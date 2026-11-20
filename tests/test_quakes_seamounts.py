"""Unit tests for the earthquake and seamount layers (synthetic inputs, no downloads)."""
import struct
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import quakes  # noqa: E402
import seamounts  # noqa: E402

ROW = {"time": "2011-03-11T05:46:24.120Z", "latitude": "38.297", "longitude": "142.373", "depth": "29",
       "mag": "9.1", "id": "official20110311054624120_30", "place": "2011 Great Tohoku Earthquake, Japan",
       "type": "earthquake"}


def test_to_feature_keeps_earthquakes_only_and_rounds():
    f = quakes.to_feature(ROW)
    assert f["geometry"]["coordinates"] == [142.37, 38.3]
    assert f["properties"]["time"] == 1299822384120 and f["properties"]["depth_km"] == 29
    assert quakes.to_feature({**ROW, "type": "nuclear explosion"}) is None
    assert quakes.to_feature({**ROW, "depth": ""})["properties"]["depth_km"] is None


def test_columnar_write_read_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(quakes, "OUT", tmp_path / "q.json")
    monkeypatch.setattr(quakes, "ROOT", tmp_path)
    a = quakes.to_feature(ROW)
    b = quakes.to_feature({**ROW, "id": "x2", "mag": "6.0", "time": "2020-01-01T00:00:00Z"})
    quakes.write([b, a], 5.5, None)
    meta, feats = quakes.read_out()
    assert [f["properties"]["id"] for f in feats] == [ROW["id"], "x2"]  # magnitude descending
    assert feats[0] == a and meta["count"] == 2 and meta["minmag"] == 5.5


def test_great_circle_distance_from_unit_vectors():
    t = cKDTree(quakes.unit(np.array([0.0]), np.array([0.0])))
    d, _ = quakes.dist_to(t, np.array([1.0, 0.0]), np.array([0.0, 1.0]))
    assert np.allclose(d, 111.19, atol=0.05)


def test_boundary_points_are_dense():
    pts, kinds = quakes.boundary_points({"subduction"})
    assert len(pts) == len(kinds) and set(kinds) == {"subduction"}
    step = np.hypot(np.diff(pts[:, 0]) * np.cos(np.radians(pts[1:, 1])), np.diff(pts[:, 1])) * 111.2
    assert np.median(step) <= 2.0


def test_in_polygons_handles_antimeridian():
    sq = {"type": "Polygon", "coordinates": [[[179, -1], [-179, -1], [-179, 1], [179, 1], [179, -1]]]}
    inside = seamounts.in_polygons(np.array([179.5, -179.5, 0.0, 178.0]), np.zeros(4), sq)
    assert inside.tolist() == [True, True, False, False]


def test_read_dbf(tmp_path):
    fields = [(b"X", b"N", 10), (b"Height", b"N", 6)]
    recs = [(" 12.5", "1200"), ("-170.25", "300")]
    hlen = 32 + 32 * len(fields) + 1
    rlen = 1 + sum(f[2] for f in fields)
    out = bytearray(struct.pack("<BBBBIHH20x", 3, 126, 1, 1, len(recs), hlen, rlen))
    for name, typ, ln in fields:
        out += name.ljust(11, b"\0") + typ + b"\0" * 4 + bytes([ln, 0]) + b"\0" * 14
    out += b"\x0d"
    for r in recs:
        out += b" " + b"".join(v.rjust(f[2]).encode() for v, f in zip(r, fields))
    p = tmp_path / "t.dbf"
    p.write_bytes(bytes(out))
    rows = seamounts.read_dbf(p)
    assert rows == [{"X": "12.5", "Height": "1200"}, {"X": "-170.25", "Height": "300"}]


def test_share_deeper_ignores_unknown_depths():
    share, unknown = quakes.share_deeper(np.array([10.0, 100.0, np.nan, np.nan, 300.0]), 70)
    assert share == round(2 / 3, 4) and unknown == 2
    assert quakes.share_deeper(np.array([np.nan]), 70) == (None, 1)


def test_refresh_stats_recomputes_from_browser_file_and_keeps_full_build_parts():
    def ev(i, mag, t, lon=0.0, lat=0.0, depth=10):
        return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {"id": f"e{i}", "time": t, "mag": mag, "depth_km": depth, "place": ""}}
    feats = [ev(0, 6.5, 0), ev(1, 7.2, 10**12, 10.0, 5.0, None), ev(2, 5.6, 2 * 10**12)]
    old = {"counts": {"m5_all": 99, "m5_5": 1, "m6": 1, "m7": 0, "m8": 0, "other_types_dropped": {"x": 1}},
           "tonga_slab": {"events": 7}, "plate_boundaries": {}, "per_decade_m6": {}}
    new = quakes.refresh_stats(feats, old)
    assert new["counts"] == {"m5_all": 99, "m5_5": 3, "m6": 2, "m7": 1, "m8": 0, "other_types_dropped": {"x": 1}}
    assert new["tonga_slab"] == {"events": 7}
    assert new["top10"][0]["mag"] == 7.2 and len(new["top10"]) == 3
    assert new["plate_boundaries"]["events_m6"] == 2
    assert new["per_decade_m6"][1970] == 1 and new["per_decade_m6"][2000] == 1
    assert new["from_last_full_build"] == quakes.FULL_BUILD_ONLY
    assert quakes.refresh_stats(feats, None) is None

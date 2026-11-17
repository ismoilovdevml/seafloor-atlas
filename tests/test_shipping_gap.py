"""Unit tests for the traffic-class bookkeeping in pipeline/shipping_gap.py (synthetic arrays, no data)."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import shipping_gap as sg  # noqa: E402

LABELS = {"zones": ["caspian_sea_box", "eez", "high_seas", "neither"], "goas": ["outside", "Pacific", "Atlantic"]}


def test_traffic_class_edges():
    d = np.array([0.0, np.nan, 0.03, 99.9, 100.0, 9999, 1e4, 1e5, 999999, 1e6, 1e8])
    assert sg.traffic_class(d).tolist() == [0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5]
    assert len(sg.class_names()) == 6
    assert sg.TRACK == sg.THRESHOLDS[0] and sg.HEAVY == sg.THRESHOLDS[-1]


def test_isolated_track_values():
    a = np.zeros((9, 9), dtype=np.int64)
    a[1, 1] = 5000          # isolated fix
    a[6, 6] = 300           # two fixes next to each other: not isolated
    a[6, 7] = 400
    a[4, 1] = 3             # background value nearby does not count as a neighbour
    v = sg.isolated_track_values(a)
    assert v.tolist() == [5000]


def _toy():
    # six 1' cells: density, unmeasured km2, measured km2, depth m, zone, goas
    dens = np.array([0.0, 0.5, 150.0, 2e4, 5e5, 3e6])
    un = np.array([10.0, 20.0, 30.0, 40.0, 50.0, 60.0])
    me = np.array([0.0, 5.0, 10.0, 0.0, 25.0, 40.0])
    depth = np.array([4000.0, 4000.0, 150.0, 2500.0, 100.0, 50.0])
    zone = np.array([2, 2, 1, 2, 1, 1])
    goas = np.array([1, 1, 2, 1, 2, 2])
    return dens, un, me, depth, zone, goas


def test_summarise_class_bookkeeping():
    r = sg.summarise(*_toy(), LABELS)
    assert r["area_km2"] == {"unmeasured": 210.0, "measured": 80.0}
    m = r["measured_share_by_traffic"]
    assert sum(v["ocean_km2"] for v in m.values()) == pytest.approx(290.0)     # classes partition the ocean
    assert m["no value"]["ocean_km2"] == 10 and m["no value"]["measured_share"] == 0
    assert m[">= 1e6"]["measured_share"] == pytest.approx(40 / 100)
    assert r["unmeasured_km2_at_density_ge"]["1e+02"] == pytest.approx(30 + 40 + 50 + 60)
    assert r["unmeasured_km2_at_density_ge"]["1e+06"] == pytest.approx(60)
    assert r["unmeasured_with_any_value"] == pytest.approx(200 / 210)
    assert r["ocean_share_at_density_ge"]["1e+06"] == pytest.approx(100 / 290)


def test_summarise_depth_zone_and_headline_splits():
    r = sg.summarise(*_toy(), LABELS)
    d = r["by_depth"]
    assert d["0-200 m"]["unmeasured_km2"] == pytest.approx(30 + 50 + 60)
    assert d["0-200 m"]["unmeasured_under_track_km2"] == pytest.approx(140)
    assert d["0-200 m"]["unmeasured_under_heavy_km2"] == pytest.approx(60)
    assert d["1,000-3,000 m"]["unmeasured_under_track_km2"] == pytest.approx(40)
    assert d["> 3,000 m"]["unmeasured_under_track_km2"] == 0
    assert sum(v["unmeasured_km2"] for v in d.values()) == pytest.approx(210)
    z = r["by_zone"]
    assert set(z) == {"eez", "high_seas"}
    assert z["eez"]["unmeasured_under_track_km2"] == pytest.approx(140)
    assert z["high_seas"]["unmeasured_under_track_km2"] == pytest.approx(40)
    t = r["unmeasured_under_track"]
    assert t["km2"] == pytest.approx(180)
    assert t["share_0_200m"] == pytest.approx(140 / 180)
    assert t["share_eez"] + t["share_high_seas"] == pytest.approx(1.0)
    assert r["unmeasured_under_heavy"]["share_eez"] == pytest.approx(1.0)

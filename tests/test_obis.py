import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import obis  # noqa: E402


def test_geohash_encode_known_value():
    # Wikipedia example: 57.64911, 10.40744 -> u4pruydqqvj
    assert obis.gh_encode(57.64911, 10.40744, 11) == "u4pruydqqvj"
    assert obis.gh_encode(-33.9, 151.2, 3) == "r3g"


def test_fine_cells_nest_in_coarse_cells():
    # every geohash-4 cell of a 4 x 8 block has the geohash-3 of the block as prefix
    for r3, c3 in [(0, 0), (40, 200), (127, 255), (64, 128)]:
        g3 = obis.gh_encode(*obis.cell_center(obis.COARSE, r3, c3), 3)
        for dr in range(8):
            for dc in range(4):
                g4 = obis.gh_encode(*obis.cell_center(obis.FINE, r3 * 8 + dr, c3 * 4 + dc), 4)
                assert g4[:3] == g3


def test_grid_features_to_array_places_polygon():
    lon0, lat0 = 4.5703125, 52.91015625
    ring = [[lon0, lat0], [lon0 + obis.FINE["dlon"], lat0], [lon0 + obis.FINE["dlon"], lat0 + obis.FINE["dlat"]],
            [lon0, lat0 + obis.FINE["dlat"]], [lon0, lat0]]
    a = obis.grid_features_to_array([{"geometry": {"coordinates": [ring]}, "properties": {"n": 7}}], obis.FINE)
    r, c = np.argwhere(a == 7)[0]
    lat, lon = obis.cell_center(obis.FINE, r, c)
    assert lon0 < lon < lon0 + obis.FINE["dlon"] and lat0 < lat < lat0 + obis.FINE["dlat"]
    assert a.sum() == 7


@pytest.mark.parametrize("nbytes", [1, 2, 4])
def test_planes_round_trip(nbytes):
    rng = np.random.default_rng(1)
    q = rng.integers(0, 2 ** (8 * nbytes) - 1, size=(5, 7), dtype=np.uint64).astype(f"u{nbytes}")
    assert np.array_equal(obis.unplanes(obis.planes(q), q.shape, nbytes), q)


def test_es50_limits():
    # cell 0: 100 singletons -> ES50 = 50; cell 1: one species with 100 records -> 1;
    # cell 2: 30 records -> not enough data; cell 3: two species 50/50 -> ~2
    cell = np.r_[np.zeros(100, int), 1, 2, 3, 3]
    ni = np.r_[np.ones(100), 100, 30, 50, 50]
    es, n = obis.es_n(cell, ni, 4)
    assert es[0] == pytest.approx(50)
    assert es[1] == pytest.approx(1)
    assert np.isnan(es[2]) and n[2] == 30
    assert 1.99 < es[3] <= 2


def test_es50_matches_direct_formula():
    from math import comb
    ni = np.array([40, 25, 10, 3, 1, 1])
    N = ni.sum()
    want = sum(1 - comb(N - k, 50) / comb(N, 50) for k in ni)
    es, _ = obis.es_n(np.zeros(len(ni), int), ni, 1)
    assert es[0] == pytest.approx(want, rel=1e-9)


def test_built_products_if_present():
    m = obis.OUT / "manifest.json"
    if not m.exists():
        pytest.skip("run pipeline/obis.py build first")
    man = json.loads(m.read_text())
    rec = obis.read_layer("records_gh4")
    assert rec.shape == (1024, 1024)
    # records on the grid are (almost) all OBIS records with coordinates
    assert rec.sum() == man["stats"]["recordsOnGrid"]
    # the OBIS index changes while the 32 requests run (+-0.3 % within an hour), so not an exact match
    assert 0.95 < rec.sum() / man["stats"]["obisGlobal"]["records"] < 1.01
    es = obis.read_layer("es50_gh3")
    v = (es[es > 0] - 1) / 100
    assert v.min() >= 1 and v.max() <= 50
    total = sum(f.stat().st_size for f in obis.OUT.rglob("*") if f.is_file())
    assert total < 25e6

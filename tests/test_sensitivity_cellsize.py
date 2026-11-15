"""Unit tests for the equal-width block merging in pipeline/sensitivity_cellsize.py (synthetic arrays, no data)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import sensitivity_cellsize as sc  # noqa: E402


def test_k_for_rounds_inverse_cosine():
    lat = np.array([0.0, 45.0, 48.0, 60.0, np.degrees(np.arccos(1 / 3)), 80.0])
    assert sc.k_for(lat, 1).tolist() == [1, 1, 1, 2, 3, 6]
    assert sc.k_for(np.array([0.0, 60.0]), 2).tolist() == [2, 4]
    assert sc.k_for(np.array([89.999]), 1, ncol=100).tolist() == [100]   # capped at the row width


def test_blocks_any_majority_and_short_last_block():
    # W = 7, k = 3 -> blocks [0:3] [3:6] [6:7] (last one short)
    ocean = np.array([[1, 1, 1, 1, 0, 0, 1]], dtype=bool)
    meas = np.array([[0, 1, 0, 0, 1, 0, 1]], dtype=bool)        # col 4 measured but land: ignored
    cnt = sc.merge_blocks(ocean, meas, np.array([3]), 1)
    assert cnt[:, 0].tolist() == [5, 4, 1]                      # ocean, any (3 + 1), majority (short block only)


def test_majority_is_strict_and_rows_are_kept_apart():
    # s = 2 rows, k = 2, W = 5 -> blocks [0:2] [2:4] [4:5]
    ocean = np.array([[1, 1, 1, 0, 1],
                      [1, 1, 1, 1, 0]], dtype=bool)
    meas = np.array([[1, 0, 1, 0, 0],
                     [0, 0, 1, 1, 0]], dtype=bool)
    cnt = sc.merge_blocks(ocean, meas, np.array([2]), 2)
    # block 0: 4 ocean (2 + 2), 1 measured -> any, not majority; block 1: 3 ocean (1 + 2), 3 measured -> both;
    # block 2: 1 ocean (row 0), not measured -> neither. Counts are ocean cells per row.
    assert cnt[0].tolist() == [4, 4]
    assert cnt[1].tolist() == [2 + 1, 2 + 2]
    assert cnt[2].tolist() == [1, 2]
    # tie: 2 of 4 measured is not a majority
    t = sc.merge_blocks(np.ones((2, 2), bool), np.array([[1, 0], [1, 0]], bool), np.array([2]), 2)
    assert t[1].sum() == 4 and t[2].sum() == 0


def test_k1_equals_native_counts():
    rng = np.random.default_rng(1)
    ocean = rng.random((4, 50)) < 0.7
    meas = rng.random((4, 50)) < 0.3
    cnt = sc.merge_blocks(ocean, meas, np.ones(4, dtype=np.int64), 1)
    assert (cnt[0] == ocean.sum(1)).all()
    assert (cnt[1] == (ocean & meas).sum(1)).all() and (cnt[2] == cnt[1]).all()


def brute(ocean, meas, k, s):
    n, W = ocean.shape
    out = np.zeros((3, n), dtype=np.int64)
    for g in range(n // s):
        rows = slice(g * s, (g + 1) * s)
        for c0 in range(0, W, k[g]):
            o = ocean[rows, c0:c0 + k[g]]
            m = meas[rows, c0:c0 + k[g]] & o
            per_row = o.sum(1)
            out[0, rows] += per_row
            if m.sum() > 0:
                out[1, rows] += per_row
            if 2 * m.sum() > o.sum():
                out[2, rows] += per_row
    return out


def test_matches_brute_force_with_mixed_k():
    rng = np.random.default_rng(7)
    for s in (1, 2, 4):
        n, W = 8 * s, 61
        ocean = rng.random((n, W)) < 0.8
        meas = rng.random((n, W)) < 0.25
        k = rng.integers(1, 9, n // s)
        assert (sc.merge_blocks(ocean, meas, k, s) == brute(ocean, meas, k, s)).all(), s


def test_strip_stats_conserves_ocean_area_near_the_pole():
    rng = np.random.default_rng(3)
    n, W = 16, 120                                     # rows 0..15 = 90 N .. 89.93 N, k capped at W
    ocean = rng.random((n, W)) < 0.9
    meas = rng.random((n, W)) < 0.1
    r = sc.strip_stats(ocean, meas, 0)
    band = sc.NBANDS - 1                               # 85-90 N
    for s in sc.SCALES:
        acc = r[f"ew{s}"]
        assert np.isclose(acc[0].sum(), r["native"][0].sum(), rtol=1e-12)
        assert acc[1, band] >= r["native"][1, band]          # "any" never below native
        assert acc[1, band] <= acc[0, band] + 1e-12

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from hypsometry import H_MIN, R_KM, land_at_or_above, levels, row_areas_km2  # noqa: E402


def test_row_areas_sum_to_sphere():
    # 1' global grid: every row's cell area times the row width sums to 4 pi R^2
    rows = row_areas_km2(90.0, 1 / 60, 1 / 60, 10800)
    assert np.isclose(rows.sum() * 21600, 4 * np.pi * R_KM**2, rtol=1e-12)
    assert rows[0] < rows[5400]  # polar cells are smaller than equatorial ones
    assert np.allclose(rows, rows[::-1])  # symmetric about the equator


def test_land_at_or_above_is_cumulative_from_the_top():
    hist = np.zeros(20001)
    hist[0 - H_MIN] = 2.0      # 2 km2 at exactly 0 m
    hist[-100 - H_MIN] = 3.0   # 3 km2 at -100 m
    hist[500 - H_MIN] = 1.0    # 1 km2 at +500 m
    got = land_at_or_above(hist, [-101, -100, -99, 0, 1, 500, 501])
    assert got.tolist() == [6.0, 6.0, 3.0, 3.0, 1.0, 1.0, 0.0]


def test_levels_dense_near_sea_level():
    lv = levels()
    assert np.all(np.diff(lv) > 0)
    assert set(range(-500, 201)).issubset(set(lv.tolist()))
    assert lv[0] == -11000 and lv[-1] == 9000

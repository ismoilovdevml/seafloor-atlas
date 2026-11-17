"""Unit tests for the bracket arithmetic in pipeline/official_bracket.py (synthetic arrays, no data)."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import official_bracket as ob  # noqa: E402


def test_target_cells_match_mayer_2018_table2():
    assert ob.TARGET_M.tolist() == [100.0, 200.0, 400.0, 800.0]
    assert ob.DEPTH_EDGES_M == (1500.0, 3000.0, 5750.0)
    assert sum(ob.TABLE2_OCEAN_SHARE) == pytest.approx(1.0, abs=1e-9)


def test_depth_class_edges():
    d = np.array([-5.0, 0, 1499.9, 1500, 2999, 3000, 5749, 5750, 10994, 11500])
    assert ob.depth_class(d).tolist() == [0, 0, 0, 1, 1, 2, 2, 3, 3, 3]


def test_lower_credit_per_class_and_cap():
    # a 0.2145 km2 cell (463 m x 463 m): 100 m -> 0.01/0.2145, 200 m -> 0.04/0.2145, 400 m -> 0.16/0.2145, 800 m capped
    c = ob.lower_credit(np.array([0.2145, 0.1]))
    assert c[0].tolist() == pytest.approx([0.01 / 0.2145, 0.04 / 0.2145, 0.16 / 0.2145, 1.0])
    assert c[1].tolist() == pytest.approx([0.1, 0.4, 1.0, 1.0])       # small (high-latitude) cell: 400 m also capped


def test_bracket_arithmetic_per_depth_class():
    # two rows, cell areas 0.2 and 0.1 km2
    area = np.array([0.2, 0.1])
    ocean = np.array([[10, 10, 10, 10],
                      [20, 0, 0, 0]])
    meas = np.zeros((2, 4, 2), dtype=np.int64)
    meas[0, 0] = [2, 3]       # row 0, 0-1500 m: 2 single-beam-type cells, 3 multibeam/combination cells
    meas[0, 3] = [1, 0]       # row 0, deep: 1 other-code cell (800 m target > cell -> credit 1 in every variant)
    meas[1, 0] = [0, 4]       # row 1, shallow: 4 multibeam cells
    b = ob.bracket(ocean, meas, area)
    assert b["ocean_km2"] == pytest.approx(40 * 0.2 + 20 * 0.1)
    up = 6 * 0.2 + 4 * 0.1
    assert b["upper_km2"] == pytest.approx(up)
    lo = 5 * 0.2 * (0.01 / 0.2) + 1 * 0.2 + 4 * 0.1 * (0.01 / 0.1)    # one 100 m cell per shallow cell, deep in full
    assert b["lower_km2"] == pytest.approx(lo)
    mx = 3 * 0.2 + 2 * 0.2 * (0.01 / 0.2) + 1 * 0.2 + 4 * 0.1          # TID 11/17 in full
    assert b["mixed_km2"] == pytest.approx(mx)
    assert b["lower"] <= b["mixed"] <= b["upper"]
    assert b["upper"] == pytest.approx(up / 10.0)
    assert sum(b["upper_km2_by_class"]) == pytest.approx(b["upper_km2"])
    assert b["lower_km2_by_class"][3] == pytest.approx(b["upper_km2_by_class"][3])   # 800 m class: no gap
    assert b["full_code_km2"] == pytest.approx(3 * 0.2 + 4 * 0.1)


def test_where_labels():
    assert ob.where(0.30, 0.20, 0.29, 0.31) == "mixed-upper"
    assert ob.where(0.25, 0.20, 0.29, 0.31) == "lower-mixed"
    assert ob.where(0.35, 0.20, 0.29, 0.31) == "above upper"
    assert ob.where(0.10, 0.20, 0.29, 0.31) == "below lower"

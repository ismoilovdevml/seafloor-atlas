import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from disagree import DATA_STEP, wquantiles  # noqa: E402


def test_weighted_quantiles_of_whole_metres_are_not_shifted_by_half_a_bin():
    # integer inputs: the middle of bin [11, 12) used to report 11.5
    assert wquantiles(np.array([10, 10, 11, 12, 40.0]), np.ones(5), (0.5,), 0, 100, 1.0) == [11.0]
    assert wquantiles(np.array([-3, -1, 0, 2.0]), np.array([1, 1, 1, 1.0]), (0.25, 0.75), -100, 100, 1.0) == [-3.0, 0.0]


def test_weighted_quantiles_on_the_decimetre_grid_of_aust_minus_gebco():
    # AUST is stored in 0.1 m steps, so differences such as 60.3 occur; float32 noise must not move them to a
    # neighbouring bin, and the result is the data value itself (whole-metre bins gave 60.0 or 60.5)
    v = np.array([60.1, 60.3, 60.4, 402.7], dtype=np.float32)
    assert DATA_STEP == 0.1
    assert wquantiles(v, np.ones(4), (0.5, 0.99), 0, 15000, DATA_STEP) == [60.3, 402.7]
    assert wquantiles(-v, np.ones(4), (0.5,), -15000, 15000, DATA_STEP) == [-60.4]   # sorted: -402.7, -60.4, ...
    # weights move the median
    assert wquantiles(v, np.array([1, 1, 1, 10.0]), (0.5,), 0, 15000, DATA_STEP) == [402.7]

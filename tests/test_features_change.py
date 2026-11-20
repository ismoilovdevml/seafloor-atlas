"""Unit tests for the gazetteer depth window (pipeline/features.py) and the 2025->2026 change masks
(pipeline/change.py). Synthetic inputs, no data files."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import change  # noqa: E402
import features  # noqa: E402


def test_window_min_wraps_across_the_antimeridian():
    elev = np.zeros((10, 100), dtype=np.int16)
    elev[5, 99] = -8000          # last column (just west of 180 E)
    assert features.window_min(elev, 5, 0) == -8000     # first column sees the last one (was clipped)
    assert features.window_min(elev, 5, 1) == -8000
    assert features.window_min(elev, 5, 2) == 0         # 3 columns away: outside +-2
    elev[5, 99], elev[5, 1] = 0, -7000
    assert features.window_min(elev, 5, 99) == -7000    # last column sees column 1 (was clipped)
    assert features.window_min(elev, 5, 98) == 0
    elev[0, 50] = -50
    assert features.window_min(elev, 1, 50) == -50      # rows clipped at the grid edge, no wrap
    assert features.window_min(elev, 9, 50) == 0


def test_change_masks_use_the_2026_tid_mask():
    sea = np.array([True, True, True, True, False])
    t25 = np.array([11, 11, 40, 11, 11], dtype=np.int16)
    t26 = np.array([11, 40, 11, 0, 11], dtype=np.int16)
    m = change.strip_masks(t25, t26, sea)
    # cell 3: measured in 2025 but TID 0 (land) in 2026 -> outside the ocean, not "no longer measured"
    assert m["ocean"].tolist() == [True, True, True, False, False]
    assert m["lost"].tolist() == [False, True, False, False, False]
    assert m["new"].tolist() == [False, False, True, False, False]
    assert m["m25"].tolist() == [True, True, False, False, False]

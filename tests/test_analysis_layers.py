"""Unit tests for the model-disagreement, seal and uncertainty layers (synthetic inputs, no data files)."""
import sys
from pathlib import Path

import numpy as np
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import disagree  # noqa: E402
import seals  # noqa: E402
import uncertainty  # noqa: E402


def test_disagree_colorize_transparent_below_threshold():
    v = disagree.colorize(np.array([[np.nan, 10.0, 49.9, 50.0, 1000.0, 5000.0]], dtype=np.float32))
    assert (v[0, :3, 3] == 0).all()                       # NaN and < 50 m -> transparent
    assert v[0, 3, 3] == disagree.ALPHA_MIN
    assert v[0, 4, 3] == disagree.ALPHA_MAX == v[0, 5, 3]  # clipped at vmax


def test_wquantiles_matches_numpy_for_equal_weights():
    rng = np.random.default_rng(0)
    x = rng.normal(0, 100, 100_000)
    q = disagree.wquantiles(x, np.ones_like(x), (0.5, 0.95), -1000, 1000, 1.0)
    assert abs(q[0] - np.median(x)) <= 1.0 and abs(q[1] - np.percentile(x, 95)) <= 1.0


def test_uncertainty_classes_follow_file_thresholds():
    v = uncertainty.colorize(np.array([[np.nan, 10.0, 79.9, 80.0, 150.0, 150.1]], dtype=np.float32))
    assert v[0, 0, 3] == 0
    a1, a2, a3 = (uncertainty.COLORS[k][1] for k in (1, 2, 3))
    assert list(v[0, 1:, 3]) == [a1, a1, a2, a2, a3]


def _grid():
    # 15" grid, 40 x 80 cells, top-left at (lon 0, lat -60); a deep hole at row 20, col 40
    T = Affine(1 / 240, 0, 0.0, 0, -1 / 240, -60.0)
    E = np.full((40, 80), -100, dtype=np.int16)
    E[20, 40] = -900
    return E, T


def test_seal_bilinear_is_exact_at_cell_centres():
    E, T = _grid()
    lat = np.array([-60 - (20 + 0.5) / 240])
    lon = np.array([(40 + 0.5) / 240])
    assert abs(seals.bilinear(E, 0, T, lat, lon)[0] + 900) < 1e-6


def test_seal_deepest_within_box_finds_nearby_hole():
    E, T = _grid()
    # a dive 3 cells (~1.4 km N-S) north of the hole
    lat = np.array([-60 - (17 + 0.5) / 240] * 2)
    lon = np.array([(40 + 0.5) / 240] * 2)
    r_km = np.array([0.2, 2.0])                    # too small to reach the hole / large enough
    out = seals.deepest_within(E, 0, T, lat, lon, r_km)
    assert out[0] == -100 and out[1] == -900

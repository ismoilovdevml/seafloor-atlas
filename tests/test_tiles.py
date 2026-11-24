import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from tiles import LOW_LAND_ALPHA, VEIL_MAX, down2, terrarium, unterrarium, veil  # noqa: E402


def test_terrarium_roundtrip_integer_and_fraction():
    h = np.array([[-10935.0, -4000.5, 0.0], [8848.0, -0.25, -32768.0]], dtype=np.float32)
    back = unterrarium(terrarium(h))
    assert np.max(np.abs(back - h)) <= 1 / 512 + 1e-9


def test_terrarium_survives_lossless_webp():
    rng = np.random.default_rng(0)
    h = rng.uniform(-11000, 9000, size=(64, 64)).astype(np.float32)
    buf = io.BytesIO()
    Image.fromarray(terrarium(h)).save(buf, "WEBP", lossless=True, quality=100)
    rgb = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))
    assert np.max(np.abs(unterrarium(rgb) - h)) <= 1 / 512 + 1e-6


def test_veil_alpha_and_land():
    f = np.array([[np.nan, 0.0, 1.0, 0.5]], dtype=np.float32)
    v = veil(f)
    assert v[0, 0, 3] == 0                      # land transparent
    assert v[0, 1, 3] == VEIL_MAX               # unmeasured -> full veil
    assert v[0, 2, 3] == 0                      # fully measured -> clear
    assert v[0, 3, 3] == round(VEIL_MAX * 0.5)


def test_down2_nan_aware():
    a = np.array([[1, np.nan], [3, np.nan]], dtype=np.float32)
    assert down2(a)[0, 0] == 2.0
    assert np.isnan(down2(np.full((2, 2), np.nan, dtype=np.float32))[0, 0])


def test_new_layer_alpha():
    from tiles import new_layer
    v = new_layer(np.array([[np.nan, 0.0, 0.1, 1.0]], dtype=np.float32))
    assert v[0, 0, 3] == 0 and v[0, 1, 3] == 0      # nothing new -> transparent
    assert 80 < v[0, 2, 3] < 255                    # thin line still visible
    assert v[0, 3, 3] == 255


def test_blend_poles_makes_edge_rows_constant():
    from tiles import blend_poles, row_latitudes
    rng = np.random.default_rng(1)
    a = rng.uniform(-5000, -1000, size=(512, 64)).astype(np.float32)
    a[300, :5] = np.nan
    blend_poles(a, -3175.0, 2585.0)
    assert np.ptp(a[0]) < 1.0 and abs(a[0].mean() + 3175) < 1.0      # north edge row = cap
    assert np.ptp(a[-1]) < 1.0 and abs(a[-1].mean() - 2585) < 1.0    # south edge row = cap
    lat = row_latitudes(512)
    mid = np.abs(lat) < 80
    assert np.isnan(a[300, :5]).all()                                  # untouched away from the poles


def test_blend_poles_nan_cap_clears_edge():
    from tiles import blend_poles
    a = np.full((512, 8), 0.4, dtype=np.float32)
    blend_poles(a, float("nan"), 0.2)
    assert np.isnan(a[0]).all() and abs(a[-1].mean() - 0.2) < 1e-3


def test_blend_poles_leaves_real_arctic_data_alone():
    # regression: an 82 deg band once flattened the Gakkel Ridge rift (84.7 N) towards the cap mean
    from tiles import BLEND_FROM, blend_poles, row_latitudes
    a = np.full((16384, 4), -5300.0, dtype=np.float32)
    blend_poles(a, -3175.0, 2585.0)
    lat = row_latitudes(16384)
    assert np.all(a[np.abs(lat) < BLEND_FROM] == -5300.0)
    assert abs(a[0].mean() + 3175) < 1e-3
    # 64 outermost rows exact -> top 2 rows of every lower zoom (2x2 means down to z0) are exact too
    assert np.all(a[:64] == -3175.0) and np.all(a[-64:] == 2585.0)


def test_fill_nearest_uses_neighbours_not_the_tile_mean():
    from tiles_hires import fill_nearest
    a = np.full((4, 6), -5000.0, dtype=np.float32)
    a[:, 3:] = -100.0
    a[1, 2] = np.nan            # next to the -5000 side
    a[2, 4] = np.nan            # inside the -100 side
    f = fill_nearest(a)
    assert f[1, 2] == -5000.0 and f[2, 4] == -100.0
    assert not np.isnan(f).any()
    b = np.full((2, 2), np.nan, dtype=np.float32)
    assert np.isnan(fill_nearest(b)).all()


def test_veil_reserves_alpha_1_for_land_below_sea_level():
    f = np.array([[np.nan, np.nan, 1 - 0.8 / VEIL_MAX, 1 - 1.2 / VEIL_MAX, 0.5]], np.float32)
    low = np.array([[1.0, 0.0, 0.0, 0.0, 1.0]], np.float32)
    a = veil(f, low)[0, :, 3]
    assert a[0] == LOW_LAND_ALPHA                 # low land
    assert a[1] == 0                              # ordinary land
    assert a[2] == 0 and a[3] == 2                # ocean never lands on the reserved alpha
    assert a[4] == round(VEIL_MAX * 0.5)          # ocean pixels ignore the low-land share
    assert LOW_LAND_ALPHA not in veil(np.linspace(0, 1, 5001, dtype=np.float32)[None, :])[0, :, 3]

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from tiles import VEIL_MAX, down2, terrarium, unterrarium, veil  # noqa: E402


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

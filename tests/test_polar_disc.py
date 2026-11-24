import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from polar import count_empty, disc_mask, pixel_latlon  # noqa: E402


def test_disc_mask_holds_the_pixels_within_the_radius():
    for north in (True, False):
        m = disc_mask(64, north, radius=7.0)
        lat, _ = pixel_latlon(64, north, radius=7.0)
        assert np.array_equal(m, np.abs(lat) >= 83.0)
        # the inscribed circle covers pi/4 of the square
        assert abs(m.mean() - np.pi / 4) < 0.02


def test_empty_count_ignores_the_corners_outside_the_disc():
    m = disc_mask(64, True, radius=7.0)
    g = np.zeros((64, 64))
    g[~m] = np.nan                      # every corner pixel empty: not counted
    assert count_empty(g, m) == 0
    inside = np.argwhere(m)[:5]
    g[tuple(inside.T)] = np.nan         # five empty pixels inside the disc
    assert count_empty(g, m) == 5

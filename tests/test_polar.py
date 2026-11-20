import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from polar import bin_average, pixel_latlon, polar_xy  # noqa: E402


def test_pixel_centres_round_trip_through_the_grid_mapping():
    for north in (True, False):
        lat, lon = pixel_latlon(64, north, radius=7.0)
        X, Y = polar_xy(lat, lon, north)
        c = (np.arange(64) + 0.5) * 14 / 64 - 7.0
        assert np.allclose(X, c[None, :], atol=1e-9) and np.allclose(Y, -c[:, None], atol=1e-9)
        assert np.all(np.abs(lat) >= 90 - 7.0 * np.sqrt(2) - 1e-9)


def test_orientation_north_and_south():
    # north: lon 0 lies below the pole (row index grows), lon 90 E to the right; south: lon 0 above the pole
    lat, lon = pixel_latlon(2, True, radius=1.0)
    assert lon[1, 0] < 0 < lon[1, 1] and abs(lon[1, 0] + 45) < 1e-9          # bottom-left -45, bottom-right +45
    lat, lon = pixel_latlon(2, False, radius=1.0)
    assert abs(lon[0, 1] - 45) < 1e-9 and np.all(lat < -88)


def test_bin_average_is_area_weighted_and_leaves_empty_pixels_nan():
    lat = np.array([89.0, 89.0, 85.0])
    lon = np.array([0.0, 0.0, 90.0])
    z = np.array([-1000.0, -3000.0, 50.0])
    g = bin_average(lat, lon, z, 8, True, radius=5.5)
    assert abs(np.nanmin(g) + 2000.0) < 1e-9 and abs(np.nanmax(g) - 50.0) < 1e-9
    assert np.isnan(g).sum() == 64 - 2

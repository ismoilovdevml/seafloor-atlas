import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import chlorophyll as chl  # noqa: E402
import flow  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def test_encode_uv_round_trip_sign_and_fill():
    u = np.array([[np.nan, -1.234, 0.0], [2.5, -0.001, 3.0]])
    v = np.array([[1.0, 0.5, np.nan], [-2.5, 0.001, -3.0]])
    blob = flow.encode_uv(u, v, 0.001)
    uu, vv = flow.decode_uv(blob, u.shape, 0.001)
    bad = ~(np.isfinite(u) & np.isfinite(v))           # a cell is no data in both components together
    assert np.all(np.isnan(uu[bad])) and np.all(np.isnan(vv[bad]))
    assert np.max(np.abs(uu[~bad] - u[~bad])) <= 0.0005 + 1e-9
    assert np.max(np.abs(vv[~bad] - v[~bad])) <= 0.0005 + 1e-9
    with pytest.raises(ValueError):
        flow.encode_uv(np.array([40.0]), np.array([0.0]), 0.001)


def test_grid_coords():
    lat, lon = flow.grid_coords("wind")
    assert lat[0] == 89.5 and lat[-1] == -89.5 and lon[0] == -179.5 and lon[-1] == 179.5
    lat, lon = flow.grid_coords("currents")
    assert lat[0] == 89.75 and lat[-1] == -89.75 and lat.size == 719
    assert lon[0] == -180.0 and lon[-1] == 179.75 and lon.size == 1440


def test_to_served_orientation():
    lat_s, lon_s = flow.oscar_coords()                  # OSCAR: rows south -> north, columns 0..359.75 E
    LON, LAT = np.meshgrid(lon_s, lat_s)
    lat, lon = flow.grid_coords("currents")
    assert np.allclose(flow.to_served(LAT)[:, 0], lat)
    assert np.allclose(np.mod(flow.to_served(LON)[0] + 180, 360) - 180, lon)


def test_chl_log_encoding_and_block_mean():
    lg = np.array([[np.nan, -3.0, -1.5], [0.0, 1.3, 2.0]])
    back = chl.decode_log(chl.encode_log(lg))
    assert np.isnan(back[0, 0])
    assert np.nanmax(np.abs(back - lg)) <= chl.STEP / 2 + 1e-9
    a = np.full((6, 6), np.nan, np.float32)
    a[:3, :3] = [[0.1, 1.0, 10.0], [np.nan] * 3, [np.nan] * 3]   # 3 valid of 9 -> geometric mean 1.0
    a[3:, 3:] = 0.5
    a[4, 4] = np.nan                                              # 8 valid of 9
    m = chl.block_log_mean(a)
    assert m[0, 0] == pytest.approx(0.0, abs=1e-6)
    assert np.isnan(m[0, 1]) and np.isnan(m[1, 0])
    assert m[1, 1] == pytest.approx(np.log10(0.5), abs=1e-6)


built = pytest.mark.skipif(not (ROOT / "web/public/flow/currents/manifest.json").exists()
                           or not (ROOT / "web/public/chl/manifest.json").exists(), reason="layers not built")


@built
def test_built_flow_spot_values():
    # trade winds and the Indian monsoon reversal
    u, v, _ = flow.speed_at("wind", "annual", -40, 15)
    assert u < -4 and 5 < np.hypot(u, v) < 9
    u1, v1, _ = flow.speed_at("wind", "01", 62, 12)
    u7, v7, _ = flow.speed_at("wind", "07", 62, 12)
    assert u1 < 0 and v1 < 0 and u7 > 5 and v7 > 0 and np.hypot(u7, v7) > 9
    # Southern Ocean westerlies
    u, _, _ = flow.speed_at("wind", "annual", 90, -50)
    assert u > 7
    # western boundary currents and the ACC
    assert flow.speed_at("currents", "annual", -77, 32, 4)[2] > 1.0
    # Kuroshio: the 2017-2025 Large Meander spreads the climatological jet; annual peak ~0.9, monthly > 1
    assert flow.speed_at("currents", "annual", 140, 33, 8)[2] > 0.8
    assert max(flow.speed_at("currents", f"{m:02d}", 140, 33, 8)[2] for m in range(1, 13)) > 1.0
    assert flow.speed_at("currents", "07", 51, 8, 1)[1] > 0.4 > -0.1 > flow.speed_at("currents", "01", 51, 8, 1)[1]
    assert flow.speed_at("currents", "annual", 140, -52, 2)[0] > 0.05
    # land is no data in the currents grid, not zero
    assert np.isnan(flow.speed_at("currents", "annual", 20, 0)[0])         # central Africa
    for name in ("wind", "currents"):
        m = json.loads((ROOT / f"web/public/flow/{name}/manifest.json").read_text())
        assert set(m["layers"]) == {f"{i:02d}" for i in range(1, 13)} | {"annual"}


@built
def test_built_chl_spot_values():
    assert chl.value_at("annual", -78, -10, 4) > 1.0                       # Peru upwelling
    assert chl.value_at("annual", 13.5, -23, 4) > 1.0                      # Benguela
    assert chl.value_at("annual", -120, -25, 4) < 0.05                     # South Pacific gyre
    assert chl.value_at("05", -25, 50, 4) > 2 * chl.value_at("01", -25, 50, 4)   # North Atlantic spring bloom
    assert np.isnan(chl.value_at("annual", 20, 0))                         # land

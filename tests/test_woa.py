import json
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import woa  # noqa: E402


def test_quantise_u16_round_trip_and_no_data():
    a = np.array([[np.nan, -1.9, 0.0], [10.0, 31.5, np.nan]], dtype=np.float32)
    step = woa.MAP_STEP["t"]
    q, lo = woa.quantise_u16(a, step)
    assert q.dtype == np.uint16
    assert q[0, 0] == 0 and q[1, 2] == 0            # no data -> 0
    assert q[0, 1] == 1                             # the minimum -> 1
    back = woa.dequantise_u16(woa.from_byte_planes(woa.byte_planes(q), q.shape), lo, step)
    ok = np.isfinite(a)
    assert np.all(np.isnan(back[~ok]))
    assert np.max(np.abs(back[ok] - a[ok])) <= step / 2 + 1e-6
    with pytest.raises(ValueError):
        woa.quantise_u16(np.array([0.0, 700.0]), 0.01)  # 70,000 steps do not fit


def test_encode_i16_round_trip_and_range():
    a = np.array([np.nan, -1.95, 0.0, 30.123, 40.0])
    q = woa.encode_i16(a, woa.COL_OFFSET["t"])
    assert q[0] == woa.COL_FILL
    back = woa.decode_i16(q, woa.COL_OFFSET["t"])
    assert np.isnan(back[0])
    assert np.allclose(back[1:], a[1:], atol=woa.COL_SCALE / 2 + 1e-9)
    with pytest.raises(ValueError):
        woa.encode_i16(np.array([50.0]), woa.COL_OFFSET["t"])  # 10 + 32.767 is the int16 ceiling


def test_north_up_flips_rows_only():
    a = np.arange(12).reshape(1, 3, 4)
    b = woa.north_up(a)
    assert b[0, 0].tolist() == a[0, 2].tolist() and b[0, 2].tolist() == a[0, 0].tolist()


def test_sigma0_against_reference_densities():
    # IAPWS-08 / TEOS-10 check value: rho(SA = 35.16504 g/kg, t = 0 degC, p = 0 dbar) = 1028.10633 kg/m3.
    # Practical salinity 35 in the open North Atlantic is SA ~ 35.165 + a small absolute-salinity anomaly.
    s0 = woa.sigma0(np.array([0.0]), np.array([35.0]), 0.0, np.array([-30.0]), np.array([30.0]))[0]
    assert abs(s0 - 28.10633) < 0.02
    # UNESCO EOS-80 check value rho(S = 35, T = 5 degC, p = 0) = 1027.67547; TEOS-10 agrees to ~0.01 kg/m3
    s5 = woa.sigma0(np.array([5.0]), np.array([35.0]), 0.0, np.array([-30.0]), np.array([30.0]))[0]
    assert abs(s5 - 27.67547) < 0.02


def test_sigma0_is_potential_density_not_in_situ():
    # the same water parcel at 4,000 m: in-situ density is ~18 kg/m3 higher, sigma0 must barely change
    # (only through the adiabatic cooling of in-situ temperature: t at depth is warmer than potential t)
    lon, lat = np.array([-30.0]), np.array([0.0])
    shallow = woa.sigma0(np.array([2.0]), np.array([34.9]), 0.0, lon, lat)[0]
    deep = woa.sigma0(np.array([2.0]), np.array([34.9]), 4000.0, lon, lat)[0]
    assert 0 < deep - shallow < 0.1  # same in-situ t at depth = colder potential t = slightly denser
    assert 27.7 < shallow < 27.9     # North Atlantic Deep Water range


def test_chunk_layout_matches_contract():
    # [var][level][row][col] int16 little endian, decoded the way the viewer does it
    n, nl = 3, 4
    rng = np.random.default_rng(1)
    t = rng.uniform(-2, 30, (nl, n, n))
    t[2:, 1, 1] = np.nan
    parts = [woa.encode_i16(t, woa.COL_OFFSET["t"])] * 3
    raw = np.stack(parts).astype("<i2").tobytes()
    a = np.frombuffer(zlib.decompress(woa.deflate(raw)), "<i2").reshape(3, nl, n, n)
    col = woa.decode_i16(a[0, :, 1, 1].copy(), woa.COL_OFFSET["t"])
    assert np.allclose(col[:2], t[:2, 1, 1], atol=6e-4) and np.isnan(col[2:]).all()


BUILT = woa.OUT / "manifest.json"


@pytest.mark.skipif(not BUILT.exists(), reason="web/public/woa not built (pipeline/woa.py build)")
def test_built_files_match_manifest_and_known_oceanography():
    man = json.loads(BUILT.read_text())
    assert man["period"] == "1991-2020"
    for key, L in man["map"]["layers"].items():
        p = woa.OUT / "map" / f"{key}.bin"
        assert p.stat().st_size == L["bytes"]
    raw = zlib.decompress((woa.OUT / "map" / "t_0.bin").read_bytes())
    assert len(raw) == 2 * 1440 * 720
    # science spot checks (the same numbers `woa.py check` prints)
    assert 28.5 < woa.map_value("t_0", 150.0, 0.0) < 30.5          # West Pacific warm pool
    assert woa.map_value("t_0", -45.0, -74.0) < -1.0               # Weddell shelf, near freezing
    assert 1.0 < woa.map_value("t_4000", -150.0, 30.0) < 2.0       # deep North Pacific
    assert woa.map_value("s_0", -45.0, 25.0) > 37.0                # subtropical North Atlantic
    assert woa.map_value("s_0", 89.5, 19.5) < 33.0                 # Bay of Bengal
    med = woa.map_value("s_1000", -12.0, 37.0)
    west = woa.map_value("s_1000", -60.0, 37.0)
    assert med > 35.6 and med - west > 0.5                          # Mediterranean outflow tongue at 1,000 m
    c = woa.column_at(-20.5, 30.5)
    ok = np.isfinite(c["t"])
    assert ok[0] and c["depth"][ok][-1] >= 4000
    assert np.all(np.diff(c["d"][ok]) > -0.01)                     # stably stratified column

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


def test_bottom_fields_take_the_deepest_level_with_both_variables():
    depths = np.array([0.0, 100.0, 1000.0, 4000.0])
    nan = np.nan
    # 3 cells: full column; T missing at the last level (S present); land (no data)
    T = np.array([[[20.0, 20.0, nan]], [[10.0, 10.0, nan]], [[4.0, 4.0, nan]], [[1.0, nan, nan]]], np.float32)
    S = np.array([[[35.0, 35.0, nan]], [[35.0, 35.0, nan]], [[34.9, 34.9, nan]], [[34.7, 34.7, nan]]], np.float32)
    # two slabs, as fetch_bottom stores them
    slabs = [(0, T[:2], S[:2]), (2, T[2:], S[2:])]
    tb, sb, zb = woa.bottom_fields(iter(slabs), depths)
    assert tb[0].tolist()[:2] == [1.0, 4.0]
    assert zb[0].tolist()[:2] == [4000.0, 1000.0]   # second cell stops where T stops
    assert sb[0, 1] == pytest.approx(34.9)
    assert np.isnan(tb[0, 2]) and np.isnan(zb[0, 2])


def test_bottom_properties_theta_cooler_than_in_situ_and_sigma4_only_deep():
    t = np.array([2.0, 2.0, 15.0])
    s = np.array([34.9, 34.9, 35.5])
    z = np.array([5000.0, 2500.0, 500.0])
    lon = np.zeros(3)
    lat = np.full(3, -40.0)
    theta, sig4 = woa.bottom_properties(t, s, z, lon, lat)
    # adiabatic heating: in-situ 2 degC at 5,000 m is ~0.4 degC warmer than its potential temperature
    assert 0.3 < t[0] - theta[0] < 0.6
    assert t[1] - theta[1] < t[0] - theta[0]
    # sigma4 of abyssal water is ~45-46 kg/m3; the 500 m bottom gets none
    assert 45.0 < sig4[0] < 46.5 and 45.0 < sig4[1] < 46.5
    assert np.isnan(sig4[2])


def test_deep_range_ignores_shallow_cells():
    a = np.array([0.1, 0.5, 1.0, 1.5, 2.0, 25.0, 28.0])
    z = np.array([5000, 5000, 4000, 4000, 3000, 50, 20.0])
    lo, hi = woa.deep_range(a, z, 0.01)
    assert lo <= 0.1 and 2.0 <= hi < 3.0     # warm shelf water does not stretch the scale


def test_seafloor_layers_when_built():
    man_p = Path(woa.OUT) / "manifest.json"
    man = json.loads(man_p.read_text())
    if "bottom" not in man["map"]:
        pytest.skip("seafloor layers not built (woa.py fetch-bottom + bottom)")
    for k in ("t_bottom", "s_bottom", "d_bottom", "z_bottom"):
        assert (Path(woa.OUT) / "map" / f"{k}.bin").exists()
        assert man["map"]["layers"][k]["ocean_cells"] > 0
    # Antarctic Bottom Water: the Weddell Sea floor is colder than the Canary Basin floor and denser in sigma4
    assert woa.map_value("t_bottom", -30.0, -65.0) < 0.0 < woa.map_value("t_bottom", -25.0, 30.0)
    assert woa.map_value("d_bottom", -30.0, -65.0) > woa.map_value("d_bottom", -25.0, 30.0)


def test_despike_removes_isolated_and_patchy_artefacts_but_keeps_fronts():
    a = np.full((16, 24), 4.0)
    a[:, 12:] = 15.0                                 # a sharp but real 11 degC front between two wide water masses
    a[3, 3] = 44.0                                   # one spike in cold water
    a[10:12, 4:6] = [[19.4, 42.8], [43.1, 20.0]]     # a patch that would hide behind itself in a 3 x 3 window
    out, n = woa.despike(a)
    assert np.isnan(out[3, 3]) and np.isnan(out[10:12, 4:6]).all()
    assert np.isfinite(out[:, 9:]).all()             # both sides of the front kept
    assert n == 5

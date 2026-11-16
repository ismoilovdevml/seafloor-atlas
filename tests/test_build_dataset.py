"""Fast tests for pipeline/build_dataset.py: per-cell record logic and area sums on tiny synthetic arrays."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import build_dataset as bd  # noqa: E402
import history  # noqa: E402


def test_record_from_bits_examples():
    # never; 2019 only; 2026 only; all; 2020+2021; 2019+2025; 2019+2026; land with stray bits (ignored)
    bits = np.array([[0, 0b1, 0b10000000, 0b11111111],
                     [0b00000110, 0b01000001, 0b10000001, 0b10000001]], dtype=np.uint8)
    ocean = np.array([[1, 1, 1, 1], [1, 1, 1, 0]], dtype=bool)
    r = bd.record_from_bits(bits, ocean)
    assert r["first"].tolist() == [[-1, 2019, 2026, 2019], [2020, 2019, 2019, -1]]
    assert r["last"].tolist() == [[-1, 2019, 2026, 2026], [2021, 2025, 2026, -1]]
    assert r["n"].tolist() == [[0, 1, 1, 8], [2, 2, 2, -1]]
    assert r["latest"].tolist() == [[0, 0, 1, 1], [0, 0, 1, -1]]
    assert r["recoded"].tolist() == [[0, 1, 0, 0], [1, 1, 0, -1]]
    assert r["first"].dtype == np.int16 and r["n"].dtype == np.int8


def test_lut_agrees_with_history_first_code_for_all_bitmasks():
    b = np.arange(256, dtype=np.uint8)
    r = bd.record_from_bits(b, np.ones(256, bool))
    code = history.first_code(b).astype(int)
    assert np.array_equal(np.where(code > 0, 2000 + code % 100, -1), r["first"])
    assert np.array_equal((code >= history.RECODED).astype(np.int8), r["recoded"])
    assert np.array_equal(np.unpackbits(b[:, None], axis=1).sum(axis=1), r["n"])
    # last >= first, recoded <=> measured before 2026 but not in 2026
    m = r["first"] > 0
    assert (r["last"][m] >= r["first"][m]).all()
    assert np.array_equal(r["recoded"] == 1, (r["n"] > 0) & (r["latest"] == 0))


def test_global_sums_bookkeeping():
    rng = np.random.default_rng(1)
    bits = rng.integers(0, 256, size=(6, 9), dtype=np.uint8)
    ocean = rng.random((6, 9)) > 0.2
    area = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    s = bd.global_sums(bits, ocean, area)
    m = [(((bits >> i) & 1) == 1) & ocean for i in range(bd.NY)]
    for i in range(bd.NY):
        assert np.isclose(s["measured"][i], (m[i] * area[:, None]).sum())
        if i:
            # m(y) = m(y-1) + new - re-coded away
            assert np.isclose(s["measured"][i], s["measured"][i - 1] + s["new_vs_previous"][i]
                              - s["recoded_away_vs_previous"][i])
    ever = np.any(m, axis=0)
    assert np.isclose(s["ever_measured"][-1], (ever * area[:, None]).sum())
    assert np.isclose(s["first_measured"].sum(), s["ever_measured"][-1])
    assert np.isclose(s["ocean"], (ocean * area[:, None]).sum())


def test_area_from_lat_bnds_matches_history_rows():
    # rows 0..3 of the 15" grid counted from the north = the last four ascending rows
    i = np.arange(bd.H15 - 4, bd.H15)
    bnds = np.stack([-90 + i / 240, -90 + (i + 1) / 240], axis=1)
    a = bd.area_from_lat_bnds(bnds, 1 / 240)[::-1]
    assert np.allclose(a, history.row_area_km2(0, 4), rtol=1e-12)


# ---------------------------------------------------------------- connectivity (inland_below_sea_level)

def _brute_inland(mask: np.ndarray) -> np.ndarray:
    """Reference: flood fill on the whole array, 8-connectivity, longitude wrap; largest component = world ocean."""
    h, w = mask.shape
    comp = np.full(mask.shape, -1)
    sizes = []
    for i0, j0 in zip(*np.nonzero(mask)):
        if comp[i0, j0] >= 0:
            continue
        k = len(sizes)
        stack, n = [(i0, j0)], 0
        comp[i0, j0] = k
        while stack:
            i, j = stack.pop()
            n += 1
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    ii, jj = i + di, (j + dj) % w
                    if 0 <= ii < h and mask[ii, jj] and comp[ii, jj] < 0:
                        comp[ii, jj] = k
                        stack.append((ii, jj))
        sizes.append(n)
    if not sizes:
        return np.zeros(mask.shape, bool)
    return mask & (comp != int(np.argmax(sizes)))


def test_inland_wrap_joins_across_180_degrees():
    m = np.zeros((6, 8), bool)
    m[:, 0] = m[:, 7] = True                     # one ocean, split by the edge of the array
    m[2:4, 3:5] = True                           # a lake
    inl = bd.inland_from_mask(m, strip=2)
    assert inl[:, [0, 7]].max() == 0             # both edge columns are the world ocean
    assert (inl[2:4, 3:5] == 1).all() and inl.astype(bool).sum() == 4


def test_inland_diagonal_contact_across_strip_and_wrap_edges():
    m = np.zeros((6, 8), bool)
    m[:3, 0] = True                              # ocean: rows 0-2 in column 0 ...
    m[3:, 7] = True                              # ... continue diagonally across 180 deg AND a strip edge (row 2|3)
    m[0, 4] = True                               # isolated cell -> inland
    inl = bd.inland_from_mask(m, strip=3)
    assert inl[:, [0, 7]].max() == 0
    assert inl[0, 4] == 1 and inl.astype(bool).sum() == 1


def test_inland_matches_flood_fill_on_random_masks():
    rng = np.random.default_rng(3)
    for strip in (1, 3, 4, 7):
        for _ in range(5):
            m = rng.random((12, 15)) < 0.45
            assert np.array_equal(bd.inland_from_mask(m, strip=strip) > 0, _brute_inland(m)), strip


def test_inland_ranks_follow_area():
    m = np.zeros((5, 10), bool)
    m[:, 0] = True                                # world ocean (5 cells)
    m[1, 3] = True                                # small lake (1 cell)
    m[1:3, 6:8] = True                            # larger lake (4 cells)
    area = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
    inl = bd.inland_from_mask(m, strip=2, area_row=area)
    assert (inl[1:3, 6:8] == 1).all() and inl[1, 3] == 2


def test_connect_mask_only_adds_connectivity():
    ocean = np.array([[True, False, False, True]])
    t26 = np.array([[11, 40, 0, 11]], dtype=np.int8)
    e15 = np.array([[-5, -3, -3, -5]], dtype=np.int16)
    assert bd.connect_mask(ocean, t26, e15).tolist() == [[True, True, False, True]]


def test_ellipsoid_area_total_and_sphere_bias():
    lat_bnds = np.stack([np.arange(-90, 90, 5.0), np.arange(-85, 95, 5.0)], axis=1)
    a_e = bd.ellipsoid_area_from_lat_bnds(lat_bnds, 360.0)
    assert np.isclose(a_e.sum(), 510_065_621.7, rtol=1e-8)          # WGS84 surface area
    a_s = bd.area_from_lat_bnds(lat_bnds, 360.0)
    assert np.isclose(a_s.sum(), a_e.sum(), rtol=1e-8)              # authalic sphere: same total area
    assert a_s[0] < a_e[0] and a_s[18] > a_e[18]                    # sphere too small near the poles, large at equator


def test_inland_name_lookup():
    assert bd.inland_name((36.5, 49.6, 44.4, 55.7)) == "Caspian Sea and Caspian Depression"
    assert bd.inland_name((0.0, 1.0, 0.0, 1.0)) == ""

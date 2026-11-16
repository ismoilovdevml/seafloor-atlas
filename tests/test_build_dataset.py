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

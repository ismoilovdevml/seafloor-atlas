import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import blindtest as bt  # noqa: E402

H, W = 32, 64                     # tiny 15" grid; 1' distance grid is (8, 16); map is (2, 4)
KEY = f"{bt.PAIRS[0][0]}_{bt.PAIRS[0][1]}"
CLS = bt.classes()


def synthetic(bias=120, seed=0):
    rng = np.random.default_rng(seed)
    zb = -rng.integers(100, 5900, size=(H, W)).astype(np.int16)
    za = zb.copy()
    ta = np.full((H, W), 40, dtype=np.int16)
    tb = np.full((H, W), 40, dtype=np.int16)
    new = np.zeros((H, W), dtype=bool)
    new[:, :32] = True                                    # left half: TID 40 in a, measured (11) in b
    tb[new] = 11
    za[new] = zb[new] + bias                              # planted error: the prediction was too shallow
    ta[0:4, 40:48] = 11
    tb[0:4, 40:48] = 11                                   # measured in both, unchanged
    ta[4:8, 40:48] = 41
    tb[4:8, 40:48] = 17                                   # interpolated -> measured, exact
    ta[8:12, 40:48] = 0                                   # land in a: excluded
    ocean = np.ones((H, W), dtype=bool)
    ocean[12:16, 40:48] = False                           # inland basin: excluded
    za[~new & (ta == 40) & (tb == 40)] += 7               # the prediction changed by 7 m between releases
    dist = np.zeros((H // 4, W // 4), dtype=np.float32)
    dist[:, :4] = 0.0                                     # same 1' cell had data
    dist[:, 4:8] = 30.0                                   # 20-50 km
    dist[:, 8:] = 150.0
    return ta, tb, za, zb, ocean, dist, new


def run_acc(*args):
    ta, tb, za, zb, ocean, dist = args
    acc = bt.empty_acc(H, W)
    # two strips, as in the real run
    for r0 in (0, 16):
        s = slice(r0, r0 + 16)
        bt.strip_update(acc, KEY, r0, ta[s], tb[s], za[s], zb[s], ocean[s], dist[r0 // 4:(r0 + 16) // 4], h=H)
    return acc


def test_recovers_planted_bias_and_counts():
    ta, tb, za, zb, ocean, dist, new = synthetic(bias=120)
    acc = run_acc(ta, tb, za, zb, ocean, dist)
    st = bt.make_stats(acc)["pairs"][KEY]
    f40 = st["classes"]["new_from_40"]
    assert f40["n_cells"] == new.sum() == H * 32
    assert f40["bias_median_m"] == 120 and f40["bias_mean_m"] == 120
    assert f40["nmad_m"] == 0 and f40["share_estimate_too_shallow"] == 1.0
    assert st["classes"]["new_from_41"]["n_cells"] == 32 and st["classes"]["new_from_41"]["bias_median_m"] == 0
    assert st["classes"]["ctrl_meas_meas"]["n_cells"] == 32
    assert st["classes"]["ctrl_meas_meas"]["share_exact_zero"] == 1.0
    n_pp = H * 32 - 4 * 8 * 4                             # right half minus the four 4x8 special blocks
    assert st["classes"]["ctrl_pred_pred"]["n_cells"] == n_pp
    assert st["classes"]["ctrl_pred_pred"]["bias_median_m"] == 7
    # land in a and the inland block are in no class
    assert sum(v["n_cells"] for v in st["classes"].values() if v) == H * W - 2 * 32


def test_strata_bookkeeping():
    ta, tb, za, zb, ocean, dist, new = synthetic(bias=-80)
    acc = run_acc(ta, tb, za, zb, ocean, dist)
    st = bt.make_stats(acc)["pairs"][KEY]
    # distance: new cells sit in 1' columns 0-7 -> half "same 1' cell", half "20-50"
    dn = [d["n_cells"] if d else 0 for d in st["f40"]["dist"]]
    assert dn[0] == H * 16 and dn[bt.DIST_LABELS.index("20-50")] == H * 16 and sum(dn) == H * 32
    assert all(d is None or d["bias_median_m"] == -80 for d in st["f40"]["dist"])
    # destination code: all 11
    assert st["f40"]["to"]["11"]["n_cells"] == H * 32
    # depth strata add up and match a direct count
    depth = -zb[new]
    exp = np.histogram(depth, bins=bt.DEPTH_EDGES)[0]
    got = [d["n_cells"] if d else 0 for d in st["f40"]["depth"]]
    assert got == exp.tolist()
    # latitude: 32 rows of a 180-degree grid -> 5.625 degrees per row; every cell lands in a band
    assert sum(d["n_cells"] for d in st["f40"]["lat"] if d) == H * 32
    # pooled group holds 40 -> measured and 41 -> measured; the control group only TID 40 in both
    assert sum(d["n_cells"] for d in st["est"]["dist"] if d) == H * 32 + 32
    assert sum(d["n_cells"] for d in st["c40"]["dist"] if d) == st["classes"]["ctrl_pred_pred"]["n_cells"]
    # the error map only holds new_from_40 cells
    assert int(acc[f"{KEY}/map_n"].sum()) == H * 32
    assert np.isclose(acc[f"{KEY}/map_sum"].sum(), 80 * H * 32)


def test_missing_distance_goes_to_its_own_stratum():
    ta, tb, za, zb, ocean, dist, new = synthetic()
    dist[:, 0] = np.nan
    acc = run_acc(ta, tb, za, zb, ocean, dist)
    st = bt.make_stats(acc)["pairs"][KEY]
    assert st["f40"]["dist"][-1]["n_cells"] == H * 4


def test_hist_stats_robust_spread():
    rng = np.random.default_rng(3)
    d = np.rint(rng.normal(30, 50, 200_000)).astype(np.int64)
    h = np.zeros(bt.NB)
    np.add.at(h, np.clip(d, -bt.DMAX, bt.DMAX) + bt.DMAX, 1.0)
    s = bt.hist_stats(h, n=d.size)
    assert abs(s["bias_median_m"] - 30) <= 1
    assert abs(s["nmad_m"] - 50) < 2.5 and abs(s["iqr_sigma_m"] - 50) < 2.5
    assert abs(s["rms_m"] - np.sqrt(30 ** 2 + 50 ** 2)) < 1
    assert bt.hist_stats(np.zeros(bt.NB)) is None


def test_exact_zero_variant_drops_relabelled_cells():
    ta, tb, za, zb, ocean, dist, new = synthetic(bias=60)
    za[:8, :32] = zb[:8, :32]                             # a quarter of the new cells were already measured depths
    acc = run_acc(ta, tb, za, zb, ocean, dist)
    st = bt.make_stats(acc)["pairs"][KEY]
    assert st["classes"]["new_from_40"]["share_exact_zero"] == 0.25
    assert st["classes"]["new_from_40"]["bias_median_m"] == 60
    v = st["classes_excl_exact_zero"]["new_from_40"]
    assert v["share_exact_zero"] == 0 and v["bias_mean_m"] == 60 and v["nmad_m"] == 0

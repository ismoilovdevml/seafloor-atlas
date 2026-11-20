import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import distance  # noqa: E402
import history  # noqa: E402


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * history.R_KM * np.arcsin(np.sqrt(a))


def centre(r, c):
    return 90 - (r + 0.5) / 60, -180 + (c + 0.5) / 60


def brute(measured, query, row0, col0):
    mr, mc = np.nonzero(measured)
    mlat, mlon = centre(mr + row0, mc + col0)
    qr, qc = np.nonzero(query)
    out = []
    for r, c in zip(qr, qc):
        lat, lon = centre(r + row0, c + col0)
        out.append(haversine_km(lat, lon, mlat, mlon).min())
    return np.array(out)


def test_nearest_matches_brute_force_haversine():
    rng = np.random.default_rng(1)
    # mid latitude, the tropics and the polar cap (where 1' of longitude is short)
    for row0, col0 in ((2400, 5000), (5390, 12000), (0, 300)):
        m = rng.random((40, 60)) < 0.02
        m[0, 0] = True
        q = ~m
        got = distance.nearest_km(m, q, chunk=500, row0=row0, col0=col0)
        exp = brute(m, q, row0, col0)
        assert np.allclose(got, exp, rtol=1e-5, atol=1e-3), np.abs(got - exp).max()


def test_nearest_wraps_the_dateline():
    m = np.zeros((3, distance.W1), dtype=bool)
    m[1, 0] = True                                    # just east of 180 W
    q = np.zeros_like(m)
    q[1, -1] = True                                   # just west of 180 E: neighbours across the dateline
    q[1, distance.W1 // 2] = True                     # the antimeridian of the measurement
    got = distance.nearest_km(m, q, row0=5399)
    lat, _ = centre(5400, 0)
    one_min = haversine_km(lat, 0, lat, 1 / 60)
    # np.nonzero order: the antimeridian cell (column W1/2) first, then the last column
    assert abs(got[1] - one_min) < 1e-3               # ~1.85 km across the dateline, not ~20000 km
    assert abs(got[0] - haversine_km(lat, -180 + 0.5 / 60, lat, 0.5 / 60)) < 1e-2


def test_chord_to_km_limits():
    assert distance.chord_to_km(np.array([0.0]))[0] == 0
    assert abs(distance.chord_to_km(np.array([2.0]))[0] - np.pi * history.R_KM) < 1e-6


def test_cell_area_rows_sum_to_sphere():
    total = distance.cell_area_km2().sum() * distance.W1
    assert abs(total / (4 * np.pi * history.R_KM ** 2) - 1) < 1e-9


def test_weighted_quantiles_on_uniform_histogram():
    h = np.zeros(len(distance.HIST_EDGES_KM) - 1)
    j = int(np.searchsorted(distance.HIST_EDGES_KM, 10.0))     # one bin just above 10 km
    h[j] = 1.0
    lo, hi = distance.HIST_EDGES_KM[j], distance.HIST_EDGES_KM[j + 1]
    med, p90 = distance.weighted_quantiles(h, (0.5, 0.9))
    assert abs(med - (lo + 0.5 * (hi - lo))) < 1e-9
    assert abs(p90 - (lo + 0.9 * (hi - lo))) < 1e-9


def test_measured_majority_gives_a_zero_median_and_nothing_falls_off_the_top():
    d = np.array([0.0] * 6 + [0.4, 2.0, 30.0, 5000.0])          # 60 % measured, one cell beyond the old 3,000 km edge
    h, _ = np.histogram(d, bins=distance.HIST_EDGES_KM)
    assert h.sum() == d.size                                   # every value lands in a bin
    med, p75 = distance.weighted_quantiles(h.astype(float), (0.5, 0.75))
    assert med < 1e-6                                          # was ~0.83 km with a [0, 1) km first bin
    assert 0.3 < p75 < 2.5

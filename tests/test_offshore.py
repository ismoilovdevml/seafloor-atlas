import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))


def test_capacity_thousands_separators_and_decimal_commas():
    from offshore import capacity_mw
    assert capacity_mw("1,200 MW") == 1200.0      # was 1.2: the comma was read as a decimal comma
    assert capacity_mw("1 200 MW") == 1200.0
    assert capacity_mw("7,5 MW") == 7.5
    assert capacity_mw("1.2 GW") == 1200.0
    assert capacity_mw("12,000 kW") == 12.0
    assert capacity_mw("588") == 588.0
    assert capacity_mw(None) is None and capacity_mw("unknown") is None


def test_wind_status_uses_current_year_unless_pinned(monkeypatch):
    import datetime as dt

    import offshore
    this_year = dt.datetime.now(dt.timezone.utc).year
    assert offshore.year_now() == this_year
    assert offshore.wind_status({}, this_year + 1) == "construction"
    assert offshore.wind_status({}, this_year) == "operating"
    assert offshore.wind_status({}, None) == "operating"
    assert offshore.wind_status({"construction": "yes"}, 2001) == "construction"
    monkeypatch.setattr(offshore, "YEAR_NOW", 2026)
    assert offshore.year_now() == 2026
    assert offshore.wind_status({}, 2027) == "construction"
    assert offshore.wind_status({}, 2027, now=2027) == "operating"


def _offset(lon, lat, east_m, north_m):
    """lon/lat of a point east_m / north_m metres from (lon, lat) on the sphere (small offsets)."""
    import math
    r = 6371008.8
    return lon + math.degrees(east_m / (r * math.cos(math.radians(lat)))), lat + math.degrees(north_m / r)


def test_seamark_duplicates_use_true_distance_at_every_latitude_and_across_the_antimeridian():
    import numpy as np
    from offshore import seamark_duplicates
    cases = []
    for lat in (0.0, 30.0, 55.0, 70.0, 80.0, -60.0):
        for east in (80.0, 140.0):
            cases.append(((10.0, lat), _offset(10.0, lat, east, 0.0), east < 111))
    # across the antimeridian: 179.9995 E and 179.9995 W are 0.001 deg of longitude apart (~56 m at 60 N, ~111 m
    # at the equator); the old metric saw 359.999 deg
    cases.append(((179.9995, 60.0), (-179.9995, 60.0), True))
    cases.append(((179.999, 0.0), (-179.999, 0.0), False))                    # ~222 m at the equator
    for (a, b, dup) in cases:
        ll = np.array([b, a])                     # [seamark-only node, man_made element]
        got = seamark_duplicates(ll, np.array([True, False]))
        assert list(got) == [dup, False], (a, b, dup)
    # two seamark-only nodes (or two man_made elements) are never merged with each other
    ll = np.array([[3.0, 56.0], [3.0, 56.0]])
    assert not seamark_duplicates(ll, np.array([True, True])).any()
    assert not seamark_duplicates(ll, np.array([False, False])).any()
    assert not seamark_duplicates(np.zeros((0, 2)), np.zeros(0, bool)).any()

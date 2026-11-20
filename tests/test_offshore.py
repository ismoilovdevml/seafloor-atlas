

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

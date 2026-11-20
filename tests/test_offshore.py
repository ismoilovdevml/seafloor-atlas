

def test_capacity_thousands_separators_and_decimal_commas():
    from offshore import capacity_mw
    assert capacity_mw("1,200 MW") == 1200.0      # was 1.2: the comma was read as a decimal comma
    assert capacity_mw("1 200 MW") == 1200.0
    assert capacity_mw("7,5 MW") == 7.5
    assert capacity_mw("1.2 GW") == 1200.0
    assert capacity_mw("12,000 kW") == 12.0
    assert capacity_mw("588") == 588.0
    assert capacity_mw(None) is None and capacity_mw("unknown") is None

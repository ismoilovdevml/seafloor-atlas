import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from amoc import annual_means, summary  # noqa: E402


def test_annual_means_use_complete_years_only():
    months = [f"2004-{m:02d}" for m in range(4, 13)] + [f"2005-{m:02d}" for m in range(1, 13)] + ["2006-01"]
    v = np.arange(len(months), dtype=float)
    out = annual_means(months, v)
    assert [a["year"] for a in out] == [2005]                 # 2004 starts in April, 2006 has one month
    assert out[0]["mean"] == round(float(v[9:21].mean()), 2)
    v[12] = np.nan                                            # a gap makes the year incomplete
    assert annual_means(months, v) == []


def test_summary_reports_extremes_with_their_month():
    s = summary(["2010-01", "2010-02", "2010-03"], np.array([17.0, 6.7, 24.9]))
    assert s["min"] == {"sv": 6.7, "month": "2010-02"} and s["max"] == {"sv": 24.9, "month": "2010-03"}
    assert s["mean_sv"] == 16.2 and s["n_months"] == 3

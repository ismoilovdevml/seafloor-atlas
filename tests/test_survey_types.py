import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import survey_types as st  # noqa: E402


def test_groups_cover_every_direct_code_once():
    codes = [c for _, cs, _ in st.GROUPS for c in cs]
    assert sorted(codes) == list(range(10, 18))


def test_grouped_sums_equal_direct_total_and_match_readme():
    t = st.load()
    g = st.grouped(t)
    for i, y in enumerate(t):
        direct = sum(v for c, v in t[y].items() if 10 <= c <= 17)
        assert abs(sum(col[i] for col in g.values()) - direct) < 1e-9
        assert abs(sum(t[y].values()) - 100) < 0.01
    assert round(sum(v for c, v in t[2019].items() if 10 <= c <= 17), 1) == 12.4
    assert round(sum(v for c, v in t[2026].items() if 10 <= c <= 17), 1) == 30.8
    assert round(t[2026][11], 1) == 26.4

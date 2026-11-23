"""Fail-safe checks of pipeline/refresh_overlays.py and the name matching of pipeline/cables_osm.py."""
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

import refresh_overlays as ro  # noqa: E402

SPEC = {**ro.LAYERS["windfarms"], "min": 3}


def fc(n: int, **meta) -> dict:
    return {"type": "FeatureCollection",
            "metadata": {"attribution": ro.OSM_ATTR, "licence": "ODbL 1.0", **meta},
            "features": [{"type": "Feature", "properties": {"id": f"w{i}", "status": "operating", "depth_m": 20},
                          "geometry": {"type": "Point", "coordinates": [2.0 + i / 100, 54.0]}} for i in range(n)]}


def check(tmp_path, new: dict | str, old: dict | None = None, allow: bool = False) -> list[str]:
    p = tmp_path / "windfarms.geojson"
    p.write_text(new if isinstance(new, str) else json.dumps(new))
    return ro.validate(SPEC, p, old, allow)[1]


def test_good_file_passes(tmp_path):
    assert check(tmp_path, fc(10), fc(9)) == []


def test_empty_or_broken_file_fails(tmp_path):
    assert check(tmp_path, "")
    assert check(tmp_path, "{not json")
    assert check(tmp_path, {"type": "Feature"})
    assert any("minimum" in e for e in check(tmp_path, fc(2)))


def test_count_jump_needs_override(tmp_path):
    errs = check(tmp_path, fc(13), fc(10))
    assert any("+30%" in e for e in errs), errs
    assert any("-30%" in e for e in check(tmp_path, fc(7), fc(10)))
    assert check(tmp_path, fc(12), fc(10)) == []        # +20 % is still inside
    assert check(tmp_path, fc(13), fc(10), allow=True) == []


def test_schema_errors_are_reported(tmp_path):
    bad = fc(5)
    bad["metadata"]["attribution"] = "someone else"
    bad["features"][0]["geometry"] = {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}
    bad["features"][1]["geometry"]["coordinates"] = [200.0, 54.0]
    bad["features"][2]["properties"].pop("depth_m")
    bad["features"][3]["properties"]["id"] = "w4"
    errs = " | ".join(check(tmp_path, bad))
    for s in ("attribution", "allowed geometry", "invalid coordinates", "depth_m x1", "duplicate id"):
        assert s in errs, (s, errs)


def test_real_files_pass_their_own_checks():
    for name, spec in ro.LAYERS.items():
        p = ro.DATA / spec["file"]
        if p.exists():
            assert ro.validate(spec, p, json.loads(p.read_text()), False)[1] == [], name


def test_cable_name_matching():
    import cables_osm as c

    def match(osm: str, tg: str) -> bool:
        return bool(c.name_keys(osm, True) & c.name_keys(tg, False))

    assert match("SEA-ME-WE3 SEG 10.4", "SeaMeWe-3")
    assert match("Apollo South", "Apollo")
    assert match("FLAG Europe-Asia", "FLAG Europe-Asia (FEA)")
    assert match("AMITIE", "Amitié")
    assert match("Havfrue/AEC-2", "Havfrue/AEC-2")
    assert match("LION S2.1", "Lower Indian Ocean Network (LION)")
    assert not match("SEA ME WE2-S5", "SeaMeWe-3")
    assert not match("TAT 11", "TAT-14")
    assert not match("Segment 2", "Segment")
    assert c.after_snapshot("2024") and c.after_snapshot("2022-12") and not c.after_snapshot("2022-11")
    assert not c.after_snapshot(None) and not c.after_snapshot("1997")


def test_spec_copy_is_independent():
    s = copy.deepcopy(SPEC)
    s["min"] = 0
    assert ro.LAYERS["windfarms"]["min"] == 50


# ---------------------------------------------------------------- Overpass outages
import urllib.error  # noqa: E402

import offshore  # noqa: E402

OK = b'{"elements": [{"type": "node", "id": 1}]}'


def fake_post(script):
    """post() that answers from a list of (url-substring, result) rules; result = bytes or an exception."""
    calls = []

    def post(url, query, timeout):
        calls.append((url, query == offshore.PROBE))
        for key, res in script:
            if key in url:
                if isinstance(res, Exception):
                    raise res
                return res
        raise AssertionError(url)
    return post, calls


def test_overpass_falls_back_to_the_next_instance():
    post, calls = fake_post([("a.example", urllib.error.HTTPError("u", 502, "busy", {}, None)), ("b.example", OK)])
    body = offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0], post, lambda s: None)
    assert body == OK
    assert calls == [("https://a.example/api", True), ("https://b.example/api", True), ("https://b.example/api", False)]


def test_overpass_unavailable_after_every_round():
    waits = []
    post, calls = fake_post([("example", OSError(101, "Network is unreachable"))])
    try:
        offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0, 120, 300], post, waits.append)
        raise AssertionError("no exception")
    except offshore.OverpassUnavailable as e:
        assert e.code == offshore.UNAVAILABLE == ro.UNAVAILABLE
        assert "unreachable" in e.msg
    assert waits == [120, 300] and len(calls) == 6


def test_overpass_client_error_is_raised_at_once():
    post, calls = fake_post([("a.example", urllib.error.HTTPError("u", 400, "bad query", {}, None))])
    try:
        offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0, 120], post, lambda s: None)
        raise AssertionError("no exception")
    except urllib.error.HTTPError as e:
        assert e.code == 400
    assert len(calls) == 1


def test_incomplete_answers_are_not_accepted():
    assert offshore.overpass_answer_ok(OK) is None
    assert offshore.overpass_answer_ok(b"<html>504</html>")
    assert offshore.overpass_answer_ok(b'{"elements": [], "remark": "runtime error: Query timed out in \\"query\\""}')
    post, _ = fake_post([("a.example", b'{"elements": [], "remark": "runtime error: Query run out of memory"}'), ("b.example", OK)])
    assert offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0], post, lambda s: None) == OK


def test_outage_skips_the_other_overpass_layers_and_stays_green(tmp_path, monkeypatch):
    runs = []

    class Proc:
        def __init__(self, rc):
            self.returncode = rc

    def run(cmd, cwd):
        runs.append(Path(cmd[1]).name + ":" + (cmd[3] if len(cmd) > 3 else ""))
        return Proc(ro.UNAVAILABLE)

    out = tmp_path / "gh_out"
    monkeypatch.setattr(ro.subprocess, "run", run)
    monkeypatch.setattr(ro, "STAGE", tmp_path / "stage")
    monkeypatch.setattr(ro.time, "sleep", lambda s: None)
    monkeypatch.setattr(ro, "osm_age_days", lambda fc, now=None: 7.0)
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    monkeypatch.setattr(sys, "argv", ["refresh_overlays.py", "--layers", "platforms,pipelines,cables-osm"])
    ro.main()  # no SystemExit: an outage with fresh data is a warning, not a failure
    assert runs == ["offshore.py:platforms"]  # pipelines and cables-osm were not queried again
    assert "unavailable=platforms,pipelines,cables-osm" in out.read_text()
    assert "failed=\n" in out.read_text()

    monkeypatch.setattr(ro, "osm_age_days", lambda fc, now=None: 90.0)
    runs.clear()
    try:
        ro.main()
        raise AssertionError("stale data during an outage must fail the run")
    except SystemExit as e:
        assert "platforms" in str(e.code)


def test_osm_age_days():
    fcx = {"metadata": {"osmTimestamp": "2026-11-16T12:00:00Z"}}
    now = ro.time.mktime(ro.time.strptime("2026-11-23T12:00:00Z", "%Y-%m-%dT%H:%M:%SZ")) - ro.time.timezone
    assert abs(ro.osm_age_days(fcx, now) - 7.0) < 1e-6
    assert ro.osm_age_days({}) is None

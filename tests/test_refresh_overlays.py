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


def test_overpass_query_syntax_error_is_raised_at_once():
    def post(url, query, timeout):
        calls.append(url)
        if query == offshore.PROBE:
            return OK
        raise urllib.error.HTTPError(url, 400, "bad query", {}, None)
    calls = []
    try:
        offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0, 120], post, lambda s: None)
        raise AssertionError("no exception")
    except urllib.error.HTTPError as e:
        assert e.code == 400
    assert calls == ["https://a.example/api", "https://a.example/api"]  # probe + query, no other instance


def test_overpass_403_404_and_bad_probes_move_to_the_next_instance():
    for code in (403, 404, 429, 400):
        post, calls = fake_post([("a.example", urllib.error.HTTPError("u", code, "no", {}, None)), ("b.example", OK)])
        assert offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0], post,
                                       lambda s: None) == OK, code
        assert calls[-1] == ("https://b.example/api", False)


def test_empty_or_tiny_answers_move_to_the_next_instance():
    assert offshore.overpass_answer_ok(b'{"elements": []}')
    assert offshore.overpass_answer_ok(b'{"elements": []}', 0) is None  # the probe may be empty
    assert "only 1 elements" in offshore.overpass_answer_ok(OK, 100)

    def post(url, query, timeout):
        if query == offshore.PROBE or "b.example" in url:
            return OK
        return b'{"elements": []}'
    assert offshore.overpass_query("q", ["https://a.example/api", "https://b.example/api"], [0], post, lambda s: None) == OK
    assert offshore.MIN_ELEMENTS["platforms"] >= 1000


def test_overpass_deadline_caps_every_request():
    """No request starts after the deadline; query timeouts (client and [timeout:N]) shrink to the time left."""
    t = [0.0]
    sent = []

    def post(url, query, timeout):
        sent.append((query == offshore.PROBE, round(timeout), query))
        if query == offshore.PROBE:
            return OK  # the probe answers at once, the real query hangs until its timeout
        t[0] += timeout
        raise TimeoutError("The read operation timed out")

    def sleep(s):
        t[0] += s

    q = '[out:json][timeout:600];node;out;'
    try:
        offshore.overpass_query(q, ["https://a.example/api", "https://b.example/api"], [0, 120, 300], post, sleep,
                                deadline=1000.0, clock=lambda: t[0])
        raise AssertionError("no exception")
    except offshore.OverpassUnavailable as e:
        assert "time budget spent" in e.msg
    assert t[0] <= 1000.0 + offshore.PROBE_TIMEOUT  # never far past the deadline
    queries = [x for x in sent if not x[0]]
    assert [x[1] for x in queries] == [300, 300, 250]  # the last one cut to the time left
    assert "[timeout:300]" in queries[0][2] and "[timeout:250]" in queries[2][2]  # server timeout follows
    # before: 3 instances x 3 rounds x (30 + 900) s = 2.3 h of hanging queries; now bounded by the deadline


def test_overpass_env_deadline(monkeypatch):
    monkeypatch.setenv(offshore.DEADLINE_ENV, "1000")
    assert offshore.env_deadline() == 1000.0
    assert offshore.DEADLINE_ENV == ro.DEADLINE_ENV
    assert offshore.with_server_timeout("[out:json][timeout:600];x", 250) == "[out:json][timeout:250];x"
    assert offshore.with_server_timeout("[out:json][timeout:10];x", 250) == "[out:json][timeout:10];x"


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

    def run(cmd, cwd, env=None):
        runs.append(Path(cmd[1]).name + ":" + (cmd[3] if len(cmd) > 3 else ""))
        assert env and float(env[ro.DEADLINE_ENV]) > ro.time.time()
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


def test_stale_outage_is_in_the_summary(tmp_path, monkeypatch):
    class Proc:
        returncode = ro.UNAVAILABLE

    monkeypatch.setattr(ro.subprocess, "run", lambda cmd, cwd, env=None: Proc())
    monkeypatch.setattr(ro, "STAGE", tmp_path / "stage")
    monkeypatch.setattr(ro.time, "sleep", lambda s: None)
    monkeypatch.setattr(ro, "osm_age_days", lambda fc, now=None: 90.0)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    summary = tmp_path / "summary.md"
    monkeypatch.setattr(sys, "argv", ["refresh_overlays.py", "--layers", "windfarms", "--summary", str(summary)])
    try:
        ro.main()
        raise AssertionError("no exit")
    except SystemExit:
        pass
    assert "FAILED: Overpass unavailable and the kept data is 90 days old" in summary.read_text()


def test_wrecks_run_before_overpass_and_overpass_has_one_budget(tmp_path, monkeypatch):
    runs, clock = [], [1_000_000.0]

    class Proc:
        def __init__(self, rc):
            self.returncode = rc

    def run(cmd, cwd, env=None):
        name = Path(cmd[1]).name
        runs.append((name, None if env is None else float(env[ro.DEADLINE_ENV])))
        clock[0] += 600 if name != "wrecks.py" else 60  # each Overpass layer takes 10 min
        return Proc(1 if name == "wrecks.py" else 0)  # results do not matter here

    monkeypatch.setattr(ro.subprocess, "run", run)
    monkeypatch.setattr(ro, "STAGE", tmp_path / "stage")
    monkeypatch.setattr(ro, "validate", lambda *a: ({}, ["skip"]))
    monkeypatch.setattr(ro.time, "time", lambda: clock[0])
    monkeypatch.setattr(ro.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + s))
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    monkeypatch.setattr(sys, "argv", ["refresh_overlays.py", "--layers", "platforms,pipelines,windfarms,wrecks,cables-osm",
                                      "--overpass-budget", "1500"])
    try:
        ro.main()
    except SystemExit:
        pass
    assert runs[0] == ("wrecks.py", None)  # first, and without an Overpass deadline
    deadlines = {d for _, d in runs[1:]}
    assert len(deadlines) == 1  # one shared deadline for every Overpass layer
    # 1500 s budget, 600 s per layer + 30 s pauses: 270 s are left after three layers, the fourth is skipped
    assert [n for n, _ in runs] == ["wrecks.py", "offshore.py", "offshore.py", "offshore.py"]


def test_osm_age_days_is_utc_in_any_time_zone(monkeypatch):
    import calendar
    fcx = {"metadata": {"osmTimestamp": "2026-07-01T12:00:00Z"}}  # northern summer: DST in most zones
    now = calendar.timegm((2026, 7, 8, 12, 0, 0, 0, 0, 0))
    for tz in ("UTC", "Europe/Berlin", "America/New_York", "Asia/Tashkent"):
        monkeypatch.setenv("TZ", tz)
        ro.time.tzset()
        assert abs(ro.osm_age_days(fcx, now) - 7.0) < 1e-9, tz
    monkeypatch.delenv("TZ")
    ro.time.tzset()
    assert ro.osm_age_days({}) is None


def test_wrecks_count_guard_is_tight():
    spec = {**ro.LAYERS["wrecks"], "min": 1}

    def wfc(n):
        return {"type": "FeatureCollection", "metadata": {"attribution": spec["attribution"], "licence": spec["licence"]},
                "features": [{"type": "Feature", "properties": {"id": f"Q{i}", "depth_m": 10, "sitelinks": 1},
                              "geometry": {"type": "Point", "coordinates": [0, 0]}} for i in range(n)]}

    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "wrecks.geojson"
        p.write_text(json.dumps(wfc(88)))
        assert any("-12%" in e for e in ro.validate(spec, p, wfc(100), False)[1])  # 12 % loss no longer slips by
        p.write_text(json.dumps(wfc(97)))
        assert ro.validate(spec, p, wfc(100), False)[1] == []


# ---------------------------------------------------------------- Wikidata answers cut short
import wrecks  # noqa: E402

CSV = "item,label\r\n" + "".join(f"http://www.wikidata.org/entity/Q{i},Ship {i}\r\n" for i in range(200))


def test_complete_csv_passes():
    assert wrecks.csv_problem(CSV, 200) is None
    assert wrecks.csv_problem(CSV) is None


def test_truncated_csv_is_detected():
    assert "incomplete" in wrecks.csv_problem(CSV[: len(CSV) * 85 // 100], 200)  # cut mid-row
    cut = CSV[: CSV.rindex("\n", 0, len(CSV) * 85 // 100) + 1]                     # cut at a row boundary
    assert "count query says 200" in wrecks.csv_problem(cut, 200)
    assert "server error" in wrecks.csv_problem(cut + "java.util.concurrent.TimeoutException\n", None)
    assert wrecks.csv_problem("") == "empty answer"
    assert "fields" in wrecks.csv_problem("item,label\r\nQ1\r\n")


def test_sparql_retries_a_truncated_answer_and_never_caches_it(tmp_path):
    answers = iter(["n\r\n200\r\n", CSV[:3000], "n\r\n200\r\n", CSV])
    sleeps = []
    rows = wrecks.sparql("q", tmp_path / "c.csv", True, core="?item ?p ?o", fetch=lambda q: next(answers),
                         sleep=sleeps.append)
    assert len(rows) == 200 and sleeps == [60]
    assert (tmp_path / "c.csv").read_bytes() == CSV.encode()

    always_cut = lambda q: "n\r\n200\r\n" if q.startswith("SELECT (COUNT") else CSV[:3000]  # noqa: E731
    try:
        wrecks.sparql("q", tmp_path / "d.csv", True, core="?item ?p ?o", fetch=always_cut, sleep=lambda s: None)
        raise AssertionError("no exception")
    except ValueError as e:
        assert "incomplete SPARQL answer" in str(e)
    assert not (tmp_path / "d.csv").exists()

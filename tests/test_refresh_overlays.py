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

import io
import json
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import history  # noqa: E402
import sealevel_history  # noqa: E402

PUB = ROOT / "web/public"


def test_first_code_semantics():
    m = np.array([0, 0b1, 0b10000000, 0b11111111, 0b00000110, 0b01000001, 0b10000001], dtype=np.uint8)
    # never; 2019 only (re-coded); 2026 only; always; 2020+2021 (re-coded); 2019+2025 (re-coded); 2019 and 2026
    assert history.first_code(m).tolist() == [0, 119, 26, 19, 120, 119, 19]


def test_row_area_sums_to_sphere():
    a = history.row_area_km2(0, 43200)
    total = a.sum() * 86400
    assert abs(total / (4 * np.pi * history.R_KM ** 2) - 1) < 1e-9


def test_block_helpers():
    m = np.zeros((8, 8), dtype=bool)
    m[1, 2] = True
    m[5, 5] = m[6, 6] = True
    assert history.block_any(m).tolist() == [[True, False], [False, True]]
    assert history.block_sum(m).tolist() == [[1, 0], [0, 2]]


def test_to_merc_keeps_thin_tracks_and_ors_years():
    # a 2' plate carree world (90 x 180) with one measured cell at the equator, years 2019 and 2026
    mask = np.zeros((90, 180), dtype=np.uint8)
    frac = np.zeros_like(mask)
    ocean = np.full_like(mask, 16)
    mask[45, 90] = 0b10000001
    frac[45, 90] = 16
    m, f = history.to_merc(mask, frac, ocean, 128)
    assert (m == 0b10000001).sum() >= 1 and set(np.unique(m)) <= {0, 0b10000001}
    assert np.nanmax(f) > 0 and not np.isnan(f).any()
    rgba = history.encode_tile(m, f)
    assert rgba[..., 0].max() == 19 and rgba[..., 1].max() == 0b10000001 and (rgba[..., 3] == 255).all()


def test_tile_codes_survive_lossless_webp():
    m = np.array([[0, 1, 0b10000000, 0b00000110]], dtype=np.uint8).repeat(4, 0)
    f = np.array([[np.nan, 0.0, 0.5, 1.0]], dtype=np.float32).repeat(4, 0)
    rgba = history.encode_tile(m, f)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "WEBP", lossless=True, quality=100, exact=True)
    back = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGBA"))
    assert np.array_equal(back[..., 3], rgba[..., 3])
    ocean = rgba[..., 3] > 0
    assert np.array_equal(back[ocean], rgba[ocean])


def test_down2_or():
    a = np.array([[1, 2], [4, 0]], dtype=np.uint8)
    assert history.down2_or(a).tolist() == [[7]]


def test_parse_table_s3_snippet():
    text = """Table S3.
Best estimates of the ice-volume equivalent sea-level function (esl) (column 3) and its accuracy estimate
                   nominal esl
       time (ka)      (m)        esl (m)   sigma esl
            0             0         0         0.0
        0.122          -0.21     -0.16       0.07
	                                    30
       14.500    -95.14    -103.1   2.09
References
       99.0 1 2 3
"""
    rows = sealevel_history.parse_table_s3(text)
    assert rows == [(0.0, 0.0, 0.0, 0.0), (0.122, -0.21, -0.16, 0.07), (14.5, -95.14, -103.1, 2.09)]


# ---------------------------------------------------------------- built files (skipped until built)

SL = PUB / "data/sea-level-history.json"
MAN = PUB / "history/manifest.json"


@pytest.mark.skipif(not SL.exists(), reason="run pipeline/sealevel_history.py")
def test_sea_level_curve_spot_values():
    d = json.loads(SL.read_text())
    p = d["points"]
    at = lambda y: sealevel_history.at(p, y)
    assert p[0]["years_bp"] == 0 and p[0]["sea_level_m"] == 0
    assert all(b["years_bp"] > a["years_bp"] for a, b in zip(p, p[1:]))
    assert p[-1]["years_bp"] >= 26000
    assert -136 <= d["lgm"]["sea_level_m"] <= -120 and 19000 <= d["lgm"]["years_bp"] <= 26000
    for y in (21000, 23000, 26000):
        assert -136 <= at(y) <= -120
    assert at(14000) - at(14600) > 10            # Meltwater Pulse 1A
    assert -8 < at(7000) < -2                   # early-Holocene slow-down
    assert all(q["lo"] <= q["sea_level_m"] <= q["hi"] for q in p)


@pytest.mark.skipif(not MAN.exists(), reason="run pipeline/history.py build")
def test_history_manifest_bookkeeping():
    man = json.loads(MAN.read_text())
    ys = man["stats"]["years"]
    assert [y["year"] for y in ys] == list(range(2019, 2027))
    for a, b in zip(ys, ys[1:]):
        assert abs(b["measured_km2"] - (a["measured_km2"] + b["new_vs_previous_km2"]
                                        - b["no_longer_measured_vs_previous_km2"])) < 5
        assert b["ever_measured_km2"] >= a["ever_measured_km2"]
    assert abs(sum(y["first_measured_km2"] for y in ys) - ys[-1]["ever_measured_km2"]) < 5
    # GEBCO_2026 measured share agrees with pipeline/coverage.py (same mask): 30.8 %
    assert abs(ys[-1]["measured_frac"] - 0.3081) < 0.002
    for y in ys:
        assert 0.10 < y["measured_frac"] < 0.40


@pytest.mark.skipif(not (PUB / "history/first-measured_1arcmin.bin").exists(), reason="run history.py build")
def test_history_bins_decode_and_agree():
    raw = zlib.decompress((PUB / "history/first-measured_1arcmin.bin").read_bytes())
    first = np.frombuffer(raw, dtype=np.uint8).reshape(10800, 21600)
    # inner Asia is land (0)
    assert first[int((90 - 46) * 60), int((100 + 180) * 60)] == 0
    codes = set(np.unique(first).tolist())
    assert codes <= {0} | set(range(19, 27)) | set(range(119, 126))


@pytest.mark.skipif(not MAN.exists(), reason="run pipeline/history.py build")
def test_history_manifest_names_only_shipped_bin_files():
    import re
    text = MAN.read_text()
    for name in set(re.findall(r"[A-Za-z0-9_-]+\.bin\b", text)):
        assert (MAN.parent / name).exists(), name

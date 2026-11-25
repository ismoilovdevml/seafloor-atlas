import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import viewer_land as vl  # noqa: E402


def test_erode1_drops_the_edge_and_wraps_columns():
    a = np.zeros((7, 8), bool)
    a[1:6, 2:7] = True
    e = vl.erode1(a)
    assert e[2:5, 3:6].all() and e.sum() == 9           # only the 3 x 3 interior survives
    w = np.zeros((5, 6), bool)
    w[1:4, :] = True                                      # a band spanning the antimeridian
    assert vl.erode1(w)[2].all()                          # columns wrap: the middle row survives everywhere


def test_polders_become_land_but_measured_lakes_and_open_sea_do_not():
    tid = np.array([[44, 10, 40, 40, 44, 0]], np.int16)   # polder, surveyed lake (wet), open sea, lagoon, no JRC, land
    inland = np.zeros_like(tid, np.int8)
    osm = np.array([[True, True, False, True, True, True]])
    occ = np.array([[0.3, 98, 0, 90, np.nan, 0]], np.float32)
    land, reason = vl.viewer_land(tid, inland, osm, occ)
    assert land.tolist() == [[True, False, False, False, False, False]]
    assert reason.tolist() == [[2, 0, 0, 0, 0, 0]]


def test_dry_polder_cells_flip_even_when_singlebeam_coded_or_gebco_land():
    tid = np.array([[11, 0, 0, 0]], np.int16)             # polder ditch survey, GEBCO land below 0, wet, above 0
    inland = np.zeros_like(tid, np.int8)
    osm = np.array([[True, False, False, False]])
    occ = np.array([[1, 2, 90, 0]], np.float32)
    h15 = np.array([[-3, -4, -2, 5]], np.int16)
    land, reason = vl.viewer_land(tid, inland, osm, occ, h15)
    assert land.tolist() == [[True, True, False, False]]


def test_inland_basins_are_land_and_split_into_dry_ground_and_lakes():
    tid = np.array([[11, 40, 40, 40]], np.int16)
    inland = np.array([[1, 1, 1, -1]], np.int8)           # 1 = inland, -1 = outside the ocean mask
    occ = np.array([[95, 2, np.nan, 95]], np.float32)     # lake, dry basin, no JRC tile, outside
    land, reason = vl.viewer_land(tid, inland, np.zeros((1, 4), bool), occ)
    assert land.tolist() == [[True, True, True, False]]
    assert reason.tolist() == [[3, 1, 1, 0]]              # 3 = inland water, 1 = dry (unknown counts as dry)


def test_jrc_tile_names_follow_the_west_and_north_edges():
    assert vl.gsw_tile_name(5, 53) == "0E_60N"            # Flevoland block 5-6 E, 52-53 N
    assert vl.gsw_tile_name(-52, 0) == "60W_0N"           # Amazon mouth block, 1 S-0
    assert vl.gsw_tile_name(-52, -31) == "60W_30S"        # Lagoa dos Patos block, 32-31 S
    assert vl.gsw_tile_name(10, 60) == "10E_60N"          # a block touching the tile's north edge

"""Pack a z/x/y tile folder into one PMTiles v3 archive (for moving big raster sets off GitHub Pages).

When web/dist nears the 1 GB Pages limit, the largest raster sets (tiles/disagree, tiles/shipping,
tiles/coverage, ...) can move to the Hugging Face dataset next to the z6-7 archives
(pipeline/publish_hires.py) and be read with HTTP range requests through the same sfa:// protocol.
This script only packs and verifies; it uploads nothing. See README "Site size".

  python pipeline/to_pmtiles.py web/public/tiles/new2026 data/derived/pmtiles/new2026.pmtiles

Tiles are written in tile-id order (a clustered archive), identical tiles are stored once, the payload is
stored as-is (Compression.NONE, as for the WebP archives of tiles_hires.py). Files other than
<z>/<x>/<y>.<ext> (legend.json, ...) are skipped and listed; a JSON file can be added to the archive
metadata with --metadata. After writing, every tile is read back and compared byte for byte (--no-verify
skips it).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

TYPES = {"webp": TileType.WEBP, "png": TileType.PNG, "jpg": TileType.JPEG, "jpeg": TileType.JPEG,
         "avif": TileType.AVIF, "pbf": TileType.MVT, "mvt": TileType.MVT}
TILE_RE = re.compile(r"^(\d+)/(\d+)/(\d+)\.(\w+)$")
MERC_LAT = 85.0511287


def scan(folder: Path) -> tuple[list[tuple[int, int, int, int, Path]], str, list[str]]:
    tiles, other, exts = [], [], set()
    for p in sorted(folder.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(folder).as_posix()
        m = TILE_RE.match(rel)
        if not m or m.group(4).lower() not in TYPES:
            other.append(rel)
            continue
        z, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
            raise SystemExit(f"tile outside its zoom level: {rel}")
        exts.add(m.group(4).lower())
        tiles.append((zxy_to_tileid(z, x, y), z, x, y, p))
    if not tiles:
        raise SystemExit(f"no z/x/y tiles in {folder}")
    if len({TYPES[e] for e in exts}) > 1:
        raise SystemExit(f"mixed tile types in {folder}: {sorted(exts)}")
    tiles.sort()
    return tiles, exts.pop(), other


def pack(folder: Path, out: Path, metadata: dict, verify: bool) -> dict:
    t0 = time.time()
    tiles, ext, other = scan(folder)
    zooms = sorted({t[1] for t in tiles})
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    src_bytes = 0
    with open(tmp, "wb") as f:
        w = Writer(f)
        for tid, *_zxy, p in tiles:
            data = p.read_bytes()
            src_bytes += len(data)
            w.write_tile(tid, data)
        w.finalize({"tile_type": TYPES[ext], "tile_compression": Compression.NONE,
                    "min_lon_e7": -1800000000, "min_lat_e7": int(-MERC_LAT * 1e7),
                    "max_lon_e7": 1800000000, "max_lat_e7": int(MERC_LAT * 1e7),
                    "center_zoom": zooms[0], "center_lon_e7": 0, "center_lat_e7": 0},
                   {"name": metadata.pop("name", folder.name), "format": ext, **metadata})
        contents = len(w.hash_to_offset)
    tmp.rename(out)
    stats = {"tiles": len(tiles), "unique_contents": contents, "zooms": zooms, "format": ext,
             "source_bytes": src_bytes, "archive_bytes": out.stat().st_size, "skipped_files": other,
             "seconds": round(time.time() - t0, 1)}
    if verify:
        with open(out, "rb") as f:
            src = MmapSource(f)
            hdr = Reader(src).header()
            assert (hdr["min_zoom"], hdr["max_zoom"]) == (zooms[0], zooms[-1]), hdr
            assert hdr["addressed_tiles_count"] == len(tiles), hdr
            got = {zxy: data for zxy, data in all_tiles(src)}
        assert len(got) == len(tiles), (len(got), len(tiles))
        for _tid, z, x, y, p in tiles:
            if got[(z, x, y)] != p.read_bytes():
                raise SystemExit(f"read-back mismatch at {z}/{x}/{y}")
        stats["verified"] = f"all {len(tiles)} tiles read back byte-identical"
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path, help="z/x/y tile folder, e.g. web/public/tiles/shipping")
    ap.add_argument("out", type=Path, help="output .pmtiles")
    ap.add_argument("--metadata", type=Path, help="JSON file merged into the archive metadata (e.g. legend.json)")
    ap.add_argument("--name", help="archive name (default: folder name)")
    ap.add_argument("--attribution", help="attribution text stored in the metadata")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()
    meta = json.loads(args.metadata.read_text()) if args.metadata else {}
    if args.name:
        meta["name"] = args.name
    if args.attribution:
        meta["attribution"] = args.attribution
    stats = pack(args.folder, args.out, meta, not args.no_verify)
    print(json.dumps(stats, indent=1))
    if stats["skipped_files"]:
        print(f"note: {len(stats['skipped_files'])} non-tile files not packed (serve them separately)",
              file=sys.stderr)


if __name__ == "__main__":
    main()

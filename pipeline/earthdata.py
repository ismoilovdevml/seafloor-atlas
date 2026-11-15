"""Download helpers for NASA Earthdata Login (EDL) protected URLs and NASA CMR granule search.

Credentials: a `machine urs.earthdata.nasa.gov login ... password ...` entry in ~/.netrc (never in this repo).
Downloads go through curl (`-n` reads ~/.netrc, `-L` follows the EDL redirect) with a throwaway cookie jar in a
temporary directory that is deleted afterwards, so neither credentials nor session cookies land in data/ or git.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

CMR = "https://cmr.earthdata.nasa.gov/search"


class Session:
    """One EDL session (cookie jar) for many downloads. Use as a context manager."""

    def __enter__(self) -> "Session":
        self._dir = Path(tempfile.mkdtemp(prefix="edl-"))
        return self

    @property
    def jar(self) -> Path:
        """One cookie jar per thread, so parallel downloads do not overwrite each other's jar."""
        import threading

        return self._dir / f"cookies-{threading.get_ident()}"

    def __exit__(self, *exc) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)

    def get(self, url: str, dest: Path, tries: int = 5, min_bytes: int = 1000) -> int:
        """Download url to dest atomically (dest.part -> dest). Returns the size in bytes."""
        if not shutil.which("curl"):
            raise RuntimeError("curl not found")
        if not Path.home().joinpath(".netrc").exists():
            raise RuntimeError("~/.netrc with an urs.earthdata.nasa.gov entry is required")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        for attempt in range(tries):
            r = subprocess.run(["curl", "-s", "-f", "-n", "-L", "-c", str(self.jar), "-b", str(self.jar),
                                "--retry", "2", "--connect-timeout", "30", "-o", str(part), url])
            if r.returncode == 0 and part.exists() and part.stat().st_size >= min_bytes:
                # an EDL login page instead of data means the netrc entry or app authorisation is missing
                with open(part, "rb") as f:
                    head = f.read(512).lower()
                if b"<html" in head or b"<!doctype html" in head:
                    part.unlink()
                    raise RuntimeError(f"got an HTML page instead of data for {url} (Earthdata login failed?)")
                part.rename(dest)
                return dest.stat().st_size
            print(f"  retry {attempt + 1}/{tries} (curl exit {r.returncode}) {url}", flush=True)
            time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"download failed: {url}")


def cmr_granules(short_name: str, version: str | None = None, pattern: str | None = None,
                 temporal: str | None = None, page_size: int = 2000) -> list[dict]:
    """CMR granule search (public, no login). Returns the JSON feed entries."""
    q = {"short_name": short_name, "page_size": str(page_size)}
    if version:
        q["version"] = version
    if pattern:
        q["readable_granule_name"] = pattern
        q["options[readable_granule_name][pattern]"] = "true"
    if temporal:
        q["temporal"] = temporal
    url = f"{CMR}/granules.json?" + urllib.parse.urlencode(q)
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)["feed"]["entry"]


def https_link(entry: dict, suffix: str = ".nc") -> str | None:
    for link in entry.get("links", []):
        h = link.get("href", "")
        if h.startswith("https://") and h.endswith(suffix) and "opendap" not in h:
            return h
    return None

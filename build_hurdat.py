"""Convert NOAA/NHC HURDAT2 best-track files into compact JSON for TropicalWeather's Past storms view.

HURDAT2 (https://www.nhc.noaa.gov/data/hurdat/) is NHC's official historical record: every Atlantic
storm since 1851 and northeast/north-central Pacific storm since 1949, six-hourly, with landfall points.
nhc.noaa.gov doesn't allow cross-origin requests, and the files only change once or twice a year, so
this runs by hand (or yearly) and the output is committed:

    python3 build_hurdat.py          # writes site/hurdat/atl.json and site/hurdat/pac.json

Each file: {"source": url, "built": iso, "storms": [{"id", "name", "year", "peak", "minp", "landfall",
"pts": [[yyyymmddhhmm, lat, lon, vmax_kt, mslp_mb|null, status, record]]}]}.
"""

import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.nhc.noaa.gov/data/hurdat/"
OUT = Path(__file__).parent / "site" / "hurdat"
FILES = {"atl": r"hurdat2-1851-\d{4}-[\d]+\.txt", "pac": r"hurdat2-nepac-1949-\d{4}-[\d]+\.txt"}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "TropicalWeather (standardweather.github.io)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def newest(pattern, listing):
    """The most recently modified file matching pattern in the Apache directory listing."""
    rows = re.findall(r'href="(' + pattern + r')".*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', listing)
    if not rows:
        raise SystemExit(f"no file matching {pattern}")
    return max(rows, key=lambda r: r[1])[0]


def coord(s):
    v = float(s[:-1])
    return -v if s[-1] in "SW" else v


def parse(text):
    storms = []
    cur = None
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) >= 3 and re.fullmatch(r"(AL|EP|CP)\d{6}", f[0]):
            cur = {"id": f[0], "name": f[1].title() if f[1] != "UNNAMED" else "Unnamed", "year": int(f[0][-4:]), "pts": []}
            storms.append(cur)
            continue
        if cur is None or len(f) < 8 or not f[0].isdigit():
            continue
        vmax = int(f[6]) if f[6].lstrip("-").isdigit() and int(f[6]) >= 0 else None
        mslp = int(f[7]) if f[7].lstrip("-").isdigit() and int(f[7]) > 0 else None
        cur["pts"].append([int(f[0] + f[1].zfill(4)), round(coord(f[4]), 1), round(coord(f[5]), 1), vmax, mslp, f[3], f[2]])
    for s in storms:
        winds = [p[3] for p in s["pts"] if p[3] is not None]
        press = [p[4] for p in s["pts"] if p[4] is not None]
        s["peak"] = max(winds) if winds else None
        s["minp"] = min(press) if press else None
        s["landfall"] = any(p[6] == "L" for p in s["pts"])
        s["storm_types"] = sorted({p[5] for p in s["pts"]})
    # Most recent first, which is how the page lists them.
    return sorted(storms, key=lambda s: (s["year"], s["id"]), reverse=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    listing = get(BASE)
    for key, pattern in FILES.items():
        name = newest(pattern, listing)
        storms = parse(get(BASE + name))
        for s in storms:
            del s["storm_types"]
        out = {"source": BASE + name, "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "storms": storms}
        path = OUT / f"{key}.json"
        path.write_text(json.dumps(out, separators=(",", ":")))
        years = [s["year"] for s in storms]
        print(f"{path}: {len(storms)} storms {min(years)}–{max(years)}, {sum(len(s['pts']) for s in storms)} points, "
              f"{path.stat().st_size // 1024} KB from {name}")


if __name__ == "__main__":
    main()

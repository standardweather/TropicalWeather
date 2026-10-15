"""Collect current tropical data for TropicalWeather into site/data/tropical.json.

NHC's web and FTP servers don't send CORS headers, so the browser can't read
them directly. This script runs in GitHub Actions on a schedule and gathers:

  * active storms           www.nhc.noaa.gov/CurrentStorms.json
  * outlook text            www.nhc.noaa.gov/gtwo.xml
  * best tracks / guidance  ftp.nhc.noaa.gov/atcf (btk + aid_public), incl. invests
  * aircraft tasking        TCPOD (NOUS42 KNHC REPRPD) from tgftp.nws.noaa.gov
  * recon observations      HDOBs and vortex messages from www.nhc.noaa.gov/archive/recon

Cones, tracks, warnings and outlook areas are drawn live in the browser from
NOAA's tropical MapServer, which does allow cross-origin requests.

Standard library only. Any source that fails is recorded in "errors" and the
rest of the file is still written.
"""

import gzip
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path

OUT = Path(__file__).parent / "site" / "data" / "tropical.json"
UA = "TropicalWeather (standardweather.github.io)"
NOW = datetime.now(timezone.utc)

NHC = "https://www.nhc.noaa.gov"
ATCF = "https://ftp.nhc.noaa.gov/atcf"
TCPOD_URL = "https://tgftp.nws.noaa.gov/data/raw/no/nous42.knhc.rep.rpd.txt"
RECON = f"{NHC}/archive/recon/{NOW.year}"

INVEST_MAX_AGE = timedelta(hours=36)   # b-deck must have a fix this recent
HDOB_WINDOW = timedelta(hours=12)
VORTEX_WINDOW = timedelta(hours=36)

# Guidance worth drawing on the map. Interpolated ("early") aids plus the
# official forecast and consensus; anything not listed is left out.
MODELS = [
    "OFCL", "OFCI", "TVCN", "IVCN", "HCCA", "RVCN",
    "AVNI", "EMXI", "EGRI", "UKXI", "CMCI", "NVGI", "CTCI",
    "HFAI", "HFBI", "HWFI", "HMNI", "AEMI", "CEMI",
    "TABS", "TABM", "TABD", "XTRP", "CLP5",
    "DSHP", "LGEM", "ICON", "SHIP",   # intensity aids (they reuse the official track)
]

errors = []


def get(url, binary=False, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def safe(name, fn, default=None):
    try:
        return fn()
    except Exception as e:  # keep going; the page shows what's missing
        errors.append(f"{name}: {e}")
        print(f"warning: {name}: {e}", file=sys.stderr)
        return default


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def listing(url):
    """(name, modified) pairs from an Apache directory index."""
    html = get(url)
    rows = re.findall(r'href="([^"?/][^"]*)".*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})', html)
    return [(n, datetime.strptime(m, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)) for n, m in rows]


# —— Active storms and outlooks ——————————————————————————————————————————

def current_storms():
    data = json.loads(get(f"{NHC}/CurrentStorms.json"))
    storms = []
    for s in data.get("activeStorms", []):
        sid = s["id"].upper()
        def link(key):
            return (s.get(key) or {}).get("url")
        storms.append({
            "id": s["id"],
            "bin": s.get("binNumber"),
            "name": s.get("name"),
            "classification": s.get("classification"),
            "intensity": int(s["intensity"]) if str(s.get("intensity", "")).isdigit() else None,
            "pressure": int(s["pressure"]) if str(s.get("pressure", "")).isdigit() else None,
            "lat": s.get("latitudeNumeric"),
            "lon": s.get("longitudeNumeric"),
            "movementDir": s.get("movementDir"),
            "movementSpeed": s.get("movementSpeed"),
            "lastUpdate": s.get("lastUpdate"),
            "advisory": (s.get("publicAdvisory") or {}).get("advNum"),
            "links": {
                "public": link("publicAdvisory"),
                "forecast": link("forecastAdvisory"),
                "discussion": link("forecastDiscussion"),
                "windProbs": link("windSpeedProbabilities"),
                "graphics": f"{NHC}/graphics_{sid[:2].lower()}{sid[2:4]}.shtml",
                "cone": f"{NHC}/storm_graphics/{sid[:4]}/{sid}_5day_cone_with_line_and_wind.png",
            },
        })
    return storms


def outlooks():
    xml = get(f"{NHC}/gtwo.xml")
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
        title = re.search(r"<title>(.*?)</title>", item, re.S)
        desc = re.search(r"<description>\s*<!\[CDATA\[(.*?)\]\]>", item, re.S)
        link = re.search(r"<link>(.*?)</link>", item, re.S)
        date = re.search(r"<pubDate>(.*?)</pubDate>", item, re.S)
        if not (title and desc) or "Outlook" not in title.group(1):
            continue
        text = re.sub(r"<br\s*/?>", "\n", desc.group(1), flags=re.I)
        text = unescape(re.sub(r"<[^>]+>", "", text))
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        # Drop the WMO/AWIPS header lines ahead of the product title.
        start = text.find("Tropical Weather Outlook")
        if start > 0:
            text = text[start:]
        text = re.sub(r"\s*(\$\$|NNNN)\s*", "\n\n", text).strip()
        t = title.group(1)
        basin = "AL" if "Atlantic" in t else "CP" if "Central" in t else "EP"
        out.append({"basin": basin, "title": t.strip(), "text": text,
                    "link": unescape(link.group(1).strip()) if link else None,
                    "issued": date.group(1).strip() if date else None})
    return out


# —— ATCF best tracks and guidance —————————————————————————————————————

def latlon(lat, lon):
    la = int(lat[:-1]) / 10 * (1 if lat[-1] == "N" else -1)
    lo = int(lon[:-1]) / 10 * (-1 if lon[-1] == "W" else 1)
    return round(la, 1), round(lo, 1)


def deck_rows(text):
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 9 or not f[2].isdigit() or not f[6] or not f[7]:
            continue
        try:
            lat, lon = latlon(f[6], f[7])
        except ValueError:
            continue
        yield {
            "basin": f[0], "cy": f[1], "dtg": f[2], "tech": f[4],
            "tau": int(f[5] or 0), "lat": lat, "lon": lon,
            "vmax": int(f[8]) if f[8].lstrip("-").isdigit() else None,
            "mslp": int(f[9]) if len(f) > 9 and f[9].isdigit() and int(f[9]) > 0 else None,
            "ty": f[10] if len(f) > 10 else "",
            "name": f[27] if len(f) > 27 else "",
        }


def dtg_iso(dtg):
    return f"{dtg[:4]}-{dtg[4:6]}-{dtg[6:8]}T{dtg[8:10]}:00:00Z"


def best_track(sid):
    rows, seen = [], set()
    for r in deck_rows(get(f"{ATCF}/btk/b{sid}.dat")):
        if r["dtg"] in seen:   # one line per wind-radii threshold
            continue
        seen.add(r["dtg"])
        rows.append(r)
    name = next((r["name"] for r in reversed(rows) if r["name"]), "")
    track = [{"t": dtg_iso(r["dtg"]), "lat": r["lat"], "lon": r["lon"],
              "vmax": r["vmax"], "mslp": r["mslp"], "ty": r["ty"]} for r in rows]
    return name, track


def guidance(sid):
    raw = gzip.decompress(get(f"{ATCF}/aid_public/a{sid}.dat.gz", binary=True)).decode("utf-8", "replace")
    by_cycle = {}
    for r in deck_rows(raw):
        if r["tech"] in MODELS:
            by_cycle.setdefault(r["dtg"], {}).setdefault(r["tech"], {})[r["tau"]] = r
    if not by_cycle:
        return None

    def tracks(cycle, techs=None):
        out = {}
        for tech, pts in by_cycle[cycle].items():
            if techs and tech not in techs:
                continue
            seq = [{"tau": tau, "lat": p["lat"], "lon": p["lon"], "vmax": p["vmax"]}
                   for tau, p in sorted(pts.items())]
            if len(seq) >= 2:
                out[tech] = seq
        return out

    cycles = sorted(by_cycle)
    # Newest cycle with a meaningful set of aids (the latest one may still be filling in).
    latest = next((c for c in reversed(cycles) if len(tracks(c)) >= 4), cycles[-1])
    result = {"cycle": dtg_iso(latest), "tracks": tracks(latest)}
    ofcl = next((c for c in reversed(cycles) if "OFCL" in by_cycle[c]), None)
    if ofcl and "OFCL" not in result["tracks"]:
        t = tracks(ofcl, {"OFCL"})
        if t:
            result["ofcl"] = {"cycle": dtg_iso(ofcl), "track": t["OFCL"]}
    return result


def atcf_systems(storms):
    ids = {s["id"].lower() for s in storms}
    files = safe("ATCF btk listing", lambda: listing(f"{ATCF}/btk/"), [])
    for name, _ in files:
        m = re.fullmatch(r"b((?:al|ep|cp)9\d\d{4})\.dat", name)
        if m and m.group(1)[-4:] == str(NOW.year):
            ids.add(m.group(1))

    def one(sid):
        bt = safe(f"best track {sid}", lambda: best_track(sid), ("", []))
        name, track = bt
        invest = sid[2] == "9"
        if invest:   # drop invests that have been deactivated or merged
            if not track or NOW - datetime.fromisoformat(track[-1]["t"].replace("Z", "+00:00")) > INVEST_MAX_AGE:
                return None
        return {
            "id": sid,
            "basin": sid[:2].upper(),
            "kind": "invest" if invest else "storm",
            "name": (f"Invest {sid[2:4]}{sid[1].upper()}" if invest else name.title() or sid.upper()),
            "best": track,
            "models": safe(f"guidance {sid}", lambda: guidance(sid)),
        }

    with ThreadPoolExecutor(8) as ex:
        return [s for s in ex.map(one, sorted(ids)) if s]


# —— TCPOD ————————————————————————————————————————————————————————————

FIELD_NAMES = {
    "A": "fixTime", "B": "mission", "C": "departure", "D": "position",
    "E": "onStation", "F": "altitude", "G": "profile", "H": "wra",
}


def parse_tcpod(text):
    lines = text.replace("\r", "").splitlines()
    head = "\n".join(lines[:15])
    pod = {
        "text": text.strip(),
        "issued": (re.search(r"^\s*(\d{3,4} (?:AM|PM) \w{3} \w{3} \d+ \w+ \d{4})", head, re.M) or [None, None])[1],
        "valid": (re.search(r"VALID\s+(.+)", head) or [None, None])[1],
        "number": (re.search(r"TCPOD NUMBER\.*\s*([\w-]+)", head) or [None, None])[1],
        "basins": [],
    }
    basin = system = None
    field = None
    # Busy plans print flights side by side ("FLIGHT ONE - ...   FLIGHT TWO - ..."),
    # so each flight owns a column that starts where its FLIGHT heading starts.
    cols = []   # [[offset, flight, current field]]
    for raw in lines:
        line = raw.strip()
        if line.startswith(("$$", "NNNN")):   # forecaster initials follow
            break
        if not line:
            continue
        m = re.match(r"^(I{1,3}|IV)\.\s+(.*?)\s+REQUIREMENTS", line)
        if m:
            basin = {"name": m.group(2).title(), "negative": False, "systems": [], "outlook": "", "remarks": ""}
            pod["basins"].append(basin)
            system = field = None
            cols = []
            continue
        if basin is None:
            continue
        m = re.match(r"^\d+\.\s+(.*)", line)
        if m:
            body = m.group(1)
            field = None
            cols = []
            if body.startswith("NEGATIVE"):
                basin["negative"] = True
                system = None
            elif body.startswith(("OUTLOOK", "SUCCEEDING")):
                system = None
                basin["outlook"] = re.sub(r"^(OUTLOOK FOR SUCCEEDING DAY|SUCCEEDING DAY OUTLOOK)\W*", "", body)
                field = "outlook"
            elif body.startswith("REMARK"):
                system = None
                basin["remarks"] = re.sub(r"^REMARKS?\W*", "", body)
                field = "remarks"
            else:
                system = {"name": body.title(), "flights": []}
                basin["systems"].append(system)
            continue
        heads = list(re.finditer(r"FLIGHT\s+(\w+)\s*-\s*(.*?)(?=\s{3,}FLIGHT|\s*$)", raw))
        if heads and raw.lstrip().startswith("FLIGHT") and system is not None:
            cols = []
            for h in heads:
                flight = {"flight": h.group(1).title(), "aircraft": h.group(2).strip().title(), "fields": {}}
                system["flights"].append(flight)
                cols.append([h.start(), flight, None])
            continue
        if cols:
            for i, col in enumerate(cols):
                stop = cols[i + 1][0] if i + 1 < len(cols) else None
                seg = raw[col[0]:stop].strip() if len(cols) > 1 else line
                if not seg:
                    continue
                fm = re.match(r"^([A-K])\.\s+(.*)", seg)
                if fm:
                    col[2] = FIELD_NAMES.get(fm.group(1), fm.group(1))
                    col[1]["fields"][col[2]] = fm.group(2).strip()
                elif col[2]:
                    col[1]["fields"][col[2]] += " " + seg
            continue
        # Continuation lines
        if field in ("outlook", "remarks"):
            # Keep lettered sub-items (A. ..., B. ...) on their own lines.
            sep = "\n" if re.match(r"^[A-K]\.\s", line) else " "
            basin[field] = (basin[field] + sep + line).strip()
        elif system is not None:
            system["note"] = (system.get("note", "") + " " + line).strip()

    for b in pod["basins"]:
        for s in b["systems"]:
            for f in s["flights"]:
                pos = re.search(r"(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])", f["fields"].get("position", ""))
                if pos:
                    f["lat"] = float(pos.group(1)) * (1 if pos.group(2) == "N" else -1)
                    f["lon"] = float(pos.group(3)) * (-1 if pos.group(4) == "W" else 1)
    return pod


def tcpod():
    return parse_tcpod(get(TCPOD_URL))


# —— Recon: HDOBs and vortex messages ——————————————————————————————————

def recon_files(folder, window):
    try:
        rows = listing(f"{RECON}/{folder}/?C=M;O=D")
    except urllib.error.HTTPError as e:
        if e.code == 404:   # no messages of this kind yet this year
            return []
        raise
    out = []
    for name, _ in rows:
        m = re.search(r"\.(\d{12})\.txt$", name)
        if not m:
            continue
        t = datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        if NOW - t <= window:
            out.append((t, f"{RECON}/{folder}/{name}"))
    return sorted(out)


def ddmm(v, hemi):
    deg, minutes = divmod(int(v), 100)
    x = deg + minutes / 60
    return round(-x if hemi in "SW" else x, 3)


def tenths_mb(v):
    """HDOB pressure fields drop the thousands digit: 0123 -> 1012.3, 9876 -> 987.6."""
    if not v.isdigit():
        return None
    x = int(v) / 10
    return round(x + 1000 if x < 100 else x, 1)


def parse_hdob(text):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    hdr = next((i for i, l in enumerate(lines) if "HDOB" in l), None)
    if hdr is None:
        return None
    m = re.match(r"^(.*?)\s+HDOB\s+(\d+)\s+(\d{8})", lines[hdr])
    if not m:
        return None
    mission, seq, day = m.group(1).split(), int(m.group(2)), m.group(3)
    obs = []
    for l in lines[hdr + 1:]:
        f = l.split()
        if len(f) < 11 or not re.fullmatch(r"\d{6}", f[0]):
            continue
        try:
            lat = ddmm(f[1][:-1], f[1][-1])
            lon = ddmm(f[2][:-1], f[2][-1])
        except ValueError:
            continue
        wind = f[8]
        obs.append({
            "hhmmss": f[0],
            "lat": lat, "lon": lon,
            "alt": int(f[4]) if f[4].isdigit() else None,          # geopotential height, m
            # Field 6 is extrapolated SLP at/below 550 mb flight level, a D-value above it.
            "slp": tenths_mb(f[5]) if (tenths_mb(f[3]) or 0) >= 550 else None,
            "wdir": int(wind[:3]) if wind[:3].isdigit() else None,
            "wspd": int(wind[3:]) if wind[3:].isdigit() else None,
            "peak": int(f[9]) if f[9].isdigit() else None,
            "sfmr": int(f[10]) if f[10].isdigit() else None,
        })
    return {"mission": mission, "seq": seq, "day": day, "obs": obs}


def mission_basin(parts, folder):
    # Mission IDs end in the basin letter: 0121E = EPAC, 0612A = Atlantic, 0103C = CPAC.
    # A transit can be reported under either bulletin, so prefer the ID.
    suffix = parts[1][-1:] if len(parts) > 1 else ""
    return {"A": "AL", "E": "EP", "C": "CP"}.get(suffix) or {"AHONT1": "AL", "AHOPA1": "CP"}.get(folder, "EP")


def hdobs():
    files = []
    for folder in ("AHONT1", "AHOPN1", "AHOPA1"):
        files += [(t, u, folder) for t, u in safe(f"recon {folder}", lambda f=folder: recon_files(f, HDOB_WINDOW), [])]
    with ThreadPoolExecutor(8) as ex:
        texts = list(ex.map(lambda x: safe("hdob", lambda: get(x[1])), files))

    missions = {}
    for (t, _, folder), text in zip(files, texts):
        msg = parse_hdob(text or "")
        if not msg or not msg["obs"]:
            continue
        parts = msg["mission"]
        key = " ".join(parts)
        mis = missions.setdefault(key, {
            "id": key,
            "aircraft": parts[0] if parts else "",
            "missionId": parts[1] if len(parts) > 1 else "",
            "storm": " ".join(parts[2:]).title(),
            "basin": mission_basin(parts, folder),
            "obs": [], "_seen": set(),
        })
        day = datetime.strptime(msg["day"], "%Y%m%d").replace(tzinfo=timezone.utc)
        for o in msg["obs"]:
            ts = day + timedelta(hours=int(o["hhmmss"][:2]), minutes=int(o["hhmmss"][2:4]), seconds=int(o["hhmmss"][4:]))
            if ts - t > timedelta(hours=12):   # header date is the file's; obs just before 00Z
                ts -= timedelta(days=1)
            stamp = iso(ts)
            if stamp in mis["_seen"]:
                continue
            mis["_seen"].add(stamp)
            o = dict(o, t=stamp)
            del o["hhmmss"]
            mis["obs"].append(o)

    out = []
    for m in missions.values():
        del m["_seen"]
        m["obs"].sort(key=lambda o: o["t"])
        obs = m["obs"]
        m["first"], m["last"] = obs[0]["t"], obs[-1]["t"]
        fl = [o for o in obs if o["wspd"] is not None]
        sf = [o for o in obs if o["sfmr"] is not None]
        m["maxFl"] = max(fl, key=lambda o: o["wspd"]) if fl else None
        m["maxSfmr"] = max(sf, key=lambda o: o["sfmr"]) if sf else None
        m["active"] = NOW - datetime.fromisoformat(m["last"].replace("Z", "+00:00")) < timedelta(minutes=45)
        out.append(m)
    out.sort(key=lambda m: m["last"], reverse=True)
    return out


def parse_vortex(text, file_time):
    if "VORTEX DATA MESSAGE" not in text:
        return None
    sid = (re.search(r"VORTEX DATA MESSAGE\s+(\w+)", text) or [None, ""])[1]
    def item(letter):
        m = re.search(rf"^\s*{letter}\.\s+(.*)$", text, re.M)
        return m.group(1).strip() if m else ""
    pos = re.search(r"([\d.]+) deg ([NS])\s+([\d.]+) deg ([EW])", item("B"))
    if not pos:
        return None
    t = re.match(r"(\d{2})/(\d{2}):(\d{2}):(\d{2})Z", item("A"))
    when = file_time
    if t:
        when = file_time.replace(day=int(t.group(1)), hour=int(t.group(2)), minute=int(t.group(3)), second=int(t.group(4)))
        if when > file_time + timedelta(hours=1):   # fix from the previous month
            when = (file_time.replace(day=1) - timedelta(days=1)).replace(
                day=int(t.group(1)), hour=int(t.group(2)), minute=int(t.group(3)), second=int(t.group(4)))
    slp = re.search(r"(\d{3,4})\s*mb", item("D"))
    maxfl = re.search(r"MAX FL WIND\s+(\d+)\s*KT", text)
    return {
        "storm": sid,
        "t": iso(when),
        "lat": float(pos.group(1)) * (1 if pos.group(2) == "N" else -1),
        "lon": float(pos.group(3)) * (-1 if pos.group(4) == "W" else 1),
        "slp": int(slp.group(1)) if slp else None,
        "slpNote": item("D"),
        "eye": item("F") if item("F") != "NA" else "",
        "eyeSize": item("G") if item("G") != "NA" else "",
        "maxFl": int(maxfl.group(1)) if maxfl else None,
        "mission": item("U"),
    }


def vortex():
    files = []
    for folder in ("REPNT2", "REPPN2", "REPPA2"):
        files += safe(f"recon {folder}", lambda f=folder: recon_files(f, VORTEX_WINDOW), [])
    with ThreadPoolExecutor(8) as ex:
        texts = list(ex.map(lambda x: safe("vortex", lambda: get(x[1])), files))
    out = [v for (t, _), text in zip(files, texts) if (v := parse_vortex(text or "", t))]
    return sorted(out, key=lambda v: v["t"], reverse=True)


# —— Main —————————————————————————————————————————————————————————————

def main():
    storms = safe("CurrentStorms.json", current_storms, [])
    with ThreadPoolExecutor(5) as ex:
        f_sys = ex.submit(atcf_systems, storms)
        f_pod = ex.submit(safe, "TCPOD", tcpod)
        f_two = ex.submit(safe, "outlooks", outlooks, [])
        f_hdob = ex.submit(safe, "HDOBs", hdobs, [])
        f_vtx = ex.submit(safe, "vortex messages", vortex, [])
        data = {
            "generated": iso(NOW),
            "storms": storms,
            "systems": f_sys.result(),
            "tcpod": f_pod.result(),
            "outlooks": f_two.result(),
            "recon": {"missions": f_hdob.result(), "vortex": f_vtx.result()},
            "errors": errors,
        }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(storms)} storms, "
          f"{len(data['systems'])} ATCF systems, {len(data['recon']['missions'])} recon missions, "
          f"{len(data['recon']['vortex'])} vortex fixes, {len(errors)} errors")


if __name__ == "__main__":
    main()

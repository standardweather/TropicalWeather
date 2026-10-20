# TropicalWeather

Live tropical cyclone map for [Standard Weather](https://standardweather.github.io/TropicalWeather/).

**Loaded live in the browser**
- NHC cones, forecast/past tracks, watches & warnings, wind field and 7-day outlook areas — NOAA tropical MapServer
- Full-disk GOES-East/West IR, visible, GeoColor and air mass — NASA GIBS (10-minute frames)
- WPC 7-day rainfall forecast and day 1 excessive rainfall outlook — NOAA WPC MapServers
- Daily sea surface temperature (GHRSST MUR) — NASA GIBS

**Collected about every 15 minutes by GitHub Actions** (each run starts the next, with the cron as a backup) (`fetch_data.py` → `site/data/tropical.json`), because these servers don't allow cross-origin requests:
- Active storms — `nhc.noaa.gov/CurrentStorms.json`
- ATCF best tracks (including invests) and model guidance — `ftp.nhc.noaa.gov/atcf`
- Tropical Cyclone Plan of the Day (TCPOD) — `tgftp.nws.noaa.gov` (NOUS42 KNHC REPRPD)
- Recon HDOBs and vortex data messages — `nhc.noaa.gov/archive/recon`
- Tropical weather outlook text — `nhc.noaa.gov/gtwo.xml`
- Buoy and coastal station observations — `ndbc.noaa.gov/data/latest_obs`

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo.

## Local preview

```bash
python3 fetch_data.py
```

Then serve a folder that has the main site's `css/` and `assets/` at its root and this repo's `site/` as `TropicalWeather/`.

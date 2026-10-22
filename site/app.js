/* TropicalWeather — live tropical console for standardweather.github.io.
 *
 * Live in the browser (these services allow cross-origin requests):
 *   NHC tropical MapServer  cones, forecast/past tracks, watches & warnings, wind field, 7-day outlook areas
 *   NASA GIBS GOES tiles    IR / visible / GeoColor / air mass, 10-minute full-disk frames
 *   NHC map service images  wind-speed probabilities, arrival time of TS-force winds, peak storm surge (inundation)
 *   WPC map service images  7-day rainfall forecast and day 1 excessive rainfall (flash flood) outlook
 *   NASA GIBS GHRSST MUR    daily sea surface temperature
 * Built by build_hurdat.py from NOAA/NHC HURDAT2 into hurdat/atl.json and hurdat/pac.json:
 *   historical best tracks (Atlantic since 1851, Pacific since 1949) for the Past storms view
 * Collected every ~15 min by GitHub Actions into data/tropical.json (fetch_data.py):
 *   NHC CurrentStorms, ATCF best tracks + guidance, TCPOD, recon HDOBs + vortex messages, outlook text,
 *   NDBC buoy and coastal station observations
 */
(() => {
  "use strict";

  const MS = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
  const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
  const WPC_QPF = "https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer";
  const WPC_ERO = "https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer";
  const SAT = {
    ir: { name: "IR", product: "ABI_Band13_Clean_Infrared", level: 6 },
    vis: { name: "Visible", product: "ABI_Band2_Red_Visible_1km", level: 7 },
    geocolor: { name: "GeoColor", product: "ABI_GeoColor", level: 7 },
    airmass: { name: "Air mass", product: "ABI_Air_Mass", level: 6 },
  };
  const SAT_SPLIT_LON = -105;      // GOES-West to the west, GOES-East to the east
  const SAT_FRAMES = 12;           // 2 hours of 10-minute frames
  const SAT_STEP = 10 * 60000;
  const BINS = ["AT1", "AT2", "AT3", "AT4", "AT5", "EP1", "EP2", "EP3", "EP4", "EP5", "CP1", "CP2", "CP3", "CP4", "CP5"];
  const BASIN_BOUNDS = {
    ALL: [[4, -160], [46, -14]],
    AL: [[6, -100], [46, -14]],
    EP: [[2, -142], [32, -82]],
    CP: [[2, -180], [32, -136]],
  };
  const BASIN_NAMES = { AL: "Atlantic", EP: "East Pacific", CP: "Central Pacific" };
  const CLASS = {
    HU: "Hurricane", MH: "Major Hurricane", TS: "Tropical Storm", TD: "Tropical Depression",
    STS: "Subtropical Storm", SS: "Subtropical Storm", STD: "Subtropical Depression", SD: "Subtropical Depression",
    PTC: "Potential Tropical Cyclone", PC: "Post-Tropical Cyclone", TY: "Typhoon",
    DB: "Disturbance", LO: "Low", WV: "Tropical Wave", EX: "Extratropical",
  };

  // Saffir–Simpson colors (kt)
  const SS = [[137, "#ff6b6b", "5"], [113, "#ff9548", "4"], [96, "#ffbf47", "3"], [83, "#ffe27a", "2"], [64, "#fff4c2", "1"], [34, "#6fe3e8", "TS"], [0, "#7cb8ff", "TD"]];
  const ssColor = (kt) => (kt == null ? "#9aa3c0" : SS.find(([m]) => kt >= m)[1]);
  const ssLabel = (kt) => (kt == null ? "" : SS.find(([m]) => kt >= m)[2]);
  const WW = { HWR: ["#ff4d4d", "Hurricane warning"], HWA: ["#ff9fd6", "Hurricane watch"], TWR: ["#4f8dff", "Tropical storm warning"], TWA: ["#ffd84a", "Tropical storm watch"] };
  const RISK = { Low: "#ffd84a", Medium: "#ff9548", High: "#ff5a5a" };
  const RECON = "#ffd84a";

  const MODEL_GROUPS = {
    consensus: { name: "Consensus", models: ["TVCN", "IVCN", "HCCA", "RVCN"], on: true },
    global: { name: "Global", models: ["AVNI", "EMXI", "EGRI", "UKXI", "CMCI", "NVGI", "CTCI", "AEMI", "CEMI"], on: false },
    hurricane: { name: "Hurricane", models: ["HFAI", "HFBI", "HWFI", "HMNI"], on: false },
    simple: { name: "Statistical", models: ["TABS", "TABM", "TABD", "XTRP", "CLP5"], on: false },
  };
  const MODEL_COLORS = {
    TVCN: "#4ad1ff", IVCN: "#7fe3ff", HCCA: "#2fb8ff", RVCN: "#9fd8ff",
    AVNI: "#7ee08a", EMXI: "#ff7aa8", EGRI: "#ffb86b", UKXI: "#e6e07a", CMCI: "#ff9b5e", NVGI: "#b5f07a", CTCI: "#8af0d0", AEMI: "#a9e6a0", CEMI: "#ffc58f",
    HFAI: "#c9a0ff", HFBI: "#a98bff", HWFI: "#e6a0ff", HMNI: "#d68bff",
    TABS: "#8a93b5", TABM: "#a7afcd", TABD: "#c4cae0", XTRP: "#7c84a6", CLP5: "#b0b6cc",
  };
  const MODEL_GROUP_OF = Object.fromEntries(Object.entries(MODEL_GROUPS).flatMap(([g, d]) => d.models.map((m) => [m, g])));

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const hhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
  const dayZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCDate())}/${hhmmZ(iso)}`; };
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ll = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
  const compass = (d) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d / 22.5) % 16];
  const mph = (kt) => Math.round(kt * 1.15078);
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 60) return `${Math.max(m, 0)} min ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const isLive = (m) => Date.now() - new Date(m.last) < 40 * 60000;

  const state = {
    data: null,
    nhc: {},          // bin -> { points, cone, track, ww, past, radii }
    gtwo: null,
    layerIds: null,
    basin: "ALL",
    selected: null,
    tab: "forecast",
    on: { cone: true, ww: true, models: true, past: true, recon: true, outlook: true, radii: false, sat: true, windprob: false, arrival: false, surge: false, rain: false, ero: false, sst: false, buoys: false },
    windKt: 34,
    mode: "active",
    hist: { data: {}, q: "", selected: null, near: null },
    groupsOn: Object.fromEntries(Object.entries(MODEL_GROUPS).map(([k, v]) => [k, v.on])),
    sat: { kind: "ir", times: [], layers: [], idx: 0, timer: null, opacity: 0.85 },
    fitted: false,
  };

  // Restore selection from the URL (#ep212026) so a view can be shared.
  const hashId = location.hash.slice(1).toLowerCase();
  const pastHash = /^past-(al|ep|cp)\d{6}$/.test(hashId) ? hashId.slice(5).toUpperCase() : null;
  if (/^(al|ep|cp)\d{6}$/.test(hashId)) state.selected = hashId;

  // —— Map ————————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: false, minZoom: 2, maxZoom: 11, worldCopyJump: false }).fitBounds(BASIN_BOUNDS.ALL);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["satW", 250], ["satE", 251], ["sst", 255], ["outlook", 380], ["cone", 400], ["radii", 410], ["lines", 420], ["recon", 600], ["points", 620], ["labels", 640]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.8 }).addTo(map);
  map.attributionControl.addAttribution("NOAA/NHC · GOES via NASA GIBS · ATCF");

  const layers = {
    hist: L.layerGroup(),
    outlook: L.layerGroup().addTo(map),
    storms: L.layerGroup().addTo(map),   // cones, tracks, warnings — rebuilt on selection
    models: L.layerGroup().addTo(map),
    recon: L.layerGroup().addTo(map),
    buoys: L.layerGroup().addTo(map),
    markers: L.layerGroup().addTo(map),
  };

  function setStatus(msg) { $("status").textContent = msg || ""; $("status").hidden = !msg; }

  function glyph(kt, size = 24, invest = false) {
    if (invest) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;overflow:visible"><circle cx="12" cy="12" r="6" fill="none" stroke="#060818" stroke-width="4.5" opacity=".7"/><circle cx="12" cy="12" r="6" fill="none" stroke="#cfd5ef" stroke-width="2" stroke-dasharray="3 2.4"/><circle cx="12" cy="12" r="1.8" fill="#cfd5ef"/></svg>`;
    }
    const c = ssColor(kt);
    const arms = kt >= 34 ? `<path d="M12 8.6C12 4.3 15.6 2.6 19.4 3.1M12 15.4C12 19.7 8.4 21.4 4.6 20.9" fill="none" stroke-linecap="round"/>` : "";
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;overflow:visible" aria-hidden="true">
      <g stroke="#060818" stroke-width="5.2" opacity=".75">${arms}<circle cx="12" cy="12" r="3.6" fill="#060818"/></g>
      <g stroke="${c}" stroke-width="2.4">${arms}<circle cx="12" cy="12" r="3.4" fill="${kt >= 64 ? c : "#0b0f26"}"/></g></svg>`;
  }

  function popup(title, rows) {
    return `<h4>${esc(title)}</h4><table>${rows.filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
  }

  // —— Satellite ———————————————————————————————————————————————————
  const satUrl = (sat, side, time) => `${GIBS}/GOES-${side}_${sat.product}/default/${time}/GoogleMapsCompatible_Level${sat.level}/{z}/{y}/{x}.png`;

  async function tileExists(sat, side, time) {
    // One zoom-2 tile inside each disk: x=0 spans 180°–90°W (West), x=1 spans 90°W–0° (East).
    const url = satUrl(sat, side, time).replace("{z}/{y}/{x}", `2/1/${side === "West" ? 0 : 1}`);
    try { return (await fetch(url, { cache: "no-store" })).ok; } catch { return false; }
  }

  // GIBS returns 404 for frames not yet processed. Find the newest frame both satellites have,
  // then step back one more: the newest frame is often still filling in at higher zooms.
  async function satNewest(sat) {
    let t = Math.floor(Date.now() / SAT_STEP) * SAT_STEP - SAT_STEP;
    for (let i = 0; i < 18; i++, t -= SAT_STEP) {
      const time = isoMin(t);
      const [e, w] = await Promise.all([tileExists(sat, "East", time), tileExists(sat, "West", time)]);
      if (e && w) return t - SAT_STEP;
    }
    throw new Error("no recent frames");
  }

  function clipSat(x) {
    map.getPane("satE").style.clipPath = `polygon(${x}px -100000px, 100000px -100000px, 100000px 100000px, ${x}px 100000px)`;
  }
  map.on("zoomend moveend viewreset resize", () => clipSat(map.latLngToLayerPoint([0, SAT_SPLIT_LON]).x));
  map.on("zoomanim", (e) => clipSat(map._latLngToNewLayerPoint(L.latLng(0, SAT_SPLIT_LON), e.zoom, e.center).x));
  clipSat(map.latLngToLayerPoint([0, SAT_SPLIT_LON]).x);

  // GIBS generates tiles on first request and can briefly answer 404. Retry each tile once,
  // then fall back to the previous one or two frames so the map never shows holes.
  const GibsLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("img");
      tile.alt = "";
      tile.setAttribute("role", "presentation");
      const url = this.getTileUrl(coords);
      const t = Date.parse(this.options.time);
      const urls = [url, url, ...[1, 2].map((k) => url.replace(this.options.time, isoMin(t - k * SAT_STEP)))];
      let i = 0;
      tile.onload = () => done(null, tile);
      tile.onerror = () => {
        if (++i >= urls.length) { done(new Error("tile unavailable"), tile); return; }
        setTimeout(() => { tile.src = urls[i]; }, i === 1 ? 2500 : 0);
      };
      tile.src = urls[0];
      return tile;
    },
  });

  function satFrame(sat, time, opacity) {
    const opts = (pane) => ({ pane, opacity, time, maxNativeZoom: sat.level, maxZoom: 16, attribution: "" });
    const frame = L.layerGroup([new GibsLayer(satUrl(sat, "West", time), opts("satW")), new GibsLayer(satUrl(sat, "East", time), opts("satE"))]);
    frame.setOpacity = (o) => frame.eachLayer((l) => l.setOpacity(o));
    return frame;
  }

  function clearSat() {
    satLoop(false);
    state.sat.layers.forEach((l) => l.remove());
    state.sat.layers = [];
    state.sat.times = [];
  }

  async function loadSat(force) {
    const s = state.sat;
    if (!state.on.sat) { clearSat(); $("t1").textContent = "Satellite off"; $("t0").textContent = ""; return; }
    const sat = SAT[s.kind];
    const kind = s.kind;
    if (force) $("t1").textContent = `${sat.name} loading…`;
    try {
      const newest = await satNewest(sat);
      if (kind !== s.kind || !state.on.sat || state.mode === "past") return;   // Past storms hides today's satellite
      const times = Array.from({ length: SAT_FRAMES }, (_, i) => isoMin(newest - (SAT_FRAMES - 1 - i) * SAT_STEP));
      if (!force && times[times.length - 1] === s.times[s.times.length - 1]) return;   // nothing new
      clearSat();
      s.times = times;
      s.layers = times.map((t, i) => satFrame(sat, t, i === times.length - 1 ? s.opacity : 0));
      s.idx = times.length - 1;
      s.layers[s.idx].addTo(map);   // the rest load when the loop or scrubber reaches them
      $("frame").max = times.length - 1;
      $("frame").value = s.idx;
      $("t0").textContent = hhmmZ(times[0]);
      satLabel();
    } catch {
      if (kind === s.kind) $("t1").textContent = `${sat.name} unavailable`;
    }
  }

  function satLabel() {
    const s = state.sat;
    const t = s.times[s.idx];
    if (t) $("t1").textContent = `GOES ${SAT[s.kind].name} ${hhmmZ(t)}`;
  }

  function satShow(i) {
    const s = state.sat;
    const n = s.layers.length;
    if (!n) return;
    const next = (i + n) % n;
    if (!map.hasLayer(s.layers[next])) s.layers[next].addTo(map);
    s.layers[next].setOpacity(s.opacity);
    s.layers.forEach((l, j) => { if (j !== next) l.setOpacity(0); });
    s.idx = next;
    $("frame").value = next;
    satLabel();
  }

  function satLoop(force) {
    const s = state.sat;
    const playing = force ?? !s.timer;
    clearInterval(s.timer);
    s.timer = null;
    $("play").textContent = playing ? "❚❚" : "▶";
    $("play").setAttribute("aria-label", playing ? "Pause satellite loop" : "Play satellite loop");
    if (!playing || !s.layers.length) return;
    s.layers.forEach((l) => { if (!map.hasLayer(l)) l.addTo(map); });   // preload every frame
    let hold = 0;
    s.timer = setInterval(() => {
      if (s.idx === s.layers.length - 1 && hold++ < 2) return;   // pause on the newest frame
      hold = 0;
      satShow(s.idx + 1);
    }, 500);
  }

  $("play").onclick = () => satLoop();
  $("frame").oninput = (e) => { satLoop(false); satShow(+e.target.value); };
  $("satpick").addEventListener("click", (e) => {
    const k = e.target.dataset?.sat;
    if (!k) return;
    state.sat.kind = k;
    document.querySelectorAll("#satpick button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sat === k));
    if (!state.on.sat) { state.on.sat = true; document.querySelector('[data-layer="sat"]').checked = true; }
    loadSat(true);
  });

  // —— NHC MapServer —————————————————————————————————————————————————
  async function msQuery(id) {
    if (id == null) return null;
    const res = await fetch(`${MS}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&_=${Math.floor(Date.now() / 120000)}`);
    if (!res.ok) throw new Error(`MapServer ${id}: ${res.status}`);
    const gj = await res.json();
    if (gj.error) throw new Error(gj.error.message);
    return gj;
  }

  async function loadNhc() {
    if (!state.layerIds) {
      const info = await (await fetch(`${MS}?f=json`)).json();
      state.layerIds = Object.fromEntries(info.layers.map((l) => [l.name.trim(), l.id]));
    }
    const ids = state.layerIds;
    const name = (bin, s) => ids[`${bin} ${s}`];
    const points = await Promise.all(BINS.map((b) => msQuery(name(b, "Forecast Points")).catch(() => null)));
    const nhc = {};
    await Promise.all(BINS.map(async (bin, i) => {
      if (!points[i]?.features?.length) return;
      const [cone, track, ww, past, radii] = await Promise.all(
        ["Forecast Cone", "Forecast Track", "Watch-Warning", "Past Track", "Advisory Wind Field"].map((s) => msQuery(name(bin, s)).catch(() => null)));
      nhc[bin] = { points: points[i], cone, track, ww, past, radii };
    }));
    const [areas, pts] = await Promise.all([ids["Seven-Day: Potential Development Region"], ids["Seven-Day: Current Location"]].map((id) => msQuery(id).catch(() => null)));
    state.nhc = nhc;
    state.gtwo = { areas, pts };
  }

  // —— Systems list ———————————————————————————————————————————————————
  function systems() {
    const d = state.data;
    if (!d) return [];
    const atcf = Object.fromEntries((d.systems || []).map((s) => [s.id, s]));
    const list = (d.storms || []).map((s) => ({ ...s, kind: "storm", basin: s.id.slice(0, 2).toUpperCase(), atcf: atcf[s.id] }));
    for (const s of d.systems || []) {
      if (s.kind !== "invest" || !s.best.length) continue;
      const last = s.best[s.best.length - 1];
      list.push({ id: s.id, kind: "invest", basin: s.basin, name: s.name, classification: last.ty, intensity: last.vmax,
        pressure: last.mslp, lat: last.lat, lon: last.lon, lastUpdate: last.t, atcf: s });
    }
    return list.sort((a, b) => (a.kind === b.kind ? (b.intensity || 0) - (a.intensity || 0) : a.kind === "storm" ? -1 : 1));
  }

  // 7-day outlook areas, named from the outlook text where the 7-day chance matches.
  function outlookAreas() {
    const feats = state.gtwo?.areas?.features || [];
    const texts = state.data?.outlooks || [];
    return feats.map((f, i) => {
      const p = f.properties;
      const basin = /atl/i.test(p.basin || "") ? "AL" : /cent/i.test(p.basin || "") ? "CP" : "EP";
      const text = (texts.find((o) => o.basin === basin) || {}).text || "";
      const pct = String(p.prob7day || "").replace("%", "");
      const para = text.split(/\n\s*\n/).find((x) => new RegExp(`7 days\\.\\.\\.\\w+\\.\\.\\.(near )?${pct} percent`).test(x));
      const title = para ? para.split("\n")[0].replace(/[:.]\s*$/, "").trim() : "Area of interest";
      return { id: `area${i}`, basin, title, p, feature: f, text: para || "" };
    });
  }

  const inBasin = (b) => state.basin === "ALL" || state.basin === b;

  function catName(p) {
    if (p.dvlbl === "H" || p.dvlbl === "M") return `Cat ${ssLabel(p.maxwind)}`;
    if (p.dvlbl === "S") return "TS";
    if (p.dvlbl === "D") return "TD";
    return (p.tcdvlp || "").replace("Post-Tropical Cyclone", "Post-trop").replace("Remnant Low", "Remnant") || "—";
  }

  // Intensity guidance: NHC official forecast over a grey envelope of the intensity aids.
  function intensityChart(s, H = 150) {
    const tr = s.atcf?.models?.tracks;
    if (!tr) return "";
    const W = 336, L0 = 30, B0 = 20, R0 = 6, T0 = 8;
    const all = Object.entries(tr).filter(([k, v]) => k !== "OFCI" && v.some((p) => p.vmax)).map(([, v]) => v.filter((p) => p.tau <= 120 && p.vmax));
    const off = (tr.OFCI || []).filter((p) => p.tau <= 120 && p.vmax);
    const vals = all.flat().concat(off).map((p) => p.vmax);
    if (!vals.length) return "";
    const hi = Math.ceil(Math.max(...vals) / 20) * 20 + 10;
    const x = (t) => L0 + t / 120 * (W - L0 - R0), y = (v) => T0 + (1 - v / hi) * (H - T0 - B0);
    const mono = 'font-family="IBM Plex Mono, monospace" font-size="10" fill="rgba(255,255,255,.4)"';
    let svg = "";
    for (let v = 0; v <= hi; v += 20) svg += `<line x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.07)"/><text x="${L0 - 6}" y="${y(v) + 3}" text-anchor="end" ${mono}>${v}</text>`;
    for (let t = 0; t <= 120; t += 24) svg += `<text x="${x(t)}" y="${H - 5}" text-anchor="middle" ${mono}>${t}h</text>`;
    [[34, "TS"], [64, "Hurricane"], [96, "Major"]].forEach(([v, t]) => {
      if (v < hi) svg += `<line x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,.22)" stroke-dasharray="2 4"/><text x="${W - R0}" y="${y(v) - 4}" text-anchor="end" font-size="10" fill="rgba(255,255,255,.45)">${t}</text>`;
    });
    const line = (pts) => pts.map((p) => `${x(p.tau).toFixed(1)},${y(p.vmax).toFixed(1)}`).join(" ");
    all.forEach((pts) => { svg += `<polyline fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1" points="${line(pts)}"/>`; });
    if (off.length) svg += `<polyline fill="none" stroke="#4ad1ff" stroke-width="2.2" stroke-linejoin="round" points="${line(off)}"/>`;
    return `<h5 class="sub">Intensity guidance (kt)</h5><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block" role="img" aria-label="Intensity guidance for ${esc(s.name)}">${svg}</svg>
      <p class="chart-key">${off.length ? '<span style="color:#4ad1ff">━</span> NHC official &nbsp; ' : ""}<span style="color:rgba(255,255,255,.4)">━</span> ${all.length} models · ${hhmmZ(s.atcf.models.cycle)} cycle</p>`;
  }

  function stormRecon(s) {
    const r = state.data.recon || {};
    const key = (s.name || "").toUpperCase().split(" ").pop();
    const invTag = s.id.slice(2, 4) + s.id[1].toUpperCase();
    const pod = (state.data.tcpod?.basins || []).flatMap((b) => b.systems)
      .filter((x) => x.name.toUpperCase().includes(key) || x.name.toUpperCase().includes(invTag));
    return {
      vortex: (r.vortex || []).filter((v) => v.storm.toLowerCase() === s.id),
      missions: (r.missions || []).filter((m) => m.storm.toUpperCase().includes(key) || m.missionId.includes(invTag)),
      flights: pod.flatMap((x) => x.flights),
    };
  }

  function tabForecast(s) {
    const pts = (state.nhc[s.bin]?.points?.features || []).map((f) => f.properties).sort((a, b) => a.tau - b.tau);
    const rc = stormRecon(s);
    let html = intensityChart(s);
    if (pts.length) {
      html += `<h5 class="sub">NHC forecast</h5>`;
      html += `<table class="fc"><thead><tr><th>Valid</th><th>Wind</th><th>Stage</th></tr></thead><tbody>${pts.map((p) => `<tr>
        <td>${p.tau === 0 ? "Now" : `${p.tau} h`} <span class="dim">${esc(String(p.validtime || "").replace("/", " "))}Z</span></td>
        <td>${p.maxwind} kt</td>
        <td><span class="cat" style="background:${ssColor(p.maxwind)}"></span>${esc(catName(p))}</td></tr>`).join("")}</tbody></table>`;
    } else if (s.kind === "invest") {
      const last = s.atcf.best.slice(-5).reverse();
      html += `<table class="fc"><thead><tr><th>Best track</th><th>Wind</th><th>Pressure</th></tr></thead><tbody>${last.map((p) =>
        `<tr><td>${dayZ(p.t)} <span class="dim">${esc(p.ty)}</span></td><td>${p.vmax ?? "—"} kt</td><td>${p.mslp ? `${p.mslp} mb` : "—"}</td></tr>`).join("")}</tbody></table>
        <p class="note">Invests have no NHC forecast. Model tracks show ATCF guidance.</p>`;
    } else {
      html += `<p class="note">Forecast points are loading from NHC.</p>`;
    }
    const v = rc.vortex[0];
    if (v) html += `<p class="note"><b>Recon</b> ${dayZ(v.t)} fix: ${esc(v.slpNote.toLowerCase())}${v.maxFl ? `, ${v.maxFl} kt flight-level` : ""}${v.eye ? `, eye ${esc(v.eye.toLowerCase())}` : ""}.</p>`;
    if (rc.flights.length) html += `<p class="note"><b>Tasked</b> ${rc.flights.map((f) => `${esc(f.aircraft)}, ${esc((f.fields.profile || "mission").toLowerCase())} at ${esc(f.fields.fixTime || "")}`).join("; ")}.</p>`;
    return html;
  }

  function tabGuidance(s) {
    const m = s.atcf?.models;
    if (!m) return `<p class="note">No ATCF guidance available.</p>`;
    const present = Object.keys(m.tracks).filter((t) => MODEL_GROUP_OF[t]);
    return `<p class="note" style="margin-top:0">Track guidance from the ${new Date(m.cycle).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${hhmmZ(m.cycle)} cycle. Choose which model families appear on the map.</p>
      <div class="models" style="margin-top:.6rem">${Object.entries(MODEL_GROUPS).map(([k, g]) =>
        `<label><input type="checkbox" data-group="${k}" ${state.groupsOn[k] ? "checked" : ""}/> ${g.name}</label>`).join("")}</div>
      <h5 class="sub">Models in this cycle</h5>
      <div class="models">${present.map((t) => `<span style="opacity:${state.groupsOn[MODEL_GROUP_OF[t]] ? 1 : 0.35}"><i style="background:${MODEL_COLORS[t]}"></i>${t}</span>`).join("")}</div>
      ${intensityChart(s)}`;
  }

  function tabRecon(s) {
    const rc = stormRecon(s);
    let html = "";
    if (rc.flights.length) {
      html += `<h5 class="sub" style="margin-top:0">Tasked · TCPOD ${esc(state.data.tcpod?.number || "")}</h5>` + rc.flights.map((f) => `<div class="flight"><b>${esc(f.aircraft)}</b>
        <dl class="kv"><dt>Profile</dt><dd>${esc(f.fields.profile)}</dd><dt>Fix time</dt><dd>${esc(f.fields.fixTime)}</dd><dt>Departs</dt><dd>${esc(f.fields.departure)}</dd>
        <dt>On station</dt><dd>${esc(f.fields.onStation)}</dd><dt>Position</dt><dd>${esc(f.fields.position)}</dd><dt>Altitude</dt><dd>${esc(f.fields.altitude)}</dd><dt>Mission</dt><dd>${esc(f.fields.mission)}</dd></dl></div>`).join("");
    }
    if (rc.missions.length) {
      html += `<h5 class="sub">Flights · last 12 h</h5>` + rc.missions.map((m) => {
        const o = m.obs[m.obs.length - 1];
        return `<div class="flight"><b>${esc(m.aircraft)} ${esc(m.missionId)}</b>${isLive(m) ? '<span class="live">LIVE</span>' : ""}
          <dl class="kv"><dt>Last report</dt><dd>${hhmmZ(o.t)} · ${ago(o.t)}</dd><dt>Position</dt><dd>${ll(o.lat, o.lon)}</dd>
          <dt>Max FL wind</dt><dd>${m.maxFl ? `${m.maxFl.wspd} kt at ${hhmmZ(m.maxFl.t)}` : "—"}</dd><dt>Max SFMR</dt><dd>${m.maxSfmr ? `${m.maxSfmr.sfmr} kt at ${hhmmZ(m.maxSfmr.t)}` : "—"}</dd></dl></div>`;
      }).join("");
    }
    if (rc.vortex.length) {
      html += `<h5 class="sub">Vortex fixes</h5><table class="fc"><thead><tr><th>Time</th><th>Pressure</th><th>FL wind</th></tr></thead><tbody>${rc.vortex.slice(0, 6).map((v) =>
        `<tr><td>${dayZ(v.t)}</td><td>${v.slp ? `${v.slp} mb` : "—"}</td><td>${v.maxFl ? `${v.maxFl} kt` : "—"}</td></tr>`).join("")}</tbody></table>`;
    }
    if (!html) html = `<p class="note" style="margin-top:0">No reconnaissance tasked or reported for ${esc(s.name)} in the last 36 hours.</p>`;
    const pod = state.data.tcpod;
    if (pod) html += `<details class="more"><summary>Full plan of the day (${esc(pod.number || "")})</summary><pre class="raw">${esc(pod.text)}</pre></details>`;
    return html;
  }

  function tabProducts(s) {
    const L0 = s.links || {};
    if (s.kind === "invest") return `<p class="note" style="margin-top:0">NHC doesn't issue advisories for invests. See the <a href="https://www.nhc.noaa.gov/gtwo.php" target="_blank" rel="noopener">tropical weather outlook</a>.</p>`;
    const link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : "");
    return `<dl class="kv" style="margin-top:0"><dt>Advisory</dt><dd>${esc(s.advisory || "—")} · ${dayZ(s.lastUpdate)}</dd><dt>Position</dt><dd>${s.lat != null ? ll(s.lat, s.lon) : "—"}</dd>
      <dt>Movement</dt><dd>${s.movementSpeed ? `${compass(s.movementDir)} ${s.movementSpeed} kt` : "Stationary"}</dd><dt>Max wind</dt><dd>${s.intensity} kt · ${mph(s.intensity)} mph</dd></dl>
      <div class="links">${link(L0.public, "Public advisory")}${link(L0.discussion, "Discussion")}${link(L0.forecast, "Forecast advisory")}${link(L0.windProbs, "Wind probabilities")}${link(L0.graphics, "NHC graphics")}</div>`;
  }

  // —— NHC layers drawn by the map service (official colors) ——————————————————
  // ArcGIS "export" renders the requested layers as an image; one request per 256-px map tile.
  const NhcExport = L.TileLayer.extend({
    getTileUrl(c) {
      const size = this.getTileSize();
      const nw = map.unproject([c.x * size.x, c.y * size.y], c.z);
      const se = map.unproject([(c.x + 1) * size.x, (c.y + 1) * size.y], c.z);
      const a = L.CRS.EPSG3857.project(nw), b = L.CRS.EPSG3857.project(se);
      return `${this.options.base}/export?bbox=${a.x},${b.y},${b.x},${a.y}&bboxSR=3857&imageSR=3857&size=${size.x},${size.y}&layers=show:${this.options.ids}&format=png32&transparent=true&dpi=96&f=image&_=${this.options.stamp}`;
    },
  });
  const nhcLayers = {};
  const NhcLegend = L.Control.extend({ options: { position: "bottomright" }, onAdd() { const d = L.DomUtil.create("div", "maplegend"); d.id = "nhcLegend"; return d; } });
  new NhcLegend().addTo(map);
  // Image layers drawn by NOAA map services: NHC products for current storms, and WPC rainfall.
  const EXPORT_KINDS = ["windprob", "arrival", "surge", "rain", "ero"];
  const exportBase = (kind) => (kind === "rain" ? WPC_QPF : kind === "ero" ? WPC_ERO : MS);
  function nhcIds(kind) {
    const ids = state.layerIds || {};
    const bins = Object.keys(state.nhc);
    if (kind === "windprob") return [{ 34: 395, 50: 396, 64: 397 }[state.windKt]];
    if (kind === "arrival") return bins.map((b) => ids[`${b} Most Likely Arrival Time`]).filter((x) => x != null);
    if (kind === "surge") return bins.filter((b) => b.startsWith("AT")).map((b) => ids[`Image_Inun_${b}`]).filter((x) => x != null);
    if (kind === "rain") return [11];   // QPF 168 Hour Day 1-7
    if (kind === "ero") return [0];     // Excessive Rainfall Day 1
    return [];
  }
  function drawNhcLayers() {
    for (const kind of EXPORT_KINDS) {
      nhcLayers[kind]?.remove();
      delete nhcLayers[kind];
      const ids = nhcIds(kind);
      if (!state.on[kind] || state.mode !== "active" || !ids.length) continue;
      nhcLayers[kind] = new NhcExport("", { base: exportBase(kind), ids: ids.join(","), stamp: Math.floor(Date.now() / 600000), pane: "radii", opacity: kind === "windprob" || kind === "rain" ? 0.6 : 0.85, attribution: "" }).addTo(map);
    }
    drawNhcLegend();
  }
  // Legend swatches come from the map service too.
  const legends = {};
  const legendFor = (base) => (legends[base] ||= fetch(`${base}/legend?f=json`).then((r) => r.json()).then((d) => Object.fromEntries(d.layers.map((l) => [l.layerId, l]))).catch(() => ({})));
  async function drawNhcLegend() {
    const el = $("nhcLegend");
    if (!el) return;
    const want = EXPORT_KINDS.filter((k) => state.on[k] && state.mode === "active");
    const sst = state.on.sst ? `<h5 class="sub">Sea surface temperature (°C)</h5><div class="key"><span>Cooler</span><span style="display:inline-block;width:7rem;height:.55rem;border-radius:3px;vertical-align:middle;background:linear-gradient(90deg,#3b2aa0,#2f7fd1,#3fd0c8,#9be15d,#ffe14d,#ff8a2a,#d7301f)"></span><span>Warmer</span></div><p class="note" style="margin:.2rem 0 0">Hurricanes need about 26 °C or warmer. NASA GHRSST MUR, daily.</p>` : "";
    if (!want.length) { el.innerHTML = sst; return; }
    const lgs = Object.fromEntries(await Promise.all([...new Set(want.map(exportBase))].map(async (b) => [b, await legendFor(b)])));
    const titles = { windprob: `Chance of ${state.windKt}-kt winds (5 days)`, arrival: "Most likely arrival of TS-force winds", surge: "Peak storm surge (ft above ground)", rain: "WPC rainfall forecast, 7 days (in)", ero: "Flash flood risk today (WPC)" };
    el.innerHTML = sst + want.map((k) => {
      const ids = nhcIds(k);
      if (!ids.length) return `<h5 class="sub">${titles[k]}</h5><p class="note" style="margin:0">Not issued for current storms.</p>`;
      const lg = lgs[exportBase(k)][ids[0]];
      const items = (lg?.legend || []).filter((x) => x.label !== "0");
      return `<h5 class="sub">${titles[k]}</h5><div class="key">${(k === "rain" ? items.slice().reverse() : items).slice(0, k === "rain" ? 18 : 11).map((x) => `<span><img alt="" src="data:${x.contentType};base64,${x.imageData}" width="14" height="14" style="vertical-align:-3px;margin-right:.3rem">${esc(x.label || "")}</span>`).join("")}</div>`;
    }).join("");
  }
  $("windkt").addEventListener("click", (e) => {
    const v = +e.target.closest("[data-kt]")?.dataset.kt;
    if (!v) return;
    state.windKt = v;
    document.querySelectorAll("#windkt [data-kt]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.kt === v));
    if (!state.on.windprob) { state.on.windprob = true; document.querySelector('[data-layer="windprob"]').checked = true; }
    drawNhcLayers();
  });

  // —— Past storms (NOAA/NHC HURDAT2) ——————————————————————————————————————
  const histFile = (b) => (b === "AL" ? "atl" : "pac");
  async function loadHurdat(file) {
    if (!state.hist.data[file]) {
      state.hist.data[file] = fetch(`hurdat/${file}.json`).then((r) => r.json()).then((d) => {
        d.storms.forEach((st) => { st.basin = st.id.slice(0, 2); });
        return d;
      });
    }
    return state.hist.data[file];
  }
  async function histStorms() {
    const files = state.basin === "ALL" ? ["atl", "pac"] : [histFile(state.basin)];
    const sets = await Promise.all(files.map(loadHurdat));
    return sets.flatMap((d) => d.storms).filter((st) => state.basin === "ALL" || st.basin === state.basin);
  }
  const ptTime = (n) => { const s2 = String(n); return Date.UTC(+s2.slice(0, 4), +s2.slice(4, 6) - 1, +s2.slice(6, 8), +s2.slice(8, 10), +s2.slice(10, 12)); };
  const ptLabel = (n) => { const d = new Date(ptTime(n)); return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
  const STATUS = { HU: "Hurricane", TS: "Tropical storm", TD: "Tropical depression", EX: "Extratropical", SD: "Subtropical depression", SS: "Subtropical storm", LO: "Low", WV: "Wave", DB: "Disturbance" };
  const catOf = (kt) => (kt == null ? "—" : kt >= 64 ? `Cat ${ssLabel(kt)}` : kt >= 34 ? "TS" : "TD");

  function histRow(st) {
    const sel = state.hist.selected?.id === st.id;
    const first = st.pts[0], last = st.pts[st.pts.length - 1];
    return `<div class="sys${sel ? " sel" : ""}"><button class="sys__row" data-hstorm="${esc(st.id)}">
        ${glyph(st.peak, 24)}
        <span class="sys__name">${esc(st.name)}<small>${esc(st.id)} · ${ptLabel(first[0]).replace(/ \d{4}Z$/, "")} – ${ptLabel(last[0]).replace(/, \d{4} \d{4}Z$/, "")}${st.landfall ? " · landfall" : ""}${st.near != null ? ` · ${Math.round(st.near * 0.621)} mi away` : ""}</small></span>
        <span class="sys__nums"><b>${st.peak ?? "—"}</b> kt<br>${st.minp ? `${st.minp} mb` : "—"}</span></button>${sel ? histDetail(st) : ""}</div>`;
  }

  function histDetail(st) {
    const lf = st.pts.filter((p) => p[6] === "L");
    return `<div class="detail">
      <dl class="kv"><dt>Peak</dt><dd>${st.peak ?? "—"} kt · ${catOf(st.peak)}${st.peak ? ` · ${mph(st.peak)} mph` : ""}</dd><dt>Lowest pressure</dt><dd>${st.minp ? `${st.minp} mb` : "not recorded"}</dd>
        <dt>Track</dt><dd>${ptLabel(st.pts[0][0])} – ${ptLabel(st.pts[st.pts.length - 1][0])}</dd></dl>
      ${lf.length ? `<h5 class="sub">Landfalls</h5><table class="fc"><tbody>${lf.map((p) => `<tr><td>${ptLabel(p[0])}</td><td>${ll(p[1], p[2])}</td><td>${p[3]} kt · ${catOf(p[3])}</td></tr>`).join("")}</tbody></table>` : `<p class="note">No landfall in the record.</p>`}
      <details class="more"><summary>All ${st.pts.length} best-track points</summary><table class="fc" style="margin-top:.4rem"><thead><tr><th>Time</th><th>Position</th><th>Wind</th><th>Pressure</th></tr></thead><tbody>
        ${st.pts.map((p) => `<tr><td>${ptLabel(p[0])}<span class="dim"> ${esc(p[5])}</span></td><td>${ll(p[1], p[2])}</td><td>${p[3] ?? "—"}</td><td>${p[4] ?? "—"}</td></tr>`).join("")}</tbody></table></details>
      ${wwHtml(st)}
      <p class="note">NOAA/NHC HURDAT2 best track. <a href="https://www.nhc.noaa.gov/data/tcr/" target="_blank" rel="noopener">Tropical Cyclone Reports ↗</a></p></div>`;
  }

  // —— Wind or water: when hurricane winds and the storm surge reached a place, for a past storm ————————————
  // Wind is estimated hour by hour from the HURDAT2 best track: its maximum wind, radius of maximum wind and the
  // 34/50/64-kt wind radii by quadrant (2004 on), interpolated between six-hourly fixes. Water comes from the nearest
  // NOAA CO-OPS tide gauge (observed level, predicted tide, and the surge as the difference), and the ground height
  // at the place from the USGS Elevation Point Query Service.
  const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const NM_KM = 1.852;
  state.ww = null;   // { key, status, wind, gauge, water, ground }

  async function loadRadii(file) {
    state.hist.radii ||= {};
    if (!state.hist.radii[file]) state.hist.radii[file] = fetch(`hurdat/${file}-radii.json`).then((r) => r.json()).then((d) => d.radii).catch(() => ({}));
    return state.hist.radii[file];
  }

  /** Estimated 1-minute sustained wind (kt) at distance rKm and bearing (degrees from the center) for one fix. */
  function windAt(fix, rKm, brg) {
    const v0 = fix.v;
    if (v0 == null) return null;
    const q = Math.floor((((brg % 360) + 360) % 360) / 90);   // 0 NE, 1 SE, 2 SW, 3 NW
    const rad = (k) => (fix.radii && fix.radii[k * 4 + q] > 0 ? fix.radii[k * 4 + q] * NM_KM : null);
    const rm = Math.max(8, Math.min(150, (fix.radii?.[12] > 0 ? fix.radii[12] : v0 >= 64 ? 20 : 35) * NM_KM));
    if (rKm <= rm) return v0 * Math.max(0, rKm / rm);
    const anchors = [[rm, v0]];
    [[2, 64], [1, 50], [0, 34]].forEach(([k, kt]) => { const r = rad(k); if (r && kt < anchors[anchors.length - 1][1] && r > anchors[anchors.length - 1][0]) anchors.push([r, kt]); });
    for (let i = 0; i + 1 < anchors.length; i++) {
      const [r1, w1] = anchors[i], [r2, w2] = anchors[i + 1];
      if (rKm <= r2) { const f = Math.log(rKm / r1) / Math.log(r2 / r1); return w1 + (w2 - w1) * f; }
    }
    const [rl, wl] = anchors[anchors.length - 1];
    return wl * Math.pow(rl / rKm, anchors.length > 1 ? 0.75 : 0.5);
  }

  function windTimeline(st, radii, lat, lon) {
    const fixes = st.pts.map((p, i) => ({ t: ptTime(p[0]), lat: p[1], lon: p[2], v: p[3], status: p[5], radii: radii?.[i] || null }));
    const out = [];
    for (let i = 0; i + 1 < fixes.length; i++) {
      const a = fixes[i], b = fixes[i + 1];
      for (let t = Math.ceil(a.t / 3600e3) * 3600e3; t < b.t || (i + 2 === fixes.length && t <= b.t); t += 3600e3) {
        const f = (t - a.t) / Math.max(1, b.t - a.t);
        const mix = (x, y) => (x == null || y == null ? x ?? y : x + (y - x) * f);
        const fix = { v: mix(a.v, b.v), radii: a.radii && b.radii ? a.radii.map((x, k) => mix(x, b.radii[k])) : a.radii || b.radii };
        const clat = mix(a.lat, b.lat), clon = mix(a.lon, b.lon);
        const kx = 111.32 * Math.cos((lat * Math.PI) / 180), dx = (lon - clon) * kx, dy = (lat - clat) * 110.57;
        const r = Math.hypot(dx, dy), brg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        out.push({ t, r, kt: windAt(fix, Math.max(1, r), brg), status: a.status });
      }
    }
    return out;
  }
  const spanOf = (tl, kt) => { const on = tl.filter((h) => h.kt >= kt); return on.length ? { from: on[0].t, to: on[on.length - 1].t } : null; };

  async function coopsSeries(id, product, begin, end, datum) {
    const ymdHM = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
    const u = `${COOPS}?product=${product}&station=${id}&begin_date=${encodeURIComponent(ymdHM(begin))}&end_date=${encodeURIComponent(ymdHM(end))}&datum=${datum}&units=english&time_zone=gmt&format=json&application=StandardWeather` + (product === "predictions" ? "&interval=6" : "");
    const d = await (await fetch(u)).json();
    const rows = d.data || d.predictions;
    if (!rows) throw new Error(d.error?.message || "no data");
    return rows.map((r) => ({ t: Date.parse(r.t.replace(" ", "T") + "Z"), v: parseFloat(r.v) })).filter((r) => Number.isFinite(r.v));
  }

  async function loadWindWater(st, place) {
    const key = `${st.id}|${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
    if (state.ww?.key === key) return;
    const ww = state.ww = { key, status: "loading" };
    const radii = (await loadRadii(histFile(st.basin)))[st.id];
    if (state.ww !== ww) return;
    ww.wind = windTimeline(st, radii, place.lat, place.lon);
    ww.radii = !!radii;
    ww.status = "ready";
    renderPast();
    const peak = ww.wind.reduce((m, h) => (!m || h.kt > m.kt ? h : m), null);
    const ts = spanOf(ww.wind, 34);
    const center = ts ? (ts.from + ts.to) / 2 : peak.t;
    const begin = (ts ? ts.from : peak.t) - 18 * 3600e3, end = (ts ? ts.to : peak.t) + 18 * 3600e3;
    // Ground height at the place (USGS 3DEP, feet NAVD88).
    fetch(`https://epqs.nationalmap.gov/v1/json?x=${place.lon.toFixed(5)}&y=${place.lat.toFixed(5)}&units=Feet&wkid=4326&includeDate=false`).then((r) => r.json())
      .then((d) => { const v = parseFloat(d.value); if (state.ww === ww && Number.isFinite(v) && v > -1000) { ww.ground = v; renderPast(); } }).catch(() => {});
    // The nearest tide gauges within 60 miles with data for the storm.
    if (st.year < 1996) { ww.water = { none: "Tide gauge data here starts in 1996." }; renderPast(); return; }
    const gauges = await fetch("hurdat/coops.json").then((r) => r.json()).then((d) => d.stations).catch(() => []);
    const near = gauges.map(([id, name, stt, la, lo]) => ({ id, name: `${name}${stt ? `, ${stt}` : ""}`, lat: la, lon: lo, km: haversine(place.lat, place.lon, la, lo) }))
      .filter((g) => g.km <= 96.6).sort((a, b) => a.km - b.km).slice(0, 4);
    for (const g of near) {
      try {
        const [obs, pred] = await Promise.all([coopsSeries(g.id, "water_level", begin, end, "MHHW"), coopsSeries(g.id, "predictions", begin, end, "MHHW").catch(() => [])]);
        if (state.ww !== ww) return;
        if (obs.length < 10) continue;
        const predAt = new Map(pred.map((p) => [p.t, p.v]));
        obs.forEach((o) => { const p = predAt.get(o.t); o.surge = p == null ? null : o.v - p; });
        const top = obs.reduce((m, o) => (!m || o.v > m.v ? o : m), null);
        const surge = obs.filter((o) => o.surge != null).reduce((m, o) => (!m || o.surge > m.surge ? o : m), null);
        const navd = await coopsSeries(g.id, "water_level", top.t - 600e3, top.t + 600e3, "NAVD").then((r) => r.reduce((m, o) => (m == null || o.v > m ? o.v : m), null)).catch(() => null);
        // A gauge that stops or skips readings mid-storm may have missed the true peak.
        let gapAt = null;
        for (let i = 1; i < obs.length; i++) if (obs[i].t - obs[i - 1].t > 3 * 3600e3) { gapAt = obs[i - 1].t; break; }
        if (!gapAt && end - obs[obs.length - 1].t > 3 * 3600e3 && obs[obs.length - 1].t < Date.now() - 3 * 3600e3) gapAt = obs[obs.length - 1].t;
        ww.water = { gauge: g, obs, top, surge, navd, gapAt, center };
        break;
      } catch { /* try the next gauge */ }
    }
    if (!ww.water) ww.water = { none: near.length ? "The nearest tide gauges have no water levels for this storm (gauges sometimes fail in a major surge)." : "No NOAA tide gauge within 60 miles." };
    if (state.ww === ww) renderPast();
  }
  const haversine = (lat1, lon1, lat2, lon2) => {
    const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  };

  function wwChart(ww) {
    const tl = ww.wind, w = ww.water?.obs ? ww.water : null;
    const ts = spanOf(tl, 34);
    const t0 = (ts ? ts.from : tl[0].t) - 12 * 3600e3, t1 = (ts ? ts.to : tl[tl.length - 1].t) + 12 * 3600e3;
    const hrs = tl.filter((h) => h.t >= t0 && h.t <= t1);
    if (hrs.length < 2) return "";
    const W = 336, H = 150, L0 = 28, R0 = 30, T0 = 8, B0 = 18;
    const x = (t) => L0 + ((t - t0) / (t1 - t0)) * (W - L0 - R0);
    const kmax = Math.max(70, Math.ceil(Math.max(...hrs.map((h) => h.kt || 0)) / 20) * 20);
    const yk = (v) => T0 + (1 - v / kmax) * (H - T0 - B0);
    const wv = w ? w.obs.filter((o) => o.t >= t0 && o.t <= t1) : [];
    const lo = wv.length ? Math.floor(Math.min(0, ...wv.map((o) => o.v))) : 0, hi = wv.length ? Math.ceil(Math.max(2, ...wv.map((o) => o.v))) : 1;
    const yw = (v) => T0 + (1 - (v - lo) / (hi - lo)) * (H - T0 - B0);
    const mono = 'font-family="IBM Plex Mono, monospace" font-size="9" fill="rgba(255,255,255,.42)"';
    let svg = "";
    [34, 64].forEach((k) => { if (k <= kmax) svg += `<line x1="${L0}" x2="${W - R0}" y1="${yk(k)}" y2="${yk(k)}" stroke="rgba(255,255,255,.1)" stroke-dasharray="3 3"/><text x="${L0 - 4}" y="${yk(k) + 3}" text-anchor="end" ${mono}>${k}</text>`; });
    svg += `<text x="${L0 - 4}" y="${yk(kmax) + 8}" text-anchor="end" ${mono}>kt</text>`;
    if (wv.length) for (let v = lo; v <= hi; v += Math.max(1, Math.ceil((hi - lo) / 4))) svg += `<text x="${W - R0 + 4}" y="${yw(v) + 3}" ${mono} fill="#4ad1ff">${v}ft</text>`;
    for (let t = Math.ceil(t0 / 21600e3) * 21600e3; t <= t1; t += 21600e3) {
      const d = new Date(t);
      svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${T0}" y2="${H - B0}" stroke="rgba(255,255,255,.06)"/>`;
      if (d.getUTCHours() % 12 === 0) svg += `<text x="${x(t)}" y="${H - 4}" text-anchor="middle" ${mono}>${d.getUTCHours() === 0 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : "12Z"}</text>`;
    }
    if (wv.length) svg += `<polyline fill="none" stroke="#4ad1ff" stroke-width="1.6" points="${wv.map((o) => `${x(o.t).toFixed(1)},${yw(o.v).toFixed(1)}`).join(" ")}"/>`;
    svg += `<polyline fill="none" stroke="#ffbf47" stroke-width="2" points="${hrs.map((h) => `${x(h.t).toFixed(1)},${yk(h.kt || 0).toFixed(1)}`).join(" ")}"/>`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated wind and water level">${svg}</svg>
      <p class="chart-key"><span style="color:#ffbf47">━</span> estimated sustained wind at the place (kt)${wv.length ? ` <span style="color:#4ad1ff">━</span> water level at the gauge (ft above MHHW)` : ""} · UTC</p>`;
  }

  function wwHtml(st) {
    const place = state.hist.near;
    if (!place) return `<h5 class="sub">Wind or water</h5><p class="note">Click the map or enter a place above to estimate when hurricane winds and the storm surge reached it.</p>`;
    const ww = state.ww;
    if (!ww || ww.status === "loading" || !ww.key.startsWith(`${st.id}|`)) return `<h5 class="sub">Wind or water</h5><p class="note">Working out the winds at ${ll(place.lat, place.lon)}…</p>`;
    const tl = ww.wind;
    const peak = tl.reduce((m, h) => (!m || h.kt > m.kt ? h : m), null);
    const close = tl.reduce((m, h) => (!m || h.r < m.r ? h : m), null);
    const ts = spanOf(tl, 34), hu = spanOf(tl, 64);
    const when = (t) => `${dayZ(t)}`;
    const dur = (s) => `${Math.round((s.to - s.from) / 3600e3) + 1} h`;
    let html = `<h5 class="sub">Wind or water at ${esc(place.label || ll(place.lat, place.lon))}</h5>
      <dl class="kv"><dt>Closest approach</dt><dd>${Math.round(close.r * 0.621)} mi at ${when(close.t)}</dd>
        <dt>Peak wind (est.)</dt><dd>${Math.round(peak.kt)} kt · ${mph(peak.kt)} mph at ${when(peak.t)}</dd>
        <dt>Tropical-storm winds</dt><dd>${ts ? `${when(ts.from)} – ${when(ts.to)} (${dur(ts)})` : "Not reached"}</dd>
        <dt>Hurricane winds</dt><dd>${hu ? `${when(hu.from)} – ${when(hu.to)} (${dur(hu)})` : "Not reached"}</dd>`;
    const w = ww.water;
    if (!w) html += `<dt>Water</dt><dd>Loading the nearest tide gauge…</dd>`;
    else if (w.none) html += `<dt>Water</dt><dd>${esc(w.none)}</dd>`;
    else {
      html += `<dt>Tide gauge</dt><dd>${esc(w.gauge.name)} · ${Math.round(w.gauge.km * 0.621)} mi · NOAA ${esc(w.gauge.id)}</dd>
        <dt>Peak water</dt><dd>${w.top.v.toFixed(1)} ft above MHHW at ${when(w.top.t)}${w.navd != null ? ` (${w.navd.toFixed(1)} ft NAVD88)` : ""}</dd>
        ${w.surge ? `<dt>Peak surge</dt><dd>${w.surge.surge.toFixed(1)} ft above the predicted tide at ${when(w.surge.t)}</dd>` : ""}
        ${w.gapAt ? `<dt>Gauge record</dt><dd><b style="color:#ffbf47">Stopped reporting after ${when(w.gapAt)}</b>, so the true peak may have been higher</dd>` : ""}`;
    }
    if (ww.ground != null) html += `<dt>Ground here</dt><dd>${ww.ground.toFixed(1)} ft NAVD88 (USGS 3DEP)${w?.navd != null ? ` · the gauge's peak was ${Math.abs(w.navd - ww.ground).toFixed(1)} ft ${w.navd >= ww.ground ? "above" : "below"} it` : ""}</dd>`;
    html += `</dl>`;
    // Which came first.
    if (w?.top && (hu || ts)) {
      const s = hu || ts, label = hu ? "Hurricane-force" : "Tropical-storm-force";
      const lead = Math.round((w.top.t - s.from) / 3600e3);
      html += `<p class="note"><b>${label} winds reached the place about ${Math.abs(lead)} h ${lead >= 0 ? "before" : "after"} the ${w.gapAt ? "highest recorded water" : "water peaked"}</b> at the gauge${hu && w.top.t > hu.to ? `, and had dropped below hurricane force ${Math.round((w.top.t - hu.to) / 3600e3)} h before the peak` : ""}.</p>`;
    }
    html += wwChart(ww);
    html += `<p class="note">Wind is a model estimate from the NHC best track (${ww.radii ? "with its wind radii" : "no wind radii before 2004, so a simple profile"}), as 1-minute sustained wind over open ground; buildings, trees and terrain lower it and gusts run higher.
      Water is measured at the gauge, not at the place, and a surge can differ a lot over a few miles. A certified analysis would add surveyed high-water marks, USGS sensors and local observations.
      <a href="/?${new URLSearchParams({ request: "report", place: place.label || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`, lat: place.lat.toFixed(4), lon: place.lon.toFixed(4), when: `${st.name} (${st.year})`, link: location.href })}#contact">Request a certified report</a></p>`;
    return html;
  }

  /** Census Geocoder (JSONP; it sends no CORS headers) for a street address, or a typed "lat, lon". */
  function geocode(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return Promise.resolve({ label: null, lat: +m[1], lon: +m[2] });
    return new Promise((resolve, reject) => {
      const cb = "twCensus" + Math.random().toString(36).slice(2);
      const u = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
      u.searchParams.set("address", text);
      u.searchParams.set("benchmark", "Public_AR_Current");
      u.searchParams.set("format", "jsonp");
      u.searchParams.set("callback", cb);
      const script = document.createElement("script");
      const timer = setTimeout(() => done(new Error("Address search timed out")), 12000);
      function done(err, value) { clearTimeout(timer); delete window[cb]; script.remove(); err ? reject(err) : resolve(value); }
      window[cb] = (data) => {
        const hit = data?.result?.addressMatches?.[0];
        hit ? done(null, { label: hit.matchedAddress, lat: hit.coordinates.y, lon: hit.coordinates.x }) : done(new Error("Address not found. Try a full street address or lat, lon."));
      };
      script.onerror = () => done(new Error("Address search failed"));
      script.src = u.toString();
      document.head.appendChild(script);
    });
  }

  async function renderPast() {
    const box = $("list");
    if (!box.querySelector("#pq")) {
      box.innerHTML = `<form class="search" id="pastSearch"><input id="pq" placeholder="Name or year, e.g. Katrina or 2005" autocomplete="off" value="${esc(state.hist.q)}" /></form>
        <form class="search" id="placeSearch" style="padding-top:.3rem"><input id="placeQ" placeholder="Address or lat, lon" autocomplete="off" value="${esc(state.hist.near?.label || "")}" style="text-transform:none" /><button class="btn btn--secondary">Find</button></form>
        <p class="note" style="padding:0 1.25rem">Or click the map to list storms that passed within 50 miles, then pick one to see when its winds and surge reached the place.</p><div id="pastResults"><p class="empty">Loading the best-track archive…</p></div>`;
    }
    const all = await histStorms();
    const q = state.hist.q.trim().toLowerCase();
    let list, heading;
    if (state.hist.near) {
      const { lat, lon } = state.hist.near;
      list = all.map((st) => ({ ...st, near: nearestKm(st, lat, lon) })).filter((st) => st.near <= 80).sort((a, b) => b.year - a.year || a.near - b.near);
      heading = `${list.length} storms within 50 miles of ${ll(lat, lon)} <a href="#" data-clearnear="1">clear</a>`;
    } else if (/^\d{4}$/.test(q)) {
      list = all.filter((st) => st.year === +q).sort((a, b) => a.pts[0][0] - b.pts[0][0]);
      heading = `${list.length} storms in ${q}`;
    } else if (q) {
      list = all.filter((st) => st.name.toLowerCase().includes(q)).slice(0, 80);
      heading = `${list.length} storms named “${esc(state.hist.q)}”`;
    } else {
      const latest = Math.max(...all.map((st) => st.year));
      list = all.filter((st) => st.year === latest).sort((a, b) => a.pts[0][0] - b.pts[0][0]);
      heading = `${latest} season · ${list.length} storms`;
    }
    $("pastResults").innerHTML = `<h5 class="sub" style="padding:.6rem 1.25rem 0">${heading}</h5>` + (list.map(histRow).join("") || `<p class="empty">No storms found.</p>`);
    const sel = state.hist.selected;
    if (sel && state.hist.near && state.ww?.key !== `${sel.id}|${state.hist.near.lat.toFixed(4)},${state.hist.near.lon.toFixed(4)}`) loadWindWater(sel, state.hist.near);
  }

  // Distance (km) from a point to the nearest segment of a track (equirectangular, fine at these scales).
  function nearestKm(st, lat, lon) {
    const k = Math.cos((lat * Math.PI) / 180) * 111.32;
    let best = Infinity;
    for (let i = 0; i < st.pts.length; i++) {
      const ax = (st.pts[i][2] - lon) * k, ay = (st.pts[i][1] - lat) * 110.57;
      const b = st.pts[i + 1] || st.pts[i];
      const bx = (b[2] - lon) * k, by = (b[1] - lat) * 110.57;
      const dx = bx - ax, dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

  function drawHist() {
    layers.hist.clearLayers();
    const st = state.hist.selected;
    if (!st) return;
    for (let i = 0; i + 1 < st.pts.length; i++) {
      const a = st.pts[i], b = st.pts[i + 1];
      L.polyline([[a[1], a[2]], [b[1], b[2]]], { pane: "lines", color: ssColor(a[3]), weight: 3, opacity: /EX|LO|WV|DB/.test(a[5]) ? 0.45 : 0.95, dashArray: /EX|LO|WV|DB/.test(a[5]) ? "4 4" : null, interactive: false }).addTo(layers.hist);
    }
    st.pts.forEach((p) => {
      const lf = p[6] === "L";
      L.circleMarker([p[1], p[2]], { pane: "points", radius: lf ? 6 : 3.5, color: lf ? "#fff" : "#0b0f26", weight: lf ? 2 : 1, fillColor: ssColor(p[3]), fillOpacity: 1 })
        .bindTooltip(`${ptLabel(p[0])} · ${STATUS[p[5]] || p[5]} · ${p[3] ?? "—"} kt${p[4] ? ` · ${p[4]} mb` : ""}${lf ? " · landfall" : ""}`, { className: "tw-tip" })
        .addTo(layers.hist);
    });
  }

  async function selectHist(id, fly, instant) {
    const all = await histStorms();
    const st = all.find((x) => x.id === id) || null;
    state.hist.selected = state.hist.selected?.id === id ? null : st;
    history.replaceState(null, "", state.hist.selected ? `#past-${id}` : location.pathname + location.search);
    drawHist();
    await renderPast();
    document.querySelector("#pastResults .sys.sel")?.scrollIntoView({ block: "nearest" });
    if (state.hist.selected && fly) {
      const b = L.latLngBounds(state.hist.selected.pts.map((p) => [p[1], p[2]])).pad(0.15);
      // Opening a shared link: no animation, since the archive is still parsing and could strand it mid-zoom.
      instant ? map.fitBounds(b, { maxZoom: 6, animate: false }) : map.flyToBounds(b, { maxZoom: 6, duration: 0.6 });
    }
  }

  function setMode(m, quiet) {
    state.mode = m;
    document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-selected", b.dataset.mode === m));
    for (const k of ["outlook", "storms", "models", "recon", "markers"]) m === "active" ? layers[k].addTo(map) : layers[k].remove();
    m === "past" ? layers.hist.addTo(map) : layers.hist.remove();
    drawNear();
    // Today's satellite would be misleading behind a historical track.
    $("scrub").hidden = m === "past";
    if (m === "past") clearSat(); else if (state.on.sat) loadSat(true);
    $("list").innerHTML = "";
    drawNhcLayers();
    if (m === "past") renderPast(); else { history.replaceState(null, "", state.selected ? `#${state.selected}` : location.pathname); renderList(); if (!quiet) fitView(); }
  }
  $("modes").addEventListener("click", (e) => { const m = e.target.closest("[data-mode]")?.dataset.mode; if (m && m !== state.mode) setMode(m); });

  let searchTimer = null;
  $("list").addEventListener("input", (e) => {
    if (e.target.id !== "pq") return;
    state.hist.q = e.target.value;
    state.hist.near = null;
    drawNear();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderPast, 250);
  });
  $("list").addEventListener("submit", async (e) => {
    if (e.target.id === "pastSearch") { e.preventDefault(); return; }
    if (e.target.id !== "placeSearch") return;
    e.preventDefault();
    try {
      const hit = await geocode($("placeQ").value);
      state.hist.near = hit;
      drawNear();
      map.setView([hit.lat, hit.lon], Math.max(map.getZoom(), 7));
      if (state.hist.selected && nearestKm(state.hist.selected, hit.lat, hit.lon) > 80) state.hist.selected = null;
      renderPast();
    } catch (err) { $("pastResults").insertAdjacentHTML("afterbegin", `<p class="empty">${esc(err.message)}</p>`); }
  });
  const nearLayer = L.layerGroup().addTo(map);
  function drawNear() {
    nearLayer.clearLayers();
    const n = state.mode === "past" && state.hist.near;
    if (n) L.circle([n.lat, n.lon], { radius: 80467, pane: "radii", color: "#4ad1ff", weight: 1.5, dashArray: "5 5", fillOpacity: 0.05, interactive: false }).addTo(nearLayer);
    if (n) L.circleMarker([n.lat, n.lon], { pane: "points", radius: 6, color: "#fff", weight: 2, fillColor: "#4ad1ff", fillOpacity: 1, interactive: false }).addTo(nearLayer);
  }
  map.on("click", (e) => {
    if (state.mode !== "past") return;
    state.hist.near = { lat: e.latlng.lat, lon: e.latlng.lng };
    if ($("placeQ")) $("placeQ").value = "";
    drawNear();
    if (state.hist.selected && nearestKm(state.hist.selected, e.latlng.lat, e.latlng.lng) > 80) { state.hist.selected = null; drawHist(); }
    renderPast();
  });

  const TABS = [["forecast", "Forecast", tabForecast], ["guidance", "Guidance", tabGuidance], ["recon", "Recon", tabRecon], ["products", "Products", tabProducts]];

  function renderList() {
    if (state.mode === "past") { renderPast(); return; }
    const list = systems().filter((s) => inBasin(s.basin));
    const areas = outlookAreas().filter((a) => inBasin(a.basin));
    const sel = state.selected;
    let html = list.map((s) => {
      const invest = s.kind === "invest";
      const open = s.id === sel;
      const head = `<button class="sys__row" data-id="${esc(s.id)}" aria-expanded="${open}">
          ${glyph(s.intensity, 24, invest)}
          <span class="sys__name">${esc(invest ? s.name : s.name)}<small>${esc(CLASS[s.classification] || s.classification || "")} · ${esc(s.id.toUpperCase())}</small></span>
          <span class="sys__nums"><b>${s.intensity ?? "—"}</b> kt<br>${s.pressure ? `${s.pressure} mb` : "—"}</span></button>`;
      const tab = TABS.find(([k]) => k === state.tab) || TABS[0];
      const body = open
        ? `<div class="detail"><div class="tabs" role="tablist">${TABS.map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab[0]}">${t}</button>`).join("")}</div>${tab[2](s)}</div>`
        : "";
      return `<div class="sys${open ? " sel" : ""}">${head}${body}</div>`;
    }).join("");
    html += areas.map((a) => `<div class="sys"><button class="sys__row" data-area="${a.id}">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="${RISK[a.p.risk7day] || "#ffd84a"}" stroke-width="2.4" stroke-linecap="round"/></svg>
        <span class="sys__name">${esc(a.title)}<small>7-day outlook · ${esc(BASIN_NAMES[a.basin])}</small></span>
        <span class="sys__nums"><b>${esc(a.p.prob7day)}</b> 7 d<br>${esc(a.p.prob2day)} 48 h</span></button></div>`).join("");
    for (const b of state.basin === "ALL" ? ["AL", "EP"] : [state.basin]) {
      if (list.some((s) => s.basin === b) || areas.some((a) => a.basin === b)) continue;
      const text = (state.data?.outlooks || []).find((o) => o.basin === b)?.text || "";
      const quiet = /not expected/i.test(text);
      html += `<div class="sys quiet"><div class="sys__row" style="cursor:default"><span></span><span class="sys__name">${BASIN_NAMES[b]}<small>${quiet ? "No formation expected · 7 days" : "No active systems"}</small></span><span class="sys__nums">—</span></div></div>`;
    }
    $("list").innerHTML = html || `<p class="empty">No systems.</p>`;
  }

  $("list").addEventListener("click", (e) => {
    const h = e.target.closest("[data-hstorm]");
    if (h) { selectHist(h.dataset.hstorm, true); return; }
    if (e.target.closest("[data-clearnear]")) { e.preventDefault(); state.hist.near = null; drawNear(); renderPast(); return; }
    if (state.mode === "past") return;
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; renderList(); return; }
    const row = e.target.closest("[data-id]");
    if (row) { select(row.dataset.id === state.selected ? null : row.dataset.id, true); return; }
    const area = e.target.closest("[data-area]");
    if (area) {
      const a = outlookAreas().find((x) => x.id === area.dataset.area);
      if (a) map.flyToBounds(L.geoJSON(a.feature).getBounds().pad(0.3), { maxZoom: 6, duration: 0.6 });
    }
  });
  $("list").addEventListener("change", (e) => {
    const g = e.target.dataset?.group;
    if (!g) return;
    state.groupsOn[g] = e.target.checked;
    drawModels();
    renderList();
  });

  $("basins").addEventListener("click", (e) => {
    const b = e.target.dataset?.basin;
    if (!b) return;
    state.basin = b;
    document.querySelectorAll("#basins button").forEach((x) => x.setAttribute("aria-selected", x.dataset.basin === b));
    if (state.mode === "past") { renderPast(); map.flyToBounds(BASIN_BOUNDS[b], { duration: 0.6 }); return; }
    const sel = systems().find((s) => s.id === state.selected);
    if (sel && !inBasin(sel.basin)) select(null);
    renderList();
    fitView();
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    if (k === "sat") loadSat(true);
    else if (EXPORT_KINDS.includes(k)) drawNhcLayers();
    else if (k === "sst") drawSst();
    else if (k === "buoys") drawBuoys();
    else drawAll();
  });

  function select(id, fly) {
    state.selected = id;
    history.replaceState(null, "", id ? `#${id}` : location.pathname + location.search);
    renderList();
    if (id) document.querySelector(".sys.sel")?.scrollIntoView({ block: "nearest" });
    drawStorms();
    drawModels();
    if (fly) fitView();
  }

  // —— Drawing ——————————————————————————————————————————————————————
  function drawStorms() {
    layers.storms.clearLayers();
    layers.markers.clearLayers();
    const sel = state.selected;
    for (const s of systems()) {
      const n = state.nhc[s.bin] || {};
      const isSel = !sel || s.id === sel;
      const k = isSel ? 1 : 0.35;
      const g = layers.storms;
      if (state.on.cone && n.cone) L.geoJSON(n.cone, { pane: "cone", interactive: false, style: { color: "#fff", weight: 1, opacity: 0.75 * k, fillColor: "#fff", fillOpacity: 0.1 * k } }).addTo(g);
      if (state.on.radii && isSel && n.radii) L.geoJSON(n.radii, {
        pane: "radii",
        style: (f) => { const r = f.properties.radii; const c = r >= 64 ? "#ff6b6b" : r >= 50 ? "#ff9548" : "#ffbf47"; return { color: c, weight: 1.2, fillColor: c, fillOpacity: 0.1 }; },
        onEachFeature: (f, l) => { const p = f.properties; l.bindTooltip(`${p.radii} kt · NE ${p.ne} SE ${p.se} SW ${p.sw} NW ${p.nw} nm`, { className: "tw-tip", sticky: true }); },
      }).addTo(g);
      if (state.on.ww && n.ww) L.geoJSON(n.ww, {
        pane: "lines", style: (f) => ({ color: (WW[f.properties.tcww] || ["#fff"])[0], weight: 5, opacity: k, lineCap: "round" }),
        onEachFeature: (f, l) => l.bindTooltip((WW[f.properties.tcww] || [, f.properties.tcww])[1], { className: "tw-tip", sticky: true }),
      }).addTo(g);
      if (state.on.past && n.past) L.geoJSON(n.past, { pane: "lines", interactive: false, style: { color: "#c9cfe6", weight: 1.6, opacity: 0.6 * k, dashArray: "1 4", lineCap: "round" } }).addTo(g);
      if (s.kind === "invest" && state.on.past && s.atcf?.best?.length) {
        L.polyline(s.atcf.best.map((p) => [p.lat, p.lon]), { pane: "lines", interactive: false, color: "#cfd5ef", weight: 1.6, opacity: 0.6 * k, dashArray: "2 5" }).addTo(g);
      }
      if (n.track) L.geoJSON(n.track, { pane: "lines", interactive: false, style: { color: "#fff", weight: isSel ? 2 : 1.5, opacity: 0.95 * k } }).addTo(g);
      if (n.points) L.geoJSON(n.points, {
        pane: "points", filter: (f) => f.properties.tau > 0,
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { pane: "points", radius: isSel ? 4.5 : 3, color: "#0b0f26", weight: 1.2, opacity: k, fillOpacity: k, fillColor: ssColor(f.properties.maxwind) }),
        onEachFeature: (f, l) => {
          const p = f.properties;
          l.bindTooltip(`${p.tau} h · ${p.maxwind} kt`, { className: "tw-tip" });
          l.bindPopup(popup(`${p.stormname} · ${p.tau} h`, [["Valid", esc(p.fldatelbl || p.datelbl)], ["Forecast", esc(p.tcdvlp)],
            ["Max wind", `${p.maxwind} kt (${mph(p.maxwind)} mph)`], ["Gusts", p.gust ? `${p.gust} kt` : null], ["Position", ll(p.lat, p.lon)], ["Advisory", esc(p.advisnum)]]));
        },
      }).addTo(g);
      if (s.lat == null) continue;
      const m = L.marker([s.lat, s.lon], {
        pane: "points", zIndexOffset: isSel ? 1000 : 500, opacity: isSel ? 1 : 0.65, keyboard: true, title: s.name,
        icon: L.divIcon({ className: "", html: glyph(s.intensity, 26, s.kind === "invest"), iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(layers.markers);
      m.bindTooltip(s.name, { permanent: true, direction: "right", offset: [14, 0], className: "tw-label", pane: "labels", opacity: isSel ? 1 : 0.6 });
      m.on("click", () => select(s.id === state.selected ? null : s.id, false));
    }
  }

  function drawModels() {
    layers.models.clearLayers();
    if (!state.on.models) return;
    // Guidance for the selected system, or for every system when nothing is selected (consensus only then).
    const list = systems().filter((s) => (state.selected ? s.id === state.selected : true));
    for (const s of list) {
      const m = s.atcf?.models;
      if (!m) continue;
      for (const [tech, pts] of Object.entries(m.tracks)) {
        const grp = MODEL_GROUP_OF[tech];
        if (!grp || !state.groupsOn[grp] || (!state.selected && grp !== "consensus")) continue;
        const c = MODEL_COLORS[tech];
        L.polyline(pts.map((p) => [p.lat, p.lon]), { pane: "lines", color: c, weight: grp === "consensus" ? 2 : 1.3, opacity: grp === "simple" ? 0.6 : 0.85, dashArray: grp === "simple" ? "4 4" : null })
          .bindTooltip(`${tech} · ${hhmmZ(m.cycle)} · ${pts[pts.length - 1].tau} h`, { className: "tw-tip", sticky: true }).addTo(layers.models);
      }
    }
  }

  function obRows(o) {
    return [["Time", dayZ(o.t)], ["Position", ll(o.lat, o.lon)], ["Altitude", o.alt != null ? `${o.alt.toLocaleString()} m` : null],
      ["FL wind", o.wspd != null ? `${String(o.wdir).padStart(3, "0")}° ${o.wspd} kt` : null], ["SFMR", o.sfmr != null ? `${o.sfmr} kt` : null], ["Extrap. SLP", o.slp != null ? `${o.slp} mb` : null]];
  }

  function drawRecon() {
    layers.recon.clearLayers();
    if (!state.on.recon || !state.data) return;
    const r = state.data.recon || {};
    for (const m of r.missions || []) {
      if (m.obs.length < 2) continue;
      const live = isLive(m);
      L.polyline(m.obs.map((o) => [o.lat, o.lon]), { pane: "recon", color: RECON, weight: 1.3, opacity: live ? 0.75 : 0.4, interactive: false }).addTo(layers.recon);
      m.obs.forEach((o, i) => {
        if (i % 3) return;
        L.circleMarker([o.lat, o.lon], { pane: "recon", radius: 2.5, weight: 0, fillColor: RECON, fillOpacity: 0 })
          .bindPopup(popup(`${m.aircraft} · ${m.storm}`, obRows(o))).addTo(layers.recon);
      });
      const a = m.obs[m.obs.length - 2], b = m.obs[m.obs.length - 1];
      const hdg = Math.atan2((b.lon - a.lon) * Math.cos(b.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI;
      L.marker([b.lat, b.lon], {
        pane: "points", title: `${m.aircraft} ${m.storm}`,
        icon: L.divIcon({ className: "", iconSize: [14, 14], iconAnchor: [7, 7],
          html: `<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(${hdg}deg);opacity:${live ? 1 : 0.55}"><path d="M7 1 L12 12 L7 9.5 L2 12 Z" fill="${RECON}" stroke="#060818" stroke-width="1"/></svg>` }),
      }).bindTooltip(`${m.aircraft} · ${hhmmZ(b.t)}${live ? "" : " (ended)"}`, { className: "tw-tip", direction: "top", offset: [0, -8] })
        .bindPopup(popup(`${m.aircraft} · ${m.missionId} ${m.storm}`, [["Status", live ? "Reporting" : `Last report ${ago(m.last)}`], ...obRows(b),
          ["Max FL wind", m.maxFl ? `${m.maxFl.wspd} kt at ${hhmmZ(m.maxFl.t)}` : null], ["Max SFMR", m.maxSfmr ? `${m.maxSfmr.sfmr} kt at ${hhmmZ(m.maxSfmr.t)}` : null]]))
        .addTo(layers.recon);
    }
    for (const v of (r.vortex || []).slice(0, 8)) {
      L.circleMarker([v.lat, v.lon], { pane: "recon", radius: 4, color: RECON, weight: 1.5, fillOpacity: 0 })
        .bindTooltip(`Vortex fix ${dayZ(v.t)}${v.slp ? ` · ${v.slp} mb` : ""}`, { className: "tw-tip" })
        .bindPopup(popup(`Vortex fix · ${v.storm}`, [["Time", dayZ(v.t)], ["Center", ll(v.lat, v.lon)], ["Pressure", esc(v.slpNote)],
          ["Max FL wind", v.maxFl ? `${v.maxFl} kt` : null], ["Eye", esc([v.eye, v.eyeSize].filter(Boolean).join(" · "))], ["Mission", esc(v.mission)]]))
        .addTo(layers.recon);
    }
    for (const b of state.data.tcpod?.basins || []) {
      for (const s of b.systems) {
        for (const f of s.flights) {
          if (f.lat == null) continue;
          L.marker([f.lat, f.lon], {
            pane: "points",
            icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="${RECON}" stroke-width="1.6" stroke-dasharray="3 3"/><path d="M11 5v3M11 14v3M5 11h3M14 11h3" stroke="${RECON}" stroke-width="1.6"/></svg>` }),
          }).bindTooltip(`Tasked: ${esc(f.aircraft)} · ${esc(f.fields.fixTime || "")}`, { className: "tw-tip" })
            .bindPopup(popup(`TCPOD · ${s.name}`, [["Aircraft", esc(f.aircraft)], ["Fix time", esc(f.fields.fixTime)], ["Profile", esc(f.fields.profile)],
              ["Departs", esc(f.fields.departure)], ["On station", esc(f.fields.onStation)], ["Altitude", esc(f.fields.altitude)], ["Mission", esc(f.fields.mission)]]))
            .addTo(layers.recon);
        }
      }
    }
  }

  function drawOutlook() {
    layers.outlook.clearLayers();
    if (!state.on.outlook) return;
    for (const a of outlookAreas()) {
      const c = RISK[a.p.risk7day] || "#ffd84a";
      L.geoJSON(a.feature, { pane: "outlook", style: { color: c, weight: 1.4, dashArray: "5 5", fillColor: c, fillOpacity: 0.07 } })
        .bindPopup(popup(a.title, [["48 hours", `${esc(a.p.prob2day)} (${esc(a.p.risk2day)})`], ["7 days", `${esc(a.p.prob7day)} (${esc(a.p.risk7day)})`]]))
        .addTo(layers.outlook);
    }
    (state.gtwo?.pts?.features || []).forEach((f) => {
      const c = RISK[f.properties.risk7day] || "#ffd84a";
      L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { pane: "outlook", interactive: false,
        icon: L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="${c}" stroke-width="3" stroke-linecap="round"/></svg>` }) }).addTo(layers.outlook);
    });
  }

  function drawAll() { drawOutlook(); drawStorms(); drawModels(); drawRecon(); drawBuoys(); drawNhcLayers(); }

  // —— Sea surface temperature (NASA GIBS, latest daily MUR analysis) ——————————————
  let sstLayer = null;
  function drawSst() {
    sstLayer?.remove();
    sstLayer = null;
    if (state.on.sst) {
      sstLayer = L.tileLayer(`${GIBS}/GHRSST_L4_MUR_Sea_Surface_Temperature/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`,
        { pane: "sst", maxNativeZoom: 7, maxZoom: 11, opacity: 0.75, attribution: "GHRSST MUR via NASA GIBS" }).addTo(map);
    }
    drawNhcLegend();
  }

  // —— Buoys and coastal stations (NDBC, collected by fetch_data.py) ——————————————
  const BUOY = "#9fe6b8";
  function drawBuoys() {
    layers.buoys.clearLayers();
    if (!state.on.buoys || !state.data) return;
    for (const [id, lat, lon, t, wdir, wspd, gust, wvht, pres, wtmp] of state.data.buoys || []) {
      const c = wspd >= 64 ? ssColor(64) : wspd >= 34 ? ssColor(34) : BUOY;
      L.circleMarker([lat, lon], { pane: "points", radius: wspd >= 34 ? 5 : 3.5, color: "#060818", weight: 1, fillColor: c, fillOpacity: 0.95 })
        .bindTooltip(`${esc(id)}${wspd != null ? ` · ${wspd}${gust ? `G${gust}` : ""} kt` : ""}${pres ? ` · ${pres} mb` : ""}`, { className: "tw-tip", direction: "top" })
        .bindPopup(popup(`NDBC ${id}`, [
          ["Time", `${dayZ(t)} (${ago(t)})`],
          ["Wind", wspd != null ? `${wdir != null ? `${compass(wdir)} ` : ""}${wspd} kt${gust ? `, gusts ${gust} kt` : ""}` : null],
          ["Pressure", pres ? `${pres} mb` : null],
          ["Waves", wvht != null ? `${wvht} ft` : null],
          ["Water temp", wtmp != null ? `${wtmp} °C` : null],
          ["Station", `<a href="https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(id)}" target="_blank" rel="noopener">NDBC page</a>`],
        ])).addTo(layers.buoys);
    }
  }

  function fitView() {
    const sel = systems().find((s) => s.id === state.selected);
    const b = L.latLngBounds([]);
    const add = (s) => {
      if (s.lat != null) b.extend([s.lat, s.lon]);
      const n = state.nhc[s.bin];
      if (n?.cone?.features?.length) b.extend(L.geoJSON(n.cone).getBounds());
      else (s.atcf?.models?.tracks?.TVCN || []).forEach((p) => b.extend([p.lat, p.lon]));
    };
    if (sel) add(sel);
    else systems().filter((s) => inBasin(s.basin)).forEach(add);
    if (b.isValid()) map.flyToBounds(b.pad(0.2), { maxZoom: 6, duration: 0.6, paddingTopLeft: [0, 0], paddingBottomRight: [0, 50] });
    else map.flyToBounds(BASIN_BOUNDS[state.basin], { duration: 0.6 });
  }

  function renderUpdated() {
    const d = state.data;
    if (!d) return;
    const el = $("updated");
    const stale = Date.now() - new Date(d.generated) > 75 * 60000;
    el.textContent = stale ? `Data ${hhmmZ(d.generated)} · delayed` : `Data ${hhmmZ(d.generated)}`;
    el.title = `Collected ${new Date(d.generated).toUTCString()}`;
    el.classList.toggle("stale", stale);
  }

  // —— Load & refresh ———————————————————————————————————————————————
  async function loadData() {
    const res = await fetch(`data/tropical.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const changed = !state.data || data.generated !== state.data.generated;
    state.data = data;
    renderUpdated();
    return changed;
  }

  /** Past storms near ?loc=lat,lon; with &date=YYYY-MM-DD (from the case file), open the one nearest the place that week. */
  function openPlace(m) {
    state.hist.near = { lat: +m[1], lon: +m[2] };
    setMode("past", true);
    map.setView([state.hist.near.lat, state.hist.near.lon], 7, { animate: false });
    const dateParam = new URLSearchParams(location.search).get("date");
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) openStormNear(state.hist.near, Date.parse(`${dateParam}T12:00:00Z`));
  }

  async function init() {
    loadSat(true);
    setStatus("Loading tropical data…");
    const [dataOk, nhcOk] = await Promise.all([loadData().then(() => true, () => false), loadNhc().then(() => true, () => false)]);
    const locParam = new URLSearchParams(location.search).get("loc")?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    if (!dataOk) {
      setStatus("Data unavailable");
      // Past storms don't need the live data, so a link to them still opens.
      if (locParam && !pastHash) return openPlace(locParam);
      $("list").innerHTML = `<p class="empty">Couldn't load the latest data. Try again in a few minutes.</p>`;
      return;
    }
    setStatus(nhcOk ? "" : "NHC map service unavailable — cones and warnings not shown");
    const list = systems();
    if (state.selected && !list.some((s) => s.id === state.selected)) state.selected = null;
    // Open the strongest storm by default so the sidebar shows something useful.
    if (!state.selected && list.length && !hashId) state.selected = list[0].id;
    renderList();
    drawAll();
    // ?loc=lat,lon (from the property profile and other pages): past storms near that place.
    if (locParam && !pastHash) openPlace(locParam);
    else if (!pastHash) fitView();
    if (pastHash) {
      // Open on that storm's season so it's in the list, selected.
      state.basin = pastHash.startsWith("AL") ? "AL" : "ALL";
      state.hist.q = pastHash.slice(-4);
      document.querySelectorAll("#basins button").forEach((x) => x.setAttribute("aria-selected", x.dataset.basin === state.basin));
      setMode("past", true);
      selectHist(pastHash, true, true);
    }

    setInterval(async () => {
      if (await loadData().catch(() => false)) {
        if (state.selected && !systems().some((s) => s.id === state.selected)) state.selected = null;
        renderList(); drawAll();
      }
    }, 5 * 60000);
    setInterval(() => loadNhc().then(() => { setStatus(""); renderList(); drawAll(); }).catch(() => {}), 10 * 60000);
    setInterval(() => { if (!state.sat.timer) loadSat(false); renderUpdated(); }, 10 * 60000);
  }

  // —— Case file: the home page's case file (/case.html) opens ?loc=…&date=… in a frame and reads wind or water from here ——
  // The storm whose track came within 250 miles of the place, active within 3 days of the date; the closest wins.
  async function openStormNear(place, t) {
    const all = await histStorms();
    const pick = all.filter((st) => ptTime(st.pts[0][0]) - 3 * 86_400_000 <= t && t <= ptTime(st.pts[st.pts.length - 1][0]) + 3 * 86_400_000)
      .map((st) => ({ st, km: nearestKm(st, place.lat, place.lon) })).filter((x) => x.km <= 402).sort((a, b) => a.km - b.km)[0];
    state.caseStorm = pick ? { id: pick.st.id, km: pick.km } : { none: true };
    if (pick) await selectHist(pick.st.id, true, true);
  }
  window.SWCase = {
    status() {
      const c = state.caseStorm;
      if (!c) return "loading";
      if (c.none) return "none";
      const ww = state.ww;
      return ww?.status === "ready" && ww.water && ww.key.startsWith(`${c.id}|`) ? "ready" : "loading";
    },
    section() {
      const st = state.hist.selected;
      const div = document.createElement("div");
      div.innerHTML = wwHtml(st);
      div.querySelectorAll('a[href^="/?"]').forEach((a) => a.remove());
      return { title: `TropicalWeather: ${st.name} (${st.year})`,
        html: `<p>${esc(st.name)} (${st.year}, ${esc(st.id)}) passed about ${Math.round(state.caseStorm.km * 0.621)} miles from the place at its closest, with a peak intensity of ${st.peak ?? "—"} kt (${catOf(st.peak)}). Times are UTC.</p>${div.innerHTML}` };
    },
  };

  init();
})();

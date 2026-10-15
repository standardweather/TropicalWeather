/* TropicalWeather — live tropical map for standardweather.github.io.
 *
 * Live in the browser (these services allow cross-origin requests):
 *   NHC tropical MapServer  cones, forecast/past tracks, watches & warnings, wind radii, 7-day outlook areas
 *   NASA GIBS GOES tiles    IR / visible / GeoColor / air mass, 10-minute full-disk frames
 * Collected every ~15 min by GitHub Actions into data/tropical.json (fetch_data.py):
 *   NHC CurrentStorms, ATCF best tracks + guidance, TCPOD, recon HDOBs + vortex messages, outlook text
 */
(() => {
  "use strict";

  const MS = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
  // NASA GIBS full-disk GOES-East and GOES-West, stitched at 105°W. 10-minute frames,
  // usually 15–30 minutes behind real time.
  const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
  const SAT = {
    ir: { name: "IR", product: "ABI_Band13_Clean_Infrared", level: 6 },
    vis: { name: "Visible", product: "ABI_Band2_Red_Visible_1km", level: 7 },
    geocolor: { name: "GeoColor", product: "ABI_GeoColor", level: 7 },
    airmass: { name: "Air mass", product: "ABI_Air_Mass", level: 6 },
  };
  const SAT_SPLIT_LON = -105;
  const SAT_FRAMES = 12;           // 2 hours of 10-minute frames
  const SAT_STEP_MIN = 10;
  const BINS = ["AT1", "AT2", "AT3", "AT4", "AT5", "EP1", "EP2", "EP3", "EP4", "EP5", "CP1", "CP2", "CP3", "CP4", "CP5"];
  const BASIN_BOUNDS = {
    AL: [[6, -100], [48, -12]],
    EP: [[2, -142], [34, -82]],
    CP: [[2, -180], [34, -136]],
    ALL: [[2, -165], [48, -12]],
  };
  const BASIN_NAMES = { AL: "Atlantic", EP: "East Pacific", CP: "Central Pacific" };

  // Saffir–Simpson colors (kt)
  const SS = [
    [137, "#ff6060", "5"], [113, "#ff8f20", "4"], [96, "#ffc140", "3"], [83, "#ffe775", "2"],
    [64, "#ffffcc", "1"], [34, "#00faf4", "TS"], [0, "#5ebaff", "TD"],
  ];
  const ssColor = (kt) => (kt == null ? "#9aa3c0" : SS.find(([min]) => kt >= min)[1]);
  const ssLabel = (kt) => (kt == null ? "?" : SS.find(([min]) => kt >= min)[2]);
  const WW = {
    HWR: ["#ff3b30", "Hurricane warning"], HWA: ["#ff9ee6", "Hurricane watch"],
    TWR: ["#3d8bff", "Tropical storm warning"], TWA: ["#ffde4a", "Tropical storm watch"],
  };
  const RISK = { Low: "#ffde4a", Medium: "#ff9f43", High: "#ff453a" };

  // Model groups for the guidance toggle
  const MODEL_GROUPS = {
    consensus: { name: "Consensus", color: "#4ad1ff", models: ["TVCN", "IVCN", "HCCA", "RVCN"], on: true },
    global: { name: "Global models", color: "#7ee08a", models: ["AVNI", "EMXI", "EGRI", "UKXI", "CMCI", "NVGI", "CTCI", "AEMI", "CEMI"], on: true },
    hurricane: { name: "Hurricane models", color: "#c9a0ff", models: ["HFAI", "HFBI", "HWFI", "HMNI"], on: true },
    simple: { name: "Statistical / trajectory", color: "#9aa3c0", models: ["TABS", "TABM", "TABD", "XTRP", "CLP5"], on: false },
  };
  const MODEL_COLORS = {
    TVCN: "#4ad1ff", IVCN: "#7fe3ff", HCCA: "#2fb8ff", RVCN: "#9fd8ff",
    AVNI: "#7ee08a", EMXI: "#ff7aa8", EGRI: "#ffb86b", UKXI: "#e6e07a", CMCI: "#ff9b5e", NVGI: "#b5f07a", CTCI: "#8af0d0", AEMI: "#a9e6a0", CEMI: "#ffc58f",
    HFAI: "#c9a0ff", HFBI: "#a98bff", HWFI: "#e6a0ff", HMNI: "#d68bff",
    TABS: "#8a93b5", TABM: "#a7afcd", TABD: "#c4cae0", XTRP: "#7c84a6", CLP5: "#b0b6cc",
  };
  const MODEL_GROUP_OF = Object.fromEntries(
    Object.entries(MODEL_GROUPS).flatMap(([g, def]) => def.models.map((m) => [m, g])));
  const INTENSITY = [
    ["OFCI", "#ffffff", "Official"], ["IVCN", "#4ad1ff", "IVCN"], ["HCCA", "#2fb8ff", "HCCA"],
    ["HFAI", "#c9a0ff", "HAFS-A"], ["HFBI", "#a98bff", "HAFS-B"], ["DSHP", "#ffb86b", "SHIPS"], ["LGEM", "#7ee08a", "LGEM"],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtZ = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
  };
  const hhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; };
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60 ? `${m % 60} min ` : ""}ago` : `${Math.round(h / 24)} days ago`;
  };
  const ll = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
  const compass = (deg) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];
  const mph = (kt) => Math.round(kt * 1.15078);
  // HDOBs arrive every 10 minutes and the data file every ~15, so allow 40 minutes.
  const isLive = (m) => Date.now() - new Date(m.last) < 40 * 60000;
  // "1030 AM EDT THU 15 OCTOBER 2026" -> "10:30 AM EDT Thu 15 Oct"
  const titleTime = (s) => s.replace(/^(\d{1,2})(\d{2}) (AM|PM) (\w+) (\w)(\w+) (\d+) (\w{3})\w* \d{4}$/,
    (_, h, m, ap, tz, d1, d2, day, mon) => `${+h}:${m} ${ap} ${tz} ${d1}${d2.toLowerCase()} ${day} ${mon[0]}${mon.slice(1).toLowerCase()}`);
  const CLASS = {
    HU: "Hurricane", TS: "Tropical Storm", TD: "Tropical Depression", STS: "Subtropical Storm", SS: "Subtropical Storm",
    STD: "Subtropical Depression", SD: "Subtropical Depression", PTC: "Potential Tropical Cyclone", PC: "Post-Tropical Cyclone",
    TY: "Typhoon", MH: "Major Hurricane",
  };

  const state = {
    data: null,
    layerIds: null,
    nhc: {},             // bin -> { points, cone, track, ww, past, pastPts, radii, swath }
    satKind: "ir",
    satTimes: [],
    satLayers: [],
    satIdx: 0,
    satTimer: null,
    satOpacity: 0.85,
    on: {
      cone: true, track: true, ww: true, radii: true, past: true, swath: false, outlook: true,
      models: true, invests: true, recon: true, vortex: true, tasking: true,
    },
    groupsOn: Object.fromEntries(Object.entries(MODEL_GROUPS).map(([k, v]) => [k, v.on])),
  };

  // —— Map setup ——————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: true, worldCopyJump: false, minZoom: 2, maxZoom: 10, zoomSnap: 0.5 })
    .fitBounds(BASIN_BOUNDS.ALL);
  map.attributionControl.setPrefix("");
  const panes = [["outlook", 380], ["cone", 400], ["radii", 410], ["lines", 420], ["recon", 600], ["points", 620], ["labels", 640]];
  panes.forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, attribution: "Basemap © Esri",
  }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, pane: "labels",
  }).addTo(map);
  map.attributionControl.addAttribution("NHC/NOAA · GOES via NASA GIBS · ATCF");

  const groups = {
    outlook: L.layerGroup().addTo(map),
    cone: L.layerGroup().addTo(map),
    radii: L.layerGroup().addTo(map),
    swath: L.layerGroup(),
    ww: L.layerGroup().addTo(map),
    past: L.layerGroup().addTo(map),
    track: L.layerGroup().addTo(map),
    models: L.layerGroup().addTo(map),
    invests: L.layerGroup().addTo(map),
    recon: L.layerGroup().addTo(map),
    vortex: L.layerGroup().addTo(map),
    tasking: L.layerGroup().addTo(map),
  };
  const stormMarkers = L.layerGroup().addTo(map);

  function setStatus(msg) {
    const el = $("mapStatus");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  // —— Controls ——————————————————————————————————————————————————————
  function legendHtml() {
    const dot = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;
    const ln = (c, t) => `<span><i class="ln" style="background:${c}"></i>${t}</span>`;
    return `
      <div class="tw-legend__row">${SS.slice().reverse().map(([, c, l]) => dot(c, l === "TD" || l === "TS" ? l : `Cat ${l}`)).join("")}</div>
      <div class="tw-legend__row">${Object.values(WW).map(([c, t]) => ln(c, t.replace("Tropical storm", "TS").replace("Hurricane", "Hurr."))).join("")}</div>
      <div class="tw-legend__row">${Object.entries(RISK).map(([k, c]) => dot(c, `${k} 7-day`)).join("")}</div>
      <div class="tw-legend__row">
        <span><i style="border:2px solid #c9b8ff;background:none"></i>Vortex fix</span>
        <span><i style="border:2px dashed #ffde4a;background:none"></i>Tasked fix</span>
        <span>✈ Aircraft</span>
      </div>
      <div class="tw-legend__row"><span>Recon dots: SFMR (else flight-level) wind, same colors</span></div>`;
  }

  const LayersControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const el = L.DomUtil.create("div", "tw-ctl tw-layers");
      if (window.matchMedia("(max-width: 639px)").matches) el.classList.add("collapsed");
      const chk = (key, label, swatch) =>
        `<label><input type="checkbox" data-layer="${key}" ${state.on[key] ? "checked" : ""}/> ${label}${swatch ? `<i class="swatch" style="background:${swatch}"></i>` : ""}</label>`;
      el.innerHTML = `
        <button class="tw-layers__toggle" type="button" aria-expanded="true">Layers <span aria-hidden="true">▾</span></button>
        <div class="tw-layers__body">
          <h5>Satellite</h5>
          <div class="tw-seg" id="satSeg">
            <button type="button" data-sat="off">Off</button>
            ${Object.entries(SAT).map(([k, v]) => `<button type="button" data-sat="${k}">${v.name}</button>`).join("")}
          </div>
          <div class="tw-range">Opacity <input type="range" id="satOpacity" min="0.2" max="1" step="0.05" value="${state.satOpacity}" aria-label="Satellite opacity" /></div>
          <h5>NHC advisories</h5>
          ${chk("cone", "Forecast cone", "rgba(255,255,255,.5)")}
          ${chk("track", "Forecast track & points", "#fff")}
          ${chk("ww", "Watches & warnings", "#ff3b30")}
          ${chk("radii", "Current wind field", "#ffc140")}
          ${chk("past", "Past track", "#9aa3c0")}
          ${chk("swath", "Cumulative wind swath", "#ff8f20")}
          ${chk("outlook", "7-day outlook areas", "#ff9f43")}
          <h5>ATCF</h5>
          ${chk("models", "Model guidance tracks", "#4ad1ff")}
          <div id="modelGroups" style="padding-left:1.4rem">
            ${Object.entries(MODEL_GROUPS).map(([k, g]) =>
              `<label><input type="checkbox" data-group="${k}" ${state.groupsOn[k] ? "checked" : ""}/> ${g.name}<i class="swatch" style="background:${g.color}"></i></label>`).join("")}
          </div>
          ${chk("invests", "Invests (best track)", "#cfd5ef")}
          <h5>Reconnaissance</h5>
          ${chk("recon", "Flight tracks (HDOB)", "#4ad1ff")}
          ${chk("vortex", "Vortex fixes", "#c9b8ff")}
          ${chk("tasking", "TCPOD tasked fixes", "#ffde4a")}
          <details class="tw-legend" ${window.matchMedia("(min-height: 900px)").matches ? "open" : ""}>
            <summary><h5>Legend</h5></summary>
            ${legendHtml()}
          </details>
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      const toggle = el.querySelector(".tw-layers__toggle");
      toggle.onclick = () => {
        el.classList.toggle("collapsed");
        toggle.setAttribute("aria-expanded", !el.classList.contains("collapsed"));
      };
      el.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.layer) {
          const key = t.dataset.layer;
          state.on[key] = t.checked;
          t.checked ? groups[key].addTo(map) : groups[key].remove();
          if (key === "models") el.querySelector("#modelGroups").style.opacity = t.checked ? 1 : 0.45;
        } else if (t.dataset.group) {
          state.groupsOn[t.dataset.group] = t.checked;
          drawModels();
        }
      });
      el.querySelector("#satSeg").addEventListener("click", (e) => {
        const k = e.target.dataset?.sat;
        if (k) setSatellite(k);
      });
      el.querySelector("#satOpacity").addEventListener("input", (e) => {
        state.satOpacity = +e.target.value;
        state.satLayers.forEach((l, i) => l.setOpacity(i === state.satIdx ? state.satOpacity : 0));
      });
      return el;
    },
  });

  const SatControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const el = L.DomUtil.create("div", "tw-ctl tw-satbar");
      el.innerHTML = `
        <button type="button" id="satPrev" aria-label="Previous satellite frame">◀</button>
        <button type="button" id="satPlay" aria-label="Loop satellite">▶</button>
        <button type="button" id="satNext" aria-label="Next satellite frame">▶</button>
        <span class="t" id="satTime">Satellite<small>loading…</small></span>`;
      L.DomEvent.disableClickPropagation(el);
      el.querySelector("#satPrev").onclick = () => { satLoop(false); satShow(state.satIdx - 1); };
      el.querySelector("#satNext").onclick = () => { satLoop(false); satShow(state.satIdx + 1); };
      el.querySelector("#satPlay").onclick = () => satLoop();
      el.querySelector("#satNext").textContent = "▶|";
      el.querySelector("#satPrev").textContent = "|◀";
      return el;
    },
  });

  new LayersControl().addTo(map);
  new SatControl().addTo(map);

  // —— Satellite —————————————————————————————————————————————————————
  const satUrl = (sat, sideName, time) =>
    `${GIBS}/GOES-${sideName}_${sat.product}/default/${time}/GoogleMapsCompatible_Level${sat.level}/{z}/{y}/{x}.png`;
  const isoMin = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

  // One zoom-2 tile inside each disk: x=0 spans 180°–90°W (West), x=1 spans 90°W–0° (East).
  async function tileExists(sat, side, time) {
    const url = satUrl(sat, side, time).replace("{z}/{y}/{x}", `2/1/${side === "West" ? 0 : 1}`);
    try { return (await fetch(url, { cache: "no-store" })).ok; } catch { return false; }
  }

  // GIBS returns 404 for frames not yet processed, so probe back from now for the
  // newest time both satellites have.
  async function satNewest(sat) {
    const step = SAT_STEP_MIN * 60000;
    // Frames are never ready within 10 minutes, so start one step back.
    let t = Math.floor(Date.now() / step) * step - step;
    for (let i = 0; i < 18; i++, t -= step) {
      const time = isoMin(t);
      const [e, w] = await Promise.all([tileExists(sat, "East", time), tileExists(sat, "West", time)]);
      if (e && w) return t;
    }
    throw new Error("no recent frames");
  }

  map.createPane("satW").style.zIndex = 250;
  map.createPane("satE").style.zIndex = 251;
  // Keep GOES-East to the east of the split; GOES-West shows through west of it.
  function clipSat() {
    const x = map.latLngToLayerPoint([0, SAT_SPLIT_LON]).x;
    map.getPane("satE").style.clipPath = `polygon(${x}px -100000px, 100000px -100000px, 100000px 100000px, ${x}px 100000px)`;
  }
  map.on("zoomend moveend viewreset resize", clipSat);
  map.on("zoomanim", (e) => {
    const x = map._latLngToNewLayerPoint(L.latLng(0, SAT_SPLIT_LON), e.zoom, e.center).x;
    map.getPane("satE").style.clipPath = `polygon(${x}px -100000px, 100000px -100000px, 100000px 100000px, ${x}px 100000px)`;
  });
  clipSat();

  function satFrame(sat, time, opacity) {
    const opts = (pane) => ({ pane, opacity, maxNativeZoom: sat.level, maxZoom: 12, tileSize: 256, attribution: "", errorTileUrl: "" });
    const frame = L.layerGroup([
      L.tileLayer(satUrl(sat, "West", time), opts("satW")),
      L.tileLayer(satUrl(sat, "East", time), opts("satE")),
    ]);
    frame.setOpacity = (o) => frame.eachLayer((l) => l.setOpacity(o));
    return frame;
  }

  function clearSat() {
    satLoop(false);
    state.satLayers.forEach((l) => l.remove());
    state.satLayers = [];
    state.satTimes = [];
  }

  async function setSatellite(kind) {
    document.querySelectorAll("#satSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sat === kind));
    const tEl = $("satTime");
    if (kind === "off") { state.satKind = kind; clearSat(); tEl.innerHTML = "Satellite<small>off</small>"; return; }
    const sat = SAT[kind];
    const switching = state.satKind !== kind || !state.satLayers.length;
    state.satKind = kind;
    if (switching) tEl.innerHTML = `${sat.name}<small>finding latest frame…</small>`;
    try {
      const newest = await satNewest(sat);
      if (state.satKind !== kind) return;
      const times = Array.from({ length: SAT_FRAMES }, (_, i) => isoMin(newest - (SAT_FRAMES - 1 - i) * SAT_STEP_MIN * 60000));
      if (!switching && times[times.length - 1] === state.satTimes[state.satTimes.length - 1]) return;   // nothing new
      clearSat();
      state.satTimes = times;
      state.satLayers = times.map((t, i) => satFrame(sat, t, i === times.length - 1 ? state.satOpacity : 0));
      // Only the newest frame loads up front; the rest load when the loop starts.
      state.satIdx = times.length - 1;
      state.satLayers[state.satIdx].addTo(map);
      satLabel();
    } catch (e) {
      if (state.satKind === kind) tEl.innerHTML = `${sat.name}<small>unavailable</small>`;
    }
  }

  function satLabel() {
    const t = state.satTimes[state.satIdx];
    if (!t) return;
    const newest = state.satIdx === state.satTimes.length - 1;
    $("satTime").innerHTML = `GOES ${SAT[state.satKind].name} · ${hhmmZ(t)}<small>${newest ? ago(t) : `frame ${state.satIdx + 1}/${state.satTimes.length}`}</small>`;
  }

  function satShow(i) {
    const n = state.satLayers.length;
    if (!n) return;
    const next = (i + n) % n;
    const layer = state.satLayers[next];
    if (!map.hasLayer(layer)) layer.addTo(map);
    layer.setOpacity(state.satOpacity);
    state.satLayers.forEach((l, j) => { if (j !== next) l.setOpacity(0); });
    state.satIdx = next;
    satLabel();
  }

  function satLoop(force) {
    const playing = force ?? !state.satTimer;
    clearInterval(state.satTimer);
    state.satTimer = null;
    const btn = $("satPlay");
    if (btn) btn.textContent = playing ? "❚❚" : "▶";
    if (!playing || !state.satLayers.length) return;
    state.satLayers.forEach((l) => { if (!map.hasLayer(l)) l.addTo(map); });   // preload every frame
    state.satTimer = setInterval(() => {
      // Hold on the newest frame a little longer before starting over.
      if (state.satIdx === state.satLayers.length - 1 && !state.satHold) { state.satHold = true; return; }
      state.satHold = false;
      satShow(state.satIdx + 1);
    }, 550);
  }

  // —— NHC MapServer —————————————————————————————————————————————————
  async function msLayerIds() {
    if (state.layerIds) return state.layerIds;
    const res = await fetch(`${MS}?f=json`);
    const info = await res.json();
    state.layerIds = Object.fromEntries(info.layers.map((l) => [l.name.trim(), l.id]));
    return state.layerIds;
  }

  async function msQuery(id) {
    if (id == null) return { type: "FeatureCollection", features: [] };
    const res = await fetch(`${MS}/${id}/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&_=${Math.floor(Date.now() / 120000)}`);
    if (!res.ok) throw new Error(`MapServer ${id}: ${res.status}`);
    const gj = await res.json();
    if (gj.error) throw new Error(gj.error.message);
    return gj;
  }

  async function loadNhc() {
    const ids = await msLayerIds();
    const name = (bin, suffix) => ids[`${bin} ${suffix}`];
    const pointsByBin = await Promise.all(BINS.map((b) => msQuery(name(b, "Forecast Points")).catch(() => null)));
    const active = BINS.filter((b, i) => pointsByBin[i]?.features?.length);
    const nhc = {};
    await Promise.all(active.map(async (bin) => {
      const [cone, track, ww, past, pastPts, radii, swath] = await Promise.all([
        "Forecast Cone", "Forecast Track", "Watch-Warning", "Past Track", "Past Points", "Advisory Wind Field", "Past Cumulative Wind Swath",
      ].map((s) => msQuery(name(bin, s)).catch(() => null)));
      nhc[bin] = { points: pointsByBin[BINS.indexOf(bin)], cone, track, ww, past, pastPts, radii, swath };
    }));
    const [gtwoAreas, gtwoPts, gtwoLines, gtwo2] = await Promise.all([
      ids["Seven-Day: Potential Development Region"], ids["Seven-Day: Current Location"],
      ids["Seven-Day: Development Motion"], ids["Two-Day: Current Location"],
    ].map((id) => msQuery(id).catch(() => null)));
    state.nhc = nhc;
    state.gtwo = { areas: gtwoAreas, pts: gtwoPts, lines: gtwoLines, two: gtwo2 };
    drawNhc();
  }

  function popupTable(title, rows) {
    return `<h4>${esc(title)}</h4><table>${rows.filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
  }

  function drawNhc() {
    ["cone", "track", "ww", "past", "radii", "swath", "outlook"].forEach((k) => groups[k].clearLayers());
    for (const [bin, d] of Object.entries(state.nhc)) {
      if (d.cone) L.geoJSON(d.cone, {
        pane: "cone", style: { color: "#ffffff", weight: 1.2, opacity: 0.8, fillColor: "#ffffff", fillOpacity: 0.13 },
        interactive: false,
      }).addTo(groups.cone);
      if (d.swath) L.geoJSON(d.swath, {
        pane: "radii",
        style: (f) => ({ color: ssColor(f.properties.radii), weight: 0.8, fillColor: f.properties.radii >= 64 ? "#ff6060" : f.properties.radii >= 50 ? "#ff8f20" : "#ffc140", fillOpacity: 0.16 }),
        interactive: false,
      }).addTo(groups.swath);
      if (d.radii) L.geoJSON(d.radii, {
        pane: "radii",
        style: (f) => {
          const r = f.properties.radii;
          const c = r >= 64 ? "#ff6060" : r >= 50 ? "#ff8f20" : "#ffc140";
          return { color: c, weight: 1.4, fillColor: c, fillOpacity: 0.12 };
        },
        onEachFeature: (f, l) => {
          const p = f.properties;
          l.bindTooltip(`${p.radii} kt wind field — NE ${p.ne} · SE ${p.se} · SW ${p.sw} · NW ${p.nw} nm`, { className: "tw-tip", sticky: true });
        },
      }).addTo(groups.radii);
      if (d.ww) L.geoJSON(d.ww, {
        pane: "lines",
        style: (f) => ({ color: (WW[f.properties.tcww] || ["#fff"])[0], weight: 6, opacity: 0.95, lineCap: "round" }),
        onEachFeature: (f, l) => l.bindTooltip((WW[f.properties.tcww] || [, f.properties.tcww])[1], { className: "tw-tip", sticky: true }),
      }).addTo(groups.ww);
      if (d.past) L.geoJSON(d.past, {
        pane: "lines", style: { color: "#c4cae0", weight: 2, opacity: 0.7, dashArray: "1 5", lineCap: "round" }, interactive: false,
      }).addTo(groups.past);
      if (d.pastPts) L.geoJSON(d.pastPts, {
        pane: "lines",
        pointToLayer: (f, latlng) => L.circleMarker(latlng, {
          pane: "lines", radius: 3, weight: 0, fillOpacity: 0.9, fillColor: ssColor(f.properties.intensity),
        }),
        onEachFeature: (f, l) => {
          const p = f.properties;
          const dtg = String(Math.round(p.dtg));
          l.bindTooltip(`${dtg.slice(6, 8)}/${dtg.slice(8, 10)}Z · ${p.stormtype} · ${p.intensity} kt${p.mslp ? ` · ${p.mslp} mb` : ""}`, { className: "tw-tip" });
        },
      }).addTo(groups.past);
      if (d.track) L.geoJSON(d.track, {
        pane: "lines", style: { color: "#ffffff", weight: 2.4, opacity: 0.95 }, interactive: false,
      }).addTo(groups.track);
      if (d.points) L.geoJSON(d.points, {
        pane: "points",
        filter: (f) => f.properties.tau > 0,
        pointToLayer: (f, latlng) => L.circleMarker(latlng, {
          pane: "points", radius: 6, color: "#0b0f26", weight: 1.5, fillOpacity: 1, fillColor: ssColor(f.properties.maxwind),
        }),
        onEachFeature: (f, l) => {
          const p = f.properties;
          l.bindTooltip(`${p.datelbl} · ${p.maxwind} kt`, { className: "tw-tip" });
          l.bindPopup(popupTable(`${p.stormname} · ${p.tau} h`, [
            ["Valid", esc(p.fldatelbl || p.datelbl)],
            ["Forecast", esc(p.tcdvlp)],
            ["Max wind", `${p.maxwind} kt (${mph(p.maxwind)} mph)`],
            ["Gusts", p.gust ? `${p.gust} kt` : null],
            ["Position", ll(p.lat, p.lon)],
            ["Advisory", esc(p.advisnum)],
          ]));
        },
      }).addTo(groups.track);
    }

    const g = state.gtwo || {};
    if (g.areas) L.geoJSON(g.areas, {
      pane: "outlook",
      style: (f) => {
        const c = RISK[f.properties.risk7day] || "#ffde4a";
        return { color: c, weight: 2, dashArray: "6 5", fillColor: c, fillOpacity: 0.16 };
      },
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindPopup(popupTable(`7-day outlook area · ${p.basin || ""}`, [
          ["48 hours", `${esc(p.prob2day)} (${esc(p.risk2day)})`],
          ["7 days", `${esc(p.prob7day)} (${esc(p.risk7day)})`],
        ]));
      },
    }).addTo(groups.outlook);
    if (g.lines) L.geoJSON(g.lines, {
      pane: "outlook", style: { color: "#ffffff", weight: 2, opacity: 0.8 }, interactive: false,
    }).addTo(groups.outlook);
    [g.pts, g.two].forEach((pts) => pts && L.geoJSON(pts, {
      pane: "outlook",
      pointToLayer: (f, latlng) => L.marker(latlng, {
        pane: "outlook",
        icon: L.divIcon({ className: "", html: `<div style="font:800 22px/1 var(--brand);color:${RISK[f.properties.risk7day] || "#ffde4a"};text-shadow:0 0 4px #000">✕</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      }),
      onEachFeature: (f, l) => {
        const p = f.properties;
        l.bindPopup(popupTable("Area of interest", [
          ["48 hours", `${esc(p.prob2day)} (${esc(p.risk2day)})`],
          ["7 days", `${esc(p.prob7day)} (${esc(p.risk7day)})`],
        ]));
      },
    }).addTo(groups.outlook));
  }

  // —— ATCF guidance, invests, recon ———————————————————————————————————
  function drawModels() {
    groups.models.clearLayers();
    for (const sys of state.data?.systems || []) {
      const m = sys.models;
      if (!m) continue;
      const cyc = new Date(m.cycle);
      for (const [tech, pts] of Object.entries(m.tracks)) {
        const grp = MODEL_GROUP_OF[tech];
        if (!grp || !state.groupsOn[grp]) continue;
        const color = MODEL_COLORS[tech] || MODEL_GROUPS[grp].color;
        const isCons = grp === "consensus";
        const line = L.polyline(pts.map((p) => [p.lat, p.lon]), {
          pane: "lines", color, weight: isCons ? 2.6 : 1.6, opacity: grp === "simple" ? 0.6 : 0.85,
          dashArray: grp === "simple" ? "4 4" : null,
        });
        const end = pts[pts.length - 1];
        line.bindTooltip(`${tech} · ${pad(cyc.getUTCHours())}Z ${cyc.getUTCDate()}th · ${sys.name} · to ${end.tau} h`, { className: "tw-tip", sticky: true });
        line.addTo(groups.models);
        pts.filter((p) => p.tau > 0 && p.tau % 24 === 0).forEach((p) =>
          L.circleMarker([p.lat, p.lon], { pane: "lines", radius: 2, weight: 0, fillColor: color, fillOpacity: 0.9, interactive: false }).addTo(groups.models));
      }
    }
  }

  function drawInvests() {
    groups.invests.clearLayers();
    for (const sys of state.data?.systems || []) {
      if (sys.kind !== "invest" || !sys.best.length) continue;
      L.polyline(sys.best.map((p) => [p.lat, p.lon]), {
        pane: "lines", color: "#cfd5ef", weight: 1.8, opacity: 0.75, dashArray: "2 5",
      }).addTo(groups.invests);
      sys.best.forEach((p) => L.circleMarker([p.lat, p.lon], {
        pane: "lines", radius: 2.6, weight: 0, fillColor: ssColor(p.vmax), fillOpacity: 0.85,
      }).bindTooltip(`${fmtZ(p.t)} · ${p.ty} · ${p.vmax} kt${p.mslp ? ` · ${p.mslp} mb` : ""}`, { className: "tw-tip" }).addTo(groups.invests));
    }
  }

  function bearing(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  function obRows(o) {
    return [
      ["Time", fmtZ(o.t)],
      ["Position", ll(o.lat, o.lon)],
      ["Altitude", o.alt != null ? `${o.alt.toLocaleString()} m` : null],
      ["Flight-level wind", o.wspd != null ? `${String(o.wdir).padStart(3, "0")}° ${o.wspd} kt` : null],
      ["Peak 10-s wind", o.peak != null ? `${o.peak} kt` : null],
      ["SFMR surface wind", o.sfmr != null ? `${o.sfmr} kt` : null],
      ["Extrap. SLP", o.slp != null ? `${o.slp} mb` : null],
    ];
  }

  function drawRecon() {
    groups.recon.clearLayers();
    groups.vortex.clearLayers();
    groups.tasking.clearLayers();
    const r = state.data?.recon || {};
    for (const m of r.missions || []) {
      const obs = m.obs;
      if (obs.length < 2) continue;
      L.polyline(obs.map((o) => [o.lat, o.lon]), {
        pane: "recon", color: "#4ad1ff", weight: 1.5, opacity: isLive(m) ? 0.75 : 0.4,
      }).addTo(groups.recon);
      // Color observations by surface (SFMR) wind where measured, else flight-level wind.
      obs.forEach((o, i) => {
        if (i % 2 && i !== obs.length - 1) return;   // every minute is plenty at this scale
        const kt = o.sfmr ?? o.wspd;
        L.circleMarker([o.lat, o.lon], {
          pane: "recon", radius: 2.4, weight: 0, fillColor: ssColor(kt), fillOpacity: isLive(m) ? 0.95 : 0.6,
        }).bindPopup(popupTable(`${m.aircraft} · ${m.storm}`, obRows(o))).addTo(groups.recon);
      });
      const last = obs[obs.length - 1];
      const prev = obs[obs.length - 2];
      const hdg = bearing(prev, last);
      L.marker([last.lat, last.lon], {
        pane: "points",
        icon: L.divIcon({
          className: "",
          html: `<div class="tw-ac" style="transform:rotate(${hdg - 90}deg);opacity:${isLive(m) ? 1 : 0.55}">✈</div>`,
          iconSize: [18, 18], iconAnchor: [9, 9],
        }),
      }).bindTooltip(`${m.aircraft} ${m.storm} · ${hhmmZ(last.t)}${isLive(m) ? "" : " (ended)"}`, { className: "tw-tip", direction: "top", offset: [0, -8] })
        .bindPopup(popupTable(`${m.aircraft} · ${m.missionId} ${m.storm}`, [
          ["Status", isLive(m) ? "Reporting" : `Last report ${ago(m.last)}`],
          ...obRows(last),
          ["Max FL wind", m.maxFl ? `${m.maxFl.wspd} kt at ${hhmmZ(m.maxFl.t)}` : null],
          ["Max SFMR", m.maxSfmr ? `${m.maxSfmr.sfmr} kt at ${hhmmZ(m.maxSfmr.t)}` : null],
        ]))
        .addTo(groups.recon);
    }

    for (const v of r.vortex || []) {
      L.marker([v.lat, v.lon], {
        pane: "points",
        icon: L.divIcon({ className: "", html: `<div class="tw-vortex"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).bindTooltip(`Vortex fix ${hhmmZ(v.t)}${v.slp ? ` · ${v.slp} mb` : ""}`, { className: "tw-tip" })
        .bindPopup(popupTable(`Vortex fix · ${v.storm}`, [
          ["Time", fmtZ(v.t)],
          ["Center", ll(v.lat, v.lon)],
          ["Min. pressure", esc(v.slpNote)],
          ["Max FL wind", v.maxFl ? `${v.maxFl} kt` : null],
          ["Eye", esc([v.eye, v.eyeSize].filter(Boolean).join(" · "))],
          ["Mission", esc(v.mission)],
        ])).addTo(groups.vortex);
    }

    for (const b of state.data?.tcpod?.basins || []) {
      for (const s of b.systems) {
        for (const f of s.flights) {
          if (f.lat == null) continue;
          L.marker([f.lat, f.lon], {
            pane: "points",
            icon: L.divIcon({ className: "", html: `<div class="tw-target"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
          }).bindTooltip(`Tasked: ${f.aircraft} · ${f.fields.fixTime || ""}`, { className: "tw-tip" })
            .bindPopup(popupTable(`TCPOD · ${s.name}`, podRows(f))).addTo(groups.tasking);
        }
      }
    }
  }

  function podRows(f) {
    const F = f.fields;
    return [
      ["Flight", esc(`${f.flight} — ${f.aircraft}`)],
      ["Fix / target time", esc(F.fixTime)],
      ["Mission ID", esc(F.mission)],
      ["Departure", esc(F.departure)],
      ["Position", esc(F.position)],
      ["On station", esc(F.onStation)],
      ["Altitude", esc(F.altitude)],
      ["Profile", esc(F.profile)],
      ["WRA", esc(F.wra)],
    ];
  }

  // —— Storm markers and panels —————————————————————————————————————
  function systemsList() {
    const d = state.data;
    const atcf = Object.fromEntries((d.systems || []).map((s) => [s.id, s]));
    const list = (d.storms || []).map((s) => ({ ...s, kind: "storm", basin: s.id.slice(0, 2).toUpperCase(), atcf: atcf[s.id] }));
    for (const s of d.systems || []) {
      if (s.kind !== "invest" || !s.best.length) continue;
      const last = s.best[s.best.length - 1];
      list.push({
        id: s.id, kind: "invest", basin: s.basin, name: s.name, classification: last.ty,
        intensity: last.vmax, pressure: last.mslp, lat: last.lat, lon: last.lon, lastUpdate: last.t, atcf: s,
      });
    }
    return list;
  }

  function drawStormMarkers() {
    stormMarkers.clearLayers();
    for (const s of systemsList()) {
      if (s.lat == null) continue;
      const invest = s.kind === "invest";
      const label = invest ? s.id.slice(2, 4) + s.id[1].toUpperCase() : ssLabel(s.intensity);
      const m = L.marker([s.lat, s.lon], {
        pane: "points", zIndexOffset: 1000,
        icon: L.divIcon({
          className: "",
          html: `<div class="tw-storm${invest ? " invest" : ""}" style="--c:${ssColor(s.intensity)}">${label}</div>`,
          iconSize: [30, 30], iconAnchor: [15, 15],
        }),
      });
      m.bindTooltip(s.name, { permanent: true, direction: "right", offset: [16, 0], className: "tw-label", pane: "labels" });
      m.on("click", () => { document.getElementById(`storm-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); });
      m.addTo(stormMarkers);
    }
  }

  function intensityChart(sys) {
    const m = sys?.models;
    if (!m) return "";
    const series = INTENSITY.map(([tech, color, name]) => {
      const pts = (m.tracks[tech] || []).filter((p) => p.vmax != null && p.tau <= 168);
      return { tech, color, name, pts };
    }).filter((s) => s.pts.length >= 2);
    if (!series.length) return "";
    // Narrower drawing on phones so the axis text stays readable once scaled.
    const W = window.matchMedia("(max-width: 639px)").matches ? 340 : 560, H = 150, L0 = 30, R0 = 8, T0 = 8, B0 = 20;
    const maxTau = Math.max(120, ...series.flatMap((s) => s.pts.map((p) => p.tau)));
    const vals = series.flatMap((s) => s.pts.map((p) => p.vmax));
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 10) / 20) * 20);
    const hi = Math.ceil((Math.max(...vals) + 10) / 20) * 20;
    const x = (t) => L0 + (t / maxTau) * (W - L0 - R0);
    const y = (v) => T0 + (1 - (v - lo) / (hi - lo)) * (H - T0 - B0);
    let grid = "";
    // Saffir–Simpson thresholds as faint bands
    [[34, "TS"], [64, "H1"], [96, "MH"]].forEach(([v, t]) => {
      if (v > lo && v < hi) grid += `<line x1="${L0}" x2="${W - R0}" y1="${y(v)}" y2="${y(v)}" stroke="${ssColor(v)}" stroke-opacity=".35" stroke-dasharray="3 4"/><text x="${W - R0}" y="${y(v) - 3}" text-anchor="end" font-size="9" fill="${ssColor(v)}" fill-opacity=".7">${t}</text>`;
    });
    for (let v = lo; v <= hi; v += 20) grid += `<text x="${L0 - 5}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,.42)">${v}</text>`;
    for (let t = 0; t <= maxTau; t += 24) grid += `<line x1="${x(t)}" x2="${x(t)}" y1="${T0}" y2="${H - B0}" stroke="rgba(255,255,255,.07)"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.42)">${t}h</text>`;
    const lines = series.map((s) =>
      `<polyline fill="none" stroke="${s.color}" stroke-width="${s.tech === "OFCI" ? 2.4 : 1.6}" stroke-linejoin="round" points="${s.pts.map((p) => `${x(p.tau).toFixed(1)},${y(p.vmax).toFixed(1)}`).join(" ")}"><title>${s.name}</title></polyline>`).join("");
    const cyc = new Date(m.cycle);
    return `<figure class="ichart"><figcaption>Intensity guidance (kt) · ${pad(cyc.getUTCHours())}Z cycle</figcaption>
      <div class="ichart__key">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("")}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Intensity guidance for ${esc(sys.name)}">${grid}${lines}</svg></figure>`;
  }

  function renderStorms() {
    const list = systemsList();
    const el = $("storms");
    const vortex = state.data.recon?.vortex || [];
    const pod = state.data.tcpod;
    if (!list.length) {
      el.innerHTML = `<p class="tw-empty">No active tropical cyclones or invests. Check the outlooks below for areas NHC is watching.</p>`;
      return;
    }
    el.innerHTML = list.map((s) => {
      const invest = s.kind === "invest";
      const cls = CLASS[s.classification] || s.classification || "";
      const fix = vortex.find((v) => v.storm.toLowerCase() === s.id.toLowerCase());
      const nameKey = (s.name || "").toUpperCase().split(" ").pop();
      const tasked = (pod?.basins || []).flatMap((b) => b.systems).filter((x) => x.name.toUpperCase().includes(nameKey) || x.name.toUpperCase().includes(s.id.slice(2, 4) + s.id[1].toUpperCase()));
      const flights = tasked.flatMap((x) => x.flights);
      const L = s.links || {};
      const move = s.movementSpeed === 0 ? "Stationary"
        : s.movementSpeed != null && s.movementDir != null ? `${compass(s.movementDir)} ${s.movementSpeed} kt` : "—";
      return `<article class="storm" id="storm-${esc(s.id)}">
        <div class="storm__top">
          <div class="storm__badge${invest ? " invest" : ""}" style="--c:${ssColor(s.intensity)}">${invest ? "INV" : ssLabel(s.intensity)}</div>
          <h3 class="storm__name">${esc(invest ? s.name : `${cls} ${s.name}`)}<small>${esc(s.id.toUpperCase())} · ${BASIN_NAMES[s.basin] || s.basin}${s.advisory ? ` · Advisory ${esc(s.advisory)}` : ""} · ${fmtZ(s.lastUpdate)}</small></h3>
          <button class="btn btn--secondary btn--sm storm__zoom" data-zoom="${esc(s.id)}">Zoom</button>
        </div>
        <div class="storm__stats">
          <div class="stat"><span>Max wind</span><b>${s.intensity != null ? `${s.intensity} kt` : "—"}</b></div>
          <div class="stat"><span>Pressure</span><b>${s.pressure ? `${s.pressure} mb` : "—"}</b></div>
          <div class="stat"><span>Movement</span><b>${move}</b></div>
          <div class="stat"><span>Position</span><b>${s.lat != null ? ll(s.lat, s.lon) : "—"}</b></div>
        </div>
        ${fix ? `<p class="storm__note"><b>Latest recon fix</b> ${fmtZ(fix.t)} — ${esc(fix.slpNote)}${fix.maxFl ? `, max flight-level wind ${fix.maxFl} kt` : ""}${fix.eye ? `, eye ${esc(fix.eye.toLowerCase())}` : ""}.</p>` : ""}
        ${flights.length ? `<p class="storm__note"><b>Tasked</b> ${flights.map((f) => `${esc(f.aircraft)} (${esc(f.fields.profile?.toLowerCase() || "mission")}, ${esc(f.fields.fixTime || "")})`).join("; ")}.</p>` : ""}
        ${intensityChart(s.atcf)}
        ${invest ? "" : `<div class="storm__links">
          ${L.public ? `<a href="${esc(L.public)}" target="_blank" rel="noopener">Public advisory</a>` : ""}
          ${L.discussion ? `<a href="${esc(L.discussion)}" target="_blank" rel="noopener">Discussion</a>` : ""}
          ${L.forecast ? `<a href="${esc(L.forecast)}" target="_blank" rel="noopener">Forecast advisory</a>` : ""}
          ${L.windProbs ? `<a href="${esc(L.windProbs)}" target="_blank" rel="noopener">Wind probabilities</a>` : ""}
          ${L.graphics ? `<a href="${esc(L.graphics)}" target="_blank" rel="noopener">NHC graphics</a>` : ""}
        </div>`}
      </article>`;
    }).join("");
    el.querySelectorAll("[data-zoom]").forEach((b) => { b.onclick = () => zoomTo(b.dataset.zoom); });
  }

  function renderPod() {
    const pod = state.data.tcpod;
    const el = $("pod");
    if (!pod) { el.innerHTML = `<p class="tw-empty">The TCPOD couldn't be loaded.</p>`; return; }
    $("podNote").textContent = `No. ${pod.number || "—"}${pod.issued ? ` · Issued ${titleTime(pod.issued)}` : ""}`;
    const basins = pod.basins.map((b) => {
      const body = b.negative
        ? `<p class="pod-text">No reconnaissance requirements.</p>`
        : b.systems.map((s) => `<div class="pod-sys"><b>${esc(s.name)}</b>${s.note ? `<p class="pod-text">${esc(s.note)}</p>` : ""}
            ${s.flights.map((f) => `<div class="pod-flight">
              <div class="pod-flight__head">${esc(f.flight === "One" && s.flights.length === 1 ? "" : `Flight ${f.flight} · `)}${esc(f.aircraft)}<span>${esc(f.fields.profile || "")}</span></div>
              <dl>${podRows(f).slice(1).filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
            </div>`).join("")}</div>`).join("");
      return `<div class="pod-basin"><h3>${esc(b.name)}</h3>${body}
        ${b.outlook ? `<p class="tw-sub">Outlook for succeeding day</p><p class="pod-text">${esc(b.outlook)}</p>` : ""}
        ${b.remarks ? `<p class="tw-sub">Remarks</p><p class="pod-text">${esc(b.remarks)}</p>` : ""}</div>`;
    }).join("");
    el.innerHTML = `<p class="pod-text" style="margin:0 0 .6rem">Valid ${esc(pod.valid || "—")}</p>${basins}
      <details class="raw"><summary>Full TCPOD text</summary><pre>${esc(pod.text)}</pre></details>`;
  }

  function renderRecon() {
    const r = state.data.recon || {};
    const el = $("recon");
    const missions = r.missions || [];
    const vortex = r.vortex || [];
    if (!missions.length && !vortex.length) {
      el.innerHTML = `<p class="tw-empty">No reconnaissance observations in the last 12 hours.</p>`;
      return;
    }
    const mrows = missions.map((m) => {
      const last = m.obs[m.obs.length - 1];
      return `<tr>
        <td><b>${esc(m.aircraft)}</b>${isLive(m) ? '<span class="live">LIVE</span>' : ""}<small>${esc(m.missionId)} ${esc(m.storm)}</small></td>
        <td>${hhmmZ(last.t)}<small>${ago(last.t)}</small></td>
        <td>${ll(last.lat, last.lon)}<small>${last.alt != null ? `${last.alt.toLocaleString()} m` : ""}</small></td>
        <td>${m.maxFl ? `${m.maxFl.wspd} kt` : "—"}<small>${m.maxFl ? hhmmZ(m.maxFl.t) : ""}</small></td>
        <td>${m.maxSfmr ? `${m.maxSfmr.sfmr} kt` : "—"}<small>${m.maxSfmr ? hhmmZ(m.maxSfmr.t) : ""}</small></td>
      </tr>`;
    }).join("");
    const vrows = vortex.slice(0, 8).map((v) => `<tr>
        <td><b>${esc(v.storm)}</b><small>${esc(v.mission.replace(/\s+OB\s+\d+$/, ""))}</small></td>
        <td>${fmtZ(v.t)}<small>${ago(v.t)}</small></td>
        <td>${ll(v.lat, v.lon)}</td>
        <td>${v.slp ? `${v.slp} mb` : "—"}<small>${/EXTRAP/.test(v.slpNote) ? "extrap." : "dropsonde"}</small></td>
        <td>${v.maxFl ? `${v.maxFl} kt` : "—"}<small>${esc(v.eye.toLowerCase())}</small></td>
      </tr>`).join("");
    el.innerHTML = `
      ${missions.length ? `<div class="tw-table-wrap"><table class="flights">
        <thead><tr><th>Aircraft</th><th>Last ob</th><th>Position</th><th>Max FL wind</th><th>Max SFMR</th></tr></thead>
        <tbody>${mrows}</tbody></table></div>` : `<p class="tw-empty">No aircraft observations in the last 12 hours.</p>`}
      ${vortex.length ? `<p class="tw-sub">Vortex fixes</p><div class="tw-table-wrap"><table class="flights">
        <thead><tr><th>Storm</th><th>Time</th><th>Center</th><th>Min. pressure</th><th>Max FL wind</th></tr></thead>
        <tbody>${vrows}</tbody></table></div>` : ""}`;
  }

  function renderOutlooks() {
    const two = state.data.outlooks || [];
    const tabs = $("twoTabs");
    if (!two.length) { $("twoText").textContent = "Outlooks couldn't be loaded."; return; }
    const pick = (i) => {
      tabs.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-pressed", i === j));
      $("twoText").textContent = two[i].text;
      $("twoNote").innerHTML = two[i].link ? `<a href="${esc(two[i].link)}" target="_blank" rel="noopener">Graphical outlook ↗</a>` : "";
    };
    const current = [...tabs.querySelectorAll("button")].findIndex((b) => b.getAttribute("aria-pressed") === "true");
    tabs.innerHTML = two.map((o) => `<button type="button">${esc(BASIN_NAMES[o.basin] || o.basin)}</button>`).join("");
    tabs.querySelectorAll("button").forEach((b, i) => { b.onclick = () => pick(i); });
    tabs.style.marginBottom = "0.2rem";
    pick(current >= 0 ? current : 0);
  }

  function renderMeta() {
    const d = state.data;
    const list = systemsList();
    const storms = list.filter((s) => s.kind === "storm").length;
    const inv = list.length - storms;
    $("chipSystems").firstChild.textContent = storms || inv
      ? `${storms} active storm${storms === 1 ? "" : "s"}${inv ? ` · ${inv} invest${inv === 1 ? "" : "s"}` : ""}`
      : "No active systems";
    const live = (d.recon?.missions || []).filter(isLive).length;
    $("chipSystemsSub").textContent = live ? `${live} recon aircraft reporting` : "";
    $("chipData").firstChild.textContent = `Data ${hhmmZ(d.generated)}`;
    $("chipDataSub").textContent = `Updated ${ago(d.generated)}`;
    const stale = Date.now() - new Date(d.generated) > 75 * 60000;
    $("chipData").classList.toggle("warn", stale);
    if (stale) $("chipDataSub").textContent = `Last updated ${ago(d.generated)} — collection may be delayed`;
  }

  // —— Zoom helpers —————————————————————————————————————————————————
  function boundsForSystem(id) {
    const b = L.latLngBounds([]);
    const s = systemsList().find((x) => x.id === id);
    if (!s) return b;
    if (s.lat != null) b.extend([s.lat, s.lon]);
    const nhc = s.bin && state.nhc[s.bin];
    if (nhc?.cone) b.extend(L.geoJSON(nhc.cone).getBounds());
    const consensus = s.atcf?.models?.tracks?.TVCN || s.atcf?.models?.tracks?.IVCN;
    if (consensus) consensus.forEach((p) => b.extend([p.lat, p.lon]));
    return b;
  }

  function zoomTo(id) {
    const b = boundsForSystem(id);
    if (b.isValid()) {
      map.flyToBounds(b.pad(0.25), { maxZoom: 6, duration: 0.8 });
      $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function zoomBasin(key) {
    document.querySelectorAll("#basins button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.basin === key));
    if (key === "active") {
      const b = L.latLngBounds([]);
      systemsList().forEach((s) => { const sb = boundsForSystem(s.id); if (sb.isValid()) b.extend(sb); });
      (state.data?.recon?.missions || []).filter(isLive).forEach((m) => { const o = m.obs[m.obs.length - 1]; b.extend([o.lat, o.lon]); });
      if (b.isValid()) { map.flyToBounds(b.pad(0.15), { maxZoom: 6, duration: 0.8 }); return; }
      key = "ALL";
    }
    map.flyToBounds(BASIN_BOUNDS[key], { duration: 0.8 });
  }
  document.querySelectorAll("#basins button").forEach((b) => { b.onclick = () => zoomBasin(b.dataset.basin); });

  // —— Load & refresh ——————————————————————————————————————————————
  async function loadData() {
    const res = await fetch(`data/tropical.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const changed = !state.data || data.generated !== state.data.generated;
    state.data = data;
    renderMeta();
    if (!changed) return false;
    drawModels();
    drawInvests();
    drawRecon();
    drawStormMarkers();
    renderStorms();
    renderPod();
    renderRecon();
    renderOutlooks();
    return true;
  }

  async function init() {
    setSatellite("ir");
    setStatus("Loading tropical data…");
    let first = true;
    try {
      await loadData();
    } catch (e) {
      $("chipSystems").firstChild.textContent = "Data unavailable";
      ["storms", "pod", "recon"].forEach((id) => { $(id).innerHTML = `<p class="tw-empty">Couldn't load the latest data. Try again in a few minutes.</p>`; });
      $("twoText").textContent = "";
    }
    try {
      await loadNhc();
    } catch (e) {
      setStatus("NHC map service unavailable — cones and warnings not shown");
      first = false;
    }
    if (first) setStatus("");
    if (state.data) zoomBasin("active");

    // Refresh: data file every 5 min, NHC layers every 10, satellite frames every 5.
    setInterval(() => loadData().catch(() => {}), 5 * 60000);
    setInterval(() => loadNhc().then(() => setStatus("")).catch(() => {}), 10 * 60000);
    setInterval(() => {
      if (state.satKind !== "off" && !state.satTimer) setSatellite(state.satKind);
      if (state.data) renderMeta();
    }, 5 * 60000);
  }

  init();
})();

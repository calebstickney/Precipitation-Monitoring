// Precipitation Monitoring – page logic (Leaflet map, controls, saved locations).
// All data work happens in js/worker.js; grids come back as Float32Arrays and are drawn here.
import {
  cellIndex, gridBounds, legendFor, colorOf, autoScale, autoDepScale, areaStats, areaMask,
  labelPoint, polygonAreaKm2, geoTagsFor, colRow, VAR_LABELS, areaHasPartial,
} from "./grid.js?v=7";
import { writeGeoTiff } from "./decoders.js?v=7";
import { importAreas } from "./shapes.js?v=7";
import { makeBins, intervalsFor, defaultInterval, INTERVAL_LABELS } from "./bins.js?v=7";

const $ = (id) => document.getElementById(id);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rid = () => Math.random().toString(36).slice(2, 12);
const HOUR = 3600000, DAY = 86400000;

// ------------------------------------------------------------------ worker RPC
const worker = new Worker(new URL("./worker.js?v=7", import.meta.url), { type: "module" });
const pending = new Map();
let callSeq = 0;
worker.onmessage = (ev) => {
  const { id, progress, result, error } = ev.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress) { if (p.onProgress) p.onProgress(progress); return; }
  pending.delete(id);
  if (error) p.reject(new Error(error)); else p.resolve(result);
};
worker.onerror = (e) => setStatus(`Background worker failed: ${e.message || "this browser may be too old"}`, true);
function call(fn, args = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, fn, args });
  });
}

// ------------------------------------------------------------------ preferences (this browser)
const PREF_KEY = "Precip.prefs.v1";
const LOC_KEY = "Precip.locations.v1";
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (_) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
};
const prefs = store.get(PREF_KEY, {});
const savePrefs = () => store.set(PREF_KEY, prefs);

const state = {
  cfg: null, source: "stage4", s4Latest: {}, mrmsLatest: {},
  main: null, display: null, layer: null,
  var: prefs.var || "obs", scale: prefs.scale || "auto", opacity: prefs.opacity ?? 0.4,
  sel: null, selMarker: null, series: null,
  lastPreset: null, steps: [], stepMode: false, stepIdx: 0, playing: false, stepToken: 0, interval: "day",
  boundary: prefs.dayBoundary === "local" ? "local" : "12z",   // daily tab: NWS 12Z days or local-midnight days (MRMS)
  localLatest: null,                                              // end of the latest MRMS hour (local-midnight mode)
  saved: { points: [], areas: [], removedDefaults: [] }, values: { points: [], areas: [] },
  drawing: null, fitted: !!prefs.view, autoTimer: null, lastDeleted: null,
};

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true, worldCopyJump: true });
if (prefs.view) map.setView([prefs.view.lat, prefs.view.lon], prefs.view.z); else map.setView([37.8, -85.5], 6);
const pane = (name, z, passThrough) => {
  map.createPane(name).style.zIndex = z;
  if (passThrough) map.getPane(name).style.pointerEvents = "none";
};
pane("precip", 450, true);
pane("labels", 620, true);
pane("areas", 625);
pane("pick", 640);
pane("saved", 650);

const esri = (svc, opts) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`,
  Object.assign({ attribution: "Basemap &copy; Esri", maxZoom: 19 }, opts));
const bases = {
  "Light gray": esri("Canvas/World_Light_Gray_Base", { maxNativeZoom: 16 }),
  "Dark gray": esri("Canvas/World_Dark_Gray_Base", { maxNativeZoom: 16 }),
  "Topographic": esri("World_Topo_Map"),
  "Imagery": esri("World_Imagery"),
  "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19 }),
};
const darkPref = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
const overlays = {
  "Labels & boundaries": esri(darkPref ? "Canvas/World_Dark_Gray_Reference" : "Canvas/World_Light_Gray_Reference", { pane: "labels", maxNativeZoom: 16 }),
  "Places & roads (for imagery)": esri("Reference/World_Boundaries_and_Places", { pane: "labels" }),
};
let baseLayer = bases[prefs.base] || (darkPref ? bases["Dark gray"] : bases["Light gray"]);
baseLayer.addTo(map);
overlays["Labels & boundaries"].addTo(map);
L.control.layers(bases, overlays, { position: "topright" }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);
map.on("baselayerchange", (e) => { baseLayer = e.layer; prefs.base = e.name; savePrefs(); });
map.on("moveend", () => { const c = map.getCenter(); prefs.view = { lat: c.lat, lon: c.lng, z: map.getZoom() }; savePrefs(); });

const RefreshCtl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const d = L.DomUtil.create("div", "leaflet-bar leaflet-control refresh-ctl");
    const a = L.DomUtil.create("a", "", d);
    a.href = "#"; a.title = "Refresh: re-check NWS for new data and redraw the map"; a.textContent = "↻";
    a.setAttribute("role", "button");
    L.DomEvent.on(a, "click", (e) => { L.DomEvent.preventDefault(e); refresh(); });
    L.DomEvent.disableClickPropagation(d);
    this.btn = a;
    return d;
  },
});
const refreshCtl = new RefreshCtl().addTo(map);

const legendCtrl = L.control({ position: "bottomright" });
legendCtrl.onAdd = () => {
  const d = L.DomUtil.create("div", "legend hidden");
  d.id = "legend";
  if (window.innerWidth < 760) d.classList.add("collapsed");
  L.DomEvent.on(d, "click", (e) => { if (e.target.classList.contains("t")) d.classList.toggle("collapsed"); });
  L.DomEvent.disableClickPropagation(d);
  return d;
};
legendCtrl.addTo(map);
const savedLayer = L.layerGroup().addTo(map);

// ------------------------------------------------------------------ precipitation layer (drawn from the grid in memory)
const PrecipLayer = L.GridLayer.extend({
  createTile(coords) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 256;
    try { renderTile(tile, coords, this.options.result, this.options.v, this.options.lg); } catch (e) { console.error(e); }
    return tile;
  },
});

function renderTile(canvas, { x, y, z }, r, v, lg) {
  if (!r) return;
  const g = r.grid, n = 256 * Math.pow(2, z);
  const lons = new Float64Array(256), lats = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    let lon = ((x * 256 + i + 0.5) / n) * 360 - 180;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    lons[i] = lon;
    const yy = Math.PI * (1 - (2 * (y * 256 + i + 0.5)) / n);
    lats[i] = (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
  }
  const [[s, w], [nn, e]] = r.bounds;
  let anyLon = false, anyLat = false;
  for (let i = 0; i < 256; i++) { if (lons[i] >= w && lons[i] <= e) anyLon = true; if (lats[i] >= s && lats[i] <= nn) anyLat = true; }
  if (!anyLon || !anyLat) return;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(256, 256);
  const px = new Uint32Array(img.data.buffer);
  const obs = r.obs, nrm = r.normal, W = g.width, H = g.height;
  const val = v === "obs" ? (k) => obs[k]
    : v === "normal" ? (k) => nrm[k]
      : v === "departure" ? (k) => obs[k] - nrm[k]
        : (k) => (nrm[k] > 0.01 ? (100 * obs[k]) / nrm[k] : NaN);
  if (g.kind === "latlon") {
    const cols = new Int32Array(256);
    for (let i = 0; i < 256; i++) cols[i] = Math.floor((lons[i] - g.lon0) / g.dlon);
    for (let j = 0; j < 256; j++) {
      const row = Math.floor((g.lat0 - lats[j]) / g.dlat);
      if (row < 0 || row >= H) continue;
      for (let i = 0; i < 256; i++) {
        const c = cols[i];
        if (c >= 0 && c < W) px[j * 256 + i] = colorOf(lg, val(row * W + c));
      }
    }
  } else {
    const D2R = Math.PI / 180, K = (1 + Math.sin(60 * D2R)) * g.R;
    const sn = new Float64Array(256), cs = new Float64Array(256);
    for (let i = 0; i < 256; i++) { const dl = (lons[i] + 105) * D2R; sn[i] = Math.sin(dl); cs[i] = Math.cos(dl); }
    for (let j = 0; j < 256; j++) {
      const phi = lats[j] * D2R, rho = (K * Math.cos(phi)) / (1 + Math.sin(phi));
      for (let i = 0; i < 256; i++) {
        const c = Math.floor((rho * sn[i] - g.x0) / g.dx), row = Math.floor((g.y0 + rho * cs[i]) / g.dy);
        if (c >= 0 && c < W && row >= 0 && row < H) px[j * 256 + i] = colorOf(lg, val(row * W + c));
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ formatting
const fmtIn = (v) => (v == null || Number.isNaN(v) ? "—" : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} in`);
const fmtVal = (v, vr) => {
  if (v == null || Number.isNaN(v)) return "—";
  if (vr === "pct") return `${Math.round(v)}%`;
  if (vr === "departure") return `${v >= 0 ? "+" : "−"}${fmtIn(Math.abs(v))}`;
  return fmtIn(v);
};
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseDate = (s) => new Date(s + "T00:00:00Z");
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
const localTime = (d, opts) => d.toLocaleString(undefined, opts || { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayLabel = (iso, long) => parseDate(iso).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}) });
const llText = (lat, lon) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
const csvCell = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

function setStatus(msg, isError, html) {
  const s = $("status");
  if (html) s.innerHTML = msg; else s.textContent = msg || "";
  s.classList.toggle("error", !!isError);
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// CSVs: plain hyphens instead of en/em dashes, and a UTF-8 byte-order mark so Excel doesn't read
// the file as Windows-1252 (which turns an en dash into "â€“").
const BOM = String.fromCharCode(0xfeff);
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, "g");
const downloadText = (text, name, type) => {
  if (!type || type === "text/csv") text = BOM + text.replace(LONG_DASHES, "-");
  downloadBlob(new Blob([text], { type: type || "text/csv;charset=utf-8" }), name);
};
// "2026-10-05 08:00 EDT" in the viewer's time zone, for CSV columns
const localStamp = (iso) => {
  const d = new Date(iso);
  const tz = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}`;
};
const localDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMidnight = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const MRMS_LOCAL_EARLIEST = "2020-10-15";

// ------------------------------------------------------------------ source tabs + inputs
function setSource(src) {
  state.source = src;
  prefs.source = src; savePrefs();
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.src === src));
  $("src-stage4").classList.toggle("hidden", src !== "stage4");
  $("src-mrms").classList.toggle("hidden", src !== "mrms");
  if (src === "mrms") refreshMrmsLatest().catch(() => {});
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setSource(b.dataset.src)));

async function refreshS4Latest() {
  if (state.boundary === "local") {
    // local-midnight days come from MRMS hourly data; the last day may be partial
    state.localLatest = new Date(await call("mrmsLatest", ["ms2"]));
    const last = localDateStr(new Date(+state.localLatest - 1));
    for (const id of ["s4-start", "s4-end"]) { $(id).min = MRMS_LOCAL_EARLIEST; $(id).max = last; }
    updateS4Note();
    return last;
  }
  const region = $("s4-region").value;
  const latest = await call("s4Latest", [region]);
  state.s4Latest[region] = latest;
  for (const id of ["s4-start", "s4-end"]) { $(id).min = state.cfg.s4_earliest; $(id).max = latest; }
  updateS4Note();
  return latest;
}

function s4Preset(p) {
  if (state.boundary === "local") {
    if (!state.localLatest) return;
    const last = new Date(+state.localLatest - 1);
    const y = last.getFullYear(), m = last.getMonth(), d = last.getDate();
    let start = new Date(y, m, d);
    if (/^\d+$/.test(p)) start = new Date(y, m, d - (Number(p) - 1));
    else if (p === "mtd") start = new Date(y, m, 1);
    else if (p === "wytd") start = new Date(m >= 9 ? y : y - 1, 9, 1);
    else if (p === "ytd") start = new Date(y, 0, 1);
    $("s4-start").value = localDateStr(start);
    $("s4-end").value = localDateStr(last);
    updateS4Note();
    return;
  }
  const latestDay = state.s4Latest[$("s4-region").value];
  if (!latestDay) return;
  const L_ = parseDate(latestDay);
  let start = L_;
  if (/^\d+$/.test(p)) start = addDays(L_, -(Number(p) - 1));
  // NWS month / water-year / year-to-date totals start with the day ending 12Z on the 2nd
  else if (p === "mtd") start = new Date(Date.UTC(L_.getUTCFullYear(), L_.getUTCMonth(), 2));
  else if (p === "wytd") start = new Date(Date.UTC(L_.getUTCMonth() >= 9 ? L_.getUTCFullYear() : L_.getUTCFullYear() - 1, 9, 2));
  else if (p === "ytd") start = new Date(Date.UTC(L_.getUTCFullYear(), 0, 2));
  if (start > L_) start = L_;
  $("s4-start").value = isoDate(start);
  $("s4-end").value = isoDate(L_);
  updateS4Note();
}

function updateS4Note() {
  const s = $("s4-start").value, e = $("s4-end").value;
  if (!s || !e) return;
  if (state.boundary === "local") {
    const n = Math.round((localMidnight(e) - localMidnight(s)) / DAY) + 1;
    const endFull = localMidnight(e); endFull.setDate(endFull.getDate() + 1);
    const partial = state.localLatest && endFull > state.localLatest;
    $("s4-note").textContent = n < 1 ? "First day must be on or before the last day." :
      `${n} day${n > 1 ? "s" : ""}, midnight to midnight local time` +
      (partial ? ` (the last day so far, through ${localTime(state.localLatest)})` : "") +
      `. Uses NOAA MRMS multi-sensor (radar + gauge) hourly data summed by local day; normals aren't available. Data from Oct 15, 2020.`;
    return;
  }
  const t0 = new Date(addDays(parseDate(s), -1).getTime() + 12 * HOUR);
  const t1 = new Date(parseDate(e).getTime() + 12 * HOUR);
  const n = Math.round((parseDate(e) - parseDate(s)) / DAY) + 1;
  $("s4-note").textContent = n < 1 ? "First day must be on or before the last day." :
    `${n} day${n > 1 ? "s" : ""}: ${localTime(t0)} → ${localTime(t1)} local time. ` +
    `Each day is the 24 h ending 12:00 UTC. Latest available: ${state.s4Latest[$("s4-region").value] || "…"}.`;
}

async function refreshMrmsLatest() {
  const product = $("mrms-product").value;
  $("mrms-note").textContent = "Checking for the latest hour…";
  try {
    const latest = new Date(await call("mrmsLatest", [product]));
    state.mrmsLatest[product] = latest;
    $("mrms-note").textContent = `Latest hour ends ${localTime(latest)}. Archive back to Oct 2020.`;
    for (const id of ["mrms-start", "mrms-end"]) $(id).max = toLocalInput(latest);
    $("mrms-start").min = $("mrms-end").min = toLocalInput(new Date(state.cfg.mrms_earliest));
    if (!$("mrms-end").value) mrmsPreset(24);
    return latest;
  } catch (e) {
    $("mrms-note").textContent = `Could not reach the MRMS archive: ${e.message}`;
    throw e;
  }
}

function mrmsPreset(h) {
  const latest = state.mrmsLatest[$("mrms-product").value];
  if (!latest) return;
  $("mrms-end").value = toLocalInput(latest);
  $("mrms-start").value = toLocalInput(new Date(latest.getTime() - Number(h) * HOUR));
}

function applyPreset(source, p) {
  if (source === "stage4") s4Preset(p); else mrmsPreset(p);
  state.lastPreset = { source, p };
  prefs.preset = prefs.preset || {};
  prefs.preset[source] = p; savePrefs();
}

$("s4-presets").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  applyPreset("stage4", b.dataset.p); load();
});
$("mrms-presets").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  try { await refreshMrmsLatest(); } catch (_) { return; }
  applyPreset("mrms", b.dataset.p); load();
});
["s4-start", "s4-end"].forEach((id) => $(id).addEventListener("change", () => { state.lastPreset = null; updateS4Note(); }));
["mrms-start", "mrms-end"].forEach((id) => $(id).addEventListener("change", () => { state.lastPreset = null; }));
$("s4-region").addEventListener("change", async () => {
  prefs.region = $("s4-region").value; savePrefs();
  state.fitted = false;
  setStatus("Checking latest data…");
  try { await refreshS4Latest(); applyPreset("stage4", "7"); setStatus(""); load(); } catch (e) { setStatus(e.message, true); }
});
$("mrms-product").addEventListener("change", () => { prefs.product = $("mrms-product").value; savePrefs(); refreshMrmsLatest().catch(() => {}); });

function applyBoundaryUi() {
  $("day-boundary").value = state.boundary;
  $("s4-region-wrap").classList.toggle("hidden", state.boundary === "local");   // MRMS covers CONUS only
  // the Daily tab's subtitle names the data behind the current day setting
  $("daily-sub").textContent = state.boundary === "local" ? "MRMS · midnight · 2020+" : "Stage IV · 12Z · 2016+";
}
$("day-boundary").addEventListener("change", async () => {
  state.boundary = $("day-boundary").value;
  prefs.dayBoundary = state.boundary; savePrefs();
  applyBoundaryUi();
  setStatus("Checking latest data…");
  try {
    await refreshS4Latest();
    applyPreset("stage4", (state.lastPreset && state.lastPreset.source === "stage4" && state.lastPreset.p) || "7");
    setStatus("");
    load();
  } catch (e) { setStatus(e.message, true); }
});

// ------------------------------------------------------------------ results
let resultSeq = 0;
function makeResult(raw) {
  const r = Object.assign(raw, { id: ++resultSeq });
  r.bounds = gridBounds(r.grid);
  r.autoScale = autoScale(r.obs);
  r.autoDepScale = r.normal ? autoDepScale(r.obs, r.normal) : null;
  return r;
}

function currentParams() {
  if (state.source === "stage4" && state.boundary === "local") {
    // midnight-to-midnight local days: sum MRMS hourly data from local midnight to local midnight
    const s = $("s4-start").value, e = $("s4-end").value;
    if (!s || !e) throw new Error("Pick a first and last day.");
    if (s < MRMS_LOCAL_EARLIEST) throw new Error("Midnight-to-midnight days use MRMS data, which starts Oct 15, 2020. Choose \"12:00 UTC to 12:00 UTC\" for older dates.");
    const t0 = localMidnight(s);
    let t1 = localMidnight(e);
    t1.setDate(t1.getDate() + 1);
    if (state.localLatest && t1 > state.localLatest) t1 = state.localLatest;      // today so far
    if (t1 <= t0) throw new Error(`No data yet for that day; the latest hour available ends ${localTime(state.localLatest)}.`);
    return { source: "mrms", product: "ms2", start: t0.toISOString(), end: t1.toISOString(), prefer: "day", localDays: true };
  }
  if (state.source === "stage4") {
    const s = $("s4-start").value, e = $("s4-end").value;
    if (!s || !e) throw new Error("Pick a first and last day.");
    return { source: "stage4", region: $("s4-region").value, start: s, end: e };
  }
  const s = $("mrms-start").value, e = $("mrms-end").value;
  if (!s || !e) throw new Error("Pick a start and end time.");
  return { source: "mrms", product: $("mrms-product").value, start: new Date(s).toISOString(), end: new Date(e).toISOString() };
}

let loading = false;
async function load() {
  if (loading) return false;
  if (state.source === "stage4" && state.boundary === "local") {
    try { state.localLatest = new Date(await call("mrmsLatest", ["ms2"])); } catch (_) { /* keep the last known hour */ }
  }
  let params;
  try { params = currentParams(); } catch (e) { setStatus(e.message, true); return false; }
  loading = true;
  $("load").disabled = $("refresh").disabled = true;
  $("progress").classList.remove("hidden");
  setProgress(0);
  setStatus("Starting…");
  try {
    const raw = await call("accumulate", [params], (p) => { setProgress(p.total ? p.done / p.total : 0); setStatus(p.message); });
    setProgress(1);
    setStatus("");
    stepCache.clear();
    setMain(makeResult(raw));
    return true;
  } catch (e) {
    setStatus(e.message, true);
    return false;
  } finally {
    loading = false;
    $("load").disabled = $("refresh").disabled = false;
    setTimeout(() => $("progress").classList.add("hidden"), 400);
  }
}
const setProgress = (f) => { $("progress").firstElementChild.style.width = `${Math.round(f * 100)}%`; };
$("load").addEventListener("click", () => load());

// ------------------------------------------------------------------ refresh: new data + redraw everything on the map
async function refresh() {
  if (loading) return;
  refreshCtl.btn.classList.add("spin");
  try {
    await call("refresh");
    if (state.source === "stage4") await refreshS4Latest(); else await refreshMrmsLatest();
    if (state.lastPreset && state.lastPreset.source === state.source) applyPreset(state.source, state.lastPreset.p);
    const ok = await load();
    baseLayer.redraw();
    Object.values(overlays).forEach((o) => { if (map.hasLayer(o)) o.redraw(); });
    map.invalidateSize();
    if (!ok && state.display) redrawLayer();
    renderSaved();
    if (ok) setStatus(`Map refreshed at ${localTime(new Date(), { hour: "numeric", minute: "2-digit" })}.`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    refreshCtl.btn.classList.remove("spin");
  }
}
$("refresh").addEventListener("click", refresh);

function setAutoRefresh(min) {
  if (state.autoTimer) clearInterval(state.autoTimer);
  state.autoTimer = min > 0 ? setInterval(() => { if (!state.playing && !state.drawing) refresh(); }, min * 60000) : null;
  prefs.autoRefresh = min; savePrefs();
}
$("auto-refresh").addEventListener("change", () => setAutoRefresh(Number($("auto-refresh").value)));

function setMain(r) {
  state.main = r;
  const m = r.meta;
  $("result-card").classList.remove("hidden");
  $("display-card").classList.remove("hidden");
  if (m.source === "mrms") {
    $("res-title").textContent = `${localTime(new Date(m.start_utc))} – ${localTime(new Date(m.end_utc))} (${m.n_steps} h)`;
    $("res-product").textContent = `${m.product} · ${m.resolution} · ${m.label}` +
      (m.local_days ? " · days run midnight to midnight, local time" : "");
  } else {
    $("res-title").textContent = m.label;
    $("res-product").textContent = `${m.product} · ${m.resolution} · days end 12:00 UTC`;
  }
  $("res-warnings").innerHTML = m.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  $("res-files").innerHTML = m.files.map((f) => `<li>${esc(f)}</li>`).join("");
  $("res-nfiles").textContent = m.files.length;
  $("updated").textContent = `Updated ${localTime(new Date(m.computed_utc), { hour: "numeric", minute: "2-digit" })}`;
  if (!state.fitted) { map.fitBounds(r.bounds, { padding: [10, 10] }); state.fitted = true; }
  stopPlay();
  const ivs = intervalsFor(m);
  if (!state.intervalChosen || !ivs.includes(state.interval)) state.interval = defaultInterval(m);
  $("interval").innerHTML = ivs.map((iv) => `<option value="${iv}">${INTERVAL_LABELS[iv]}</option>`).join("");
  $("interval").value = state.interval;
  $("interval-wrap").classList.toggle("hidden", ivs.length < 2);
  buildSteps();
  resetSeries();
  if (state.stepMode && state.steps.length) showStep(Math.min(state.stepIdx, state.steps.length - 1));
  else { setStepMode(false, true); setDisplay(r); }
}

const effVar = () => (state.display && !state.display.meta.has_normals ? "obs" : state.var);
function effectiveScale() {
  if (state.scale !== "auto") return state.scale;
  if (state.stepMode) return { hour: "hourly", day: "daily", month: "monthly" }[state.interval];   // fixed while animating
  if (effVar() === "departure") return state.display.autoDepScale || "daily";
  return state.display.autoScale || "daily";
}

function setDisplay(r) {
  state.display = r;
  for (const opt of $("var").options) opt.disabled = opt.value !== "obs" && !r.meta.has_normals;
  redrawLayer();
  refreshSavedValues();
  refreshSelection();
}

function redrawLayer() {
  const d = state.display;
  if (!d) return;
  const v = effVar(), lg = legendFor(v, effectiveScale());
  const old = state.layer;
  const layer = new PrecipLayer({ pane: "precip", opacity: state.opacity, result: d, v, lg, maxZoom: 19, attribution: "Precipitation: NOAA/NWS", keepBuffer: 1 });
  let swapped = false;
  const swap = () => { if (!swapped && old) { swapped = true; map.removeLayer(old); } };
  layer.once("load", swap);           // keep the previous frame until the new one is drawn
  setTimeout(swap, 3000);
  layer.addTo(map);
  state.layer = layer;
  drawLegend(lg, v);
}

function drawLegend(lg, v) {
  const el = $("legend");
  el.classList.remove("hidden");
  const u = lg.unit === "%" ? "%" : " in";
  const lab = (it) => {
    if (v === "obs" || v === "normal") return `${it.lo}${u}${it.hi == null ? "+" : ""}`;
    if (it.lo == null) return `< ${it.hi}${u}`;
    if (it.hi == null) return `≥ ${it.lo}${u}`;
    return `${it.lo} to ${it.hi}${u}`;
  };
  const gaps = state.display.meta.missing && state.display.meta.missing.length ? " * some data missing" : "";
  el.innerHTML = `<div class="t" title="Show/hide legend">${esc(lg.title)} ▾</div><div class="period">${esc(periodLabel(state.display) + gaps)}</div>` +
    lg.items.slice().reverse().map((it) => `<div class="r"><span class="sw" style="background:${it.color}"></span>${lab(it)}</div>`).join("");
}

function periodLabel(r) {
  if (!r) return "";
  const m = r.meta;
  if (m.source === "mrms") return `${localTime(new Date(m.start_utc))} – ${localTime(new Date(m.end_utc))}`;
  return m.n_steps === 1 ? `24 h ending 12Z ${dayLabel(m.end, true)}` : m.label;
}

$("var").addEventListener("change", () => {
  state.var = $("var").value; prefs.var = state.var; savePrefs();
  redrawLayer(); updateSavedLabels(); refreshSelection();
});
$("scale").addEventListener("change", () => { state.scale = $("scale").value; prefs.scale = state.scale; savePrefs(); redrawLayer(); });
$("opacity").addEventListener("input", () => {
  state.opacity = Number($("opacity").value); prefs.opacity = state.opacity; savePrefs();
  $("opacity-val").textContent = `${Math.round(state.opacity * 100)}%`;
  if (state.layer) state.layer.setOpacity(state.opacity);
});

// value of variable v at grid cell k
function valueAt(r, v, k) {
  if (k < 0) return null;
  const o = r.obs[k], n = r.normal ? r.normal[k] : NaN;
  const x = v === "obs" ? o : v === "normal" ? n : v === "departure" ? o - n : n > 0.01 ? (100 * o) / n : NaN;
  return Number.isFinite(x) ? x : null;
}
// true when cell k has a value but some days/hours of the range had no data there
const partialAt = (r, k) => k >= 0 && !!r.miss && r.miss[k] > 0 && r.miss[k] < r.meta.n_parts;
const star = (p) => (p ? "*" : "");

// ------------------------------------------------------------------ time steps
const stepCache = new Map();               // key -> result (small LRU; MRMS grids are ~100 MB)
const binLabel = (b, m) => (m.source === "stage4" && state.interval === "day" ? `24 h ending 12Z ${b.label}` : b.label) + (b.partial ? " (partial)" : "");
function buildSteps() {
  const m = state.main.meta;
  const bins = m.n_steps > 1 ? makeBins(m, state.interval) : [];
  state.steps = bins.length > 1 ? bins.map((b) => ({
    label: binLabel(b, m),
    params: m.source === "stage4" ? { source: "stage4", region: m.region, start: b.start, end: b.end }
      : { source: "mrms", product: m.product_key, start: b.start, end: b.end },
  })) : [];
  $("steps").classList.toggle("hidden", !state.steps.length);
  $("step-mode-btn").textContent = `One ${state.interval} at a time`;
  $("step-slider").max = Math.max(0, state.steps.length - 1);
}

$("interval").addEventListener("change", () => {
  state.interval = $("interval").value;
  state.intervalChosen = true;
  stopPlay();
  buildSteps();
  resetSeries();
  state.stepIdx = 0;
  if (state.stepMode) showStep(0);
  refreshSelection();
});

function getStep(i) {
  const params = state.steps[i].params;
  const key = JSON.stringify(params);
  if (stepCache.has(key)) { const v = stepCache.get(key); stepCache.delete(key); stepCache.set(key, v); return v; }
  const p = call("accumulate", [params]).then(makeResult);
  stepCache.set(key, p);
  p.catch(() => stepCache.delete(key));
  const limit = params.source === "mrms" ? 3 : 40;
  while (stepCache.size > limit) stepCache.delete(stepCache.keys().next().value);
  return p;
}

function setStepMode(on, silent) {
  state.stepMode = on && state.steps.length > 0;
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", (b.dataset.mode === "step") === state.stepMode));
  $("step-controls").classList.toggle("hidden", !state.stepMode);
  if (silent) return;
  if (state.stepMode) showStep(state.stepIdx);
  else { stopPlay(); state.stepToken++; setDisplay(state.main); highlightChart(); }
}
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setStepMode(b.dataset.mode === "step")));

async function showStep(i) {
  const n = state.steps.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  state.stepIdx = i;
  $("step-slider").value = i;
  const step = state.steps[i];
  const token = ++state.stepToken;
  $("step-label").textContent = `${step.label} · loading…`;
  highlightChart();
  try {
    const r = await getStep(i);
    if (token !== state.stepToken || !state.stepMode) return;
    setDisplay(r);
    $("step-label").textContent = `${step.label} (${i + 1} of ${n})`;
  } catch (e) {
    if (token === state.stepToken) $("step-label").textContent = `${step.label}: ${e.message}`;
  }
}

function stopPlay() { state.playing = false; $("step-play").textContent = "▶"; }
async function play() {
  if (state.playing) return stopPlay();
  state.playing = true;
  $("step-play").textContent = "⏸";
  while (state.playing && state.stepMode) {
    const next = state.stepIdx + 1;
    if (state.steps.length) getStep((next + 1) % state.steps.length).catch(() => {});   // prefetch
    await showStep(next);
    await sleep(1100);
  }
}
$("step-play").addEventListener("click", play);
$("step-prev").addEventListener("click", () => { stopPlay(); showStep(state.stepIdx - 1); });
$("step-next").addEventListener("click", () => { stopPlay(); showStep(state.stepIdx + 1); });
$("step-slider").addEventListener("input", () => { stopPlay(); showStep(Number($("step-slider").value)); });

// ------------------------------------------------------------------ GeoTIFF export
async function exportTiff(bbox) {
  const d = state.display;
  if (!d) return;
  const g = d.grid, v = effVar();
  let c0 = 0, r0 = 0, c1 = g.width, r1 = g.height;
  if (bbox) {
    const [w, s, e, n] = bbox;
    const cs = [], rs = [];
    for (let i = 0; i <= 10; i++) for (const [lat, lon] of [[s + ((n - s) * i) / 10, w], [s + ((n - s) * i) / 10, e], [s, w + ((e - w) * i) / 10], [n, w + ((e - w) * i) / 10]]) {
      const [c, r] = colRow(g, lat, lon); cs.push(c); rs.push(r);
    }
    c0 = Math.max(0, Math.floor(Math.min(...cs))); c1 = Math.min(g.width, Math.ceil(Math.max(...cs)));
    r0 = Math.max(0, Math.floor(Math.min(...rs))); r1 = Math.min(g.height, Math.ceil(Math.max(...rs)));
    if (c1 <= c0 || r1 <= r0) return setStatus("The map view does not overlap the data.", true);
  }
  const W = c1 - c0, H = r1 - r0;
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const x = valueAt(d, v, (r0 + r) * g.width + c0 + c);
    out[r * W + c] = x == null ? NaN : x;
  }
  setStatus("Writing GeoTIFF…");
  const bytes = await writeGeoTiff(W, H, out, geoTagsFor(g, c0, r0), { description: `${VAR_LABELS[v]} (${v === "pct" ? "percent" : "inches"}) – ${d.meta.product} – ${periodLabel(d)}` });
  const m = d.meta;
  const tag = m.source === "stage4" ? `stageIV_${m.region}_${m.start.replace(/-/g, "")}-${m.end.replace(/-/g, "")}`
    : `mrms_${m.product_key}_${m.start_utc.slice(0, 13).replace(/[-T]/g, "")}Z-${m.end_utc.slice(0, 13).replace(/[-T]/g, "")}Z`;
  downloadBlob(new Blob([bytes], { type: "image/tiff" }), `${tag}_${v}${bbox ? "_view" : ""}.tif`);
  setStatus("");
}
$("export-full").addEventListener("click", () => exportTiff(null));
$("export-view").addEventListener("click", () => {
  const b = map.getBounds();
  exportTiff([b.getWest(), Math.max(b.getSouth(), -85), b.getEast(), Math.min(b.getNorth(), 85)]);
});

// ------------------------------------------------------------------ hover readout (mouse only)
const hover = $("hover");
let hoverRaf = 0;
map.on("mousemove", (ev) => {
  if (state.drawing && state.drawing.pts.length) state.drawing.line.setLatLngs([...state.drawing.pts, ev.latlng]);
  if (!state.display || hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const d = state.display, v = effVar();
    const k = cellIndex(d.grid, ev.latlng.lat, ev.latlng.lng);
    const x = valueAt(d, v, k);
    hover.textContent = x == null ? "no data" : `${fmtVal(x, v)}${partialAt(d, k) ? " * some data missing" : ""}`;
    hover.style.left = `${ev.originalEvent.clientX + 14}px`;
    hover.style.top = `${ev.originalEvent.clientY + 12}px`;
    hover.classList.remove("hidden");
  });
});
map.on("mouseout", () => hover.classList.add("hidden"));
map.on("movestart", () => hover.classList.add("hidden"));

// ------------------------------------------------------------------ map clicks
map.on("click", (ev) => {
  if (state.drawing) return drawClick(ev.latlng);
  if (ev.originalEvent && ev.originalEvent.shiftKey) return addPoint(ev.latlng.lat, ev.latlng.lng, "");
  selectPoint(ev.latlng.lat, ev.latlng.lng);
});
map.on("dblclick", () => { if (state.drawing) finishDraw(); });
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.drawing) cancelDraw();
  if (ev.key === "Enter" && state.drawing && document.activeElement === document.body) finishDraw();
});

// ------------------------------------------------------------------ selection (one point or area)
function selectPoint(lat, lon, opts = {}) {
  state.sel = { kind: "point", lat, lon, id: opts.savedId || null, label: opts.label || null };
  if (opts.savedId) {
    if (state.selMarker) { map.removeLayer(state.selMarker); state.selMarker = null; }
  } else if (state.selMarker) state.selMarker.setLatLng([lat, lon]);
  else state.selMarker = L.circleMarker([lat, lon], { pane: "pick", radius: 7, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
  $("save-name").value = opts.label && !opts.savedId ? opts.label : "";
  resetSeries();
  renderSavedList();
  updateSavedLabels();
  refreshSelection();
}

function selectArea(id) {
  if (!state.saved.areas.some((x) => x.id === id)) return;
  state.sel = { kind: "area", id };
  if (state.selMarker) { map.removeLayer(state.selMarker); state.selMarker = null; }
  resetSeries();
  renderSavedList();
  updateSavedLabels();
  refreshSelection();
}

function selName() {
  const s = state.sel;
  if (!s) return "";
  if (s.kind === "area") return (state.saved.areas.find((a) => a.id === s.id) || {}).name || "Area";
  if (s.id) return (state.saved.points.find((p) => p.id === s.id) || {}).name || "Saved point";
  return s.label || "Point";
}

const maskCache = new Map();               // `${gridKey}|${areaId}` -> Int32Array
function maskFor(r, area) {
  const key = `${r.grid.kind}:${r.grid.width}:${r.grid.lon0 ?? r.grid.x0}|${area.id}|${area.geometry.coordinates.length}`;
  if (!maskCache.has(key)) {
    maskCache.set(key, areaMask(r.grid, area.geometry));
    if (maskCache.size > 400) maskCache.delete(maskCache.keys().next().value);
  }
  return maskCache.get(key);
}
function areaValues(r, area) {
  const m = maskFor(r, area);
  const o = areaStats(r.obs, m);
  if (!o) return null;
  const out = { obs: o, partial: !!r.miss && areaHasPartial(r.miss, m, r.meta.n_parts) };
  if (r.normal) {
    const n = areaStats(r.normal, m);
    if (n) { out.normal = n; out.departure = { mean: o.mean - n.mean }; out.pct = { mean: n.mean > 0.01 ? (100 * o.mean) / n.mean : NaN }; }
  }
  return out;
}

// Which days/hours had no data at a location (only computed for locations marked with *).
const missCache = new Map();
function missingFor(r, pts, ars) {
  const key = `${r.id}|${JSON.stringify(pts)}|${ars.length ? JSON.stringify(ars).length + JSON.stringify(ars).slice(0, 200) : ""}`;
  if (!missCache.has(key)) {
    // shortcut: a point missing exactly the files missing everywhere needs no extra reading
    if (pts.length === 1 && !ars.length) {
      const k = cellIndex(r.grid, pts[0].lat, pts[0].lon);
      if (k >= 0 && r.miss[k] === r.meta.missing.length) missCache.set(key, Promise.resolve([r.meta.missing]));
    }
    if (!missCache.has(key)) {
      const p = call("series", [r.meta, pts, ars, "total"]).then((j) => [...j.points, ...j.areas].map((x) => x[0].m));
      p.catch(() => missCache.delete(key));
      missCache.set(key, p);
    }
    if (missCache.size > 200) missCache.delete(missCache.keys().next().value);
  }
  return missCache.get(key);
}
const listText = (arr, max = 12) => (arr.length ? arr.slice(0, max).join("; ") + (arr.length > max ? `; +${arr.length - max} more` : "") : "");

function refreshSelection() {
  const s = state.sel;
  if (!s) return;
  $("sel-card").classList.remove("hidden");
  $("sel-title").textContent = selName();
  $("save-point").classList.toggle("hidden", s.kind !== "point" || !!s.id);
  const d = state.display;
  const rows = [];
  let partial = false, payload = null;
  if (s.kind === "point") {
    $("sel-sub").textContent = llText(s.lat, s.lon);
    if (d) {
      const k = cellIndex(d.grid, s.lat, s.lon);
      const o = valueAt(d, "obs", k);
      partial = partialAt(d, k);
      payload = [[{ lat: s.lat, lon: s.lon }], []];
      rows.push(["Precipitation", o == null ? "no data" : `${fmtIn(o)}${star(partial)} (${(o * 25.4).toFixed(1)} mm)`]);
      if (d.meta.has_normals) rows.push(["Normal", fmtVal(valueAt(d, "normal", k), "normal")], ["Departure", fmtVal(valueAt(d, "departure", k), "departure") + star(partial)], ["% of normal", fmtVal(valueAt(d, "pct", k), "pct") + star(partial)]);
    }
  } else {
    const a = state.saved.areas.find((x) => x.id === s.id);
    if (!a) return;
    $("sel-sub").textContent = `${a.area_km2.toFixed(1)} km² · ${(a.area_km2 / 2.589988).toFixed(1)} mi²`;
    if (d) {
      const v = areaValues(d, a);
      if (!v) rows.push(["Precipitation", "no data in this area"]);
      else {
        partial = v.partial;
        payload = [[], [a.geometry]];
        rows.push(["Area average", `${fmtIn(v.obs.mean)}${star(partial)} (${(v.obs.mean * 25.4).toFixed(1)} mm)`],
          ["Max / min cell", `${fmtIn(v.obs.max)} / ${fmtIn(v.obs.min)}`],
          ["Grid cells", `${v.obs.cells}${v.obs.coverage < 1 ? ` (${Math.round(v.obs.coverage * 100)}% with data)` : ""}`]);
        if (d.meta.has_normals && v.normal) rows.push(["Normal (avg)", fmtVal(v.normal.mean, "normal")], ["Departure (avg)", fmtVal(v.departure.mean, "departure") + star(partial)], ["% of normal", fmtVal(v.pct.mean, "pct") + star(partial)]);
      }
    }
  }
  if (d) rows.unshift(["Period", esc(periodLabel(d))]);
  if (partial) rows.push(["* Missing data", `<span id="sel-missing" class="missing-list">checking which ${d.meta.step === "day" ? "days" : "hours"}…</span>`]);
  $("sel-table").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  if (partial) {
    const sel = s;
    missingFor(d, ...payload).then(([list]) => {
      if (state.sel !== sel || !$("sel-missing")) return;
      $("sel-missing").textContent = `Total includes only the data available. No data for: ${listText(list) || "part of the period"}`;
    }).catch((e) => { if ($("sel-missing")) $("sel-missing").textContent = `Some data missing (${e.message})`; });
  }
  if (!state.main) { $("series-btn").classList.add("hidden"); return; }
  $("series-btn").classList.remove("hidden");
  const nb = makeBins(state.main.meta, state.interval).length;
  const unit = { hour: "hour", day: "day", month: "month" }[state.interval];
  $("series-btn").textContent = `Show ${INTERVAL_LABELS[state.interval].toLowerCase()} breakdown (${nb} ${unit}${nb > 1 ? "s" : ""})` + (s.kind === "area" ? " – area average" : "");
}

$("save-point").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const s = state.sel;
  if (!s || s.kind !== "point" || s.id) return;
  addPoint(s.lat, s.lon, $("save-name").value.trim());
});

// ------------------------------------------------------------------ breakdown chart
function resetSeries() {
  state.series = null;
  $("chart-wrap").classList.add("hidden");
  $("series-table").classList.add("hidden");
  $("table-btn").textContent = "Show table";
  $("chart").innerHTML = "";
}

function selGeomPayload() {
  const s = state.sel;
  if (s.kind === "point") return [[{ lat: s.lat, lon: s.lon }], []];
  return [[], [state.saved.areas.find((a) => a.id === s.id).geometry]];
}

$("series-btn").addEventListener("click", async () => {
  if (!state.main || !state.sel) return;
  const btn = $("series-btn");
  const old = btn.textContent;
  btn.disabled = true;
  try {
    const sel = state.sel;
    const [pts, ars] = selGeomPayload();
    const j = await call("series", [state.main.meta, pts, ars, state.interval], (p) => { btn.textContent = `${p.message}…`; });
    if (state.sel !== sel) return;
    state.series = { interval: j.interval, bins: j.bins, vals: sel.kind === "point" ? j.points[0] : j.areas[0], name: selName() };
    $("chart-wrap").classList.remove("hidden");
    drawChart();
    buildTable();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

// short axis label for a bin
function shortLabel(b, interval) {
  if (interval === "hour") return new Date(b.end).toLocaleTimeString(undefined, { hour: "numeric" });
  if (interval === "month") return b.label;
  return b.label.replace(/, \d{4}$/, "");
}
const longLabel = (b, interval) => (state.main.meta.source === "stage4" && interval === "day" ? `24 h ending 12Z ${b.label}` : b.label) + (b.partial ? " (partial period)" : "");
function niceMax(v) {
  if (!(v > 0)) return 0.1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawChart() {
  const { bins, vals, interval } = state.series;
  const nums = vals.map((x) => x.v);
  const total = nums.reduce((a, v) => a + (v || 0), 0);
  const nNone = vals.filter((x) => x.v == null).length;
  const nPart = vals.filter((x) => x.v != null && x.m.length).length;
  const W = 330, H = 170, ml = 34, mr = 6, mt = 22, mb = 22;
  const pw = W - ml - mr, ph = H - mt - mb;
  const ymax = niceMax(Math.max(...nums.map((v) => v || 0)));
  const bw = pw / vals.length, gap = Math.min(2, bw * 0.25);
  const y = (v) => mt + ph - (v / ymax) * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Precipitation per ${interval}">`;
  s += `<text x="${ml}" y="13" font-size="11.5" fill="var(--ink-2)">Total ${fmtIn(total)}${nNone || nPart ? "*" : ""} · per ${interval}${nNone ? ` · ${nNone} with no data` : ""}</text>`;
  for (const t of [0, ymax / 2, ymax]) {
    s += `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" stroke="var(--grid)" />`;
    s += `<text x="${ml - 4}" y="${y(t) + 3.5}" font-size="10" text-anchor="end" fill="var(--muted)">${+t.toFixed(2)}</text>`;
  }
  vals.forEach(({ v, m }, i) => {
    const x = ml + i * bw + gap / 2, w = Math.max(1, bw - gap);
    if (v == null) s += `<text x="${x + w / 2}" y="${mt + ph - 2}" font-size="9" text-anchor="middle" fill="var(--muted)">×</text>`;
    else {
      if (v > 0) {
        const h = Math.max(1, mt + ph - y(v)), r = Math.min(4, w / 2, h);
        s += `<path class="bar" data-i="${i}" d="M${x},${mt + ph} V${mt + ph - h + r} Q${x},${mt + ph - h} ${x + r},${mt + ph - h} H${x + w - r} Q${x + w},${mt + ph - h} ${x + w},${mt + ph - h + r} V${mt + ph} Z" fill="var(--bar)"${m.length ? ' fill-opacity="0.5"' : ""} />`;
      }
      if (m.length && bw >= 5) s += `<text x="${x + w / 2}" y="${Math.min(y(v), mt + ph) - 2}" font-size="10" text-anchor="middle" fill="var(--ink-2)">*</text>`;
    }
    s += `<rect class="hit" data-i="${i}" x="${ml + i * bw}" y="${mt}" width="${bw}" height="${ph}" fill="transparent" style="cursor:pointer" />`;
  });
  s += `<rect class="hl" x="0" y="${mt}" width="${bw}" height="${ph}" fill="none" stroke="var(--hl)" stroke-width="1.5" rx="2" visibility="hidden" />`;
  s += `<line x1="${ml}" x2="${W - mr}" y1="${mt + ph}" y2="${mt + ph}" stroke="var(--muted)" />`;
  for (const i of [...new Set([0, Math.floor((vals.length - 1) / 2), vals.length - 1])]) {
    const anchor = i === 0 ? "start" : i === vals.length - 1 ? "end" : "middle";
    const x = i === 0 ? ml : i === vals.length - 1 ? W - mr : ml + (i + 0.5) * bw;
    s += `<text x="${x}" y="${H - 6}" font-size="10" text-anchor="${anchor}" fill="var(--muted)">${esc(shortLabel(bins[i], interval))}</text>`;
  }
  s += `<text x="4" y="${mt + 2}" font-size="10" fill="var(--muted)">in</text></svg><div class="tip hidden"></div>`;
  if (nNone || nPart) {
    const what = state.main.meta.step === "day" ? "days" : "hours";
    s += `<p class="note">* Some ${what} have no data here${nPart ? `; faded bars show the ${what} that do` : ""}${nNone ? "; × = no data at all" : ""}. Hover a bar or open the table for details.</p>`;
  }
  const el = $("chart");
  el.innerHTML = s;
  el.dataset.bw = bw; el.dataset.ml = ml;
  const tip = el.querySelector(".tip"), svg = el.querySelector("svg");
  const paint = (i) => el.querySelectorAll("path.bar").forEach((b) => b.setAttribute("fill", Number(b.dataset.i) === i ? "var(--bar-hover)" : "var(--bar)"));
  el.querySelectorAll("rect.hit").forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener("mouseenter", () => {
      paint(i);
      const box = svg.getBoundingClientRect(), sc = box.width / W;
      const { v, m } = vals[i];
      tip.textContent = `${longLabel(bins[i], interval)}: ${v == null ? "no data" : fmtIn(v)}${m.length && v != null ? ` * no data for ${listText(m, 3)}` : ""}`;
      tip.style.left = `${Math.min(Math.max((ml + (i + 0.5) * bw) * sc, 90), box.width - 90)}px`;
      tip.style.top = `${mt * sc}px`;
      tip.classList.remove("hidden");
    });
    r.addEventListener("click", () => {        // jump the map to this day / hour
      if (!state.steps.length) return;
      if (!state.stepMode) setStepMode(true, true);
      stopPlay();
      showStep(i);
    });
  });
  svg.addEventListener("mouseleave", () => { tip.classList.add("hidden"); paint(-1); });
  highlightChart();
}

function highlightChart() {
  const hl = document.querySelector("#chart rect.hl");
  if (!hl) return;
  const on = state.stepMode && state.series && state.series.vals.length === state.steps.length;
  hl.setAttribute("visibility", on ? "visible" : "hidden");
  if (on) hl.setAttribute("x", Number($("chart").dataset.ml) + state.stepIdx * Number($("chart").dataset.bw));
  document.querySelectorAll("#series-table tr[data-i]").forEach((tr) => tr.classList.toggle("hl", on && Number(tr.dataset.i) === state.stepIdx));
}

function buildTable() {
  const { bins, vals, interval } = state.series;
  let cum = 0;
  const rows = vals.map(({ v, m }, i) => {
    cum += v || 0;
    return `<tr data-i="${i}"><td>${esc(longLabel(bins[i], interval))}</td><td>${v == null ? "—" : v.toFixed(2) + star(m.length)}</td><td>${cum.toFixed(2)}</td>` +
      `<td class="miss-cell">${m.length ? esc(listText(m, 6)) : ""}</td></tr>`;
  }).join("");
  const head = { hour: "Hour ending (local)", day: state.main.meta.source === "stage4" ? "Day (24 h ending 12Z)" : "Day (local)", month: "Month" }[interval];
  $("series-table").innerHTML = `<table><tr><th>${head}</th><th>in</th><th>cum. in</th><th>* no data for</th></tr>${rows}</table>`;
  highlightChart();
}

$("table-btn").addEventListener("click", () => {
  const t = $("series-table");
  t.classList.toggle("hidden");
  $("table-btn").textContent = t.classList.contains("hidden") ? "Show table" : "Hide table";
});

$("csv-btn").addEventListener("click", () => {
  if (!state.series) return;
  const m = state.main.meta, s = state.sel;
  let cum = 0;
  const where = s.kind === "point" ? `point lat,lon = ${s.lat.toFixed(5)},${s.lon.toFixed(5)}` : `area average over "${selName()}"`;
  const { bins, vals, interval } = state.series;
  const lines = [`# ${m.product}`, `# ${m.label}`, `# ${state.series.name}: ${where}`,
    `# precipitation in inches per ${interval}${m.source === "stage4" ? " (days end 12:00 UTC)" : m.local_days ? " (days run midnight to midnight local time)" : ""}; values include only the data available (complete = no)`,
    "period,period_start_local,period_end_local,period_start_utc,period_end_utc,precip_in,cumulative_in,complete,missing_data",
    ...vals.map(({ v, m: miss }, i) => {
      cum += v || 0;
      return [csvCell(bins[i].label + (bins[i].partial ? " (partial period)" : "")),
        localStamp(bins[i].start_utc), localStamp(bins[i].end_utc), bins[i].start_utc, bins[i].end_utc,
        v == null ? "" : v.toFixed(3), cum.toFixed(3), miss.length ? "no" : "yes", csvCell(miss.join("; "))].join(",");
    })];
  const tag = s.kind === "point" ? `${s.lat.toFixed(4)}_${s.lon.toFixed(4)}` : selName().replace(/[^\w-]+/g, "_");
  downloadText(lines.join("\r\n"), `precip_${tag}_${m.source}.csv`);
});

// ------------------------------------------------------------------ saved locations (this browser + shared defaults)
function persistSaved() {
  const ok = store.set(LOC_KEY, state.saved);
  $("saved-state").textContent = ok ? "· saved on this device" : "· could not save (storage full or blocked)";
  $("saved-state").style.color = ok ? "" : "var(--error)";
}

async function loadSaved() {
  state.saved = Object.assign({ points: [], areas: [], removedDefaults: [] }, store.get(LOC_KEY, {}));
  let defaults = { points: [], areas: [] };
  try { defaults = await (await fetch("data/locations.json", { cache: "no-cache" })).json(); } catch (_) { /* optional */ }
  const have = new Set([...state.saved.points, ...state.saved.areas].map((x) => x.id));
  const removed = new Set(state.saved.removedDefaults || []);
  let added = 0;
  for (const p of defaults.points || []) if (!have.has(p.id) && !removed.has(p.id)) { state.saved.points.push({ ...p, shared: true }); added++; }
  for (const a of defaults.areas || []) if (!have.has(a.id) && !removed.has(a.id)) {
    state.saved.areas.push({ ...a, area_km2: a.area_km2 || polygonAreaKm2(a.geometry), shared: true }); added++;
  }
  if (added || !store.get(LOC_KEY, null)) persistSaved();
  else $("saved-state").textContent = "· saved on this device";
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  renderSaved();
  refreshSavedValues();
}

function addPoint(lat, lon, name) {
  const id = rid();
  state.saved.points.push({ id, name: name || `Point ${state.saved.points.length + 1}`, lat, lon });
  persistSaved();
  renderSaved();
  selectPoint(lat, lon, { savedId: id });
  refreshSavedValues();
}

function addAreas(list, select) {
  state.saved.areas.push(...list);
  persistSaved();
  renderSaved();
  refreshSavedValues();
  if (select && list.length) selectArea(list[0].id);
}

const markerById = new Map();
function renderSaved() {
  savedLayer.clearLayers();
  markerById.clear();
  if ($("show-saved").checked) {
    for (const a of state.saved.areas) {
      const poly = L.geoJSON(a.geometry, { pane: "areas", bubblingMouseEvents: false, style: { color: "#1d2430", weight: 2, dashArray: "5 3", fillColor: "#1d2430", fillOpacity: 0.04 } });
      poly.on("click", (e) => { if (state.drawing) drawClick(e.latlng); else selectArea(a.id); });
      savedLayer.addLayer(poly);
      const mk = L.marker(labelPoint(a.geometry), { pane: "saved", icon: L.divIcon({ className: "sp-icon", html: "", iconSize: [0, 0] }) });
      mk.on("click", (e) => { if (state.drawing) drawClick(e.latlng); else selectArea(a.id); });
      savedLayer.addLayer(mk);
      markerById.set(a.id, mk);
    }
    for (const p of state.saved.points) {
      const mk = L.marker([p.lat, p.lon], { pane: "saved", icon: L.divIcon({ className: "sp-icon", html: "", iconSize: [0, 0] }) });
      mk.on("click", (e) => { if (state.drawing) drawClick(e.latlng); else selectPoint(p.lat, p.lon, { savedId: p.id }); });
      savedLayer.addLayer(mk);
      markerById.set(p.id, mk);
    }
  }
  renderSavedList();
  updateSavedLabels();
}

function savedValue(kind, i) {
  const v = (state.values[kind] || [])[i];
  if (v == null) return null;
  const vr = effVar();
  if (kind === "points") return v[vr] ?? null;
  return v[vr] ? (Number.isFinite(v[vr].mean) ? v[vr].mean : null) : null;
}
const savedPartial = (kind, i) => !!((state.values[kind] || [])[i] || {}).partial;
// "1.23 in*" / "1.23 in avg*" / "no data"
function savedText(kind, i) {
  if (!state.display) return "";
  const v = savedValue(kind, i);
  if (v == null) return "no data";
  return `${fmtVal(v, effVar())}${kind === "areas" ? " avg" : ""}${star(savedPartial(kind, i))}`;
}

function refreshSavedValues() {
  const d = state.display;
  if (!d) { state.values = { points: [], areas: [] }; updateSavedLabels(); return; }
  const vars = ["obs", "normal", "departure", "pct"];
  state.values = {
    points: state.saved.points.map((p) => {
      const k = cellIndex(d.grid, p.lat, p.lon);
      return { ...Object.fromEntries(vars.map((v) => [v, valueAt(d, v, k)])), partial: partialAt(d, k) };
    }),
    areas: state.saved.areas.map((a) => { try { return areaValues(d, a); } catch (_) { return null; } }),
  };
  updateSavedLabels();
}

function updateSavedLabels() {
  const names = $("show-names").checked, sel = state.sel;
  const tip = (name, kind, i) => esc(name) + (savedPartial(kind, i) ? " – * some data missing; click for details" : "");
  state.saved.points.forEach((p, i) => {
    const mk = markerById.get(p.id);
    if (!mk) return;
    const isSel = sel && sel.kind === "point" && sel.id === p.id;
    mk.setIcon(L.divIcon({
      className: "sp-icon", iconSize: [0, 0],
      html: `<div class="sp${names ? "" : " nonames"}${isSel ? " sel" : ""}" title="${tip(p.name, "points", i)}"><div class="sp-name">${esc(p.name)}</div>` +
        `<div class="sp-val">${savedText("points", i)}</div><div class="sp-dot"></div></div>`,
    }));
  });
  state.saved.areas.forEach((a, i) => {
    const mk = markerById.get(a.id);
    if (!mk) return;
    mk.setIcon(L.divIcon({
      className: "sp-icon", iconSize: [0, 0],
      html: `<div class="sp area${names ? "" : " nonames"}" title="${tip(a.name, "areas", i)}"><div class="sp-name">${esc(a.name)}</div>` +
        `<div class="sp-val">${savedText("areas", i)}</div></div>`,
    }));
  });
  renderSavedList();
}

function renderSavedList() {
  const ul = $("saved-list");
  if (ul.querySelector("input.rename")) return;      // a rename is open; it re-renders when done
  const sel = state.sel;
  const row = (kind, item, i) => {
    const isSel = sel && ((kind === "points" && sel.kind === "point" && sel.id === item.id) || (kind === "areas" && sel.kind === "area" && sel.id === item.id));
    return `<li data-kind="${kind}" data-id="${item.id}"${isSel ? ' class="sel"' : ""}>` +
      `<input type="checkbox" class="inc" data-act="inc" title="Include in Values / Breakdown CSV"${item.off ? "" : " checked"}>` +
      `<span class="ico" title="${kind === "points" ? "Point" : "Area"}">${kind === "points" ? "●" : "▱"}</span>` +
      `<span class="nm" title="Zoom to ${esc(item.name)}">${esc(item.name)}</span>` +
      `<span class="val"${savedPartial(kind, i) ? ' title="* some data missing in this period; click the location for details"' : ""}>${savedText(kind, i)}</span>` +
      `<button class="act" data-act="rename" title="Rename">✎</button><button class="act" data-act="delete" title="Delete">✕</button></li>`;
  };
  ul.innerHTML = state.saved.points.map((p, i) => row("points", p, i)).join("") + state.saved.areas.map((a, i) => row("areas", a, i)).join("");
  const total = state.saved.points.length + state.saved.areas.length;
  $("saved-empty").classList.toggle("hidden", total > 0);
  $("inc-row").classList.toggle("hidden", !total);
  $("inc-count").textContent = `${checkedLocations().count} of ${total} selected for CSV`;
}

const checkedLocations = () => {
  const points = state.saved.points.map((p, i) => ({ item: p, i })).filter((x) => !x.item.off);
  const areas = state.saved.areas.map((a, i) => ({ item: a, i })).filter((x) => !x.item.off);
  return { points, areas, count: points.length + areas.length };
};
function setAllIncluded(on) {
  for (const x of [...state.saved.points, ...state.saved.areas]) { if (on) delete x.off; else x.off = true; }
  persistSaved(); renderSavedList();
}
$("inc-all").addEventListener("click", () => setAllIncluded(true));
$("inc-none").addEventListener("click", () => setAllIncluded(false));

$("saved-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li");
  if (!li || li.querySelector("input.rename")) return;
  const kind = li.dataset.kind, id = li.dataset.id;
  const list = state.saved[kind];
  const item = list.find((x) => x.id === id);
  if (!item) return;
  const act = ev.target.dataset.act;
  if (act === "inc") {
    if (ev.target.checked) delete item.off; else item.off = true;
    persistSaved();
    $("inc-count").textContent = `${checkedLocations().count} of ${state.saved.points.length + state.saved.areas.length} selected for CSV`;
    return;
  }
  if (act === "delete") {
    const idx = list.indexOf(item);
    list.splice(idx, 1);
    if (item.shared) state.saved.removedDefaults.push(item.id);
    state.lastDeleted = { kind, item, idx };
    if (state.sel && state.sel.id === id) { $("sel-card").classList.add("hidden"); state.sel = null; }
    persistSaved(); renderSaved(); refreshSavedValues();
    setStatus(`Deleted “${esc(item.name)}”. <button class="link" id="undo-del">Undo</button>`, false, true);
    $("undo-del").addEventListener("click", () => {
      const d = state.lastDeleted; if (!d) return;
      state.saved[d.kind].splice(d.idx, 0, d.item);
      state.saved.removedDefaults = state.saved.removedDefaults.filter((x) => x !== d.item.id);
      state.lastDeleted = null;
      persistSaved(); renderSaved(); refreshSavedValues(); setStatus("");
    });
  } else if (act === "rename") {
    startRename(li, item);
  } else if (kind === "points") {
    map.setView([item.lat, item.lon], Math.max(map.getZoom(), 10));
    selectPoint(item.lat, item.lon, { savedId: id });
    collapseSheetForMap();
  } else {
    map.fitBounds(L.geoJSON(item.geometry).getBounds(), { padding: [30, 30], maxZoom: 13 });
    selectArea(id);
    collapseSheetForMap();
  }
});

function startRename(li, item) {
  const nm = li.querySelector(".nm");
  const input = document.createElement("input");
  input.className = "rename";
  input.value = item.name;
  nm.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save && input.value.trim()) { item.name = input.value.trim().slice(0, 80); persistSaved(); }
    input.remove();
    renderSaved();
    if (state.sel) refreshSelection();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(true); if (e.key === "Escape") commit(false); });
  input.addEventListener("blur", () => commit(true));
}
function renameById(id) {
  const li = document.querySelector(`#saved-list li[data-id="${id}"]`);
  const kind = li && li.dataset.kind;
  const item = kind && state.saved[kind].find((x) => x.id === id);
  if (item) { li.scrollIntoView({ block: "nearest" }); startRename(li, item); }
}

$("show-names").addEventListener("change", () => { prefs.showNames = $("show-names").checked; savePrefs(); updateSavedLabels(); });
$("show-saved").addEventListener("change", () => { prefs.showSaved = $("show-saved").checked; savePrefs(); renderSaved(); });

$("export-values").addEventListener("click", async () => {
  const d = state.display;
  if (!d) return;
  const sel = checkedLocations();
  if (!sel.count) return setStatus("Tick at least one saved location (checkbox on the left) to export.", true);
  const v = state.values, hasN = d.meta.has_normals;
  const btn = $("export-values");
  btn.disabled = true;
  try {
    // which days/hours are missing at the locations marked with * (one pass over the files)
    const pp = sel.points.filter((x) => (v.points[x.i] || {}).partial);
    const pa = sel.areas.filter((x) => (v.areas[x.i] || {}).partial);
    const missing = new Map();
    if (pp.length + pa.length) {
      btn.textContent = "Checking missing data…";
      const lists = await missingFor(d, pp.map((x) => ({ lat: x.item.lat, lon: x.item.lon })), pa.map((x) => x.item.geometry));
      [...pp, ...pa].forEach((x, k) => missing.set(x.item.id, lists[k]));
    }
    const f = (x, n = 3) => (x == null || !Number.isFinite(x) ? "" : x.toFixed(n));
    const lines = [`# ${d.meta.product}`, `# ${periodLabel(d)}${d.meta.source === "stage4" ? " (days end 12:00 UTC)" : ""}`,
      `# period: ${localStamp(d.meta.start_utc)} to ${localStamp(d.meta.end_utc)} (UTC ${d.meta.start_utc.slice(0, 16)} to ${d.meta.end_utc.slice(0, 16)})`,
      "# values include only the data available; complete = no means some days/hours had no data (listed in missing_data)",
      ["type", "name", "lat", "lon", "area_km2", "precip_in", "max_in", "min_in", ...(hasN ? ["normal_in", "departure_in", "pct_of_normal"] : []), "complete", "missing_data"].join(",")];
    const tail = (id, has) => [has ? (missing.has(id) ? "no" : "yes") : "", csvCell((missing.get(id) || []).join("; "))];
    for (const { item: p, i } of sel.points) {
      const s = v.points[i] || {};
      lines.push(["point", csvCell(p.name), p.lat.toFixed(5), p.lon.toFixed(5), "", f(s.obs), "", "", ...(hasN ? [f(s.normal), f(s.departure), f(s.pct, 1)] : []), ...tail(p.id, s.obs != null)].join(","));
    }
    for (const { item: a, i } of sel.areas) {
      const s = v.areas[i] || {};
      const c = labelPoint(a.geometry);
      lines.push(["area", csvCell(a.name), c[0].toFixed(5), c[1].toFixed(5), a.area_km2.toFixed(2), f(s.obs && s.obs.mean), f(s.obs && s.obs.max), f(s.obs && s.obs.min),
        ...(hasN ? [f(s.normal && s.normal.mean), f(s.departure && s.departure.mean), f(s.pct && s.pct.mean, 1)] : []), ...tail(a.id, !!s.obs)].join(","));
    }
    downloadText(lines.join("\r\n"), `saved_locations_${d.meta.source}.csv`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "Values CSV";
  }
});

$("export-breakdown").addEventListener("click", async () => {
  if (!state.main) return;
  const sel = checkedLocations();
  if (!sel.count) return setStatus("Tick at least one saved location (checkbox on the left) to export.", true);
  const pts = sel.points.map((x) => x.item), ars = sel.areas.map((x) => x.item);
  const btn = $("export-breakdown");
  btn.disabled = true;
  try {
    const j = await call("series", [state.main.meta, pts.map((p) => ({ lat: p.lat, lon: p.lon })), ars.map((a) => a.geometry), state.interval], (p) => { btn.textContent = `${p.message}…`; });
    const m = state.main.meta;
    const names = [...pts.map((p) => p.name), ...ars.map((a) => `${a.name} (area avg)`)];
    const series = [...j.points, ...j.areas];
    const lines = [`# ${m.product}`, `# ${m.label}`,
      `# precipitation in inches per ${j.interval}${m.source === "stage4" ? " (days end 12:00 UTC)" : m.local_days ? " (days run midnight to midnight local time)" : ""}; values include only the data available; missing_data lists what had no data`,
      ["period", "period_start_local", "period_end_local", "period_start_utc", "period_end_utc", ...names.map(csvCell), "missing_data"].join(",")];
    j.bins.forEach((b, i) => {
      const notes = series.map((s, k) => (s[i].m.length ? `${names[k]}: ${s[i].m.join(", ")}` : null)).filter(Boolean);
      lines.push([csvCell(b.label + (b.partial ? " (partial period)" : "")), localStamp(b.start_utc), localStamp(b.end_utc), b.start_utc, b.end_utc,
        ...series.map((s) => (s[i].v == null ? "" : s[i].v.toFixed(3))), csvCell(notes.join(" | "))].join(","));
    });
    lines.push(["TOTAL", "", "", "", "", ...series.map((s) => s.reduce((a, x) => a + (x.v || 0), 0).toFixed(3)), ""].join(","));
    downloadText(lines.join("\r\n"), `saved_breakdown_${m.source}_${j.interval}.csv`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "Breakdown CSV";
  }
});

// backup / share
$("export-locs").addEventListener("click", () => {
  const strip = (x) => { const { shared, off, ...rest } = x; return rest; };
  const doc = { points: state.saved.points.map(strip), areas: state.saved.areas.map(strip) };
  downloadText(JSON.stringify(doc, null, 1), "locations.json", "application/json");
});
$("import-locs-btn").addEventListener("click", () => $("import-locs-file").click());
$("import-locs-file").addEventListener("change", async () => {
  const f = $("import-locs-file").files[0];
  $("import-locs-file").value = "";
  if (!f) return;
  try {
    const doc = JSON.parse(await f.text());
    const have = new Set([...state.saved.points, ...state.saved.areas].map((x) => x.id));
    let n = 0;
    for (const p of doc.points || []) {
      if (!Number.isFinite(+p.lat) || !Number.isFinite(+p.lon)) continue;
      const id = p.id && !have.has(p.id) ? p.id : rid();
      if (p.id && have.has(p.id)) continue;
      state.saved.points.push({ id, name: String(p.name || "Point").slice(0, 80), lat: +p.lat, lon: +p.lon }); n++;
    }
    for (const a of doc.areas || []) {
      if (!a.geometry || (a.id && have.has(a.id))) continue;
      state.saved.areas.push({ id: a.id || rid(), name: String(a.name || "Area").slice(0, 80), geometry: a.geometry, area_km2: a.area_km2 || polygonAreaKm2(a.geometry) }); n++;
    }
    persistSaved(); renderSaved(); refreshSavedValues();
    setStatus(n ? `Imported ${n} location${n > 1 ? "s" : ""}.` : "Nothing new to import – those locations are already saved.");
  } catch (e) {
    setStatus(`Could not read that file: ${e.message}`, true);
  }
});

// CSV points: name, lat, lon (header optional)
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === "," || ch === "\t") { cells.push(cur.trim()); cur = ""; } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}
$("import-pts-btn").addEventListener("click", () => $("import-pts-file").click());
$("import-pts-file").addEventListener("change", async () => {
  const f = $("import-pts-file").files[0];
  $("import-pts-file").value = "";
  if (!f) return;
  const rows = parseCsv(await f.text());
  if (!rows.length) return setStatus("CSV is empty.", true);
  const h = rows[0].map((c) => c.toLowerCase());
  let iName = h.findIndex((c) => /^(name|label|site|station|id)/.test(c));
  let iLat = h.findIndex((c) => /^(lat|latitude|y)$/.test(c));
  let iLon = h.findIndex((c) => /^(lon|long|lng|longitude|x)$/.test(c));
  let body = rows.slice(1);
  if (iLat < 0 || iLon < 0) { body = rows; if (rows[0].length >= 3) { iName = 0; iLat = 1; iLon = 2; } else { iName = -1; iLat = 0; iLon = 1; } }
  let added = 0;
  for (const r of body) {
    const lat = Number(r[iLat]), lon = Number(r[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    state.saved.points.push({ id: rid(), name: (iName >= 0 && r[iName]) || `Point ${state.saved.points.length + 1}`, lat, lon });
    added++;
  }
  if (!added) return setStatus("No valid rows found. Expected columns: name, lat, lon (decimal degrees).", true);
  persistSaved(); renderSaved(); refreshSavedValues();
  map.fitBounds(L.latLngBounds(state.saved.points.slice(-added).map((p) => [p.lat, p.lon])), { padding: [40, 40], maxZoom: 11 });
  setStatus(`Imported ${added} point${added > 1 ? "s" : ""}.`);
});

$("import-area-btn").addEventListener("click", () => $("import-area-file").click());
$("import-area-file").addEventListener("change", async () => {
  const files = [...$("import-area-file").files];
  $("import-area-file").value = "";
  if (!files.length) return;
  setStatus("Reading area file…");
  try {
    const areas = await importAreas(files);
    addAreas(areas, areas.length === 1);
    map.fitBounds(L.geoJSON({ type: "FeatureCollection", features: areas.map((a) => ({ type: "Feature", geometry: a.geometry })) }).getBounds(), { padding: [30, 30], maxZoom: 13 });
    setStatus(`Imported ${areas.length} area${areas.length > 1 ? "s" : ""}.`);
  } catch (e) {
    setStatus(e.message, true);
  }
});

// ------------------------------------------------------------------ drawing an area
function startDraw() {
  if (state.drawing) return cancelDraw();
  stopPlay();
  state.drawing = {
    pts: [],
    line: L.polyline([], { pane: "pick", color: "#c53030", weight: 2, dashArray: "5 4", interactive: false }).addTo(map),
    marks: L.layerGroup().addTo(map),
  };
  map.doubleClickZoom.disable();
  map.getContainer().classList.add("drawing");
  $("draw-area").classList.add("active");
  $("draw-area").textContent = "✕ Cancel drawing";
  $("draw-help").classList.remove("hidden");
  collapseSheetForMap();
}
function cancelDraw() {
  const d = state.drawing;
  if (!d) return;
  map.removeLayer(d.line); map.removeLayer(d.marks);
  state.drawing = null;
  setTimeout(() => map.doubleClickZoom.enable(), 300);
  map.getContainer().classList.remove("drawing");
  $("draw-area").classList.remove("active");
  $("draw-area").textContent = "✎ Draw area";
  $("draw-help").classList.add("hidden");
}
function drawClick(latlng) {
  const d = state.drawing;
  const px = (ll) => map.latLngToContainerPoint(ll);
  if (d.pts.length >= 3 && px(d.pts[0]).distanceTo(px(latlng)) < 14) return finishDraw();
  if (d.pts.length && px(d.pts[d.pts.length - 1]).distanceTo(px(latlng)) < 3) return;   // double-click repeat
  d.pts.push(latlng);
  d.line.setLatLngs(d.pts);
  L.circleMarker(latlng, { pane: "pick", radius: d.pts.length === 1 ? 7 : 4, color: "#c53030", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(d.marks);
}
function finishDraw() {
  const d = state.drawing;
  if (!d) return;
  const pts = d.pts.slice();
  cancelDraw();
  if (pts.length < 3) return setStatus("An area needs at least 3 corners.", true);
  const ring = pts.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  const geometry = { type: "Polygon", coordinates: [ring] };
  const area = { id: rid(), name: `Area ${state.saved.areas.length + 1}`, geometry, area_km2: polygonAreaKm2(geometry) };
  addAreas([area], true);
  setTimeout(() => renameById(area.id), 50);
}
$("draw-area").addEventListener("click", startDraw);
$("draw-finish").addEventListener("click", finishDraw);

// ------------------------------------------------------------------ search
$("search").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("search-input").value.trim();
  const ul = $("search-results");
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    let lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    ul.classList.add("hidden");
    map.setView([lat, lon], Math.max(map.getZoom(), 10));
    collapseSheetForMap();
    return selectPoint(lat, lon);
  }
  ul.innerHTML = `<li class="muted">Searching…</li>`;
  ul.classList.remove("hidden");
  try {
    const url = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates" +
      `?SingleLine=${encodeURIComponent(q)}&f=json&maxLocations=6&outFields=Addr_type&forStorage=false`;
    const j = await (await fetch(url)).json();
    const seen = new Set();
    const results = (j.candidates || []).filter((c) => !seen.has(c.address) && seen.add(c.address)).map((c) => ({
      name: c.address, lat: c.location.y, lon: c.location.x, type: (c.attributes || {}).Addr_type || "",
      bounds: c.extent ? [[c.extent.ymin, c.extent.xmin], [c.extent.ymax, c.extent.xmax]] : null,
    }));
    if (!results.length) { ul.innerHTML = `<li class="muted">No matches.</li>`; return; }
    ul.innerHTML = results.map((r, i) => `<li><button data-i="${i}">${esc(r.name)}<span>${esc(r.type)}</span></button></li>`).join("");
    ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const r = results[Number(b.dataset.i)];
      ul.classList.add("hidden");
      if (r.bounds && !/Address|POI|Point/.test(r.type)) map.fitBounds(r.bounds, { maxZoom: 12 });
      else map.setView([r.lat, r.lon], 13);
      collapseSheetForMap();
      selectPoint(r.lat, r.lon, { label: r.name });
    }));
  } catch (e) {
    ul.innerHTML = `<li class="muted">Search failed: ${esc(e.message)}</li>`;
  }
});

// ------------------------------------------------------------------ phone layout: controls as a bottom sheet
const narrow = () => window.innerWidth <= 760;
function setSheet(mode) {
  document.body.classList.toggle("sheet-full", mode === "full");
  document.body.classList.toggle("sheet-min", mode === "min");
  setTimeout(() => map.invalidateSize(), 250);
}
function collapseSheetForMap() { if (narrow()) setSheet("min"); }
$("sheet-toggle").addEventListener("click", () => {
  const b = document.body.classList;
  setSheet(b.contains("sheet-min") ? "half" : b.contains("sheet-full") ? "min" : "full");
});
$("panel").addEventListener("focusin", (e) => {
  if (narrow() && document.body.classList.contains("sheet-min") && e.target.id !== "sheet-toggle") setSheet("half");
});
window.addEventListener("resize", () => map.invalidateSize());

// ------------------------------------------------------------------ init
(async function init() {
  try {
    state.cfg = await call("config");
    for (const [k, v] of Object.entries(state.cfg.regions)) $("s4-region").add(new Option(v, k));
    for (const [k, v] of Object.entries(state.cfg.mrms_products)) $("mrms-product").add(new Option(v, k));
    if (prefs.region && state.cfg.regions[prefs.region]) $("s4-region").value = prefs.region;
    if (prefs.product && state.cfg.mrms_products[prefs.product]) $("mrms-product").value = prefs.product;
    $("var").value = state.var;
    $("scale").value = state.scale;
    $("opacity").value = state.opacity;
    $("opacity-val").textContent = `${Math.round(state.opacity * 100)}%`;
    $("show-names").checked = prefs.showNames !== false;
    $("show-saved").checked = prefs.showSaved !== false;
    $("auto-refresh").value = String(prefs.autoRefresh || 0);
    setAutoRefresh(Number(prefs.autoRefresh || 0));
    applyBoundaryUi();
    loadSaved();

    setStatus("Checking latest data…");
    const src = prefs.source === "mrms" ? "mrms" : "stage4";
    setSource(src);
    const pp = prefs.preset || {};
    if (src === "stage4") { await refreshS4Latest(); applyPreset("stage4", pp.stage4 || "7"); }
    else { await refreshMrmsLatest(); applyPreset("mrms", pp.mrms || "24"); }
    if (src === "mrms") refreshS4Latest().then(() => s4Preset(pp.stage4 || "7")).catch(() => {});
    else refreshMrmsLatest().catch(() => {});
    await load();
  } catch (e) {
    setStatus(`Startup failed: ${e.message}`, true);
  }
})();

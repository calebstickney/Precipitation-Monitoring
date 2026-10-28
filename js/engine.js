// Data engine for Precipitation Monitoring: finds, downloads, decodes and sums NWS
// precipitation grids entirely in the browser (runs inside js/worker.js).
//
//   Stage IV daily (NWS River Forecast Centers, radar + gauges), 24 h ending 12Z, 2016-present
//     water.noaa.gov/resources/downloads/precip/stageIV/YYYY/MM/DD/  (GeoTIFF; NCEP GRIB tarball fallback)
//   MRMS hourly (NOAA/NSSL, ~1 km), October 2020-present, NOAA Open Data on AWS
//     noaa-mrms-pds.s3.amazonaws.com/CONUS/<product>_00.00/YYYYMMDD/
//
// Missing data: totals add up whatever is available. For every grid cell `miss` counts the files
// (days / hour blocks) with no value there; the page marks those totals with an asterisk.

import { readTiff, decodeGrib1, decodeGrib2, inflate, untar, isGzip } from "./decoders.js?v=7";
import { Sampler, sameGrid, gridKey } from "./grid.js?v=7";
import { makeBins, fmtDay, fmtLocal } from "./bins.js?v=7";

export const S4_BASE = "https://water.noaa.gov/resources/downloads/precip/stageIV";
export const MRMS_BASE = "https://noaa-mrms-pds.s3.amazonaws.com";
export const S4_EARLIEST = "2016-01-01";
export const MRMS_EARLIEST = "2020-10-15T00:00:00Z";
export const REGIONS = {
  conus: { label: "Contiguous US", grid: { kind: "hrap", R: 6371200, x0: -1904912.11073866, y0: -3423783.69569394, dx: 4762.5, dy: 4762.5, width: 1121, height: 881 } },
  ak: { label: "Alaska", grid: { kind: "hrap", R: 6367470, x0: -3288923.2282200567, y0: -1002622.6720475592, dx: 4762.5, dy: 4762.5, width: 460, height: 530 } },
  pr: { label: "Puerto Rico", grid: { kind: "hrap", R: 6367470, x0: 4940902.266009701, y0: -6234583.378461189, dx: 4762.5, dy: 4762.5, width: 205, height: 205 } },
};
export const MRMS_PRODUCTS = {
  ms2: { label: "Multi-sensor Pass 2 (radar + gauges, ~2 h latency)", dir: (h) => `MultiSensor_QPE_${pad(h)}H_Pass2_00.00` },
  ms1: { label: "Multi-sensor Pass 1 (radar + gauges, ~1 h latency)", dir: (h) => `MultiSensor_QPE_${pad(h)}H_Pass1_00.00` },
  radar: { label: "Radar only (fastest, no gauge correction)", dir: (h) => `RadarOnly_QPE_${pad(h)}H_00.00` },
};
const S4_LASTN = [365, 180, 120, 90, 60, 30, 14, 10, 7, 6, 5, 4, 3, 2];
const S4_DAILY_TIF_MAX = 62;          // longer ranges use the ~5x smaller GRIB tarballs (no normals)
const MRMS_WINDOWS = [72, 48, 24, 12, 6, 3, 1];
const DAY = 86400000, HOUR = 3600000;

function pad(n, w = 2) { return String(n).padStart(w, "0"); }
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const ymdSlash = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseDay = (s) => new Date(`${s}T00:00:00Z`);
const todayUtc = () => parseDay(isoDay(new Date()));
const daysAgo = (d) => Math.round((todayUtc() - d) / DAY);
const roundHour = (t) => new Date(Math.round(+t / HOUR) * HOUR);

export class UserError extends Error {}

// ----------------------------------------------------------------- fetching + caching
let refreshMark = 0;                  // recent files fetched before this are re-validated
const CACHE_NAME = "precip-data-v1";
const hasCacheApi = typeof caches !== "undefined";

/** Forget listings and re-check recent (provisional) files on the next fetch. */
export function refresh() {
  refreshMark = Date.now();
  listings.clear();
  latestCache.clear();
  emptyFiles.clear();
  for (const [k, v] of grids) if (v.recent) { gridBytes -= v.bytes; grids.delete(k); }
}

/** GET url -> Uint8Array, or null when the file does not exist. immutable files go to Cache Storage.
 *  missingOk: water.noaa.gov answers "404 Not Found" WITHOUT the CORS header, so in a browser a missing
 *  file or folder looks like a network failure (fetch throws TypeError). For requests that may
 *  legitimately not exist (folder listings), treat that as "not there" after one quick retry. */
async function getBytes(url, { immutable = false, revalidate = false, missingOk = false } = {}) {
  let cache = null;
  if (immutable && hasCacheApi) {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch (_) { cache = null; }
  }
  let last;
  const attempts = missingOk ? 2 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, { cache: revalidate ? "no-cache" : "default" });
      if (r.status === 404 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (cache) {
        cache.put(url, new Response(buf.slice(0), { headers: { "Content-Type": "application/octet-stream" } }))
          .then(pruneCache).catch(() => {});
      }
      return new Uint8Array(buf);
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, (missingOk ? 300 : 800) * (attempt + 1)));
    }
  }
  if (missingOk) return null;
  throw new Error(`Download failed (${last && last.message}): ${url}`);
}

let pruneTick = 0;
async function pruneCache() {
  if (++pruneTick % 25) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 800))) await cache.delete(k);
}

async function getText(url, opts) {
  const b = await getBytes(url, opts);
  return b ? new TextDecoder().decode(b) : null;
}

/** Run fn over items with limited concurrency, preserving order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// decoded grids, LRU by bytes
const grids = new Map();
let gridBytes = 0;
const GRID_CACHE_BYTES = 320e6;
const RECENT_TTL = 10 * 60000;        // recent (provisional) files are re-checked this often: NWS re-posts them
function cacheGet(key) {
  const v = grids.get(key);
  if (!v) return v;
  grids.delete(key);
  if (v.recent && Date.now() - v.t > RECENT_TTL) { gridBytes -= v.bytes; return undefined; }
  grids.set(key, v);
  return v;
}
const countValid = (a) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] >= 0) n++; return n; };
function cachePut(key, v, recent) {
  v.bytes = v.obs.byteLength + (v.normal ? v.normal.byteLength : 0);
  v.recent = recent;
  v.t = Date.now();
  v.valid = countValid(v.obs);       // 0 = NWS posted the file without any data
  grids.set(key, v);
  gridBytes += v.bytes;
  for (const [k, old] of grids) {
    if (gridBytes <= GRID_CACHE_BYTES || grids.size <= 1) break;
    grids.delete(k); gridBytes -= old.bytes;
  }
  return v;
}
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ----------------------------------------------------------------- Stage IV
const listings = new Map();
const latestCache = new Map();
const s4Dir = (d) => `${S4_BASE}/${ymdSlash(d)}/`;
const s4Recent = (d) => daysAgo(d) <= 5;

/** File names in one day's folder (empty set when the folder isn't posted yet or can't be read). */
async function s4Listing(d) {
  const key = isoDay(d);
  const hit = listings.get(key);
  const recent = daysAgo(d) <= 20;
  if (hit && Date.now() - hit.t < hit.ttl) return hit.names;
  // folders older than a month no longer change, so keep them in Cache Storage like the data files
  const html = await getText(s4Dir(d), { revalidate: recent, immutable: daysAgo(d) > 30, missingOk: true });
  const names = new Set(html ? [...html.matchAll(/href="([^"?/]+)"/g)].map((m) => m[1]) : []);
  // an empty answer may be a not-yet-posted folder or a brief outage: only trust it for 2 minutes
  listings.set(key, { t: Date.now(), names, ttl: !names.size ? 2 * 60000 : recent ? 10 * 60000 : Infinity });
  return names;
}

// latest available day/hour, re-checked every few minutes so a page left open keeps up
function latestGet(key, ttl) {
  const hit = latestCache.get(key);
  return hit && Date.now() - hit.t < ttl ? hit.v : null;
}
const latestSet = (key, v) => { latestCache.set(key, { t: Date.now(), v }); return v; };

// NWS sometimes posts a day's files with every cell set to "no data" (e.g. Oct 23, 2026) and fixes
// them later. Those files are remembered here for a few minutes so plans route around them.
const emptyFiles = new Map();        // file name -> time found empty
const isEmptyFile = (f) => emptyFiles.has(f) && Date.now() - emptyFiles.get(f) < RECENT_TTL;
const skippedDays = new Map();       // region -> newest days skipped because their files had no data
// Cells with data in a complete NWS mosaic (every RFC reported). The newest day is sometimes posted
// before all River Forecast Centers report; NWS's multi-day files then have the same hole.
const FULL_VALID = { conus: 590556, ak: 243800, pr: 42025 };
const fullValid = new Map();
const expectedValid = (region) => Math.max(FULL_VALID[region] || 0, fullValid.get(region) || 0);
const latestValid = new Map();       // region -> data cells in the newest day's file

/** Newest day whose 1-day file is posted AND contains data. */
export async function s4Latest(region) {
  const cached = latestGet(region, RECENT_TTL);
  if (cached) return cached;
  const today = todayUtc();
  const skipped = [];
  for (let back = 0; back < 8; back++) {
    const d = new Date(today - back * DAY);
    if (!(await s4Listing(d)).has(`nws_precip_1day_${ymd(d)}_${region}.tif`)) continue;
    let g = null;
    try { g = await s4Day(d, region, true); } catch (_) { g = null; }
    if (g && g.valid > 0) {
      skippedDays.set(region, skipped);
      latestValid.set(region, g.valid);
      return latestSet(region, isoDay(d));
    }
    skipped.push(d);                  // posted but empty (or unreadable): look at the day before
  }
  throw new Error("Could not reach the NWS Stage IV archive (water.noaa.gov). Check the internet connection and press Refresh.");
}

async function windowCandidates(d, region) {
  // when one multi-day file for a date came back empty, NWS's others for that date are too
  if (isEmptyFile(`windows:${isoDay(d)}:${region}`)) return [];
  const names = await s4Listing(d);
  const out = S4_LASTN.map((n) => [`nws_precip_last${n}days_${ymd(d)}_${region}.tif`, n]);
  // NWS month / water-year / year-to-date files start with the day ending 12Z on the 2nd
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() >= 2) out.push([`nws_precip_mtd_${ymd(d)}_${region}.tif`, d.getUTCDate() - 1]);
  const wy = new Date(Date.UTC(m >= 9 ? y : y - 1, 9, 2));
  if (d >= wy) out.push([`nws_precip_wytd_${ymd(d)}_${region}.tif`, Math.round((d - wy) / DAY) + 1]);
  const jan = new Date(Date.UTC(y, 0, 2));
  if (d >= jan) out.push([`nws_precip_ytd_${ymd(d)}_${region}.tif`, Math.round((d - jan) / DAY) + 1]);
  return out.filter(([f]) => names.has(f) && !isEmptyFile(f));
}

/** Fewest files covering [start, end] (inclusive end dates): pre-summed windows where published, else days. */
async function s4Plan(start, end, region) {
  const latest = parseDay(await s4Latest(region));
  const parts = [];
  let d = end, rem = Math.round((end - start) / DAY) + 1;
  while (rem > 0) {
    let best = null;
    if ((latest - d) / DAY <= 20) {                // pre-summed windows are only kept ~2 weeks
      for (const [f, n] of await windowCandidates(d, region)) if (n <= rem && (!best || n > best[1])) best = [f, n];
    }
    if (best) { parts.push({ kind: "window", d, n: best[1], fname: best[0] }); d = new Date(d - best[1] * DAY); rem -= best[1]; }
    else { parts.push({ kind: "day", d, n: 1 }); d = new Date(d - DAY); rem -= 1; }
  }
  return parts.reverse();
}

const s4PartLabel = (pt) => (pt.n === 1 ? fmtDay(pt.d) : `${fmtDay(new Date(+pt.d - (pt.n - 1) * DAY))} – ${fmtDay(pt.d)}`);

function gridFromTiff(t, region) {
  const g = { kind: "hrap", R: REGIONS[region].grid.R, x0: t.tiepoint[3], y0: t.tiepoint[4], dx: t.pixelScale[0], dy: t.pixelScale[1], width: t.width, height: t.height };
  // snap to the canonical regional grid when it is the same layout (GRIB georef differs by < 1 cell)
  return sameGrid(g, REGIONS[region].grid) ? REGIONS[region].grid : g;
}

function cleanNeg(a) { for (let i = 0; i < a.length; i++) if (!(a[i] >= 0)) a[i] = NaN; return a; }

async function s4Tif(d, fname, region) {
  const key = `s4tif:${fname}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const recent = s4Recent(d);
    // recent files are provisional and sometimes re-posted, so always revalidate them with the server
    const bytes = await getBytes(s4Dir(d) + fname, { immutable: !recent, revalidate: recent });
    if (!bytes) return null;
    const t = await readTiff(bytes, [0, 1]);
    return cachePut(key, { grid: gridFromTiff(t, region), obs: cleanNeg(t.bands[0]), normal: cleanNeg(t.bands[1]), src: "tif" }, recent);
  });
}

async function s4Tar(d, region) {
  const key = `s4tar:${isoDay(d)}:${region}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const recent = s4Recent(d);
    const bytes = await getBytes(`${s4Dir(d)}ncep_stage_iv_source_files_${ymd(d)}.tar`, { immutable: !recent, revalidate: recent });
    if (!bytes) return null;
    const member = untar(bytes).find((f) => new RegExp(`(^|/)${region}_\\d{8}_24h\\.grb2?(\\.gz)?$`).test(f.name));
    if (!member) return null;
    let raw = member.data;
    if (isGzip(raw)) raw = await inflate(raw, "gzip");
    const g = raw[7] === 2 ? await decodeGrib2(raw) : decodeGrib1(raw);
    const ref = REGIONS[region].grid;
    if (g.nx !== ref.width || g.ny !== ref.height) return null;
    const obs = g.values;
    for (let i = 0; i < obs.length; i++) obs[i] = obs[i] >= 0 && obs[i] < 9000 ? obs[i] / 25.4 : NaN;   // mm -> in
    return cachePut(key, { grid: ref, obs, normal: null, src: "grib" }, recent);
  });
}

async function s4Day(d, region, preferTif) {
  const tif = `nws_precip_1day_${ymd(d)}_${region}.tif`;
  const tar = `ncep_stage_iv_source_files_${ymd(d)}.tar`;
  // only request files the day's folder lists: a missing file can't be told apart from a network error
  const names = await s4Listing(d);
  let order = preferTif || cacheGet(`s4tif:${tif}`) ? ["tif", "tar"] : ["tar", "tif"];
  order = order.filter((k) => names.has(k === "tif" ? tif : tar));
  let lastErr = null, empty = null;
  for (const k of order) {
    try {
      const g = k === "tif" ? await s4Tif(d, tif, region) : await s4Tar(d, region);
      if (g && g.valid > 0) return g;
      if (g) empty = g;               // posted without data: try the other file for that day
    } catch (e) {
      lastErr = e;
    }
  }
  if (empty) return empty;
  if (lastErr) throw lastErr;
  return null;
}

/** One planned file, or null when it is missing, unreadable, or was posted without data. */
async function s4LoadPart(pt, region, preferTif) {
  try {
    const g = pt.kind === "window" ? await s4Tif(pt.d, pt.fname, region) : await s4Day(pt.d, region, preferTif);
    if (g && pt.kind === "window" && !g.valid) emptyFiles.set(pt.fname, Date.now());
    return g && g.valid > 0 && sameGrid(g.grid, REGIONS[region].grid) ? g : null;
  } catch (_) {
    return null;
  }
}

/** Grids for one planned part: [{g, label, file}]. If a pre-summed window file is missing or empty,
 *  its period is re-planned without it (e.g. yesterday's window + the single day), so one bad
 *  NWS file doesn't blank a whole multi-day total. */
async function s4PartGrids(pt, region, preferTif) {
  const g = await s4LoadPart(pt, region, preferTif);
  const file = (gg) => `${pt.fname || `1day (${gg ? gg.src : "missing"})`} @ ${isoDay(pt.d)}`;
  if (g) fullValid.set(region, Math.max(fullValid.get(region) || 0, g.valid));
  // A multi-day file ending on the newest day while some RFCs haven't reported is blank there for the
  // WHOLE period; rebuild it as (window ending the day before) + (newest day) so only that day is missing.
  const partialNewest = g && pt.kind === "window" && pt.d >= parseDay(await s4Latest(region)) &&
    g.valid < expectedValid(region) * 0.995;
  if ((g && !partialNewest) || pt.kind !== "window") return [{ g, label: s4PartLabel(pt), file: file(g) }];
  emptyFiles.set(pt.fname, Date.now());
  emptyFiles.set(`windows:${isoDay(pt.d)}:${region}`, Date.now());
  const out = [];
  for (const sub of await s4Plan(new Date(+pt.d - (pt.n - 1) * DAY), pt.d, region)) out.push(...await s4PartGrids(sub, region, preferTif));
  return out;
}

/** Running sum that tolerates missing files and missing cells. */
class Accumulator {
  constructor(grid, withNormals) {
    const N = grid.width * grid.height;
    this.grid = grid;
    this.obs = new Float32Array(N);
    this.normal = withNormals ? new Float32Array(N) : null;
    this.miss = new Uint16Array(N);
    this.parts = 0;
    this.missingParts = [];         // labels of whole files that are missing
    this.hasNormals = withNormals;
  }
  add(g) {
    this.parts++;
    const o = g.obs, n = g.normal, obs = this.obs, miss = this.miss;
    if (!n) this.hasNormals = false;
    const nrm = this.hasNormals ? this.normal : null;
    for (let k = 0; k < o.length; k++) {
      const v = o[k];
      if (v >= 0) { obs[k] += v; if (nrm) nrm[k] += n[k]; } else miss[k]++;
    }
  }
  missing(label) { this.parts++; this.missingParts.push(label); }
  finish() {
    const P = this.parts, gm = this.missingParts.length, obs = this.obs, miss = this.miss, nrm = this.hasNormals ? this.normal : null;
    let partialCells = 0;
    for (let k = 0; k < obs.length; k++) {
      miss[k] += gm;
      if (miss[k] >= P) { obs[k] = NaN; if (nrm) nrm[k] = NaN; }
      else if (miss[k] > gm) partialCells++;
    }
    return { obs, normal: nrm, miss, nParts: P, partialCells };
  }
}

function missingWarnings(acc, done, unit) {
  const w = [];
  if (acc.missingParts.length) {
    const list = acc.missingParts.slice(0, 8).join("; ") + (acc.missingParts.length > 8 ? `; +${acc.missingParts.length - 8} more` : "");
    w.push(`* Some ${unit} are missing from the archive or were posted without data, so totals include only the data available. Missing: ${list}.`);
  }
  if (done.partialCells) w.push(`* At some locations a few ${unit} have no data (for example radar or gauge outages). Those totals are marked with *; click a location to see which ${unit}.`);
  return w;
}

export async function computeStage4(p, progress) {
  if (!REGIONS[p.region]) throw new UserError("Unknown region");
  const start = parseDay(p.start), end = parseDay(p.end);
  const latest = parseDay(await s4Latest(p.region));
  if (start > end) throw new UserError("First day is after last day.");
  if (start < parseDay(S4_EARLIEST)) throw new UserError("The Stage IV archive starts Jan 1, 2016.");
  const skipped = (skippedDays.get(p.region) || []).filter((d) => d > latest);
  const skipNote = skipped.length
    ? `NWS posted ${skipped.map(fmtDay).join(", ")} without any data, so the newest day available is ${fmtDay(latest)}. If NWS re-posts it, press Refresh to pick it up.`
    : null;
  if (end > latest) throw new UserError(skipNote || `Latest available day is ${isoDay(latest)}.`);
  const ndays = Math.round((end - start) / DAY) + 1;
  progress({ done: 0, total: 1, message: "Planning downloads…" });
  const parts = await s4Plan(start, end, p.region);
  const preferTif = ndays <= S4_DAILY_TIF_MAX;
  const acc = new Accumulator(REGIONS[p.region].grid, true);
  let done = 0;
  const files = [];
  await pool(parts, 6, async (pt, i) => {
    const pieces = await s4PartGrids(pt, p.region, preferTif);
    for (const { g, label } of pieces) { if (g) acc.add(g); else acc.missing(label); }   // summed as it arrives: no long-range memory build-up
    files[i] = pieces.map((x) => x.file);
    progress({ done: ++done, total: parts.length, message: `Downloaded ${done} of ${parts.length} file(s)` });
  });
  if (acc.missingParts.length === acc.parts) throw new UserError("No Stage IV data was found for that range.");
  const r = acc.finish();
  const warnings = missingWarnings(acc, r, "days");
  if (skipNote && end >= latest) warnings.unshift(skipNote);
  if (end >= latest && (latestValid.get(p.region) || 0) < expectedValid(p.region) * 0.995) {
    warnings.unshift(`NWS's newest day (${fmtDay(latest)}) is still incomplete: some River Forecast Centers haven't reported yet. ` +
      "Totals there include only the earlier days and are marked *. Press Refresh later to pick up the rest.");
  }
  if (!acc.hasNormals) warnings.push("Normals are unavailable for part of this range (archive GRIB files), so departure and % of normal are off.");
  return {
    meta: {
      source: "stage4", region: p.region, product: `Stage IV multisensor QPE – ${REGIONS[p.region].label}`,
      label: `${ndays === 1 ? fmtDay(end) : `${fmtDay(start)} – ${fmtDay(end)}`} (${ndays} day${ndays > 1 ? "s" : ""})`,
      start: p.start, end: p.end, start_utc: new Date(+start - DAY + 12 * HOUR).toISOString(), end_utc: new Date(+end + 12 * HOUR).toISOString(),
      n_steps: ndays, step: "day", has_normals: acc.hasNormals, resolution: "4.76 km HRAP grid", warnings,
      n_parts: r.nParts, missing: acc.missingParts,
      files: files.flat(),
      computed_utc: new Date().toISOString(),
    },
    grid: acc.grid, obs: r.obs, normal: r.normal, miss: r.miss,
  };
}

// ----------------------------------------------------------------- MRMS
const mrmsKey = (product, h, t) => {
  const dir = MRMS_PRODUCTS[product].dir(h);
  return `CONUS/${dir}/${ymd(t)}/MRMS_${dir}_${ymd(t)}-${pad(t.getUTCHours())}0000.grib2.gz`;
};

export async function mrmsLatest(product) {
  const key = `mrms:${product}`;
  const cached = latestGet(key, 3 * 60000);
  if (cached) return cached;
  const dir = MRMS_PRODUCTS[product].dir(1);
  for (let back = 0; back < 3; back++) {
    const d = new Date(+todayUtc() - back * DAY);
    const xml = await getText(`${MRMS_BASE}/?list-type=2&prefix=CONUS/${dir}/${ymd(d)}/`, { revalidate: true });
    const keys = xml ? [...xml.matchAll(/<Key>[^<]*_(\d{8})-(\d{2})0000\.grib2\.gz<\/Key>/g)] : [];
    if (keys.length) {
      const [, day, hh] = keys[keys.length - 1];
      const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T${hh}:00:00.000Z`;
      return latestSet(key, iso);
    }
  }
  throw new Error("Could not list MRMS files on NOAA Open Data (AWS)");
}

/** Plan [t0, t1] (whole hours) with the fewest files from `windows` (shortest path over hour offsets). */
function mrmsPlan(t0, t1, windows) {
  const n = Math.round((t1 - t0) / HOUR);
  if (n <= 0) return [];
  const best = new Array(n + 1).fill(null);
  best[0] = [0, -1, 0];
  for (let i = 1; i <= n; i++) {
    for (const w of windows) {
      if (w <= i && best[i - w] && (!best[i] || best[i - w][0] + 1 < best[i][0])) best[i] = [best[i - w][0] + 1, i - w, w];
    }
  }
  const parts = [];
  for (let i = n; i > 0; i = best[i][1]) parts.push({ t: new Date(+t0 + i * HOUR), w: best[i][2] });
  return parts.reverse();
}

const mrmsPartLabel = (t, w) => (w === 1 ? `hour ending ${fmtLocal(t)}` : `${fmtLocal(new Date(+t - w * HOUR))} – ${fmtLocal(t)}`);

async function mrmsGrid(product, w, t) {
  const key = `mrms:${mrmsKey(product, w, t)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return once(key, async () => {
    const bytes = await getBytes(`${MRMS_BASE}/${mrmsKey(product, w, t)}`, { immutable: true });
    if (!bytes) return null;
    const g = await decodeGrib2(await inflate(bytes, "gzip"));
    const v = g.values;
    for (let i = 0; i < v.length; i++) v[i] = v[i] >= 0 ? v[i] / 25.4 : NaN;     // mm -> in; -3 = no radar coverage
    const lon1 = g.lon1 > 180 ? g.lon1 - 360 : g.lon1;
    const grid = { kind: "latlon", lon0: lon1 - g.dx / 2, lat0: g.lat1 + g.dy / 2, dlon: g.dx, dlat: g.dy, width: g.nx, height: g.ny };
    return cachePut(key, { grid, obs: v, normal: null, src: "grib2" }, false);
  });
}

/** Visit the files covering one planned MRMS part; a missing multi-hour file is replaced by shorter ones. */
async function mrmsVisit(product, t, w, visit, onFile) {
  let g = null;
  try { g = await mrmsGrid(product, w, t); } catch (_) { g = null; }
  onFile && onFile();
  if (g) return visit(g, mrmsPartLabel(t, w), t, w);
  if (w === 1) return visit(null, mrmsPartLabel(t, w), t, w);
  const sub = mrmsPlan(new Date(+t - w * HOUR), t, MRMS_WINDOWS.filter((x) => x < w));
  for (const s of sub) await mrmsVisit(product, s.t, s.w, visit, onFile);
}

export async function computeMrms(p, progress) {
  if (!MRMS_PRODUCTS[p.product]) throw new UserError("Unknown MRMS product");
  const t0 = roundHour(new Date(p.start)), t1 = roundHour(new Date(p.end));
  const hours = Math.round((t1 - t0) / HOUR);
  if (hours < 1) throw new UserError("End must be at least one hour after start.");
  if (t0 < new Date(MRMS_EARLIEST)) throw new UserError("The MRMS archive on NOAA Open Data starts Oct 15, 2020; use the daily archive for older dates.");
  const latest = new Date(await mrmsLatest(p.product));
  if (t1 > latest) throw new UserError(`Latest available hour ends ${latest.toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  const parts = mrmsPlan(t0, t1, MRMS_WINDOWS);
  let acc = null, done = 0;
  const pendingMissing = [], used = [];
  for (const part of parts) {                    // sequential: each MRMS grid is ~100 MB in memory
    await mrmsVisit(p.product, part.t, part.w, (g, label, t, w) => {
      if (!g) { if (acc) acc.missing(label); else pendingMissing.push(label); return; }
      if (!acc) { acc = new Accumulator(g.grid, false); pendingMissing.forEach((l) => acc.missing(l)); }
      acc.add(g);
      used.push(`${MRMS_PRODUCTS[p.product].dir(w)} ending ${t.toISOString().slice(0, 13).replace("T", " ")}Z`);
    }, () => progress({ done: ++done, total: Math.max(done, parts.length), message: `Downloaded ${done} file(s) of ${parts.length}+` }));
  }
  if (!acc) throw new UserError("No MRMS data was found for that range.");
  const r = acc.finish();
  const z = (d) => d.toISOString().slice(5, 16).replace("T", " ");
  return {
    meta: {
      source: "mrms", product: `MRMS ${MRMS_PRODUCTS[p.product].label}`, product_key: p.product,
      label: `${z(t0)} – ${z(t1)} UTC (${hours} h)`, start_utc: t0.toISOString(), end_utc: t1.toISOString(),
      n_steps: hours, step: "hour", has_normals: false, resolution: "0.01° (~1 km) grid", warnings: missingWarnings(acc, r, "hours"),
      n_parts: r.nParts, missing: acc.missingParts, files: used, computed_utc: new Date().toISOString(),
      prefer_interval: p.prefer || null, local_days: !!p.localDays,
    },
    grid: acc.grid, obs: r.obs, normal: null, miss: r.miss,
  };
}

// ----------------------------------------------------------------- breakdowns (any length, any interval)
/** Per-bin totals at points and area averages.
 *  interval: "hour" | "day" | "month" | "total" ("total" = one bin: used to list missing periods).
 *  Returns {interval, bins, points: [[{v, m}]], areas: [[{v, m}]]}; v = sum of available data (null if none),
 *  m = labels of days/hours with no data at that location. */
export async function series(meta, points, areas, interval, progress) {
  const bins = makeBins(meta, interval);
  const P = points.length, A = areas.length, L = P + A;
  const acc = bins.map(() => ({ v: new Float64Array(L), any: new Uint8Array(L), m: Array.from({ length: L }, () => []) }));
  const covs = [];                                   // area coverage per file, to spot partly-missing areas
  const samplers = new Map();
  const sampler = (g) => {
    const key = gridKey(g.grid);
    if (!samplers.has(key)) samplers.set(key, new Sampler(g.grid, points, areas));
    return samplers.get(key);
  };
  const take = (bi, g, label) => {
    const a = acc[bi];
    if (!g) { for (let j = 0; j < L; j++) a.m[j].push(label); return; }
    const s = sampler(g);
    s.points(g.obs).forEach((v, j) => { if (v == null) a.m[j].push(label); else { a.v[j] += v; a.any[j] = 1; } });
    s.masks.forEach((mask, ai) => {
      const j = P + ai;
      let n = 0, sum = 0;
      if (mask) for (let k = 0; k < mask.length; k++) { const v = g.obs[mask[k]]; if (v >= 0) { n++; sum += v; } }
      if (!n) { a.m[j].push(label); return; }
      a.v[j] += sum / n; a.any[j] = 1;
      covs.push({ bi, j, cov: n / mask.length, label });
    });
  };

  let done = 0, total = 0;
  const tick = () => progress && progress({ done: ++done, total: Math.max(done, total), message: `Reading file ${done} of ${total}` });
  if (meta.source === "stage4") {
    const jobs = [];
    for (let bi = 0; bi < bins.length; bi++) {
      for (const pt of await s4Plan(parseDay(bins[bi].start), parseDay(bins[bi].end), meta.region)) jobs.push({ bi, pt });
    }
    total = jobs.length;
    await pool(jobs, 6, async ({ bi, pt }) => {
      for (const { g, label } of await s4PartGrids(pt, meta.region, false)) take(bi, g, label);
      tick();
    });
  } else {
    const plans = bins.map((b) => mrmsPlan(roundHour(new Date(b.start)), roundHour(new Date(b.end)), MRMS_WINDOWS));
    total = plans.reduce((a, p) => a + p.length, 0);
    for (let bi = 0; bi < bins.length; bi++) {        // sequential to bound memory
      for (const part of plans[bi]) await mrmsVisit(meta.product_key, part.t, part.w, (g, label) => take(bi, g, label), tick);
    }
  }
  // an area is "partly missing" in a file when fewer of its cells have data than in its best-covered file
  const maxCov = new Map();
  for (const c of covs) maxCov.set(c.j, Math.max(maxCov.get(c.j) || 0, c.cov));
  for (const c of covs) if (c.cov < maxCov.get(c.j) - 1e-9) acc[c.bi].m[c.j].push(`${c.label} (part of area)`);

  const out = (j) => acc.map((a) => ({ v: a.any[j] ? a.v[j] : null, m: a.m[j] }));
  return {
    interval, bins,
    points: Array.from({ length: P }, (_, k) => out(k)),
    areas: Array.from({ length: A }, (_, k) => out(P + k)),
  };
}

// ----------------------------------------------------------------- public API (called through the worker)
export const api = {
  config: async () => ({
    regions: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.label])),
    mrms_products: Object.fromEntries(Object.entries(MRMS_PRODUCTS).map(([k, v]) => [k, v.label])),
    s4_earliest: S4_EARLIEST, mrms_earliest: MRMS_EARLIEST,
  }),
  refresh: async () => { refresh(); return true; },
  s4Latest: (region) => s4Latest(region),
  mrmsLatest: (product) => mrmsLatest(product),
  accumulate: (p, progress) => (p.source === "stage4" ? computeStage4(p, progress) : computeMrms(p, progress)),
  series: (meta, points, areas, interval, progress) => series(meta, points, areas, interval, progress),
};

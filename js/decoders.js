// Binary format readers/writers used by Precipitation Monitoring.
// Pure ES module (no DOM): runs in the browser worker and in Node for testing.
// Formats: GeoTIFF (read + write), GRIB1 simple packing, GRIB2 (5.0 simple, 5.41 PNG),
// PNG (gray 8/16-bit), tar, zip.

// ----------------------------------------------------------------- compression
export async function inflate(bytes, format) {           // 'gzip' | 'deflate' (zlib) | 'deflate-raw'
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function deflate(bytes) {                     // zlib wrapper, for GeoTIFF compression 8
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const isGzip = (u8) => u8[0] === 0x1f && u8[1] === 0x8b;

// ----------------------------------------------------------------- TIFF reader
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function readIfd(dv, off, le) {
  const n = dv.getUint16(off, le);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const p = off + 2 + i * 12;
    const tag = dv.getUint16(p, le), type = dv.getUint16(p + 2, le), count = dv.getUint32(p + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    const at = size <= 4 ? p + 8 : dv.getUint32(p + 8, le);
    const vals = [];
    if (type === 2) {
      let s = "";
      for (let k = 0; k < count; k++) s += String.fromCharCode(dv.getUint8(at + k));
      tags[tag] = s;
      continue;
    }
    for (let k = 0; k < count; k++) {
      switch (type) {
        case 1: case 7: vals.push(dv.getUint8(at + k)); break;
        case 3: vals.push(dv.getUint16(at + 2 * k, le)); break;
        case 4: vals.push(dv.getUint32(at + 4 * k, le)); break;
        case 11: vals.push(dv.getFloat32(at + 4 * k, le)); break;
        case 12: vals.push(dv.getFloat64(at + 8 * k, le)); break;
        case 16: vals.push(Number(dv.getBigUint64(at + 8 * k, le))); break;
        default: vals.push(dv.getUint8(at + k));
      }
    }
    tags[tag] = vals;
  }
  return tags;
}

/** Read float32 bands from a (Geo)TIFF. Supports tiles/strips, deflate/none, predictor 1/2/3,
 *  planar 1/2. Returns {width, height, bands:[Float32Array], pixelScale, tiepoint, geoKeys, geoDoubles, geoAscii}. */
export async function readTiff(buffer, wantBands) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = u8[0] === 0x49;
  if (dv.getUint16(2, le) !== 42) throw new Error("Not a classic TIFF");
  const t = readIfd(dv, dv.getUint32(4, le), le);
  const W = t[256][0], H = t[257][0];
  const spp = t[277] ? t[277][0] : 1;
  const bits = t[258] ? t[258][0] : 32;
  const fmt = t[339] ? t[339][0] : 1;
  const comp = t[259] ? t[259][0] : 1;
  const pred = t[317] ? t[317][0] : 1;
  const planar = t[284] ? t[284][0] : 1;
  if (bits !== 32 || fmt !== 3) throw new Error("Only float32 TIFFs are supported");
  if (![1, 8, 32946].includes(comp)) throw new Error(`TIFF compression ${comp} not supported`);
  const tiled = !!t[322];
  const cw = tiled ? t[322][0] : W;
  const ch = tiled ? t[323][0] : (t[278] ? t[278][0] : H);
  const offs = tiled ? t[324] : t[273];
  const cnts = tiled ? t[325] : t[279];
  const across = Math.ceil(W / cw), down = Math.ceil(H / ch);
  const perBand = across * down;
  const want = wantBands || Array.from({ length: spp }, (_, i) => i);
  const bands = want.map(() => new Float32Array(W * H));
  const chunkSpp = planar === 2 ? 1 : spp;

  async function chunk(k) {
    let raw = u8.subarray(offs[k], offs[k] + cnts[k]);
    if (comp !== 1) raw = await inflate(raw, "deflate");
    else raw = raw.slice();
    const words = cw * chunkSpp;                 // samples per chunk row
    if (pred === 2) {
      const w32 = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
      for (let r = 0; r < ch; r++) {
        const base = r * words;
        for (let i = chunkSpp; i < words; i++) w32[base + i] = (w32[base + i] + w32[base + i - chunkSpp]) >>> 0;
      }
    } else if (pred === 3) {
      const out = new Uint8Array(raw.length);
      const rowBytes = words * 4;
      for (let r = 0; r < ch; r++) {
        const row = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
        for (let i = chunkSpp; i < rowBytes; i++) row[i] = (row[i] + row[i - chunkSpp]) & 0xff;
        for (let j = 0; j < words; j++) {
          for (let b = 0; b < 4; b++) {
            const src = row[b * words + j];
            out[r * rowBytes + j * 4 + (le ? 3 - b : b)] = src;
          }
        }
      }
      raw = out;
    }
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  const jobs = [];
  for (let wi = 0; wi < want.length; wi++) {
    const b = want[wi];
    for (let k = 0; k < perBand; k++) {
      jobs.push((async () => {
        const kk = planar === 2 ? b * perBand + k : k;
        const v = await chunk(kk);
        const r0 = Math.floor(k / across) * ch, c0 = (k % across) * cw;
        const out = bands[wi];
        const rows = Math.min(ch, H - r0), cols = Math.min(cw, W - c0);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const s = planar === 2 ? r * cw + c : (r * cw + c) * spp + b;
            out[(r0 + r) * W + c0 + c] = v.getFloat32(s * 4, le);
          }
        }
      })());
    }
  }
  await Promise.all(jobs);
  return {
    width: W, height: H, bands,
    pixelScale: t[33550] || null, tiepoint: t[33922] || null,
    geoKeys: t[34735] || null, geoDoubles: t[34736] || null, geoAscii: t[34737] || null,
  };
}

// ----------------------------------------------------------------- TIFF writer
/** Write a single-band float32 GeoTIFF (deflate strips). geo = {pixelScale, tiepoint, geoKeys, geoDoubles?, geoAscii?} */
export async function writeGeoTiff(width, height, data, geo, opts = {}) {
  const nodata = opts.nodata ?? -9999;
  const rowsPerStrip = Math.max(1, Math.floor(65536 / (width * 4)) || 1);
  const strips = [];
  for (let r = 0; r < height; r += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - r);
    const buf = new Float32Array(rows * width);
    for (let i = 0; i < rows * width; i++) {
      const v = data[r * width + i];
      buf[i] = Number.isFinite(v) ? v : nodata;
    }
    strips.push(await deflate(new Uint8Array(buf.buffer)));
  }
  const entries = [];
  const add = (tag, type, values) => entries.push({ tag, type, values });
  add(256, 4, [width]);
  add(257, 4, [height]);
  add(258, 3, [32]);
  add(259, 3, [8]);
  add(262, 3, [1]);
  if (opts.description) add(270, 2, opts.description);
  add(273, 4, strips.map(() => 0));                  // patched below
  add(277, 3, [1]);
  add(278, 4, [rowsPerStrip]);
  add(279, 4, strips.map((s) => s.length));
  add(284, 3, [1]);
  add(339, 3, [3]);
  add(33550, 12, geo.pixelScale);
  add(33922, 12, geo.tiepoint);
  add(34735, 3, geo.geoKeys);
  if (geo.geoDoubles) add(34736, 12, geo.geoDoubles);
  if (geo.geoAscii) add(34737, 2, geo.geoAscii);
  if (opts.metadata) add(42112, 2, opts.metadata);
  add(42113, 2, String(nodata));
  entries.sort((a, b) => a.tag - b.tag);

  const size = (e) => (e.type === 2 ? e.values.length + 1 : e.values.length * TYPE_SIZE[e.type]);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const extraAt = new Map();
  for (const e of entries) {
    if (size(e) > 4) { extraAt.set(e, extra); extra += size(e) + (size(e) & 1); }
  }
  let dataAt = extra;
  const stripOffsets = strips.map((s) => { const o = dataAt; dataAt += s.length; return o; });
  entries.find((e) => e.tag === 273).values = stripOffsets;

  const out = new Uint8Array(dataAt);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  const writeVals = (e, at) => {
    if (e.type === 2) { for (let i = 0; i < e.values.length; i++) out[at + i] = e.values.charCodeAt(i) & 0xff; out[at + e.values.length] = 0; return; }
    e.values.forEach((v, i) => {
      if (e.type === 3) dv.setUint16(at + 2 * i, v, true);
      else if (e.type === 4) dv.setUint32(at + 4 * i, v, true);
      else if (e.type === 12) dv.setFloat64(at + 8 * i, v, true);
    });
  };
  entries.forEach((e, i) => {
    const p = 10 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.type === 2 ? e.values.length + 1 : e.values.length, true);
    if (extraAt.has(e)) { dv.setUint32(p + 8, extraAt.get(e), true); writeVals(e, extraAt.get(e)); }
    else writeVals(e, p + 8);
  });
  dv.setUint32(8 + 2 + entries.length * 12, 0, true);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  return out;
}

// ----------------------------------------------------------------- bit reader
function makeBitReader(u8, start) {
  let pos = start * 8;
  return (n) => {
    let v = 0;
    while (n > 0) {
      const byte = u8[pos >> 3], off = pos & 7, take = Math.min(8 - off, n);
      v = v * (1 << take) + ((byte >> (8 - off - take)) & ((1 << take) - 1));
      pos += take; n -= take;
    }
    return v;
  };
}

const signMag16 = (hi, lo) => ((hi & 0x80) ? -1 : 1) * (((hi & 0x7f) << 8) | lo);
const u24 = (u8, p) => (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
function ibmFloat(u8, p) {
  const sign = u8[p] & 0x80 ? -1 : 1, exp = (u8[p] & 0x7f) - 64;
  const mant = u24(u8, p + 1) / 16777216;
  return sign * mant * Math.pow(16, exp);
}

// ----------------------------------------------------------------- GRIB1
/** Decode the first GRIB1 message (simple grid-point packing, optional bitmap).
 *  Returns {nx, ny, values: Float32Array row 0 = north/top, NaN = missing}. */
export function decodeGrib1(u8) {
  let s = 0;
  while (s < u8.length - 4 && !(u8[s] === 71 && u8[s + 1] === 82 && u8[s + 2] === 73 && u8[s + 3] === 66)) s++;
  if (u8[s + 7] !== 1) throw new Error("Not GRIB edition 1");
  let p = s + 8;
  const pdsLen = u24(u8, p), flag = u8[p + 7];
  const D = signMag16(u8[p + 26], u8[p + 27]);
  p += pdsLen;
  let nx = 0, ny = 0, scan = 0;
  if (flag & 0x80) {
    const gdsLen = u24(u8, p);
    nx = (u8[p + 6] << 8) | u8[p + 7];
    ny = (u8[p + 8] << 8) | u8[p + 9];
    scan = u8[p + 27];                           // octet 28 for both lat/lon and polar stereographic
    p += gdsLen;
  } else throw new Error("GRIB1 without grid description");
  let bitmap = null;
  if (flag & 0x40) {
    const bmsLen = u24(u8, p);
    bitmap = u8.subarray(p + 6, p + bmsLen);
    p += bmsLen;
  }
  const bdsFlag = u8[p + 3];                    // 0x80 spherical harmonics, 0x40 complex packing
  if (bdsFlag & 0xc0) throw new Error("Only simple grid-point GRIB1 packing is supported");
  const E = signMag16(u8[p + 4], u8[p + 5]);
  const R = ibmFloat(u8, p + 6);
  const nbits = u8[p + 10];
  const read = makeBitReader(u8, p + 11);
  const scaleE = Math.pow(2, E), scaleD = Math.pow(10, -D);
  const n = nx * ny;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (bitmap && !((bitmap[i >> 3] >> (7 - (i & 7))) & 1)) { raw[i] = NaN; continue; }
    raw[i] = nbits ? (R + read(nbits) * scaleE) * scaleD : R * scaleD;
  }
  return { nx, ny, values: reorder(raw, nx, ny, scan) };
}

/** Re-order a GRIB scan into row-major, top row = north (max y), west to east. */
function reorder(raw, nx, ny, scan) {
  const negI = scan & 0x80, posJ = scan & 0x40, jFirst = scan & 0x20;
  if (!negI && !posJ && !jFirst) return raw;
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = jFirst ? i * ny + j : j * nx + i;
      const col = negI ? nx - 1 - i : i;
      const row = posJ ? ny - 1 - j : j;
      out[row * nx + col] = raw[k];
    }
  }
  return out;
}

// ----------------------------------------------------------------- PNG (gray)
export async function decodePngGray(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0;
  const idat = [];
  while (p < u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    if (type === "IHDR") { width = dv.getUint32(p + 8); height = dv.getUint32(p + 12); depth = u8[p + 16]; ctype = u8[p + 17]; }
    else if (type === "IDAT") idat.push(u8.subarray(p + 8, p + 8 + len));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (ctype !== 0) throw new Error("Only grayscale PNG is supported");
  const total = idat.reduce((a, b) => a + b.length, 0);
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const data = await inflate(z, "deflate");
  const bpp = Math.max(1, depth >> 3);
  const stride = Math.ceil((width * depth) / 8);
  const out = new Uint8Array(stride * height);
  for (let r = 0; r < height; r++) {
    const f = data[r * (stride + 1)];
    const src = r * (stride + 1) + 1, dst = r * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[prev + i] : 0;
      const c = r > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error("Bad PNG filter");
      }
      out[dst + i] = v & 0xff;
    }
  }
  const n = width * height;
  const vals = new Uint32Array(n);
  if (depth === 16) for (let i = 0; i < n; i++) vals[i] = (out[2 * i] << 8) | out[2 * i + 1];
  else if (depth === 8) for (let i = 0; i < n; i++) vals[i] = out[i];
  else throw new Error(`PNG bit depth ${depth} not supported`);
  return { width, height, vals };
}

// ----------------------------------------------------------------- GRIB2
/** Decode the first field of a GRIB2 message. Grids: 3.0 lat/lon, 3.20 polar stereographic.
 *  Packing: 5.0 simple, 5.3 complex + spatial differencing, 5.41 PNG.
 *  Returns {template, nx, ny, values (rows north->south, NaN = missing), lat1, lon1, lat2, lon2, dx, dy}. */
export async function decodeGrib2(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 16;
  const g = {};
  let R = 0, E = 0, D = 0, nbits = 0, tmpl5 = -1, s5 = null, bitmap = null, data = null, nData = 0;
  while (p < u8.length - 4) {
    if (u8[p] === 55 && u8[p + 1] === 55 && u8[p + 2] === 55 && u8[p + 3] === 55) break;
    const len = dv.getUint32(p), sec = u8[p + 4];
    if (sec === 3) {
      g.template = dv.getUint16(p + 12);
      g.nx = dv.getUint32(p + 30); g.ny = dv.getUint32(p + 34);
      if (g.template === 0) {
        g.lat1 = dv.getInt32(p + 46) / 1e6; g.lon1 = dv.getUint32(p + 50) / 1e6;
        g.lat2 = dv.getInt32(p + 55) / 1e6; g.lon2 = dv.getUint32(p + 59) / 1e6;
        g.dx = dv.getUint32(p + 63) / 1e6; g.dy = dv.getUint32(p + 67) / 1e6;
        g.scan = u8[p + 71];
      } else if (g.template === 20) {
        g.scan = u8[p + 64];
      } else throw new Error(`GRIB2 grid template 3.${g.template} is not supported`);
    } else if (sec === 5) {
      nData = dv.getUint32(p + 5);
      tmpl5 = dv.getUint16(p + 9);
      // GRIB2 scale factors are sign-magnitude, not two's complement
      R = dv.getFloat32(p + 11); E = signMag16(u8[p + 15], u8[p + 16]); D = signMag16(u8[p + 17], u8[p + 18]);
      nbits = u8[p + 19];
      s5 = u8.subarray(p, p + len);
    } else if (sec === 6) {
      if (u8[p + 5] === 0) bitmap = u8.subarray(p + 6, p + len);
    } else if (sec === 7) {
      data = u8.subarray(p + 5, p + len);
    }
    p += len;
  }
  const n = g.nx * g.ny;
  const eS = Math.pow(2, E), dS = Math.pow(10, -D);
  let packed, missing = null;
  if (tmpl5 === 41) packed = (await decodePngGray(data)).vals;
  else if (tmpl5 === 0) {
    const read = makeBitReader(data, 0);
    packed = new Float64Array(nData);
    if (nbits) for (let i = 0; i < nData; i++) packed[i] = read(nbits);
  } else if (tmpl5 === 3) ({ packed, missing } = unpackComplex(s5, data, nData, nbits));
  else throw new Error(`GRIB2 data template 5.${tmpl5} is not supported`);
  const values = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (bitmap && !((bitmap[i >> 3] >> (7 - (i & 7))) & 1)) { values[i] = NaN; continue; }
    const j = k++;
    values[i] = missing && missing[j] ? NaN : (R + packed[j] * eS) * dS;
  }
  g.values = reorder(values, g.nx, g.ny, g.scan || 0);
  if (g.template === 0 && g.lat1 < g.lat2) [g.lat1, g.lat2] = [g.lat2, g.lat1];
  return g;
}

/** GRIB2 data template 5.3: complex packing with spatial differencing (as in NCEP g2clib comunpack). */
function unpackComplex(s5, data, nData, nbits) {
  const s = (o) => s5[o - 1];                                   // 1-based octets of section 5
  const u32 = (o) => ((s(o) << 24) >>> 0) + (s(o + 1) << 16) + (s(o + 2) << 8) + s(o + 3);
  const missMgmt = s(23);
  const NG = u32(32);
  const widthRef = s(36), widthBits = s(37);
  const lenRef = u32(38), lenInc = s(42), lastLen = u32(43), lenBits = s(47);
  const order = s(48), ndesc = s(49);
  let off = 0;
  const signed = (bytes) => {
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + data[off + i];
    const neg = data[off] & 0x80;
    if (neg) v -= 0x80 * Math.pow(256, bytes - 1);
    off += bytes;
    return neg ? -v : v;
  };
  let ival1 = 0, ival2 = 0, minsd = 0;
  if (order > 0) {
    ival1 = signed(ndesc);
    if (order === 2) ival2 = signed(ndesc);
    minsd = signed(ndesc);
  }
  let read = makeBitReader(data, off);
  const refs = new Float64Array(NG), widths = new Uint8Array(NG), lens = new Uint32Array(NG);
  let bitsUsed = 0;
  for (let i = 0; i < NG; i++) refs[i] = nbits ? read(nbits) : 0;
  off += Math.ceil((NG * nbits) / 8);
  read = makeBitReader(data, off);
  for (let i = 0; i < NG; i++) widths[i] = widthRef + (widthBits ? read(widthBits) : 0);
  off += Math.ceil((NG * widthBits) / 8);
  read = makeBitReader(data, off);
  for (let i = 0; i < NG; i++) lens[i] = lenRef + (lenBits ? read(lenBits) : 0) * lenInc;
  lens[NG - 1] = lastLen;
  off += Math.ceil((NG * lenBits) / 8);
  read = makeBitReader(data, off);
  const packed = new Float64Array(nData);
  const missing = missMgmt ? new Uint8Array(nData) : null;
  const allOnes = (b) => Math.pow(2, b) - 1;
  let k = 0;
  for (let gi = 0; gi < NG; gi++) {
    const w = widths[gi], L = lens[gi], ref = refs[gi];
    for (let j = 0; j < L && k < nData; j++, k++) {
      if (w === 0) {
        if (missMgmt && nbits && ref === allOnes(nbits)) missing[k] = 1;
        else packed[k] = ref;
      } else {
        const x = read(w);
        if (missMgmt && x === allOnes(w)) missing[k] = 1;
        else packed[k] = ref + x;
      }
    }
    bitsUsed += w * L;
  }
  if (order > 0) {                                   // undo spatial differencing over non-missing values
    const idx = [];
    for (let i = 0; i < nData; i++) if (!missing || !missing[i]) idx.push(i);
    if (idx.length) packed[idx[0]] = ival1;
    if (order === 1) {
      for (let i = 1; i < idx.length; i++) packed[idx[i]] = packed[idx[i]] + minsd + packed[idx[i - 1]];
    } else {
      if (idx.length > 1) packed[idx[1]] = ival2;
      for (let i = 2; i < idx.length; i++) {
        packed[idx[i]] = packed[idx[i]] + minsd + 2 * packed[idx[i - 1]] - packed[idx[i - 2]];
      }
    }
  }
  return { packed, missing };
}

// ----------------------------------------------------------------- tar / zip
export function untar(u8) {
  const files = [];
  let p = 0;
  while (p + 512 <= u8.length) {
    const hdr = u8.subarray(p, p + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => { let s = ""; for (let i = a; i < b && hdr[i]; i++) s += String.fromCharCode(hdr[i]); return s; };
    const name = (str(345, 500) ? str(345, 500) + "/" : "") + str(0, 100);
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(hdr[156] || 48);
    if (type === "0" || type === "\0") files.push({ name, data: u8.subarray(p + 512, p + 512 + size) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Not a zip file");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lxlen;
    const raw = u8.subarray(start, start + csize);
    if (!name.endsWith("/")) {
      if (method === 0) files.push({ name, data: raw });
      else if (method === 8) files.push({ name, data: await inflate(raw, "deflate-raw") });
    }
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

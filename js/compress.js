// Allègement de PDF : recompresse les images (PNG et JPEG) et réenregistre le fichier. Aucun accès réseau.
import { PDFDocument, PDFName, PDFNumber, PDFArray, PDFRawStream, PDFString, PDFHexString, PDFBool, PDFRef } from '../vendor/pdf-lib.esm.min.js';
import { openView } from './render.js';
import { nextFrame } from './util.js';

export const LEVELS = {
  light: { id: 'light', label: 'Léger', ppp: 150, q: 0.8, detail: 'Images à 150 ppp, qualité 80 %. Le texte reste net et sélectionnable.' },
  mail: { id: 'mail', label: 'Pour un mail', ppp: 110, q: 0.65, detail: 'Images à 110 ppp, qualité 65 %. Le texte reste net et sélectionnable.' },
  tiny: { id: 'tiny', label: 'Très léger', ppp: 100, q: 0.6, raster: true, detail: "Chaque page devient une image à 100 ppp. Le texte n'est plus sélectionnable. Dernier recours." },
};
const MIN_IMAGE_BYTES = 30 * 1024; // en dessous, l'image est déjà petite : on n'y touche pas
const LOAD_OPTS = { ignoreEncryption: true, updateMetadata: false };

const N = (s) => PDFName.of(s);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);
const numOf = (o) => (o instanceof PDFNumber ? o.asNumber() : null);

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Annule le filtre PNG (prédicteurs 10 à 15) utilisé par les PDF qui embarquent des PNG tels quels
function unpredictPng(data, colors, bpc, columns) {
  const rb = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rows = Math.floor(data.length / (rb + 1));
  const out = new Uint8Array(rows * rb);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rb + 1)];
    const inOff = r * (rb + 1) + 1;
    const o = r * rb;
    const prev = o - rb;
    for (let i = 0; i < rb; i++) {
      const x = data[inOff + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = r > 0 ? out[prev + i] : 0;
      const c = i >= bpp && r > 0 ? out[prev + i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else v = x;
      out[o + i] = v & 255;
    }
  }
  return out;
}

function csInfo(ctx, cs, depth = 0) {
  cs = ctx.lookup(cs);
  if (depth > 3) return null;
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    if (n === 'DeviceRGB' || n === 'CalRGB' || n === 'RGB') return { kind: 'rgb', n: 3 };
    if (n === 'DeviceGray' || n === 'CalGray' || n === 'G') return { kind: 'gray', n: 1 };
    return null;
  }
  if (cs instanceof PDFArray) {
    const first = nameOf(ctx.lookup(cs.get(0)));
    if (first === 'CalRGB') return { kind: 'rgb', n: 3 };
    if (first === 'CalGray') return { kind: 'gray', n: 1 };
    if (first === 'ICCBased') {
      const st = ctx.lookup(cs.get(1));
      const n = st && st.dict ? numOf(ctx.lookup(st.dict.get(N('N')))) : null;
      return n === 3 ? { kind: 'rgb', n: 3 } : n === 1 ? { kind: 'gray', n: 1 } : null;
    }
    if (first === 'Indexed' || first === 'I') {
      const base = csInfo(ctx, cs.get(1), depth + 1);
      const lk = ctx.lookup(cs.get(3));
      let pal = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) pal = lk.asBytes();
      else if (lk instanceof PDFRawStream && !lk.dict.has(N('Filter'))) pal = lk.contents;
      if (!base || !pal || (base.kind !== 'rgb' && base.kind !== 'gray')) return null;
      return { kind: 'indexed', n: 1, base, pal };
    }
  }
  return null;
}

function filtersOf(ctx, dict) {
  const f = ctx.lookup(dict.get(N('Filter')));
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => nameOf(ctx.lookup(x)));
  return [null];
}

function parmsOf(ctx, dict, idx = 0) {
  let p = ctx.lookup(dict.get(N('DecodeParms')));
  if (p instanceof PDFArray) p = ctx.lookup(p.get(idx));
  return p && p.get ? p : null;
}

// ASCII85 (utilisé par certains générateurs de PDF avant la compression Flate)
function ascii85(bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length * 0.8) + 8);
  let n = 0;
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x7e) break;
    if (c <= 32) continue;
    if (c === 0x7a && count === 0) { n += 4; continue; }
    if (c < 33 || c > 117) continue;
    tuple = tuple * 85 + (c - 33);
    count++;
    if (count === 5) {
      out[n++] = (tuple >>> 24) & 255; out[n++] = (tuple >>> 16) & 255; out[n++] = (tuple >>> 8) & 255; out[n++] = tuple & 255;
      tuple = 0;
      count = 0;
    }
  }
  if (count > 1) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const b = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    for (let i = 0; i < count - 1; i++) out[n++] = b[i];
  }
  return out.subarray(0, n);
}

// Octets bruts -> pixels RGBA, ou null si le format n'est pas pris en charge
function toRgba(raw, W, H, bpc, cs) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const rb = Math.ceil((cs.n * bpc * W) / 8);
  if (raw.length < rb * H) return null;
  if (cs.kind === 'rgb' && bpc === 8) {
    for (let y = 0; y < H; y++) {
      let s = y * rb;
      let d = y * W * 4;
      for (let x = 0; x < W; x++, s += 3, d += 4) { rgba[d] = raw[s]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s + 2]; rgba[d + 3] = 255; }
    }
    return rgba;
  }
  if (cs.kind === 'gray' && [1, 2, 4, 8].includes(bpc)) {
    const max = (1 << bpc) - 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bit = x * bpc;
        const v = (raw[y * rb + (bit >> 3)] >> (8 - bpc - (bit & 7))) & max;
        const g = Math.round((v * 255) / max);
        const d = (y * W + x) * 4;
        rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
        rgba[d + 3] = 255;
      }
    }
    return rgba;
  }
  if (cs.kind === 'indexed' && [1, 2, 4, 8].includes(bpc)) {
    const max = (1 << bpc) - 1;
    const bn = cs.base.n;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bit = x * bpc;
        const idx = (raw[y * rb + (bit >> 3)] >> (8 - bpc - (bit & 7))) & max;
        const d = (y * W + x) * 4;
        if (bn === 3) { rgba[d] = cs.pal[idx * 3] || 0; rgba[d + 1] = cs.pal[idx * 3 + 1] || 0; rgba[d + 2] = cs.pal[idx * 3 + 2] || 0; }
        else rgba[d] = rgba[d + 1] = rgba[d + 2] = cs.pal[idx] || 0;
        rgba[d + 3] = 255;
      }
    }
    return rgba;
  }
  return null;
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Réduit par paliers (de moitié en moitié) puis encode en JPEG
async function encodeJpeg(src, sw, sh, dw, dh, q) {
  let cur = src;
  let cw = sw;
  let ch = sh;
  while (cw > dw * 2 || ch > dh * 2) {
    const nw = Math.max(dw, Math.ceil(cw / 2));
    const nh = Math.max(dh, Math.ceil(ch / 2));
    const c = newCanvas(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    if (cur instanceof HTMLCanvasElement && cur !== src) cur.width = 0;
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = newCanvas(dw, dh);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
  if (cur instanceof HTMLCanvasElement && cur !== src) cur.width = 0;
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', q));
  out.width = 0;
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

// Tente de recompresser une image. Retourne { bytes, w, h } ou null (image laissée telle quelle).
async function recompressImage(ctx, stream, cfg, cap) {
  const dict = stream.dict;
  if (nameOf(ctx.lookup(dict.get(N('Subtype')))) !== 'Image') return null;
  const im = ctx.lookup(dict.get(N('ImageMask')));
  if (im instanceof PDFBool && im.asBoolean()) return null;
  if (dict.has(N('Mask')) || dict.has(N('Decode'))) return null;
  const sm = ctx.lookup(dict.get(N('SMask')));
  if (sm && sm.dict && sm.dict.has(N('Matte'))) return null;
  const original = stream.contents;
  if (original.length < MIN_IMAGE_BYTES) return null;
  const W = numOf(ctx.lookup(dict.get(N('Width'))));
  const H = numOf(ctx.lookup(dict.get(N('Height'))));
  if (!W || !H) return null;
  let filters = filtersOf(ctx, dict);
  const a85 = filters.length === 2 && (filters[0] === 'ASCII85Decode' || filters[0] === 'A85');
  if (filters.length !== 1 && !a85) return null;
  const parmIdx = filters.length - 1;
  filters = [filters[filters.length - 1]];
  const cs = csInfo(ctx, dict.get(N('ColorSpace')));
  if (!cs) return null;

  const iL = Math.max(W, H);
  const iS = Math.min(W, H);
  const scale = Math.min(1, cap.long / iL, cap.short / iS);
  const dw = Math.max(1, Math.round(W * scale));
  const dh = Math.max(1, Math.round(H * scale));

  let bytes = null;
  if (filters[0] === 'DCTDecode' || filters[0] === 'DCT') {
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob([original], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    } catch (e) { return null; }
    bytes = await encodeJpeg(bmp, bmp.width, bmp.height, dw, dh, cfg.q);
    bmp.close();
  } else if (filters[0] === 'FlateDecode' || filters[0] === 'Fl') {
    const bpc = numOf(ctx.lookup(dict.get(N('BitsPerComponent')))) || 8;
    let raw;
    try {
      raw = await inflate(a85 ? ascii85(original) : original);
    } catch (e) { return null; }
    const parms = parmsOf(ctx, dict, parmIdx);
    const pred = parms ? numOf(ctx.lookup(parms.get(N('Predictor')))) || 1 : 1;
    if (pred >= 10) {
      const colors = numOf(ctx.lookup(parms.get(N('Colors')))) || 1;
      const pb = numOf(ctx.lookup(parms.get(N('BitsPerComponent')))) || 8;
      const cols = numOf(ctx.lookup(parms.get(N('Columns')))) || 1;
      raw = unpredictPng(raw, colors, pb, cols);
    } else if (pred !== 1) return null;
    const rgba = toRgba(raw, W, H, bpc, cs);
    if (!rgba) return null;
    const src = newCanvas(W, H);
    src.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    bytes = await encodeJpeg(src, W, H, dw, dh, cfg.q);
    src.width = 0;
  } else return null;

  if (!bytes || bytes.length > original.length * 0.85) return null;
  return { bytes, w: dw, h: dh };
}

async function lightenImages(bytes, cfg, onProgress) {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  if (doc.isEncrypted) { const e = new Error('chiffré'); e.userMessage = 'Ce PDF est protégé : il ne peut pas être allégé ici.'; throw e; }
  const ctx = doc.context;
  let maxLong = 0;
  let maxShort = 0;
  for (const p of doc.getPages()) {
    const { width, height } = p.getSize();
    maxLong = Math.max(maxLong, width, height);
    maxShort = Math.max(maxShort, Math.min(width, height));
  }
  const cap = { long: Math.ceil((maxLong / 72) * cfg.ppp), short: Math.ceil((maxShort / 72) * cfg.ppp) };
  const imgs = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && nameOf(ctx.lookup(obj.dict.get(N('Subtype')))) === 'Image') imgs.push([ref, obj]);
  }
  // Les masques de transparence (SMask, Mask) doivent rester en niveaux de gris : on n'y touche pas
  const masks = new Set();
  for (const [, obj] of imgs) {
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(N(key));
      if (v instanceof PDFRef) masks.add(v.toString());
    }
  }
  let replaced = 0;
  for (let i = 0; i < imgs.length; i++) {
    const [ref, obj] = imgs[i];
    if (masks.has(ref.toString())) continue;
    if (onProgress) onProgress({ done: i, total: imgs.length });
    await nextFrame();
    let r = null;
    try {
      r = await recompressImage(ctx, obj, cfg, cap);
    } catch (e) {
      console.warn('Image ignorée', e);
    }
    if (!r) continue;
    const nd = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: r.w, Height: r.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    nd.set(N('Length'), PDFNumber.of(r.bytes.length));
    if (obj.dict.has(N('SMask'))) nd.set(N('SMask'), obj.dict.get(N('SMask')));
    if (obj.dict.has(N('Interpolate'))) nd.set(N('Interpolate'), obj.dict.get(N('Interpolate')));
    ctx.assign(ref, PDFRawStream.of(nd, r.bytes));
    replaced++;
  }
  if (onProgress) onProgress({ done: imgs.length, total: imgs.length });
  doc.setProducer('PDF Pop');
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, replaced, total: imgs.length };
}

// « Très léger » : chaque page est dessinée à basse résolution puis ré-encodée en JPEG
async function rasterize(bytes, cfg, onProgress) {
  const view = await openView(bytes);
  const out = await PDFDocument.create();
  try {
    for (let n = 1; n <= view.numPages; n++) {
      if (onProgress) onProgress({ done: n - 1, total: view.numPages });
      await nextFrame();
      const page = await view.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: cfg.ppp / 72 });
      const c = newCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', cfg.q));
      c.width = 0;
      const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const pg = out.addPage([vp1.width, vp1.height]);
      pg.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    if (onProgress) onProgress({ done: view.numPages, total: view.numPages });
  } finally {
    try { view.destroy(); } catch (e) { /* rien */ }
  }
  out.setProducer('PDF Pop');
  return { bytes: await out.save({ useObjectStreams: true }), replaced: view.numPages, total: view.numPages };
}

// Retourne { bytes, before, after, changed, replaced, total }. changed=false : le fichier d'origine est conservé.
export async function lighten(bytes, levelId, onProgress) {
  const cfg = LEVELS[levelId] || LEVELS.mail;
  const r = cfg.raster ? await rasterize(bytes, cfg, onProgress) : await lightenImages(bytes, cfg, onProgress);
  const before = bytes.length;
  const better = r.bytes.length < before * 0.97 && before - r.bytes.length >= 8192; // sinon : déjà léger
  return { bytes: better ? r.bytes : bytes, before, after: better ? r.bytes.length : before, changed: better, replaced: r.replaced, total: r.total };
}

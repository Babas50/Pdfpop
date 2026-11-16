// Tout ce qui lit ou écrit des PDF (pdf-lib). Aucun accès réseau.
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  BlendMode,
  LineCapStyle,
} from '../vendor/pdf-lib.esm.min.js';

const LOAD_OPTS = { ignoreEncryption: true, updateMetadata: false };

export async function openCheck(bytes) {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  return { encrypted: !!doc.isEncrypted, pageCount: doc.getPageCount() };
}

/* ---------- Assembler, fusionner, diviser ---------- */

// specs : [{ fileId, index (0-based), rot (0/90/180/270) }] dans l'ordre voulu.
export async function buildPdf(specs, bytesById, srcCache = new Map()) {
  const out = await PDFDocument.create();
  const need = new Map();
  for (const s of specs) {
    if (!need.has(s.fileId)) need.set(s.fileId, new Set());
    need.get(s.fileId).add(s.index);
  }
  const copied = new Map();
  for (const [fid, set] of need) {
    let src = srcCache.get(fid);
    if (!src) {
      src = await PDFDocument.load(bytesById.get(fid), LOAD_OPTS);
      srcCache.set(fid, src);
    }
    const idx = [...set].sort((a, b) => a - b);
    const pages = await out.copyPages(src, idx);
    const m = new Map();
    idx.forEach((i, k) => m.set(i, pages[k]));
    copied.set(fid, m);
  }
  for (const s of specs) {
    const page = copied.get(s.fileId).get(s.index);
    const rot = (((page.getRotation().angle + (s.rot || 0)) % 360) + 360) % 360;
    page.setRotation(degrees(rot));
    out.addPage(page);
  }
  out.setProducer('PDF Pop');
  out.setCreator('PDF Pop');
  return out.save();
}

// « 1-3, 4-6, 8 » -> [{label, positions:[0,1,2]}, ...] (positions 0-based)
export function parseRanges(text, max) {
  const groups = [];
  const parts = String(text).split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    let a;
    let b;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      a = +m[1];
      b = +m[2];
    } else if (/^\d+$/.test(p)) {
      a = b = +p;
    } else {
      throw new Error('Plage non reconnue : « ' + p + ' ». Exemple : 1-3, 4-6.');
    }
    if (a < 1 || b < 1 || a > max || b > max) {
      throw new Error('La plage « ' + p + ' » dépasse le nombre de pages (' + max + ').');
    }
    if (a > b) [a, b] = [b, a];
    const positions = [];
    for (let i = a; i <= b; i++) positions.push(i - 1);
    groups.push({ label: a === b ? String(a) : a + '-' + b, positions });
  }
  if (!groups.length) throw new Error('Indiquez au moins une plage, par exemple 1-3, 4-6.');
  return groups;
}

/* ---------- Annotations ---------- */

function hex2rgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Géométrie d'une page : convertit des fractions de la page affichée (origine en haut à gauche)
// en coordonnées PDF, en tenant compte de la rotation et du cadre de recadrage.
function pageGeom(page) {
  const cb = page.getCropBox ? page.getCropBox() : page.getMediaBox();
  const rot = (((page.getRotation().angle % 360) + 360) % 360);
  const W = cb.width;
  const H = cb.height;
  const swap = rot === 90 || rot === 270;
  const dw = swap ? H : W;
  const dh = swap ? W : H;
  const toUser = (fx, fy) => {
    const dx = fx * dw;
    const dy = fy * dh;
    let x;
    let y;
    if (rot === 0) { x = dx; y = H - dy; }
    else if (rot === 90) { x = dy; y = dx; }
    else if (rot === 180) { x = W - dx; y = dy; }
    else { x = W - dy; y = H - dx; }
    return { x: cb.x + x, y: cb.y + y };
  };
  return { rot, dw, dh, toUser };
}

function dataUrlToBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


const FONTS = {
  sans: { n: StandardFonts.Helvetica, b: StandardFonts.HelveticaBold, i: StandardFonts.HelveticaOblique, bi: StandardFonts.HelveticaBoldOblique },
  serif: { n: StandardFonts.TimesRoman, b: StandardFonts.TimesRomanBold, i: StandardFonts.TimesRomanItalic, bi: StandardFonts.TimesRomanBoldItalic },
  mono: { n: StandardFonts.Courier, b: StandardFonts.CourierBold, i: StandardFonts.CourierOblique, bi: StandardFonts.CourierBoldOblique },
};
const fontKey = (a) => (a.bold ? (a.italic ? 'bi' : 'b') : a.italic ? 'i' : 'n');

// Rectangle normalisé d'une annotation « boîte » (surlignage ou forme)
export function boxOf(a) {
  if (a.type === 'highlight') return { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h };
  return { x0: Math.min(a.x1, a.x2), y0: Math.min(a.y1, a.y2), x1: Math.max(a.x1, a.x2), y1: Math.max(a.y1, a.y2) };
}
export const ROUND_RATIO = 0.3; // rayon des coins = 30 % du plus petit côté (aperçu et export identiques)

export async function drawAnnots(bytes, annots) {
  const doc = await PDFDocument.load(bytes, LOAD_OPTS);
  const pages = doc.getPages();
  const fonts = new Map();
  const getFont = async (a) => {
    const k = (a.family || 'sans') + ':' + fontKey(a);
    let f = fonts.get(k);
    if (!f) {
      f = { font: await doc.embedFont((FONTS[a.family] || FONTS.sans)[fontKey(a)]), ok: new Map() };
      fonts.set(k, f);
    }
    return f;
  };
  const safe = (f, str) => {
    let out = '';
    for (const ch of str) {
      if (ch === '\n') { out += ch; continue; }
      let ok = f.ok.get(ch);
      if (ok === undefined) {
        try { f.font.encodeText(ch); ok = true; } catch (e) { ok = false; }
        f.ok.set(ch, ok);
      }
      out += ok ? ch : '?';
    }
    return out;
  };
  const imgCache = new Map();

  for (const a of annots) {
    const page = pages[a.page];
    if (!page) continue;
    const g = pageGeom(page);
    // point exprimé en points de la page affichée (origine en haut à gauche) -> coordonnées PDF
    const P = (X, Y) => g.toUser(X / g.dw, Y / g.dh);

    if (a.type === 'highlight') {
      const b = boxOf(a);
      const opts = { color: hex2rgb(a.color), opacity: a.opacity, blendMode: BlendMode.Multiply };
      const p1 = g.toUser(b.x0, b.y0);
      const p2 = g.toUser(b.x1, b.y1);
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      if (a.shape === 'ellipse') {
        page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, ...opts });
      } else if (a.shape === 'round') {
        const X0 = b.x0 * g.dw, Y0 = b.y0 * g.dh, X1 = b.x1 * g.dw, Y1 = b.y1 * g.dh;
        const r = ROUND_RATIO * Math.min(X1 - X0, Y1 - Y0);
        const pts = [];
        const arc = (cx, cy, from) => { for (let k = 0; k <= 8; k++) { const t = from + (k / 8) * (Math.PI / 2); pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); } };
        arc(X1 - r, Y0 + r, -Math.PI / 2);
        arc(X1 - r, Y1 - r, 0);
        arc(X0 + r, Y1 - r, Math.PI / 2);
        arc(X0 + r, Y0 + r, Math.PI);
        const d = pts.map(([X, Y], k) => { const u = P(X, Y); return (k ? 'L' : 'M') + u.x.toFixed(2) + ' ' + (-u.y).toFixed(2); }).join('') + 'Z';
        page.drawSvgPath(d, { x: 0, y: 0, ...opts });
      } else {
        page.drawRectangle({ x, y, width: w, height: h, ...opts });
      }
    } else if (a.type === 'draw') {
      const thickness = Math.max(0.5, a.width * g.dw);
      const color = hex2rgb(a.color);
      const pts = a.points.map(([fx, fy]) => g.toUser(fx, fy));
      if (pts.length === 1) pts.push({ x: pts[0].x + 0.01, y: pts[0].y });
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({ start: pts[i - 1], end: pts[i], thickness, color, lineCap: LineCapStyle.Round });
      }
    } else if (a.type === 'shape') {
      const thickness = Math.max(0.5, a.width * g.dw);
      const color = hex2rgb(a.color);
      if (a.kind === 'line' || a.kind === 'arrow') {
        const p1 = g.toUser(a.x1, a.y1);
        const p2 = g.toUser(a.x2, a.y2);
        page.drawLine({ start: p1, end: p2, thickness, color, lineCap: LineCapStyle.Round });
        if (a.kind === 'arrow') {
          const X1 = a.x1 * g.dw, Y1 = a.y1 * g.dh, X2 = a.x2 * g.dw, Y2 = a.y2 * g.dh;
          const th = Math.atan2(Y2 - Y1, X2 - X1);
          const L = Math.max(8, thickness * 4);
          for (const s of [-1, 1]) {
            const ang = th + Math.PI - s * 0.45;
            page.drawLine({ start: p2, end: P(X2 + L * Math.cos(ang), Y2 + L * Math.sin(ang)), thickness, color, lineCap: LineCapStyle.Round });
          }
        }
      } else {
        const b = boxOf(a);
        const p1 = g.toUser(b.x0, b.y0);
        const p2 = g.toUser(b.x1, b.y1);
        const x = Math.min(p1.x, p2.x);
        const y = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);
        const o = { borderColor: color, borderWidth: thickness };
        if (a.fill) { o.color = color; o.opacity = 0.3; o.borderOpacity = 1; }
        if (a.kind === 'ellipse') page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, ...o });
        else page.drawRectangle({ x, y, width: w, height: h, ...o });
      }
    } else if (a.type === 'text') {
      const f = await getFont(a);
      const size = Math.max(4, a.size * g.dw);
      const lines = safe(f, a.text).split('\n');
      const color = hex2rgb(a.color);
      lines.forEach((line, i) => {
        if (!line) return;
        const baseline = a.y * g.dh + size * (0.95 + 1.2 * i);
        const p = g.toUser(a.x, baseline / g.dh);
        page.drawText(line, { x: p.x, y: p.y, size, font: f.font, color, rotate: degrees(g.rot) });
        if (a.strike) {
          const wd = f.font.widthOfTextAtSize(line, size);
          const yy = (baseline - size * 0.3) / g.dh;
          page.drawLine({ start: g.toUser(a.x, yy), end: g.toUser(a.x + wd / g.dw, yy), thickness: Math.max(0.5, size * 0.06), color });
        }
      });
    } else if (a.type === 'image') {
      let img = imgCache.get(a.dataUrl);
      if (!img) {
        img = await doc.embedPng(dataUrlToBytes(a.dataUrl));
        imgCache.set(a.dataUrl, img);
      }
      const p = g.toUser(a.x, a.y + a.h);
      page.drawImage(img, { x: p.x, y: p.y, width: a.w * g.dw, height: a.h * g.dh, rotate: degrees(g.rot) });
    }
  }
  doc.setProducer('PDF Pop');
  return doc.save();
}

// Écran Annoter : texte, surlignage, dessin et formes, signature.
import { $, $$, el, clamp, clone, uid, NS, isMobile, toast, runBusy, download, baseName, isPdfFile, trackPointer } from './util.js';
import { openView, renderToCanvas, thumbQueue } from './render.js';
import { openCheck, drawAnnots, boxOf, ROUND_RATIO } from './pdfio.js';

const HL_COLORS = [['#FFE066', 'Jaune'], ['#FF8FB1', 'Rose'], ['#7EE0A8', 'Vert menthe'], ['#7CC4FF', 'Bleu ciel'], ['#FFB067', 'Orange'], ['#B79CFF', 'Violet']];
const INK_COLORS = [['#1B1740', 'Noir'], ['#1450B8', 'Bleu'], ['#E0245E', 'Rouge'], ['#0B6B3A', 'Vert'], ['#D9570B', 'Orange'], ['#6A27B8', 'Violet']];
const FONT_CSS = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};
const TOOL_INFO = {
  select: { title: 'Sélection', hint: 'Touchez un élément pour le déplacer, le modifier ou le supprimer.', dot: '#8E87B8' },
  text: { title: 'Texte', hint: 'Touchez la page pour écrire. Touchez un texte pour le modifier.', dot: '#1450B8' },
  highlight: { title: 'Surligneur', hint: 'Faites glisser sur la page pour surligner une zone.', dot: '#FFE066' },
  draw: { title: 'Dessin', hint: 'Faites glisser sur la page pour dessiner la forme choisie.', dot: '#E0245E' },
  sign: { title: 'Signature', hint: 'Touchez la page pour poser votre signature.', dot: '#0B6B3A' },
};
const KIND_LABEL = { line: 'Ligne', arrow: 'Flèche', rect: 'Rectangle', ellipse: 'Ellipse' };
const annotGroup = (a) => ({ highlight: 'highlight', text: 'text', draw: 'draw', shape: 'draw', image: 'sign' })[a.type];
const annotLabel = (a) => (a.type === 'shape' ? KIND_LABEL[a.kind] : { highlight: 'Surlignage', text: 'Texte', draw: 'Dessin libre', image: 'Signature' }[a.type]);
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const A = {
  tool: 'select',
  page: 1,
  zoom: 1,
  doc: null,
  annots: [],
  undo: [],
  redo: [],
  sel: null,
  dims: { w: 0, h: 0 },
  ptW: 595,
  renderToken: 0,
  mainHolder: {},
  signature: null,
  dirty: false,
  pushed: false,
  style: {
    text: { family: 'sans', bold: false, italic: false, strike: false, sizePt: 14, color: '#1B1740' },
    draw: { shape: 'free', widthPt: 2, color: '#E0245E', fill: false },
    highlight: { shape: 'rect', opacityPct: 45, color: '#FFE066' },
    sign: { widthPt: 160 },
  },
};
export const isDirty = () => A.dirty;
export const hasDoc = () => !!A.doc;
export const fileName = () => (A.doc ? A.doc.name : '');

/* ---------- Document ---------- */
function showDocLayout() {
  $('#docEmpty').hidden = true;
  $('#docLayout').hidden = false;
}

export async function openDocFile(file) {
  if (!file) return;
  if (!isPdfFile(file)) { toast("Ce fichier n'est pas un PDF.", 'err'); return; }
  if (A.dirty && !confirm('Ouvrir un autre PDF ? Les modifications non exportées seront perdues.')) return;
  await runBusy('Ouverture du PDF...', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let check;
    let pdf;
    try {
      check = await openCheck(bytes);
      pdf = await openView(bytes);
    } catch (e) {
      e.userMessage = e && e.name === 'PasswordException'
        ? 'Ce PDF est protégé par un mot de passe : il ne peut pas être ouvert ici.'
        : "Impossible d'ouvrir ce fichier : il est peut-être abîmé.";
      throw e;
    }
    if (A.doc) { try { A.doc.view.destroy(); } catch (e) { /* rien */ } }
    A.doc = { name: file.name, bytes, view: pdf, numPages: pdf.numPages, encrypted: check.encrypted };
    A.annots = [];
    A.undo = [];
    A.redo = [];
    A.sel = null;
    A.page = 1;
    A.zoom = 1;
    A.dirty = false;
    showDocLayout();
    buildThumbs();
    app.refreshHeader();
    updateUndoUI();
    await renderMain();
    syncPanel();
    if (check.encrypted) toast("Ce PDF est protégé : vous pouvez le lire, mais pas l'exporter avec vos modifications.", 'err');
  });
}

function buildThumbs() {
  const box = $('#thumbs');
  box.replaceChildren();
  if (buildThumbs.obs) buildThumbs.obs.disconnect();
  if (!A.doc) return;
  const pdf = A.doc.view;
  const obs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const b = en.target;
        obs.unobserve(b);
        const n = +b.dataset.page;
        thumbQueue(async () => {
          if (!A.doc || A.doc.view !== pdf) return;
          await renderToCanvas(pdf, n, b.querySelector('canvas'), { w: 92, h: 116 });
        });
      }
    },
    { root: box, rootMargin: '200px' }
  );
  buildThumbs.obs = obs;
  for (let i = 1; i <= A.doc.numPages; i++) {
    const b = el('button', { class: 'thumb', 'data-page': String(i), 'aria-label': 'Aller à la page ' + i });
    b.innerHTML = '<span class="tbox"><canvas></canvas></span><span>' + i + '</span>';
    b.addEventListener('click', () => goPage(i));
    box.append(b);
    obs.observe(b);
  }
  markThumb();
}

function markThumb() {
  $$('#thumbs .thumb').forEach((b) => {
    const cur = +b.dataset.page === A.page;
    if (cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    if (cur && !isMobile()) b.scrollIntoView({ block: 'nearest' });
  });
}

function goPage(n) {
  if (!A.doc) return;
  n = clamp(n, 1, A.doc.numPages);
  if (n === A.page) return;
  closeEditor();
  A.page = n;
  A.sel = null;
  renderMain().then(syncPanel);
}

function updatePager() {
  if (!A.doc) return;
  $('#pageLabel').textContent = 'Page ' + A.page + ' / ' + A.doc.numPages;
  $('#prevPage').disabled = A.page <= 1;
  $('#nextPage').disabled = A.page >= A.doc.numPages;
  $('#zoomLabel').textContent = Math.round(A.zoom * 100) + ' %';
  $('#zoomOut').disabled = A.zoom <= ZOOMS[0];
  $('#zoomIn').disabled = A.zoom >= ZOOMS[ZOOMS.length - 1];
  markThumb();
}

export async function renderMain() {
  if (!A.doc || $('#docLayout').hidden || $('#viewDoc').hidden) return;
  const token = ++A.renderToken;
  const sc = $('#pageScroll');
  const availW = Math.max(200, sc.clientWidth - (isMobile() ? 16 : 48));
  const availH = Math.max(200, sc.clientHeight - 120);
  const size = isMobile()
    ? Math.min(availW, 960) * A.zoom
    : { w: Math.min(availW, 960) * A.zoom, h: availH * A.zoom };
  const canvas = document.createElement('canvas');
  canvas.id = 'pageCanvas';
  let res;
  try {
    res = await renderToCanvas(A.doc.view, A.page, canvas, size, null, A.mainHolder);
  } catch (e) {
    console.error(e);
    toast("Impossible d'afficher cette page.", 'err');
    return;
  }
  if (!res || token !== A.renderToken) return;
  $('#pageCanvas').replaceWith(canvas);
  const wrap = $('#pageWrap');
  wrap.style.width = res.w + 'px';
  wrap.style.height = res.h + 'px';
  A.dims = { w: res.w, h: res.h };
  A.ptW = res.ptW;
  redrawOverlay();
  updatePager();
}

/* ---------- Annotations : affichage ---------- */
const selectedAnnot = () => A.annots.find((a) => a.id === A.sel) || null;
const nodeFor = (id) => $('#overlay [data-id="' + id + '"]');
const textCss = (a) =>
  'font-family:' + FONT_CSS[a.family || 'sans'] + ';font-weight:' + (a.bold ? 700 : 400) + ';font-style:' + (a.italic ? 'italic' : 'normal') +
  ';text-decoration:' + (a.strike ? 'line-through' : 'none') + ';';

function pathD(points, W, H) {
  if (points.length === 1) return 'M' + points[0][0] * W + ' ' + points[0][1] * H + 'l0.01 0';
  return points.map((p, i) => (i ? 'L' : 'M') + (p[0] * W).toFixed(1) + ' ' + (p[1] * H).toFixed(1)).join('');
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Éléments SVG d'une forme (réutilisés pour la zone de clic et pour le trait visible)
function shapeParts(a, W, H) {
  const px = a.width * W; // épaisseur en px
  if (a.kind === 'line' || a.kind === 'arrow') {
    const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
    if (a.kind === 'line') return [['line', { x1, y1, x2, y2 }]];
    const th = Math.atan2(y2 - y1, x2 - x1);
    const L = Math.max((8 * W) / A.ptW, px * 4);
    const b = (s) => [x2 + L * Math.cos(th + Math.PI - s * 0.45), y2 + L * Math.sin(th + Math.PI - s * 0.45)];
    const [ax, ay] = b(-1);
    const [bx, by] = b(1);
    return [['path', { d: 'M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2 + 'M' + ax + ' ' + ay + 'L' + x2 + ' ' + y2 + 'L' + bx + ' ' + by }]];
  }
  const bx = boxOf(a);
  const x = bx.x0 * W, y = bx.y0 * H, w = (bx.x1 - bx.x0) * W, h = (bx.y1 - bx.y0) * H;
  if (a.kind === 'ellipse') return [['ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 }]];
  return [['rect', { x, y, width: w, height: h }]];
}

function fillShapeNode(node, a, W, H) {
  node.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  node.replaceChildren();
  const px = Math.max(1, a.width * W);
  for (const [tag, at] of shapeParts(a, W, H)) {
    const hit = svgEl(tag, at);
    hit.setAttribute('class', 'hit');
    hit.setAttribute('stroke-width', Math.max(18, px));
    hit.style.fill = a.fill ? 'transparent' : 'none';
    hit.style.pointerEvents = a.fill ? 'all' : 'stroke';
    const ink = svgEl(tag, at);
    ink.setAttribute('class', 'ink');
    ink.setAttribute('stroke', a.color);
    ink.setAttribute('stroke-width', px);
    if (a.fill) { ink.style.fill = a.color; ink.style.fillOpacity = '0.3'; }
    node.append(hit, ink);
  }
}

function applyGeom(node, a) {
  const { w: W, h: H } = A.dims;
  if (a.type === 'draw') {
    node.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const d = pathD(a.points, W, H);
    const [hit, ink] = node.querySelectorAll('path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke-width', Math.max(18, a.width * W));
    ink.setAttribute('d', d);
    ink.setAttribute('stroke', a.color);
    ink.setAttribute('stroke-width', Math.max(1, a.width * W));
  } else if (a.type === 'shape') {
    fillShapeNode(node, a, W, H);
  } else if (a.type === 'text') {
    node.style.cssText = 'left:' + a.x * W + 'px;top:' + a.y * H + 'px;font-size:' + a.size * W + 'px;color:' + a.color + ';' + textCss(a);
  } else if (a.type === 'highlight') {
    const radius = a.shape === 'ellipse' ? '50%' : a.shape === 'round' ? ROUND_RATIO * Math.min(a.w * W, a.h * H) + 'px' : '0';
    node.style.cssText =
      'left:' + a.x * W + 'px;top:' + a.y * H + 'px;width:' + a.w * W + 'px;height:' + a.h * H + 'px;background:' + a.color +
      ';opacity:' + a.opacity + ';border-radius:' + radius;
  } else {
    node.style.cssText = 'left:' + a.x * W + 'px;top:' + a.y * H + 'px;width:' + a.w * W + 'px;height:' + a.h * H + 'px;';
  }
}

function buildAnnotEl(a) {
  let node;
  if (a.type === 'draw') {
    node = svgEl('svg', { class: 'annot-svg' });
    node.append(svgEl('path', { class: 'hit' }), svgEl('path', { class: 'ink' }));
  } else if (a.type === 'shape') {
    node = svgEl('svg', { class: 'annot-svg' });
  } else if (a.type === 'image') {
    node = new Image();
    node.className = 'annot img';
    node.src = a.dataUrl;
    node.alt = 'Signature';
    node.draggable = false;
  } else {
    node = document.createElement('div');
    node.className = 'annot ' + (a.type === 'text' ? 'text' : 'hl');
    if (a.type === 'text') node.textContent = a.text;
  }
  node.dataset.id = a.id;
  applyGeom(node, a);
  bindAnnotEl(node, a);
  return node;
}

export function redrawOverlay() {
  const ov = $('#overlay');
  ov.replaceChildren();
  ov.dataset.tool = A.tool;
  if (!A.doc) return;
  for (const a of A.annots) if (a.page === A.page - 1) ov.append(buildAnnotEl(a));
  updateSelectionClasses();
  drawHandles();
}

function updateSelectionClasses() {
  $$('#overlay [data-id]').forEach((n) => n.classList.toggle('sel', n.dataset.id === A.sel));
}

function select(id) {
  A.sel = id;
  updateSelectionClasses();
  drawHandles();
  syncPanel();
}

/* ---------- Poignées de redimensionnement ---------- */
function handlePoints(a) {
  if (a.type === 'shape' && (a.kind === 'line' || a.kind === 'arrow')) return [[a.x1, a.y1], [a.x2, a.y2]];
  if (a.type === 'highlight' || (a.type === 'shape' && (a.kind === 'rect' || a.kind === 'ellipse'))) {
    const b = boxOf(a);
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  }
  return [];
}

function drawHandles() {
  $$('#overlay .handle').forEach((h) => h.remove());
  const a = selectedAnnot();
  if (!a || a.page !== A.page - 1 || !A.doc) return;
  const pts = handlePoints(a);
  const { w: W, h: H } = A.dims;
  pts.forEach((p, i) => {
    const h = el('div', { class: 'handle', 'data-i': String(i), role: 'presentation' });
    h.style.left = p[0] * W + 'px';
    h.style.top = p[1] * H + 'px';
    h.addEventListener('pointerdown', (e) => startResize(e, a, i));
    $('#overlay').append(h);
  });
}

function placeHandles(a) {
  const pts = handlePoints(a);
  const { w: W, h: H } = A.dims;
  $$('#overlay .handle').forEach((h, i) => {
    if (!pts[i]) return;
    h.style.left = pts[i][0] * W + 'px';
    h.style.top = pts[i][1] * H + 'px';
  });
}

function relPos(e) {
  const r = $('#overlay').getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
}

function startResize(e, a, i) {
  e.preventDefault();
  e.stopPropagation();
  const isLine = a.type === 'shape' && (a.kind === 'line' || a.kind === 'arrow');
  const b0 = isLine ? null : boxOf(a);
  const corners = isLine ? null : [[b0.x0, b0.y0], [b0.x1, b0.y0], [b0.x1, b0.y1], [b0.x0, b0.y1]];
  const opp = isLine ? null : corners[(i + 2) % 4];
  let pushedOnce = false;
  trackPointer(
    e,
    (ev) => {
      const q = relPos(ev);
      if (!pushedOnce) { pushedOnce = true; pushHistory(); }
      if (isLine) {
        if (i === 0) { a.x1 = q.x; a.y1 = q.y; } else { a.x2 = q.x; a.y2 = q.y; }
      } else {
        const x0 = Math.min(opp[0], q.x), x1 = Math.max(opp[0], q.x);
        const y0 = Math.min(opp[1], q.y), y1 = Math.max(opp[1], q.y);
        if (a.type === 'highlight') { a.x = x0; a.y = y0; a.w = x1 - x0; a.h = y1 - y0; }
        else { a.x1 = x0; a.y1 = y0; a.x2 = x1; a.y2 = y1; }
      }
      const n = nodeFor(a.id);
      if (n) applyGeom(n, a);
      placeHandles(a);
    },
    () => { if (pushedOnce) markDirty(); }
  );
}

/* ---------- Historique ---------- */
function markDirty() { A.dirty = true; }

function pushHistory() {
  A.undo.push(clone(A.annots));
  if (A.undo.length > 100) A.undo.shift();
  A.redo = [];
  updateUndoUI();
}

export const canUndo = () => A.undo.length > 0;
export const canRedo = () => A.redo.length > 0;
function updateUndoUI() { app.refreshUndo(); }

export function undoAction() {
  if (!A.undo.length) return;
  closeEditor();
  A.redo.push(clone(A.annots));
  A.annots = A.undo.pop();
  A.sel = null;
  redrawOverlay();
  syncPanel();
  updateUndoUI();
}

export function redoAction() {
  if (!A.redo.length) return;
  closeEditor();
  A.undo.push(clone(A.annots));
  A.annots = A.redo.pop();
  A.sel = null;
  redrawOverlay();
  syncPanel();
  updateUndoUI();
}

function addAnnot(a, selectIt = false) {
  pushHistory();
  A.annots.push(a);
  if (selectIt) A.sel = a.id;
  markDirty();
  redrawOverlay();
  syncPanel();
}

function removeAnnot(id) {
  const i = A.annots.findIndex((a) => a.id === id);
  if (i < 0) return;
  pushHistory();
  A.annots.splice(i, 1);
  if (A.sel === id) A.sel = null;
  markDirty();
  redrawOverlay();
  syncPanel();
}

/* ---------- Interactions ---------- */
function bboxOfAnnot(a) {
  if (a.type === 'draw') {
    const xs = a.points.map((p) => p[0]);
    const ys = a.points.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  if (a.type === 'shape') return boxOf(a);
  if (a.type === 'text') return { x0: a.x, y0: a.y, x1: a.x + 0.02, y1: a.y + 0.02 };
  return { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h };
}

function moveAnnot(a, o, dx, dy) {
  const b = bboxOfAnnot(o);
  dx = clamp(dx, -b.x0, 1 - b.x1);
  dy = clamp(dy, -b.y0, 1 - b.y1);
  if (a.type === 'draw') a.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === 'shape') { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; }
  else { a.x = o.x + dx; a.y = o.y + dy; }
}

function bindAnnotEl(node, a) {
  node.addEventListener('pointerdown', (e) => {
    if (A.tool === 'text' && a.type === 'text') {
      e.preventDefault();
      e.stopPropagation();
      select(a.id);
      startTextEdit(a, false);
      return;
    }
    if (A.tool !== 'select') return;
    e.preventDefault();
    e.stopPropagation();
    select(a.id);
    const start = relPos(e);
    const orig = clone(a);
    let moved = false;
    trackPointer(
      e,
      (ev) => {
        const q = relPos(ev);
        const dx = q.x - start.x;
        const dy = q.y - start.y;
        if (!moved && Math.hypot(dx * A.dims.w, dy * A.dims.h) < 4) return;
        if (!moved) { moved = true; pushHistory(); }
        moveAnnot(a, orig, dx, dy);
        applyGeom(node, a);
        placeHandles(a);
      },
      () => { if (moved) markDirty(); }
    );
  });
  node.addEventListener('dblclick', () => {
    if (a.type === 'text' && A.tool === 'select') startTextEdit(a, false);
  });
}

function closeEditor() {
  const ta = $('#overlay .editor');
  if (ta) ta.blur();
}

function startTextEdit(a, isNew) {
  closeEditor();
  const ov = $('#overlay');
  const { w: W, h: H } = A.dims;
  const ta = el('textarea', { class: 'editor', rows: '1', 'aria-label': 'Texte à ajouter' });
  ta.value = a.text;
  const width = Math.max(160, Math.min(W * (1 - a.x) - 4, 360));
  ta.style.cssText = 'left:' + a.x * W + 'px;top:' + a.y * H + 'px;width:' + width + 'px;font-size:' + a.size * W + 'px;color:' + a.color + ';' + textCss(a);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  const old = isNew ? null : nodeFor(a.id);
  if (old) old.style.visibility = 'hidden';
  ov.append(ta);
  autosize();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    if (commit && text.trim()) {
      if (isNew) { pushHistory(); a.text = text; A.annots.push(a); A.sel = a.id; markDirty(); }
      else if (text !== a.text) { pushHistory(); a.text = text; markDirty(); }
    } else if (commit && !isNew) {
      pushHistory();
      A.annots = A.annots.filter((x) => x.id !== a.id);
      if (A.sel === a.id) A.sel = null;
      markDirty();
    }
    redrawOverlay();
    syncPanel();
  };
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
  });
  ta.addEventListener('input', autosize);
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
}

function simplify(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot((points[i][0] - l[0]) * A.dims.w, (points[i][1] - l[1]) * A.dims.h) >= 1.5) out.push(points[i]);
  }
  if (points.length > 1) out.push(points[points.length - 1]);
  return out;
}

function placeSignature(p) {
  if (!A.signature) { openSignature(() => placeSignature(p)); return; }
  const { w: W, h: H } = A.dims;
  const w = clamp(A.style.sign.widthPt / A.ptW, 0.05, 1);
  const h = (w * W * A.signature.ratio) / H;
  addAnnot({
    id: uid(), page: A.page - 1, type: 'image',
    x: clamp(p.x - w / 2, 0, 1 - w), y: clamp(p.y - h / 2, 0, Math.max(0, 1 - h)),
    w, h, ratio: A.signature.ratio, dataUrl: A.signature.dataUrl,
  });
}

function dragCreate(e, p, make, isBigEnough, onDone) {
  const ov = $('#overlay');
  const temp = { ...make(p, p), id: 'temp' };
  const node = buildAnnotEl(temp);
  node.style.pointerEvents = 'none';
  ov.append(node);
  let cur = p;
  trackPointer(
    e,
    (ev) => {
      cur = relPos(ev);
      Object.assign(temp, make(p, cur));
      applyGeom(node, temp);
    },
    () => {
      node.remove();
      const final = make(p, cur);
      if (isBigEnough(final)) onDone(final);
    }
  );
}

function initOverlay() {
  const ov = $('#overlay');
  ov.addEventListener('pointerdown', (e) => {
    if (!A.doc) return;
    if (e.target.closest('.editor') || e.target.closest('.handle')) return;
    if (A.tool === 'select') { if (e.target === ov) select(null); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (A.sel) { A.sel = null; updateSelectionClasses(); drawHandles(); syncPanel(); }
    const p = relPos(e);
    const { w: W, h: H } = A.dims;

    if (A.tool === 'text') {
      const st = A.style.text;
      startTextEdit({
        id: uid(), page: A.page - 1, type: 'text', x: p.x, y: p.y, text: '',
        size: st.sizePt / A.ptW, color: st.color, family: st.family, bold: st.bold, italic: st.italic, strike: st.strike,
      }, true);
    } else if (A.tool === 'sign') {
      placeSignature(p);
    } else if (A.tool === 'highlight') {
      const st = A.style.highlight;
      dragCreate(
        e, p,
        (a, b) => ({ type: 'highlight', page: A.page - 1, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), shape: st.shape, color: st.color, opacity: st.opacityPct / 100 }),
        (r) => r.w * W > 6 && r.h * H > 4,
        (r) => addAnnot({ ...r, id: uid() })
      );
    } else if (A.tool === 'draw') {
      const st = A.style.draw;
      if (st.shape === 'free') {
        const pts = [[p.x, p.y]];
        const svg = svgEl('svg', { class: 'annot-svg', viewBox: '0 0 ' + W + ' ' + H });
        const ink = svgEl('path', { class: 'ink', stroke: st.color, 'stroke-width': Math.max(1, (st.widthPt / A.ptW) * W) });
        svg.append(ink);
        ov.append(svg);
        const upd = () => ink.setAttribute('d', pathD(pts, W, H));
        upd();
        trackPointer(e, (ev) => { const q = relPos(ev); pts.push([q.x, q.y]); upd(); }, () => {
          svg.remove();
          addAnnot({ id: uid(), page: A.page - 1, type: 'draw', points: simplify(pts), color: st.color, width: st.widthPt / A.ptW });
        });
      } else {
        const isLine = st.shape === 'line' || st.shape === 'arrow';
        dragCreate(
          e, p,
          (a, b) => ({ type: 'shape', page: A.page - 1, kind: st.shape, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: st.color, width: st.widthPt / A.ptW, fill: !isLine && st.fill }),
          (s) => (isLine ? Math.hypot((s.x2 - s.x1) * W, (s.y2 - s.y1) * H) > 8 : Math.abs(s.x2 - s.x1) * W > 6 && Math.abs(s.y2 - s.y1) * H > 6),
          (s) => { addAnnot({ ...s, id: uid() }, true); setTool('select'); }
        );
      }
    }
  });
}

/* ---------- Outils et panneau ---------- */
export function setTool(t) {
  closeEditor();
  A.tool = t;
  const cur = selectedAnnot();
  if (t !== 'select' && !(t === 'text' && cur && cur.type === 'text')) A.sel = null;
  $$('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  $('#overlay').dataset.tool = t;
  updateSelectionClasses();
  drawHandles();
  syncPanel();
  if (t === 'sign' && !A.signature && A.doc) openSignature(() => toast('Signature enregistrée. Touchez la page pour la poser.', 'ok'));
}

function activeGroup() {
  const a = selectedAnnot();
  if (a) return annotGroup(a);
  return A.tool === 'select' ? null : A.tool;
}

// Valeur affichée dans le panneau : celle de l'élément sélectionné, sinon le réglage par défaut de l'outil
function val(g, key) {
  const a = selectedAnnot();
  if (a && annotGroup(a) === g) {
    if (g === 'text') return key === 'sizePt' ? a.size * A.ptW : a[key];
    if (g === 'draw') return key === 'widthPt' ? a.width * A.ptW : key === 'fill' ? !!a.fill : a[key];
    if (g === 'highlight') return key === 'opacityPct' ? a.opacity * 100 : a[key];
    if (g === 'sign') return a.w * A.ptW;
  }
  return A.style[g][key];
}

function setVal(g, key, v) {
  if (!(g === 'text' && key === 'strike')) A.style[g][key] = v; // le barré ne devient pas le réglage des prochains textes
  const a = selectedAnnot();
  if (!a || annotGroup(a) !== g) return;
  if (!A.pushed) { pushHistory(); A.pushed = true; clearTimeout(setVal.t); }
  clearTimeout(setVal.t);
  setVal.t = setTimeout(() => { A.pushed = false; }, 900);
  if (g === 'text') { if (key === 'sizePt') a.size = v / A.ptW; else a[key] = v; }
  else if (g === 'draw') { if (key === 'widthPt') a.width = v / A.ptW; else if (key === 'fill') { if (a.type === 'shape') a.fill = v; } else if (key !== 'shape') a[key] = v; }
  else if (g === 'highlight') { if (key === 'opacityPct') a.opacity = v / 100; else a[key] = v; }
  else if (g === 'sign') {
    const { w: W, h: H } = A.dims;
    a.w = clamp(v / A.ptW, 0.03, 1);
    a.h = (a.w * W * a.ratio) / H;
    a.x = clamp(a.x, 0, 1 - a.w);
    a.y = clamp(a.y, 0, Math.max(0, 1 - a.h));
  }
  markDirty();
  const n = nodeFor(a.id);
  if (n) applyGeom(n, a);
  placeHandles(a);
}

const ICONS = {
  bold: 'M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z',
  italic: 'M11 5h6M7 19h6M14 5l-4 14',
  strike: 'M5 12h14M16 6.5C15 5.5 13.6 5 12 5c-2.2 0-4 1-4 3 0 1.3.8 2 2 2.5M8 17.5c1 1 2.4 1.5 4 1.5 2.2 0 4-1 4-3',
  free: 'M3 15c3-8 5-8 6-3s3 5 5 0 4-5 7 1',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M10 5h9v9',
  rect: 'M4 6h16v12H4z',
  round: 'M9 6h6a5 5 0 015 5v2a5 5 0 01-5 5H9a5 5 0 01-5-5v-2a5 5 0 015-5z',
  ellipse: 'M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z',
};
const svgIcon = (d) => '<svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';

function section(label, ...nodes) {
  const d = el('div', { class: 'ctl' });
  d.append(el('span', { class: 'lbl' }, label), ...nodes);
  return d;
}

function chipRow(g, key, items, cur) {
  const row = el('div', { class: 'chips', role: 'group' });
  for (const [v, label, icon, css] of items) {
    const b = el('button', { class: 'chipbtn', 'aria-pressed': String(v === cur), 'data-key': g + key + v });
    b.innerHTML = (icon ? svgIcon(ICONS[icon]) : '') + '<span></span>';
    b.lastChild.textContent = label;
    if (css) b.lastChild.style.cssText = css;
    b.addEventListener('click', () => { setVal(g, key, v); syncPanel(); });
    row.append(b);
  }
  return row;
}

function toggleRow(g, items) {
  const row = el('div', { class: 'chips', role: 'group' });
  for (const [key, label, icon] of items) {
    const on = !!val(g, key);
    const b = el('button', { class: 'chipbtn tog', 'aria-pressed': String(on), 'aria-label': label, 'data-key': g + key });
    b.innerHTML = svgIcon(ICONS[icon]) + '<span></span>';
    b.lastChild.textContent = label;
    b.addEventListener('click', () => { setVal(g, key, !on); syncPanel(); });
    row.append(b);
  }
  return row;
}

function stepper(g, key, { min, max, step, unit, hint }) {
  const dec = step < 1 ? 1 : 0;
  const cur = +(+val(g, key)).toFixed(dec);
  const wrap = el('div', { class: 'stepper' });
  const commit = (v) => {
    v = clamp(Math.round(v / step) * step, min, max);
    setVal(g, key, +v.toFixed(dec));
    syncPanel();
  };
  const minus = el('button', { class: 'sbtn', 'aria-label': 'Diminuer', 'data-key': g + key + '-' });
  minus.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  const plus = el('button', { class: 'sbtn', 'aria-label': 'Augmenter', 'data-key': g + key + '+' });
  plus.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const input = el('input', { type: 'text', inputmode: 'decimal', value: String(cur).replace('.', ','), 'aria-label': unit ? '(' + unit + ')' : 'Valeur', 'data-key': g + key });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', () => {
    const n = parseFloat(input.value.replace(',', '.'));
    if (Number.isFinite(n)) commit(n); else syncPanel();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  minus.addEventListener('click', () => commit(cur - step));
  plus.addEventListener('click', () => commit(cur + step));
  const mid = el('div', { class: 'sval' });
  mid.append(input, el('span', { class: 'unit' }, unit));
  wrap.append(minus, mid, plus);
  return { wrap, hint };
}

function stepperSection(label, g, key, opts) {
  const { wrap, hint } = stepper(g, key, opts);
  const d = section(label, wrap);
  if (hint) d.append(el('span', { class: 'hint' }, hint));
  return d;
}

function swatchSection(g, key) {
  const box = el('div', { class: 'swatches' });
  const cur = String(val(g, key)).toLowerCase();
  for (const [hex, name] of g === 'highlight' ? HL_COLORS : INK_COLORS) {
    const b = el('button', { class: 'sw', 'aria-label': name, 'aria-pressed': String(hex.toLowerCase() === cur), 'data-key': g + 'c' + hex });
    b.style.background = hex;
    b.addEventListener('click', () => { setVal(g, key, hex); syncPanel(); });
    box.append(b);
  }
  return section('Couleur', box);
}

export function syncPanel() {
  const box = $('#ctlBox');
  if (!box) return;
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  const a = selectedAnnot();
  const g = activeGroup();
  const info = TOOL_INFO[A.tool];
  $('#toolTitle').textContent = a ? annotLabel(a) + ' sélectionné' : info.title;
  $('#toolHint').textContent = info.hint;
  $('#toolDot').style.background = a ? (a.color || '#0B6B3A') : info.dot;
  box.replaceChildren();

  if (g === 'text') {
    box.append(
      section('Police', chipRow('text', 'family', [['sans', 'Sans', null, 'font-family:' + FONT_CSS.sans], ['serif', 'Serif', null, 'font-family:' + FONT_CSS.serif], ['mono', 'Machine', null, 'font-family:' + FONT_CSS.mono]], val('text', 'family'))),
      section('Style', toggleRow('text', [['bold', 'Gras', 'bold'], ['italic', 'Italique', 'italic'], ['strike', 'Barré', 'strike']])),
      stepperSection('Taille', 'text', 'sizePt', { min: 6, max: 120, step: 1, unit: 'pt', hint: 'Un texte de courrier courant fait 11 à 12 pt.' }),
      swatchSection('text', 'color')
    );
  } else if (g === 'draw') {
    const kind = a ? (a.type === 'shape' ? a.kind : 'free') : A.style.draw.shape;
    if (!a) {
      box.append(section('Forme', chipRow('draw', 'shape', [['free', 'Libre', 'free'], ['line', 'Ligne', 'line'], ['arrow', 'Flèche', 'arrow'], ['rect', 'Rectangle', 'rect'], ['ellipse', 'Ellipse', 'ellipse']], A.style.draw.shape)));
    }
    box.append(stepperSection('Épaisseur du trait', 'draw', 'widthPt', { min: 0.5, max: 30, step: 0.5, unit: 'pt' }), swatchSection('draw', 'color'));
    if (kind === 'rect' || kind === 'ellipse') {
      box.append(section('Remplissage', chipRow('draw', 'fill', [[false, 'Aucun'], [true, 'Couleur']], !!val('draw', 'fill'))));
    }
  } else if (g === 'highlight') {
    box.append(
      section('Forme', chipRow('highlight', 'shape', [['rect', 'Rectangle', 'rect'], ['round', 'Arrondi', 'round'], ['ellipse', 'Ellipse', 'ellipse']], val('highlight', 'shape'))),
      stepperSection('Opacité', 'highlight', 'opacityPct', { min: 5, max: 100, step: 5, unit: '%', hint: 'Le texte du document reste lisible sous la couleur.' }),
      swatchSection('highlight', 'color')
    );
  } else if (g === 'sign') {
    box.append(stepperSection('Largeur de la signature', 'sign', 'widthPt', { min: 20, max: 500, step: 10, unit: 'pt' }));
    if (!a) {
      const row = el('div', { class: 'ctl row' });
      const r1 = el('button', { class: 'btn ghost' }, 'Refaire ma signature');
      const r2 = el('button', { class: 'btn ghost' }, 'Oublier ma signature');
      r1.addEventListener('click', () => openSignature(() => toast('Signature enregistrée. Touchez la page pour la poser.', 'ok')));
      r2.addEventListener('click', () => {
        A.signature = null;
        try { localStorage.removeItem('pdfpop.signature'); } catch (e) { /* rien */ }
        toast('Signature supprimée de cet appareil.', 'ok');
      });
      row.append(r1, r2);
      box.append(row);
    }
  }
  $('#delBtn').hidden = !a;

  const list = $('#annotList');
  list.replaceChildren();
  const items = A.annots.filter((x) => x.page === A.page - 1);
  if (!items.length) list.append(el('p', { class: 'hint' }, 'Aucune annotation sur cette page.'));
  for (const x of items) {
    const b = el('button', { class: 'arow', 'aria-pressed': String(x.id === A.sel) });
    const dot = document.createElement('i');
    dot.style.background = x.color || '#0B6B3A';
    const label = el('span', {}, annotLabel(x) + (x.type === 'text' ? ' : ' + x.text.replace(/\s+/g, ' ').slice(0, 24) : ''));
    b.append(dot, label);
    b.addEventListener('click', () => { if (A.tool !== 'select') setTool('select'); select(x.id); });
    list.append(b);
  }
  if (focusKey) {
    const again = [...box.querySelectorAll('[data-key]')].find((n) => n.dataset.key === focusKey);
    if (again) again.focus({ preventScroll: true });
  }
}

/* ---------- Signature ---------- */
function openSignature(onDone) {
  const dlg = $('#sigDialog');
  const cv = $('#sigCanvas');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  ctx.fillStyle = '#111827';
  ctx.lineWidth = 6;
  let drawing = false;
  let last = null;
  let any = false;
  const ac = new AbortController();
  const o = { signal: ac.signal };
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
    ctx.fill();
    any = true;
  }, o);
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }, o);
  const stop = () => { drawing = false; };
  cv.addEventListener('pointerup', stop, o);
  cv.addEventListener('pointercancel', stop, o);
  $('#sigClear').addEventListener('click', () => { ctx.clearRect(0, 0, cv.width, cv.height); any = false; }, o);
  $('#sigCancel').addEventListener('click', () => dlg.close(), o);
  $('#sigOk').addEventListener('click', () => {
    if (!any) { toast("Tracez d'abord votre signature.", 'err'); return; }
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let minX = cv.width, minY = cv.height, maxX = 0, maxY = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (data[(y * cv.width + x) * 4 + 3] > 20) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(cv.width - 1, maxX + pad); maxY = Math.min(cv.height - 1, maxY + pad);
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(cv, minX, minY, w, h, 0, 0, w, h);
    A.signature = { dataUrl: out.toDataURL('image/png'), ratio: h / w };
    try { localStorage.setItem('pdfpop.signature', JSON.stringify(A.signature)); } catch (e) { /* stockage indisponible */ }
    dlg.close();
    if (onDone) onDone();
  }, o);
  dlg.addEventListener('close', () => ac.abort(), { once: true });
  dlg.showModal();
}

/* ---------- Export ---------- */
export async function exportDoc() {
  if (!A.doc) return;
  if (A.doc.encrypted) { toast("Ce PDF est protégé : l'export est impossible.", 'err'); return; }
  closeEditor();
  if (!A.annots.length) { toast('Rien à exporter : ajoutez d’abord une annotation.'); return; }
  await runBusy('Export en cours...', async () => {
    const bytes = await drawAnnots(A.doc.bytes, A.annots);
    download(bytes, baseName(A.doc.name) + '-annote.pdf');
    A.dirty = false;
    toast('PDF exporté avec vos annotations. L’original n’est pas modifié.', 'ok');
  });
}

/* ---------- Branchement ---------- */
let app = { refreshHeader() {}, refreshUndo() {} };
export function initAnnoter(hooks) {
  app = hooks;
  try {
    const raw = localStorage.getItem('pdfpop.signature');
    if (raw) { const s = JSON.parse(raw); if (s && s.dataUrl && s.ratio) A.signature = s; }
  } catch (e) { /* rien */ }
  initOverlay();
  $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#docPick').addEventListener('click', () => $('#docInput').click());
  $('#docInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; openDocFile(f); });
  $('#prevPage').addEventListener('click', () => goPage(A.page - 1));
  $('#nextPage').addEventListener('click', () => goPage(A.page + 1));
  $('#zoomIn').addEventListener('click', () => { const z = ZOOMS.find((v) => v > A.zoom + 0.001); if (z) { A.zoom = z; renderMain(); } });
  $('#zoomOut').addEventListener('click', () => { const z = [...ZOOMS].reverse().find((v) => v < A.zoom - 0.001); if (z) { A.zoom = z; renderMain(); } });
  $('#delBtn').addEventListener('click', () => { if (A.sel) removeAnnot(A.sel); });
  $('#panelToggle').addEventListener('click', () => {
    const p = $('#panel');
    const c = p.classList.toggle('collapsed');
    $('#panelToggle').setAttribute('aria-expanded', String(!c));
  });
  setTool('select');
}

export function deleteSelected() { if (A.sel) { removeAnnot(A.sel); return true; } return false; }
export function escapeSelection() { if (A.sel) { select(null); return true; } return false; }

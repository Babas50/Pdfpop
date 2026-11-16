// Écran Assembler : Fusionner, Diviser, Extraire (un écran par tâche).
import { $, $$, el, clamp, uid, toast, runBusy, download, baseName, isPdfFile } from './util.js';
import { openView, renderToCanvas, thumbQueue } from './render.js';
import { openCheck, buildPdf, parseRanges } from './pdfio.js';
import { makeZip } from './zip.js';

const FILE_COLORS = ['#5B3DF5', '#0A7C8C', '#D9570B', '#E0245E', '#0B6B3A', '#1450B8'];
const mk = () => ({ files: [], pages: [], undo: [], redo: [], colorIdx: 0, letterIdx: 0, dirty: false });
const M = { task: 'fusion', fusion: mk(), diviser: mk(), extraire: mk(), nodes: new Map(), dragId: null, divMode: 'every', divEvery: 4, divRanges: '', fusionNameTouched: false };
const FILES = new Map();
const cur = () => M[M.task];
const PREFIX = { fusion: 'f', diviser: 'd', extraire: 'e' };

export const isDirty = () => M.fusion.dirty || M.diviser.dirty || M.extraire.dirty;
export const canUndo = () => M.task === 'fusion' && M.fusion.undo.length > 0;
export const canRedo = () => M.task === 'fusion' && M.fusion.redo.length > 0;

const letterFor = (n) => {
  let s = '';
  n++;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const bytesMap = (st) => new Map(st.files.map((f) => [f.id, f.bytes]));
const specsOf = (pages) => pages.map((p) => ({ fileId: p.fileId, index: p.index, rot: p.rot }));
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);

// [2,3,7] -> « 2-3 et 7 »
function describePages(nums) {
  const parts = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? nums[i] + '-' + nums[j] : String(nums[i]));
    i = j + 1;
  }
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' et ' + parts[parts.length - 1];
}

/* ---------- Fichiers ---------- */
function resetTask(k) {
  const st = M[k];
  for (const f of st.files) { try { f.pdf.destroy(); } catch (e) { /* rien */ } FILES.delete(f.id); }
  for (const p of st.pages) { const n = M.nodes.get(p.id); if (n) { n.remove(); M.nodes.delete(p.id); } }
  M[k] = mk();
}

export async function addFiles(list, k = M.task) {
  let files = [...list].filter(isPdfFile);
  if (!files.length) { toast('Aucun PDF dans la sélection.', 'err'); return; }
  if (k !== 'fusion') files = files.slice(0, 1);
  await runBusy('Lecture des fichiers...', async () => {
    let st = M[k];
    let added = 0;
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const chk = await openCheck(bytes);
        if (chk.encrypted) { toast('« ' + f.name + ' » est protégé ou chiffré : il ne peut pas être traité ici.', 'err'); continue; }
        const pdf = await openView(bytes);
        if (k !== 'fusion') { resetTask(k); st = M[k]; }
        const file = {
          id: uid(), name: f.name, bytes, pdf, n: pdf.numPages,
          color: FILE_COLORS[st.colorIdx++ % FILE_COLORS.length], letter: letterFor(st.letterIdx++),
        };
        FILES.set(file.id, file);
        st.files.push(file);
        for (let i = 0; i < pdf.numPages; i++) st.pages.push({ id: uid(), fileId: file.id, index: i, rot: 0, sel: false });
        added++;
      } catch (e) {
        console.error(e);
        toast(e && e.name === 'PasswordException' ? '« ' + f.name + ' » demande un mot de passe : non pris en charge.' : '« ' + f.name + ' » est illisible.', 'err');
      }
    }
    if (added) {
      st.undo = [];
      st.redo = [];
      st.dirty = k === 'fusion';
      if (k === 'diviser') M.divRanges = '';
    }
    renderAll();
    app.refreshUndo();
  });
}

function removeFile(id) {
  const st = M.fusion;
  const f = FILES.get(id);
  if (!f) return;
  for (const p of st.pages.filter((p) => p.fileId === id)) { const n = M.nodes.get(p.id); if (n) { n.remove(); M.nodes.delete(p.id); } }
  st.pages = st.pages.filter((p) => p.fileId !== id);
  try { f.pdf.destroy(); } catch (e) { /* rien */ }
  FILES.delete(id);
  st.files = st.files.filter((x) => x.id !== id);
  st.undo = [];
  st.redo = [];
  renderAll();
  app.refreshUndo();
}

const snap = (st) => st.pages.map((p) => ({ ...p }));
function pushHistory(st) {
  st.undo.push(snap(st));
  if (st.undo.length > 100) st.undo.shift();
  st.redo = [];
  st.dirty = true;
  app.refreshUndo();
}
export function undoAction() {
  const st = M.fusion;
  if (!st.undo.length) return;
  st.redo.push(snap(st));
  st.pages = st.undo.pop();
  renderAll();
  app.refreshUndo();
}
export function redoAction() {
  const st = M.fusion;
  if (!st.redo.length) return;
  st.undo.push(snap(st));
  st.pages = st.redo.pop();
  renderAll();
  app.refreshUndo();
}

// Déplace un fichier entier (bloc de pages) d'un cran vers le haut ou le bas
function moveFile(id, dir) {
  const st = M.fusion;
  const i = st.files.findIndex((f) => f.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= st.files.length) return;
  pushHistory(st);
  const mine = st.pages.filter((p) => p.fileId === id);
  const rest = st.pages.filter((p) => p.fileId !== id);
  const other = st.files[j].id;
  if (dir < 0) {
    const at = rest.findIndex((p) => p.fileId === other);
    rest.splice(at, 0, ...mine);
  } else {
    let at = -1;
    rest.forEach((p, n) => { if (p.fileId === other) at = n; });
    rest.splice(at + 1, 0, ...mine);
  }
  st.pages = rest;
  [st.files[i], st.files[j]] = [st.files[j], st.files[i]];
  renderAll();
}

/* ---------- Grille de pages ---------- */
let observer;
function ensureObserver() {
  if (observer) return;
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        en.target._vis = en.isIntersecting;
        if (en.isIntersecting) renderThumb(en.target);
      }
    },
    { rootMargin: '300px' }
  );
}

function renderThumb(node) {
  const p = node._page;
  if (!p || node._queuedRot === p.rot) return;
  node._queuedRot = p.rot;
  const rot = p.rot;
  thumbQueue(async () => {
    if (!node.isConnected) { node._queuedRot = undefined; return; }
    const f = FILES.get(p.fileId);
    if (!f) return;
    await renderToCanvas(f.pdf, p.index + 1, node.querySelector('canvas'), { w: 112, h: 132 }, rot);
  });
}

function makePageNode(p, k) {
  const f = FILES.get(p.fileId);
  const reorder = k === 'fusion';
  const node = el('div', { class: 'pg', tabindex: '0', role: 'button', 'data-id': p.id });
  if (reorder) node.setAttribute('draggable', 'true');
  node.style.setProperty('--c', f.color);
  node.innerHTML =
    '<span class="pg-pos"></span><div class="pg-thumb"><canvas></canvas></div><span class="pg-label"></span>' +
    '<span class="pg-check" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span>';
  node._page = p;
  const toggle = () => { p.sel = !p.sel; updateBars(); };
  node.addEventListener('click', toggle);
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  if (reorder) {
    node.addEventListener('dragstart', (e) => {
      M.dragId = p.id;
      node.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
    });
    node.addEventListener('dragend', () => {
      M.dragId = null;
      $$('.pg').forEach((n) => n.classList.remove('dragging', 'over-before', 'over-after'));
    });
    node.addEventListener('dragover', (e) => {
      if (!M.dragId || M.dragId === p.id) return;
      e.preventDefault();
      const r = node.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      node.classList.toggle('over-before', before);
      node.classList.toggle('over-after', !before);
    });
    node.addEventListener('dragleave', () => node.classList.remove('over-before', 'over-after'));
    node.addEventListener('drop', (e) => {
      if (!M.dragId || M.dragId === p.id) return;
      e.preventDefault();
      const r = node.getBoundingClientRect();
      movePage(M.dragId, p.id, e.clientX < r.left + r.width / 2);
    });
  }
  ensureObserver();
  observer.observe(node);
  return node;
}

function updatePageNode(node, p, st) {
  const f = FILES.get(p.fileId);
  const pos = st.pages.indexOf(p) + 1;
  node.querySelector('.pg-pos').textContent = pos;
  node.querySelector('.pg-label').textContent = (st.files.length > 1 ? f.letter + ' · ' : 'Page ') + (p.index + 1);
  node.setAttribute('aria-pressed', String(!!p.sel));
  node.setAttribute('aria-label', 'Page ' + (p.index + 1) + ' de ' + f.name + ', position ' + pos);
}

function syncGrid(k) {
  const st = M[k];
  const grid = $('#' + PREFIX[k] + 'Grid');
  if (!grid) return;
  const seen = new Set();
  st.pages.forEach((p) => {
    let node = M.nodes.get(p.id);
    if (!node) { node = makePageNode(p, k); M.nodes.set(p.id, node); }
    node._page = p;
    seen.add(p.id);
    updatePageNode(node, p, st);
    grid.append(node);
    if (node._vis) renderThumb(node);
  });
  for (const n of [...grid.children]) {
    if (!seen.has(n.dataset.id)) { if (observer) observer.unobserve(n); n.remove(); M.nodes.delete(n.dataset.id); }
  }
}

function movePage(id, targetId, before) {
  const st = M.fusion;
  const from = st.pages.findIndex((p) => p.id === id);
  if (from < 0) return;
  pushHistory(st);
  const [p] = st.pages.splice(from, 1);
  let to = st.pages.findIndex((x) => x.id === targetId);
  if (!before) to++;
  st.pages.splice(to, 0, p);
  renderAll();
}

function moveSelected(dir) {
  const a = M.fusion.pages;
  if (!a.some((p) => p.sel)) return;
  pushHistory(M.fusion);
  if (dir < 0) {
    for (let i = 1; i < a.length; i++) if (a[i].sel && !a[i - 1].sel) [a[i - 1], a[i]] = [a[i], a[i - 1]];
  } else {
    for (let i = a.length - 2; i >= 0; i--) if (a[i].sel && !a[i + 1].sel) [a[i + 1], a[i]] = [a[i], a[i + 1]];
  }
  renderAll();
}

function rotateSelected() {
  const st = M.fusion;
  if (!st.pages.some((p) => p.sel)) return;
  pushHistory(st);
  st.pages.forEach((p) => { if (p.sel) p.rot = (p.rot + 90) % 360; });
  renderAll();
}

function deleteSelected() {
  const st = M.fusion;
  if (!st.pages.some((p) => p.sel)) return;
  pushHistory(st);
  st.pages = st.pages.filter((p) => !p.sel);
  toast('Pages supprimées. Le bouton Annuler (en haut) les rétablit.');
  renderAll();
}

/* ---------- Rendu des trois écrans ---------- */
function fileCard(f, count, extra) {
  const d = el('div', { class: 'fitem' });
  d.style.setProperty('--c', f.color);
  d.innerHTML = '<div class="meta"><div class="nm"></div><div class="ct"></div></div>';
  d.querySelector('.nm').textContent = f.name;
  d.querySelector('.nm').title = f.name;
  d.querySelector('.ct').textContent = plural(count, 'page', 'pages');
  if (extra) for (const n of extra) d.append(n);
  return d;
}

function renderFusion() {
  const st = M.fusion;
  const has = st.files.length > 0;
  $('#fEmpty').hidden = has;
  $('#fCols').hidden = !has;
  $('#fBar').hidden = !has;
  if (!has) return;
  const fl = $('#fFiles');
  fl.replaceChildren();
  st.files.forEach((f, i) => {
    const count = st.pages.filter((p) => p.fileId === f.id).length;
    const up = el('button', { 'aria-label': 'Monter ' + f.name, class: 'mini' }, '↑');
    const dn = el('button', { 'aria-label': 'Descendre ' + f.name, class: 'mini' }, '↓');
    const rm = el('button', { 'aria-label': 'Retirer ' + f.name, class: 'mini' }, '×');
    up.disabled = i === 0;
    dn.disabled = i === st.files.length - 1;
    up.addEventListener('click', () => moveFile(f.id, -1));
    dn.addEventListener('click', () => moveFile(f.id, 1));
    rm.addEventListener('click', () => removeFile(f.id));
    fl.append(fileCard(f, count, [up, dn, rm]));
  });
  if (!M.fusionNameTouched) $('#fName').value = st.files.length === 1 ? baseName(st.files[0].name) + '-modifie.pdf' : 'Document-fusionne.pdf';
  syncGrid('fusion');
}

function divGroups() {
  const st = M.diviser;
  const n = st.pages.length;
  if (!n) return { groups: [], error: '' };
  try {
    if (M.divMode === 'each') {
      return { groups: st.pages.map((_, i) => ({ label: 'page-' + (i + 1), positions: [i] })), error: '' };
    }
    if (M.divMode === 'every') {
      const k = clamp(M.divEvery | 0, 1, n);
      const groups = [];
      for (let a = 0; a < n; a += k) {
        const b = Math.min(n, a + k);
        groups.push({ label: b - a === 1 ? 'page-' + (a + 1) : 'pages-' + (a + 1) + '-' + b, positions: Array.from({ length: b - a }, (_, i) => a + i) });
      }
      return { groups, error: '' };
    }
    const groups = parseRanges(M.divRanges, n).map((g) => ({ ...g, label: g.positions.length === 1 ? 'page-' + g.label : 'pages-' + g.label }));
    return { groups, error: '' };
  } catch (e) {
    return { groups: [], error: M.divRanges.trim() ? e.message : 'Indiquez au moins une plage, par exemple 1-3, 4-8.' };
  }
}

const groupText = (g) => (g.positions.length === 1 ? String(g.positions[0] + 1) : g.positions[0] + 1 + '-' + (g.positions[g.positions.length - 1] + 1));

function renderDiviser() {
  const st = M.diviser;
  const has = st.files.length > 0;
  $('#dEmpty').hidden = has;
  $('#dCols').hidden = !has;
  $('#dBar').hidden = !has;
  if (!has) return;
  const box = $('#dFile');
  box.replaceChildren(fileCard(st.files[0], st.pages.length));
  $$('input[name="dmode"]').forEach((r) => { r.checked = r.value === M.divMode; });
  $$('.opt').forEach((o) => o.classList.toggle('on', o.querySelector('input').checked));
  $('#dEveryRow').hidden = M.divMode !== 'every';
  $('#dRangesRow').hidden = M.divMode !== 'ranges';
  $('#dEvery').value = String(M.divEvery);
  const { groups, error } = divGroups();
  const pv = $('#dPreview');
  pv.replaceChildren();
  if (error) pv.append(el('p', { class: 'errtxt' }, error));
  groups.forEach((g, i) => {
    const c = el('span', { class: 'gchip' });
    c.style.setProperty('--c', FILE_COLORS[i % FILE_COLORS.length]);
    c.textContent = 'Fichier ' + (i + 1) + ' : page' + (g.positions.length > 1 ? 's ' : ' ') + groupText(g);
    pv.append(c);
  });
}

function renderExtraire() {
  const st = M.extraire;
  const has = st.files.length > 0;
  $('#eEmpty').hidden = has;
  $('#eCols').hidden = !has;
  $('#eBar').hidden = !has;
  if (!has) return;
  $('#eFile').replaceChildren(fileCard(st.files[0], st.pages.length));
  syncGrid('extraire');
}

function updateBars() {
  // Fusionner
  const f = M.fusion;
  const fp = f.pages.length;
  const sel = f.pages.filter((p) => p.sel).length;
  $('#fSelInfo').textContent = sel ? plural(sel, 'page sélectionnée', 'pages sélectionnées') : 'Touchez une page pour la sélectionner';
  for (const id of ['fLeft', 'fRight', 'fRot', 'fDel']) $('#' + id).disabled = sel === 0;
  const runs = [];
  for (const p of f.pages) {
    const nm = baseName(FILES.get(p.fileId).name);
    if (!runs.length || runs[runs.length - 1].id !== p.fileId) runs.push({ id: p.fileId, nm });
  }
  $('#fCap').textContent = !fp
    ? 'Ajoutez au moins une page pour créer un PDF.'
    : runs.length <= 4
      ? 'Ce bouton crée un seul PDF de ' + plural(fp, 'page', 'pages') + (runs.length > 1 ? ' : ' + runs.map((r) => r.nm).join(', puis ') + '.' : ' (' + runs[0].nm + ').')
      : 'Ce bouton crée un seul PDF de ' + plural(fp, 'page', 'pages') + ', dans l’ordre affiché.';
  $('#fGo').disabled = !fp;
  f.pages.forEach((p) => { const nd = M.nodes.get(p.id); if (nd) updatePageNode(nd, p, f); });

  // Diviser
  const { groups, error } = divGroups();
  $('#dGo').textContent = '';
  const dgo = $('#dGo');
  dgo.append(...downloadLabel(groups.length ? 'Créer ' + plural(groups.length, 'fichier', 'fichiers') + ' (.zip)' : 'Créer les fichiers (.zip)'));
  dgo.disabled = !groups.length;
  const names = groups.slice(0, 5).map(groupText).join(', ') + (groups.length > 5 ? '…' : '');
  $('#dCap').textContent = groups.length
    ? 'Ce bouton crée un .zip de ' + plural(groups.length, 'PDF', 'PDF') + ' (pages ' + names + '). L’original reste intact.'
    : error || 'Choisissez un PDF pour commencer.';

  // Extraire
  const e = M.extraire;
  const picked = e.pages.filter((p) => p.sel);
  const nums = picked.map((p) => p.index + 1);
  const ego = $('#eGo');
  ego.textContent = '';
  ego.append(...downloadLabel(picked.length ? 'Créer un PDF avec ' + plural(picked.length, 'page', 'pages') : 'Créer un PDF avec les pages choisies'));
  ego.disabled = !picked.length;
  $('#eCap').textContent = picked.length
    ? 'Ce bouton crée un nouveau PDF avec ' + (picked.length > 1 ? 'les pages ' : 'la page ') + describePages(nums) + '. L’original reste intact.'
    : 'Touchez les pages à garder.';
  $('#eSelInfo').textContent = e.pages.length ? plural(picked.length, 'page choisie', 'pages choisies') + ' sur ' + e.pages.length : '';
  $('#eAll').textContent = e.pages.length && picked.length === e.pages.length ? 'Tout désélectionner' : 'Tout sélectionner';
  e.pages.forEach((p) => { const nd = M.nodes.get(p.id); if (nd) updatePageNode(nd, p, e); });
}

function downloadLabel(text) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16');
  svg.append(p);
  return [svg, document.createTextNode(text)];
}

function renderAll() {
  renderFusion();
  renderDiviser();
  renderExtraire();
  updateBars();
}

export function setTask(t) {
  M.task = t;
  $$('.task').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.task === t)));
  $('#tFusion').hidden = t !== 'fusion';
  $('#tDiviser').hidden = t !== 'diviser';
  $('#tExtraire').hidden = t !== 'extraire';
  renderAll();
  app.refreshUndo();
}

/* ---------- Actions finales ---------- */
function outName() {
  let n = $('#fName').value.trim() || 'Document-fusionne.pdf';
  n = n.replace(/[\\/:*?"<>|]+/g, '-');
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n;
}

async function goFusion() {
  const st = M.fusion;
  if (!st.pages.length) return;
  await runBusy('Création du PDF...', async () => {
    const bytes = await buildPdf(specsOf(st.pages), bytesMap(st));
    download(bytes, outName());
    st.dirty = false;
    toast('PDF créé : ' + plural(st.pages.length, 'page', 'pages') + '.', 'ok');
  });
}

async function goDiviser() {
  const st = M.diviser;
  const { groups, error } = divGroups();
  if (!groups.length) { toast(error || 'Rien à diviser.', 'err'); return; }
  await runBusy('Division en cours...', async () => {
    const base = baseName(st.files[0].name);
    const bm = bytesMap(st);
    const cache = new Map();
    const files = [];
    for (const g of groups) {
      const pages = g.positions.map((i) => st.pages[i]);
      files.push({ name: base + '-' + g.label + '.pdf', data: await buildPdf(specsOf(pages), bm, cache) });
    }
    download(makeZip(files), base + '-divise.zip', 'application/zip');
    toast(plural(files.length, 'fichier', 'fichiers') + ' dans l’archive .zip.', 'ok');
  });
}

async function goExtraire() {
  const st = M.extraire;
  const pages = st.pages.filter((p) => p.sel);
  if (!pages.length) return;
  await runBusy('Création du PDF...', async () => {
    const bytes = await buildPdf(specsOf(pages), bytesMap(st));
    download(bytes, baseName(st.files[0].name) + '-extrait.pdf');
    toast('PDF créé avec ' + plural(pages.length, 'page', 'pages') + '.', 'ok');
  });
}

/* ---------- Branchement ---------- */
let app = { refreshUndo() {} };
export function initAssembler(hooks) {
  app = hooks;
  $$('.task').forEach((b) => b.addEventListener('click', () => setTask(b.dataset.task)));
  const pick = (id, input, k) => {
    $(id).addEventListener('click', () => { input.dataset.task = k; input.click(); });
  };
  const inp = $('#asmInput');
  for (const [btn, k] of [['#fPick', 'fusion'], ['#fAdd', 'fusion'], ['#dPick', 'diviser'], ['#dChange', 'diviser'], ['#ePick', 'extraire'], ['#eChange', 'extraire']]) pick(btn, inp, k);
  inp.addEventListener('change', (e) => {
    const fs = [...e.target.files];
    const k = e.target.dataset.task || M.task;
    e.target.value = '';
    addFiles(fs, k);
  });
  $('#fName').addEventListener('input', () => { M.fusionNameTouched = true; });
  $('#fLeft').addEventListener('click', () => moveSelected(-1));
  $('#fRight').addEventListener('click', () => moveSelected(1));
  $('#fRot').addEventListener('click', rotateSelected);
  $('#fDel').addEventListener('click', deleteSelected);
  $('#fGo').addEventListener('click', goFusion);
  $('#dGo').addEventListener('click', goDiviser);
  $('#eGo').addEventListener('click', goExtraire);
  $('#eAll').addEventListener('click', () => {
    const e = M.extraire;
    const all = e.pages.length > 0 && e.pages.every((p) => p.sel);
    e.pages.forEach((p) => { p.sel = !all; });
    updateBars();
  });
  $$('input[name="dmode"]').forEach((r) => r.addEventListener('change', () => { M.divMode = r.value; renderDiviser(); updateBars(); }));
  $('#dEvery').addEventListener('input', (e) => { const v = parseInt(e.target.value, 10); if (v >= 1) { M.divEvery = v; renderDivPreviewOnly(); } });
  $('#dEvery').addEventListener('change', () => renderAll());
  $('#dMinus').addEventListener('click', () => { M.divEvery = Math.max(1, M.divEvery - 1); renderAll(); });
  $('#dPlus').addEventListener('click', () => { M.divEvery = Math.min(Math.max(1, M.diviser.pages.length), M.divEvery + 1); renderAll(); });
  $('#dRanges').addEventListener('input', (e) => { M.divRanges = e.target.value; renderDivPreviewOnly(); });
  setTask('fusion');
}

function renderDivPreviewOnly() {
  // met à jour l'aperçu et la phrase sans recréer le champ en cours de saisie
  const keepEvery = $('#dEvery').value;
  renderDiviser();
  $('#dEvery').value = document.activeElement && document.activeElement.id === 'dEvery' ? keepEvery : $('#dEvery').value;
  updateBars();
}

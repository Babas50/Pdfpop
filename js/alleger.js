// Écran Alléger : un ou plusieurs PDF, un niveau, un aperçu avant/après, puis enregistrement.
import { $, $$, el, uid, toast, download, baseName, isPdfFile, fmtSize } from './util.js';
import { openCheck } from './pdfio.js';
import { lighten, LEVELS } from './compress.js';
import { makeZip } from './zip.js';

const L = { level: 'mail', files: [], running: false };
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
export const isDirty = () => false;
const pct = (before, after) => Math.max(0, Math.round((1 - after / before) * 100));

export async function addFiles(list) {
  const files = [...list].filter(isPdfFile);
  if (!files.length) { toast('Aucun PDF dans la sélection.', 'err'); return; }
  if (L.running) { toast('Un allègement est en cours. Patientez un instant.'); return; }
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const item = { id: uid(), name: f.name, bytes, before: bytes.length, status: 'new', after: 0, result: null, done: 0, total: 0, msg: '' };
    try {
      const chk = await openCheck(bytes);
      if (chk.encrypted) { item.status = 'error'; item.msg = 'Protégé par un mot de passe : non pris en charge.'; }
    } catch (e) {
      item.status = 'error';
      item.msg = 'Fichier illisible.';
    }
    L.files.push(item);
  }
  render();
}

function resetResults() {
  for (const f of L.files) if (f.status !== 'error') { f.status = 'new'; f.result = null; f.after = 0; f.done = 0; f.total = 0; }
}

const finished = () => L.files.length > 0 && L.files.every((f) => f.status !== 'new' && f.status !== 'working');
const outputs = () => L.files.filter((f) => f.status === 'done' || f.status === 'skip');

async function run() {
  if (L.running) return;
  const todo = L.files.filter((f) => f.status === 'new');
  if (!todo.length) return;
  L.running = true;
  render();
  for (const f of todo) {
    f.status = 'working';
    f.done = 0;
    f.total = 0;
    render();
    try {
      const r = await lighten(f.bytes, L.level, (p) => { f.done = p.done; f.total = p.total; updateRow(f); });
      f.result = r.bytes;
      f.after = r.after;
      f.status = r.changed ? 'done' : 'skip';
    } catch (e) {
      console.error(e);
      f.status = 'error';
      f.msg = e && e.userMessage ? e.userMessage : "Impossible d'alléger ce fichier.";
    }
    render();
  }
  L.running = false;
  render();
  const gained = outputs().filter((f) => f.status === 'done').length;
  toast(gained ? 'Aperçu prêt : vérifiez les tailles, puis enregistrez.' : 'Rien à alléger dans ces fichiers.', gained ? 'ok' : '');
}

function save() {
  const out = outputs();
  if (!out.length) return;
  const entry = (f) => ({ name: f.status === 'done' ? baseName(f.name) + '-allege.pdf' : f.name, data: f.result || f.bytes });
  if (out.length === 1) {
    const e = entry(out[0]);
    download(e.data, e.name);
  } else {
    download(makeZip(out.map(entry)), 'PDF-alleges.zip', 'application/zip');
  }
  toast(out.length === 1 ? 'PDF enregistré.' : plural(out.length, 'PDF enregistré', 'PDF enregistrés') + ' dans l’archive .zip.', 'ok');
}

function rowHtml(f) {
  const bar = f.status === 'done' ? Math.max(4, Math.round((f.after / f.before) * 100)) : f.status === 'working' && f.total ? Math.round((f.done / f.total) * 100) : f.status === 'skip' ? 100 : 0;
  let right = '<span class="sz">' + fmtSize(f.before) + '</span>';
  if (f.status === 'done') right = '<span class="sz">' + fmtSize(f.before) + '</span><span class="arrow">→</span><b class="sz">' + fmtSize(f.after) + '</b><span class="tag ok">-' + pct(f.before, f.after) + ' %</span>';
  else if (f.status === 'skip') right += '<span class="tag">Déjà léger, gardé tel quel</span>';
  else if (f.status === 'working') right += '<span class="tag">' + (f.total ? 'Image ' + Math.min(f.done + 1, f.total) + ' sur ' + f.total : 'En cours...') + '</span>';
  else if (f.status === 'error') right = '<span class="tag err"></span>';
  return { bar, right };
}

function updateRow(f) {
  const row = $('#lList [data-id="' + f.id + '"]');
  if (!row) return;
  const { bar, right } = rowHtml(f);
  row.querySelector('.rt').innerHTML = right;
  row.querySelector('.fill').style.width = bar + '%';
}

function render() {
  const has = L.files.length > 0;
  $('#lEmpty').hidden = has;
  $('#lCols').hidden = !has;
  $('#lBar').hidden = !has;
  $$('input[name="lvl"]').forEach((r) => { r.checked = r.value === L.level; r.disabled = L.running; });
  $$('#lLevels .opt').forEach((o) => o.classList.toggle('on', o.querySelector('input').checked));
  const list = $('#lList');
  list.replaceChildren();
  for (const f of L.files) {
    const row = el('div', { class: 'lrow', 'data-id': f.id });
    const { bar, right } = rowHtml(f);
    row.innerHTML =
      '<div class="top"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg><span class="nm"></span><span class="rt">' + right + '</span></div>' +
      '<div class="meter"><div class="fill ' + f.status + '" style="width:' + bar + '%"></div></div>';
    row.querySelector('.nm').textContent = f.name;
    row.querySelector('.nm').title = f.name;
    if (f.status === 'error') row.querySelector('.tag.err').textContent = f.msg;
    const rm = el('button', { class: 'mini', 'aria-label': 'Retirer ' + f.name }, '×');
    rm.disabled = L.running;
    rm.addEventListener('click', () => { L.files = L.files.filter((x) => x.id !== f.id); render(); });
    row.querySelector('.top').append(rm);
    list.append(row);
  }
  const okFiles = L.files.filter((f) => f.status !== 'error');
  const sumBefore = okFiles.reduce((a, f) => a + f.before, 0);
  const out = outputs();
  const done = finished() && out.length > 0;
  const sumAfter = out.reduce((a, f) => a + (f.status === 'done' ? f.after : f.before), 0);
  $('#lTotal').textContent = done
    ? 'Total : ' + fmtSize(out.reduce((a, f) => a + f.before, 0)) + ' avant, ' + fmtSize(sumAfter) + ' après (-' + pct(out.reduce((a, f) => a + f.before, 0), sumAfter) + ' %)'
    : 'Total : ' + fmtSize(sumBefore) + ' avant allègement';
  const go = $('#lGo');
  const label = $('#lGoLabel');
  const lvl = LEVELS[L.level].label;
  if (L.running) {
    label.textContent = 'Allègement en cours...';
    go.disabled = true;
    $('#lCap').textContent = 'Vos fichiers restent sur votre appareil. Patientez, c’est parfois long pour les gros scans.';
  } else if (done) {
    go.disabled = false;
    label.textContent = out.length === 1 ? 'Enregistrer le PDF allégé' : 'Enregistrer ' + plural(out.length, 'PDF', 'PDF') + ' (.zip)';
    $('#lCap').textContent = out.length === 1
      ? 'Ce bouton enregistre le PDF allégé (' + (out[0].status === 'done' ? baseName(out[0].name) + '-allege.pdf' : out[0].name) + '). Votre original reste intact.'
      : 'Ce bouton enregistre un .zip avec ' + plural(out.length, 'PDF', 'PDF') + ' (nom-allege.pdf). Vos originaux restent intacts.';
  } else {
    const n = L.files.filter((f) => f.status === 'new').length;
    go.disabled = n === 0;
    label.textContent = n ? (n > 1 ? 'Alléger ' + n + ' fichiers' : 'Alléger le fichier') : 'Aucun fichier à alléger';
    $('#lCap').textContent = n
      ? 'Ce bouton allège ' + plural(n, 'fichier', 'fichiers') + ' au niveau « ' + lvl + ' » et affiche les tailles. Rien n’est enregistré avant votre accord.'
      : 'Retirez les fichiers en erreur ou ajoutez des PDF.';
  }
}

export function show() { render(); }
export const hasFiles = () => L.files.length > 0;

export function initAlleger() {
  const lv = $('#lLevels');
  for (const k of ['light', 'mail', 'tiny']) {
    const c = LEVELS[k];
    const lab = el('label', { class: 'opt' });
    lab.innerHTML = '<input type="radio" name="lvl" value="' + k + '"><span class="dotr"></span><span class="otxt"><b></b><small></small></span>';
    lab.querySelector('b').textContent = c.label;
    if (k === 'mail') { const t = el('span', { class: 'rec' }, 'Conseillé'); lab.querySelector('b').append(t); }
    lab.querySelector('small').textContent = c.detail;
    lab.querySelector('input').addEventListener('change', () => { L.level = k; resetResults(); render(); });
    lv.append(lab);
  }
  const inp = $('#lInput');
  for (const id of ['#lPick', '#lAdd']) $(id).addEventListener('click', () => inp.click());
  inp.addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addFiles(fs); });
  $('#lGo').addEventListener('click', () => (finished() && outputs().length ? save() : run()));
  render();
}

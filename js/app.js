// Point d'entrée : onglets, en-tête, glisser-déposer, raccourcis, installation.
import { $, $$, isPdfFile, toast } from './util.js';
import * as Annoter from './annoter.js';
import * as Assembler from './assembler.js';
import * as Alleger from './alleger.js';

let mode = 'annoter';

function refreshHeader() {
  const chip = $('#fileName');
  const show = mode === 'annoter' && Annoter.hasDoc();
  chip.hidden = !show;
  if (show) chip.textContent = Annoter.fileName();
  $('#exportBtn').hidden = mode !== 'annoter';
  $('#exportBtn').disabled = !Annoter.hasDoc();
  $('#undoBtn').hidden = mode === 'alleger';
  $('#redoBtn').hidden = mode === 'alleger';
}

function refreshUndo() {
  let u = false;
  let r = false;
  if (mode === 'annoter') { u = Annoter.canUndo(); r = Annoter.canRedo(); }
  else if (mode === 'assembler') { u = Assembler.canUndo(); r = Assembler.canRedo(); }
  $('#undoBtn').disabled = !u;
  $('#redoBtn').disabled = !r;
}

const hooks = { refreshHeader, refreshUndo };

function setMode(m) {
  mode = m;
  $('#app').dataset.mode = m;
  $$('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#viewDoc').hidden = m !== 'annoter';
  $('#viewAsm').hidden = m !== 'assembler';
  $('#viewLite').hidden = m !== 'alleger';
  refreshHeader();
  refreshUndo();
  if (m === 'annoter') requestAnimationFrame(() => Annoter.renderMain());
  if (m === 'alleger') Alleger.show();
}

function handleFiles(files) {
  if (!files || !files.length) return;
  if (mode === 'assembler') Assembler.addFiles(files);
  else if (mode === 'alleger') Alleger.addFiles(files);
  else {
    if (files.length > 1) toast("Un seul fichier à la fois ici. Pour en combiner plusieurs, utilisez l'onglet Assembler.");
    Annoter.openDocFile(files[0]);
  }
}

const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);

function initEvents() {
  $$('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#undoBtn').addEventListener('click', () => (mode === 'annoter' ? Annoter.undoAction() : Assembler.undoAction()));
  $('#redoBtn').addEventListener('click', () => (mode === 'annoter' ? Annoter.redoAction() : Assembler.redoAction()));
  $('#exportBtn').addEventListener('click', Annoter.exportDoc);

  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('dropping'); } }));
  window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dropping');
    handleFiles(e.dataTransfer.files);
  });

  window.addEventListener('keydown', (e) => {
    if (isTyping() || $('#sigDialog').open) return;
    const mod = e.ctrlKey || e.metaKey;
    const undo = () => $('#undoBtn').click();
    const redo = () => $('#redoBtn').click();
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'annoter') { if (Annoter.deleteSelected()) e.preventDefault(); }
    else if (e.key === 'Escape' && mode === 'annoter') Annoter.escapeSelection();
  });

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (mode === 'annoter') Annoter.renderMain(); }, 200); });

  window.addEventListener('beforeunload', (e) => {
    if (Annoter.isDirty() || Assembler.isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Installation (PWA)
  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch (e) { /* rien */ }
    deferred = null;
    $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
}

function init() {
  Annoter.initAnnoter(hooks);
  Assembler.initAssembler(hooks);
  Alleger.initAlleger();
  initEvents();
  setMode('annoter');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();

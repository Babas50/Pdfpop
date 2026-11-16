// Petits outils partagés par tous les écrans.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const NS = 'http://www.w3.org/2000/svg';
let uidN = 0;
export const uid = () => 'i' + ++uidN + Math.random().toString(36).slice(2, 6);
export const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
export const baseName = (n) => n.replace(/\.pdf$/i, '');
export const isPdfFile = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';

export function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

let toastTimer;
export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'err' ? 7000 : 3500);
}

export function busy(on, text) {
  $('#busy').hidden = !on;
  if (text) $('#busyText').textContent = text;
}

export async function runBusy(text, fn) {
  busy(true, text);
  await nextFrame();
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(e && e.userMessage ? e.userMessage : 'Une erreur est survenue : ' + (e && e.message ? e.message : e), 'err');
  } finally {
    busy(false);
  }
}

export function download(data, name, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// 6,4 Mo, 820 Ko (base 1024, comme l'Explorateur de fichiers)
export function fmtSize(b) {
  if (b < 1024) return b + ' o';
  if (b < 1024 * 1024) return Math.round(b / 1024).toLocaleString('fr-FR') + ' Ko';
  const mo = b / (1024 * 1024);
  return mo.toLocaleString('fr-FR', { minimumFractionDigits: mo < 10 ? 1 : 0, maximumFractionDigits: mo < 10 ? 1 : 0 }) + ' Mo';
}

export function makeQueue(limit) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < limit && q.length) {
      const fn = q.shift();
      active++;
      fn().catch(() => {}).finally(() => { active--; pump(); });
    }
  };
  return (fn) => { q.push(fn); pump(); };
}

export function trackPointer(e, onMove, onEnd) {
  const id = e.pointerId;
  const mv = (ev) => { if (ev.pointerId === id) onMove(ev); };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onEnd(ev);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

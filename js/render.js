// Affichage des pages avec pdf.js.
import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { makeQueue } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
export const PDFJS_OPTS = {
  isEvalSupported: false,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
};
export { pdfjsLib };
export const thumbQueue = makeQueue(2);

export function openView(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise;
}

// size : largeur CSS (nombre) ou {w, h} pour tenir dans une boîte. rotation : degrés ajoutés à ceux de la page.
export async function renderToCanvas(pdf, pageNum, canvas, size, rotation = null, holder = null) {
  holder = holder || (canvas._holder = canvas._holder || {});
  if (holder.task) { try { holder.task.cancel(); } catch (e) { /* déjà terminé */ } }
  const page = await pdf.getPage(pageNum);
  const rot = rotation == null ? page.rotate : (((page.rotate + rotation) % 360) + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation: rot });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = typeof size === 'number' ? size / base.width : Math.min(size.w / base.width, size.h / base.height);
  const vp = page.getViewport({ scale: scale * dpr, rotation: rot });
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  canvas.style.width = vp.width / dpr + 'px';
  canvas.style.height = vp.height / dpr + 'px';
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  holder.task = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return null;
    throw e;
  } finally {
    if (holder.task === task) holder.task = null;
  }
  // ptW : largeur de la page en points PDF (1 pt = 1/72 po), utile pour afficher des tailles en pt.
  return { w: vp.width / dpr, h: vp.height / dpr, ptW: base.width, ptH: base.height };
}

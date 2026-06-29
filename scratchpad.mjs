// scratchpad.mjs — the per-question annotation canvas (Apple-Pencil friendly).
// Renders a plain pad, or an overlay pad layered over a question image for
// PBQ-style labelling. Drawings persist per question in IndexedDB, encrypted
// under the PIN when one is set. Depends only on core ($, state), lib
// (escapeHtml, isSafeImageSrc), storage (IDB primitives), and crypto — no
// callbacks back into app.js, so there's no circular dependency.

import { $, state } from './core.mjs';
import { escapeHtml, isSafeImageSrc } from './lib.mjs';
import { openDB, idbGet, idbPut } from './storage.mjs';
import { encryptJSON, decryptJSON, isEncryptedBlob } from './crypto.mjs';

export function renderScratchpadHTML(q) {
  // PBQ with an image → overlay mode: canvas layered over the image so the
  // user can annotate / label components directly.
  // Filter to safe image sources before rendering. Rejected URLs are
  // dropped silently so the scratchpad still renders without an image.
  const safeImages = q && (q.images || [q.image]).filter(Boolean).filter(isSafeImageSrc);
  const hasImage = safeImages && safeImages.length > 0;
  if (hasImage) {
    const src = safeImages[0];
    return `
      <div class="scratchpad-wrap overlay">
        <div class="scratchpad-controls">
          <button id="pen-btn" class="active">✏️ Pen</button>
          <button id="eraser-btn">🧽 Eraser</button>
          <button id="clear-pad-btn" style="margin-left: auto;">Clear</button>
        </div>
        <div class="scratchpad-overlay-container">
          <img class="scratchpad-underlay" src="${escapeHtml(src)}" alt="Annotate">
          <canvas id="scratchpad" class="scratchpad overlay-canvas"></canvas>
        </div>
      </div>
    `;
  }
  return `
    <div class="scratchpad-wrap">
      <div class="scratchpad-controls">
        <button id="pen-btn" class="active">✏️ Pen</button>
        <button id="eraser-btn">🧽 Eraser</button>
        <button id="clear-pad-btn" style="margin-left: auto;">Clear</button>
      </div>
      <canvas id="scratchpad" class="scratchpad"></canvas>
    </div>
  `;
}

// Drawings persist per question in IndexedDB. If a PIN is set, the dataURL is
// encrypted before write and decrypted on read — silently skipped if locked.
async function loadDrawing(qid) {
  try {
    const raw = await idbGet('drawings', qid);
    if (!raw) return null;
    if (!isEncryptedBlob(raw)) return raw;
    if (!state._cryptoKey) return null;
    return await decryptJSON(state._cryptoKey, raw);
  } catch { return null; }
}
async function saveDrawing(qid, dataUrl) {
  try {
    const value = state._cryptoKey ? await encryptJSON(state._cryptoKey, dataUrl) : dataUrl;
    await idbPut('drawings', qid, value);
  } catch (e) { console.warn('Save drawing failed', e); }
}
async function clearDrawing(qid) {
  try {
    const db = await openDB();
    const tx = db.transaction('drawings', 'readwrite');
    tx.objectStore('drawings').delete(qid);
  } catch {}
}

export function attachScratchpadEvents(q) {
  const canvas = $('#scratchpad');
  if (!canvas) return;
  const qid = q?.id;

  // Resize canvas to actual pixel size for sharp lines
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
  };
  // For overlay mode, wait for image to load so canvas matches its dimensions
  const underlay = $('.scratchpad-underlay');
  if (underlay && !underlay.complete) {
    underlay.addEventListener('load', () => { resize(); restoreDrawing(); }, { once: true });
  }
  resize();

  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = underlay
    ? '#ff3b30'   // red pen on image overlays — high contrast
    : getComputedStyle(document.body).getPropertyValue('--text');

  // Restore prior drawing for this card
  async function restoreDrawing() {
    if (!qid) return;
    const dataUrl = await loadDrawing(qid);
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const rect = canvas.getBoundingClientRect();
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
    };
    img.src = dataUrl;
  }
  restoreDrawing();

  let drawing = false;
  let lastX = 0, lastY = 0;
  let mode = 'pen';
  let savePending = null;
  const scheduleSave = () => {
    if (!qid) return;
    clearTimeout(savePending);
    savePending = setTimeout(() => saveDrawing(qid, canvas.toDataURL('image/png')), 400);
  };

  const penBtn = $('#pen-btn');
  const eraserBtn = $('#eraser-btn');
  const clearBtn = $('#clear-pad-btn');

  penBtn.addEventListener('click', () => {
    mode = 'pen';
    penBtn.classList.add('active');
    eraserBtn.classList.remove('active');
  });
  eraserBtn.addEventListener('click', () => {
    mode = 'eraser';
    eraserBtn.classList.add('active');
    penBtn.classList.remove('active');
  });
  clearBtn.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (qid) clearDrawing(qid);
  });

  function getXY(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getXY(e);
    lastX = x; lastY = y;
    const pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    ctx.lineWidth = mode === 'eraser' ? 20 : (1 + pressure * 3);
    ctx.globalCompositeOperation = mode === 'eraser' ? 'destination-out' : 'source-over';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = getXY(e);
    const pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    ctx.lineWidth = mode === 'eraser' ? 20 : (1 + pressure * 3);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x; lastY = y;
  });

  const stop = () => { if (drawing) { drawing = false; scheduleSave(); } };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
}

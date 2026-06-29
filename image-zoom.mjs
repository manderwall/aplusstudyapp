// image-zoom.mjs — tap a figure to enlarge it in an accessible modal overlay.
// Self-contained: installImageZoom() wires a single delegated click listener;
// openImageZoom() builds the overlay. Imports only shared primitives from
// core + escapeHtml from lib, so there's no dependency back into app.js.

import { escapeHtml } from './lib.mjs';
import { trapFocus, setAppInert } from './core.mjs';

export function installImageZoom() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.q-image-zoom');
    if (!btn) return;
    e.preventDefault();
    const img = btn.querySelector('img');
    if (!img) return;
    openImageZoom(img.src, img.alt);
  });
}

export function openImageZoom(src, alt) {
  // Bail if one is already open (rapid double-tap)
  if (document.getElementById('img-zoom-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'img-zoom-overlay';
  overlay.className = 'img-zoom-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Enlarged figure — tap or press Escape to close');
  // src comes from a live img.src DOM property (already normalized to an
  // absolute URL by the browser), so an attribute breakout can't survive
  // today. Escape it anyway for defense in depth — a future refactor
  // passing a raw string shouldn't regress this.
  overlay.innerHTML = `
    <button type="button" class="img-zoom-close" aria-label="Close enlarged figure">✕</button>
    <img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}">
  `;
  document.body.appendChild(overlay);
  // Match the dialog a11y pattern from PR #39: inert background +
  // focus trap + focus restoration on close.
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const close = () => {
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.img-zoom-close')?.focus();
}

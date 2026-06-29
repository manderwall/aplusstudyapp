// confetti.mjs — tiny DOM-based celebration burst. No canvas bookkeeping, so it
// works offline and renders cheaply. Honors reduce-motion (OS + app toggle).
import { pref } from './core.mjs';

const CONFETTI_COLORS = ['#ffd700', '#ff80ab', '#80d8ff', '#4ade80', '#fbbf24', '#c084fc', '#ff87b2'];

export function celebrate({ sourceEl = null, intensity = 30, duration = 1400 } = {}) {
  if (pref('motion') === 'reduced') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.createElement('div');
  host.className = 'confetti-host';
  host.setAttribute('aria-hidden', 'true');
  let x = window.innerWidth / 2, y = 100;
  if (sourceEl) {
    const r = sourceEl.getBoundingClientRect();
    x = r.left + r.width / 2;
    y = r.top + r.height / 2;
  }
  host.style.left = `${x}px`;
  host.style.top  = `${y}px`;
  document.body.appendChild(host);
  for (let i = 0; i < intensity; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 120;
    p.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    p.style.animationDuration = `${duration + Math.random() * 400}ms`;
    p.style.animationDelay = `${Math.random() * 80}ms`;
    host.appendChild(p);
  }
  setTimeout(() => host.remove(), duration + 800);
}

// wake-lock.mjs — keep the screen awake during study/quiz/read-aloud.
// Browsers auto-release the wake lock when the tab goes hidden, so we
// re-acquire on visibility change. No-op on browsers without the API
// (Safari < 16.4, etc.). Imports only `state` from core — no app dependency.

import { state } from './core.mjs';

const wake = { lock: null, wanted: false };

export async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  wake.wanted = true;
  if (wake.lock) return;
  try {
    wake.lock = await navigator.wakeLock.request('screen');
    wake.lock.addEventListener('release', () => { wake.lock = null; });
  } catch {
    // Permission denied or NotAllowed (Safari requires a user gesture for
    // the first request); we'll retry next time the user does something.
  }
}

export function releaseWakeLock() {
  wake.wanted = false;
  if (wake.lock) wake.lock.release().catch(() => {});
  wake.lock = null;
}

export function installWakeLock() {
  if (!('wakeLock' in navigator)) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wake.wanted) acquireWakeLock();
  });
  // Acquire on first user interaction in study/quiz so we satisfy the
  // user-gesture requirement on browsers that need one.
  const onFirst = () => {
    if (state.mode === 'study' || state.mode === 'quiz') acquireWakeLock();
  };
  document.addEventListener('pointerdown', onFirst, { once: true, passive: true });
  document.addEventListener('keydown', onFirst, { once: true });
}

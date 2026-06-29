// shake.mjs — shake-to-shuffle via DeviceMotion (iOS-permission-aware).
// A vigorous shake reshuffles the current study/quiz view (new order seed).
// Imports only core (state, haptic); the render functions it calls back into
// are injected via initShake() so there's no circular import into app.js.

import { state, haptic } from './core.mjs';

let _shakeInstalled = false;
let _shakeLastFire = 0;

// App-provided re-render hooks, wired by initShake() at startup.
let _renderStudy = () => {};
let _renderQuiz = () => {};
export function initShake({ renderStudy, renderQuiz }) {
  if (renderStudy) _renderStudy = renderStudy;
  if (renderQuiz) _renderQuiz = renderQuiz;
}

function onShakeMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
  const now = Date.now();
  if (mag > 25 && now - _shakeLastFire > 1200) {
    _shakeLastFire = now;
    haptic([20, 40, 20]);
    // Shake reshuffles the current view (new seed) instead of flipping a boolean.
    state._orderSeed = (Date.now() & 0x7fffffff) || 1;
    state._orderCache = null;
    state.currentIndex = 0;
    if (state.mode === 'study') _renderStudy();
    else if (state.mode === 'quiz') _renderQuiz();
  }
}

export async function enableShake() {
  if (_shakeInstalled) return true;
  // iOS 13+ requires explicit permission for motion events
  if (typeof DeviceMotionEvent !== 'undefined'
      && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== 'granted') { alert('Motion permission denied — shake disabled.'); return false; }
    } catch (e) { alert('Couldn\'t request motion permission: ' + e.message); return false; }
  }
  window.addEventListener('devicemotion', onShakeMotion);
  _shakeInstalled = true;
  return true;
}

export function disableShake() {
  if (!_shakeInstalled) return;
  window.removeEventListener('devicemotion', onShakeMotion);
  _shakeInstalled = false;
}

// core.mjs — shared foundation for the app: global state + the small primitive
// helpers (DOM query, preferences, toast, haptics, localStorage guard, ARIA
// announce) that every feature depends on. Pure browser APIs only; this module
// imports nothing from app.js, so there are no circular dependencies — feature
// modules and app.js import from here.

//─── GLOBAL STATE ────────────────────────────────────────────
export const state = {
  exam: 'core2',
  questions: [],
  conceptFixes: {},
  mode: 'study',
  filter: { obj: null, due: false, weakest: false, hard: false, search: '' },
  currentIndex: 0,
  revealed: false,
  selectedOption: null,  // option text the user tapped pre-reveal (single-answer Qs)
  selectedOptions: [],   // option texts the user has toggled on (Multiple Answer Qs)
  committed: false,      // true once the user has either picked OR tapped "I don't know" — gates Reveal
  editing: false,  // when true, render the edit form instead of the question card
  focus: false,    // Focus Mode: hides filter/meta chrome to show just the card
  history: [],     // stack of previous currentIndex values for Prev nav
  order: 'smart',  // 'smart' | 'random' | 'sequential' — card ordering strategy
  _orderSeed: null,    // stable per-session seed so Prev/Next don't reshuffle
  _orderCache: null,   // { key, list }
  _revealedAt: 0,      // timestamp of last reveal/answer-recorded, used to block ghost-clicks
  progress: {},    // { questionId: { status, seen, correct, lastSeen, ease, interval, due, updated_at } }
  overrides: {},   // { questionId: { options?, image?, images? } } — user-added content
  quizSession: null,  // null | { questions, answers, current, startedAt, done }
  cram: null,         // null | { active, startedAt, queue: id[], originalCount, cleared }
  // Active study session (Pomodoro-style)
  session: null,   // { endsAt, startCards, ratedIds: Set<string>, length }
  _sessionTick: null,  // setInterval id for HUD refresh
  _autoSyncTimer: null,  // debounce handle for cloud push
  _cryptoKey: null,   // AES-GCM key derived from PIN; memory-only
};

//─── DOM QUERY HELPERS ───────────────────────────────────────
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

//─── PREFERENCES (persisted in localStorage via pref()/setPref()) ──
export const PREF_DEFAULTS = {
  'haptics': 'on',            // on | off
  'motion':  'full',           // full | reduced
  'contrast':'normal',         // normal | high
  'size':    'medium',         // small | medium | large | xlarge
  'font':    'system',         // system | atkinson | opendyslexic
  'autosync':'off',            // on | off
  'anxiety': 'off',            // on | off — hide numeric feedback
  'sound':   'off',            // off | white | pink | brown
  'shake':   'off',            // on | off — shake-to-shuffle
};

export function pref(key) {
  return localStorage.getItem(`pref.${key}`) || PREF_DEFAULTS[key];
}

export function setPref(key, value) {
  if (value === PREF_DEFAULTS[key]) localStorage.removeItem(`pref.${key}`);
  else lsSet(`pref.${key}`, value);
  applyPrefs();
}

export function applyPrefs() {
  const html = document.documentElement;
  for (const k of Object.keys(PREF_DEFAULTS)) {
    html.setAttribute(`data-${k}`, pref(k));
  }
  ensureFontLoaded(pref('font'));
}

// Load dyslexia-friendly fonts lazily so the default path has no external requests
const FONT_URLS = {
  atkinson: 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap',
  opendyslexic: 'https://fonts.cdnfonts.com/css/opendyslexic',
};
export function ensureFontLoaded(font) {
  const href = FONT_URLS[font];
  if (!href) return;
  const id = `font-${font}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

export function isDue(q) {
  return (state.progress[q.id]?.due || 0) <= Date.now();
}

export function haptic(pattern = 10) {
  if (pref('haptics') === 'off') return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

//─── TOAST (non-blocking notice; gentler than alert() for AuDHD users) ──
// Queues messages, shows each for a few seconds. Tap to dismiss early.
const _toastQueue = [];
let _toastShowing = false;
export function toast(msg, kind = 'info', ms = 3500, onTap = null) {
  _toastQueue.push({ msg, kind, ms, onTap });
  if (!_toastShowing) _drainToasts();
}
function _drainToasts() {
  const next = _toastQueue.shift();
  if (!next) { _toastShowing = false; return; }
  _toastShowing = true;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    // Make the host itself a live region so AT announces every toast
    // that lands inside, regardless of which kind got role=alert vs
    // role=status. Individual toasts keep their per-kind role too.
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${next.kind}` + (next.onTap ? ' toast-actionable' : '');
  el.setAttribute('role', next.kind === 'error' ? 'alert' : 'status');
  el.textContent = next.msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => { el.remove(); _drainToasts(); }, 200);
  };
  el.addEventListener('click', () => {
    if (next.onTap) { try { next.onTap(); } catch {} }
    dismiss();
  });
  setTimeout(dismiss, next.ms);
}

//─── localStorage GUARD ──────────────────────────────────────
// Defensive wrapper around localStorage.setItem. iOS Safari private mode
// can have 0 quota; quota-exceeded errors would otherwise bubble up and
// crash bumpStreak / savePinSetup / activity tracking / preferences saves
// — leaving the user with a silently-broken streak or PIN that won't
// save. Logs once per session per key on failure; surfaces a single
// toast the first time it fails so the user knows something's off.
const _lsFailed = new Set();
let _lsToastedThisSession = false;
export function lsSet(key, value) {
  try {
    localStorage['setItem'](key, value);
    return true;
  } catch (e) {
    if (!_lsFailed.has(key)) {
      _lsFailed.add(key);
      console.warn(`localStorage set failed for "${key}": ${e?.message || e}`);
    }
    if (!_lsToastedThisSession) {
      _lsToastedThisSession = true;
      // Defer so we don't recursively toast during a render cycle that
      // itself triggered the failed write. Also schedule once only.
      setTimeout(() => {
        try { toast('Browser storage is full or blocked — preferences and streak may not save.', 'error', 6000); } catch {}
      }, 0);
    }
    return false;
  }
}

//─── ARIA ANNOUNCE (screen-reader live region) ───────────────
// Created lazily so we don't touch the DOM until something needs to be spoken.
export function announce(msg, assertive = false) {
  let host = document.getElementById('aria-live-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'aria-live-host';
    // Visually hidden but readable by assistive tech.
    host.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);';
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
  }
  host.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  // Clearing first ensures repeated identical strings still re-announce.
  host.textContent = '';
  setTimeout(() => { host.textContent = msg; }, 30);
}

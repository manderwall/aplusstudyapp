// A+ Study — single-file PWA logic
// Modules: State, DB, Study, Quiz, Reading, Stats, ScratchPad, Router

import {
  MIN, DAY, MAX_INTERVAL_DAYS,
  defaultProgress, migrateProgress, schedule,
  escapeHtml, normalizeOption, formatExplanation,
} from './lib.mjs';
import {
  randomSaltB64, deriveKey, encryptJSON, decryptJSON, isEncryptedBlob,
  makeVerificationBlob, verifyPin,
} from './crypto.mjs';

//─── EXAMS (multi-dataset support) ──────────────────────────
// Each exam has its own questions + concept-fixes file, and its own
// progress/overrides rows in IndexedDB, keyed by id. Adding a new exam
// is just: drop files in data/<id>/ and add an entry here.
const EXAMS = {
  core1: {
    id: 'core1',
    label: 'Core 1 (220-1201)',
    questions: 'data/questions.json',
    fixes: 'data/concept-fixes.json',
  },
  core2: {
    id: 'core2',
    label: 'Core 2 (220-1202)',
    questions: 'data/core2/questions.json',
    fixes: 'data/core2/concept-fixes.json',
  },
};
const EXAM_IDS = Object.keys(EXAMS);
function examDef(id) { return EXAMS[id] || EXAMS.core1; }

//─── GLOBAL STATE ────────────────────────────────────────────
const state = {
  exam: 'core1',
  questions: [],
  conceptFixes: {},
  mode: 'study',
  filter: { obj: null, due: false, search: '' },
  currentIndex: 0,
  revealed: false,
  selectedOption: null,  // option text the user tapped pre-reveal
  editing: false,  // when true, render the edit form instead of the question card
  focus: false,    // Focus Mode: hides filter/meta chrome to show just the card
  history: [],     // stack of previous currentIndex values for Prev nav
  shuffle: false,
  _shuffleCache: null,  // { key, list }
  progress: {},    // { questionId: { status, seen, correct, lastSeen, ease, interval, due, updated_at } }
  overrides: {},   // { questionId: { options?, image?, images? } } — user-added content
  // Active study session (Pomodoro-style)
  session: null,   // { endsAt, startCards, ratedIds: Set<string>, length }
  _sessionTick: null,  // setInterval id for HUD refresh
  _autoSyncTimer: null,  // debounce handle for cloud push
  _cryptoKey: null,   // AES-GCM key derived from PIN; memory-only
};

// Accessibility / preference keys (persisted in localStorage via pref()/setPref())
const PREF_DEFAULTS = {
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

function pref(key) {
  return localStorage.getItem(`pref.${key}`) || PREF_DEFAULTS[key];
}

function setPref(key, value) {
  if (value === PREF_DEFAULTS[key]) localStorage.removeItem(`pref.${key}`);
  else localStorage.setItem(`pref.${key}`, value);
  applyPrefs();
}

function applyPrefs() {
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
function ensureFontLoaded(font) {
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

function isDue(q) {
  return (state.progress[q.id].due || 0) <= Date.now();
}

function haptic(pattern = 10) {
  if (pref('haptics') === 'off') return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

//─── TOAST (non-blocking notice; gentler than alert() for AuDHD users) ──
// Queues messages, shows each for a few seconds. Tap to dismiss early.
const _toastQueue = [];
let _toastShowing = false;
function toast(msg, kind = 'info', ms = 3500) {
  _toastQueue.push({ msg, kind, ms });
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
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${next.kind}`;
  el.setAttribute('role', next.kind === 'error' ? 'alert' : 'status');
  el.textContent = next.msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => { el.remove(); _drainToasts(); }, 200);
  };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, next.ms);
}

//─── SESSION (Pomodoro or card-count micro-goal) ─────────────
function startSession({ minutes = 0, targetCards = 0 } = {}) {
  state.session = {
    endsAt: minutes > 0 ? Date.now() + minutes * MIN : null,
    targetCards: targetCards > 0 ? targetCards : null,
    ratedIds: new Set(),
    length: minutes,
    targetDesc: targetCards > 0 ? `${targetCards} card${targetCards === 1 ? '' : 's'}` : `${minutes} min`,
  };
  if (state._sessionTick) clearInterval(state._sessionTick);
  if (minutes > 0) {
    state._sessionTick = setInterval(() => {
      if (!state.session) return;
      if (Date.now() >= state.session.endsAt) endSession(true);
      else updateHUD();
    }, 1000);
  }
  updateHUD();
}

function endSession(triggerSummary) {
  if (state._sessionTick) { clearInterval(state._sessionTick); state._sessionTick = null; }
  const sess = state.session;
  state.session = null;
  updateHUD();
  if (triggerSummary && sess) {
    const reviewed = sess.ratedIds.size;
    const msg = reviewed === 0
      ? `Session done. No cards rated this time — that's OK, sometimes just showing up is the win.`
      : `Session done. ${reviewed} card${reviewed === 1 ? '' : 's'} reviewed. 🎉`;
    haptic([80, 60, 80]);
    toast(msg, 'success', 5000);
  }
}

function onCardRated(qid) {
  if (state.session) {
    state.session.ratedIds.add(qid);
    // Card-count micro-goal reached → end naturally
    if (state.session.targetCards && state.session.ratedIds.size >= state.session.targetCards) {
      endSession(true);
    }
  }
  bumpStreak();
  scheduleAutoSync();
}

//─── DAILY STREAK ────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function bumpStreak() {
  const today = todayKey();
  const last = localStorage.getItem('streak.lastDay');
  if (last === today) {
    const n = Number(localStorage.getItem('streak.todayCards') || '0') + 1;
    localStorage.setItem('streak.todayCards', String(n));
    return;
  }
  // New day: check if yesterday → increment, else reset to 1
  let count = Number(localStorage.getItem('streak.count') || '0');
  if (last) {
    const [ly, lm, ld] = last.split('-').map(Number);
    const lastDate = new Date(ly, lm - 1, ld);
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((y - lastDate) / (24*60*60*1000));
    count = diffDays === 1 ? count + 1 : 1;
  } else {
    count = 1;
  }
  localStorage.setItem('streak.lastDay', today);
  localStorage.setItem('streak.count', String(count));
  localStorage.setItem('streak.todayCards', '1');
}

function getStreak() {
  const last = localStorage.getItem('streak.lastDay');
  const count = Number(localStorage.getItem('streak.count') || '0');
  const today = todayKey();
  // If last day wasn't yesterday or today, streak is effectively 0 now
  if (!last) return { count: 0, today: 0 };
  const [ly, lm, ld] = last.split('-').map(Number);
  const lastDate = new Date(ly, lm - 1, ld);
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((y - lastDate) / (24*60*60*1000));
  const active = diffDays <= 1;
  return {
    count: active ? count : 0,
    today: last === today ? Number(localStorage.getItem('streak.todayCards') || '0') : 0,
  };
}

function cardsRatedToday() {
  return getStreak().today;
}

//─── AUTO-SYNC ───────────────────────────────────────────────
function scheduleAutoSync() {
  if (pref('autosync') !== 'on') return;
  const cfg = getCloudCfg();
  if (!cfg.url || !cfg.key || !cfg.syncKey) return;
  clearTimeout(state._autoSyncTimer);
  state._autoSyncTimer = setTimeout(() => {
    cloudPush().catch(err => console.warn('Auto-sync push failed', err));
  }, 5000);
}

//─── KAWAII SVG MASCOTS (inline, so they work offline + theme-aware) ──
// One tiny round creature in three moods. Colors pull from CSS vars so
// they shift with theme/high-contrast/anxiety settings.
const MASCOT_SVG = {
  wave: `<svg class="mascot" viewBox="0 0 120 120" aria-hidden="true">
    <g class="mascot-sparkles">
      <path d="M12 26 L14 31 L19 33 L14 35 L12 40 L10 35 L5 33 L10 31 Z"/>
      <path d="M104 22 L105 26 L109 27 L105 28 L104 32 L103 28 L99 27 L103 26 Z"/>
      <path d="M100 92 L102 97 L107 99 L102 101 L100 106 L98 101 L93 99 L98 97 Z"/>
    </g>
    <circle class="mascot-body" cx="60" cy="66" r="40"/>
    <circle class="mascot-paw" cx="96" cy="48" r="8"/>
    <circle class="mascot-eye" cx="48" cy="60" r="3.5"/>
    <circle class="mascot-eye" cx="72" cy="60" r="3.5"/>
    <circle class="mascot-shine" cx="49.2" cy="58.3" r="1.1"/>
    <circle class="mascot-shine" cx="73.2" cy="58.3" r="1.1"/>
    <ellipse class="mascot-blush" cx="42" cy="72" rx="5" ry="2.4"/>
    <ellipse class="mascot-blush" cx="78" cy="72" rx="5" ry="2.4"/>
    <path class="mascot-smile" d="M53 76 Q60 82 67 76" fill="none"/>
  </svg>`,

  celebrate: `<svg class="mascot celebrate" viewBox="0 0 120 120" aria-hidden="true">
    <g class="mascot-sparkles">
      <path d="M12 26 L14 31 L19 33 L14 35 L12 40 L10 35 L5 33 L10 31 Z"/>
      <path d="M104 22 L105 26 L109 27 L105 28 L104 32 L103 28 L99 27 L103 26 Z"/>
      <path d="M100 92 L102 97 L107 99 L102 101 L100 106 L98 101 L93 99 L98 97 Z"/>
      <path d="M22 92 L23 96 L27 97 L23 98 L22 102 L21 98 L17 97 L21 96 Z"/>
    </g>
    <circle class="mascot-body" cx="60" cy="66" r="40"/>
    <path class="mascot-eye-happy" d="M44 62 Q48 57 52 62" fill="none"/>
    <path class="mascot-eye-happy" d="M68 62 Q72 57 76 62" fill="none"/>
    <ellipse class="mascot-blush" cx="42" cy="72" rx="5" ry="2.4"/>
    <ellipse class="mascot-blush" cx="78" cy="72" rx="5" ry="2.4"/>
    <path class="mascot-smile" d="M50 76 Q60 86 70 76" fill="none"/>
    <rect x="30" y="12" width="3" height="6" fill="#ffd700" transform="rotate(18 31 15)"/>
    <rect x="86" y="14" width="3" height="6" fill="#ff80ab" transform="rotate(-18 87 17)"/>
    <circle cx="60" cy="10" r="2" fill="#80d8ff"/>
  </svg>`,

  sleep: `<svg class="mascot" viewBox="0 0 120 120" aria-hidden="true">
    <text x="92" y="22" class="mascot-z">z</text>
    <text x="100" y="34" class="mascot-z" font-size="10">z</text>
    <text x="107" y="42" class="mascot-z" font-size="7">z</text>
    <circle class="mascot-body" cx="60" cy="66" r="40"/>
    <path class="mascot-eye-closed" d="M44 62 Q48 66 52 62" fill="none"/>
    <path class="mascot-eye-closed" d="M68 62 Q72 66 76 62" fill="none"/>
    <ellipse class="mascot-blush" cx="42" cy="72" rx="5" ry="2.4"/>
    <ellipse class="mascot-blush" cx="78" cy="72" rx="5" ry="2.4"/>
    <path class="mascot-smile" d="M55 77 Q60 79 65 77" fill="none"/>
  </svg>`,
};

// Expose SVG fallbacks so `<img onerror>` handlers can reach them.
window.__MASCOT_SVG__ = MASCOT_SVG;

// Try a PNG at images/kawaii/{mood}.png first; fall back to inline SVG on error.
// Drop a PNG with that name in the repo and it'll replace the SVG automatically.
function MASCOT(mood) {
  const key = mood in MASCOT_SVG ? mood : 'sleep';
  const png = `images/kawaii/${key}.png`;
  const fallback = MASCOT_SVG[key].replace(/"/g, '&quot;').replace(/\n\s*/g, ' ');
  return `<img class="mascot mascot-png" src="${png}" alt="" aria-hidden="true"
    onerror="const d=document.createElement('div');d.innerHTML=this.getAttribute('data-fallback');this.replaceWith(d.firstElementChild);"
    data-fallback="${fallback}">`;
}

const DB_NAME = 'aplus-study';
const DB_VERSION = 3;
const STORE = 'progress';
const OSTORE = 'overrides';   // per-question edits: { [qid]: {options?, image?, images?} }
const DSTORE = 'drawings';    // per-question scratchpad canvas PNGs (base64 dataURL)

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(OSTORE)) db.createObjectStore(OSTORE);
      if (!db.objectStoreNames.contains(DSTORE)) db.createObjectStore(DSTORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  }));
}

function idbPut(store, key, value) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

function idbDelete(store, key) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

//─── PIN LOCK (AES-GCM at-rest encryption) ───────────────────
// Setup metadata lives in localStorage under `pin.setup` as
//   { v: 1, salt: b64, iterations: N, verification: { v, iv, ct } }
// The derived key is held in memory only (state._cryptoKey) for the
// current session; closing the app drops it and requires re-unlock.
const PIN_SETUP_KEY = 'pin.setup';

function getPinSetup() {
  try {
    const raw = localStorage.getItem(PIN_SETUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePinSetup(setup) { localStorage.setItem(PIN_SETUP_KEY, JSON.stringify(setup)); }
function clearPinSetup()     { localStorage.removeItem(PIN_SETUP_KEY); }
function isPinSet() { return !!getPinSetup(); }

async function maybeEncrypt(obj) {
  return state._cryptoKey ? encryptJSON(state._cryptoKey, obj) : obj;
}
async function maybeDecrypt(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (!isEncryptedBlob(raw)) return raw;
  if (!state._cryptoKey) throw new Error('locked');
  return decryptJSON(state._cryptoKey, raw);
}

// Per-exam keys so Core 1 and Core 2 progress live side by side. Pre-multi-
// exam saves lived under the 'all' key; loadProgress/loadOverrides transparently
// migrate that row to 'core1' on first read.
async function loadProgress(examId = state.exam) {
  try {
    let raw = await idbGet(STORE, examId);
    if (raw == null && examId === 'core1') {
      const legacy = await idbGet(STORE, 'all');
      if (legacy != null) {
        await idbPut(STORE, 'core1', legacy);
        await idbDelete(STORE, 'all');
        raw = legacy;
      }
    }
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
async function saveProgress(examId = state.exam) {
  try { await idbPut(STORE, examId, await maybeEncrypt(state.progress)); }
  catch (e) { console.warn('Save progress failed', e); }
}
async function clearProgress(examId = state.exam) {
  try {
    await idbDelete(STORE, examId);
    state.progress = {};
  } catch (e) { console.warn('Clear failed', e); }
}

async function loadOverrides(examId = state.exam) {
  try {
    let raw = await idbGet(OSTORE, examId);
    if (raw == null && examId === 'core1') {
      const legacy = await idbGet(OSTORE, 'all');
      if (legacy != null) {
        await idbPut(OSTORE, 'core1', legacy);
        await idbDelete(OSTORE, 'all');
        raw = legacy;
      }
    }
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
async function saveOverrides(examId = state.exam) {
  try { await idbPut(OSTORE, examId, await maybeEncrypt(state.overrides)); }
  catch (e) { console.warn('Save overrides failed', e); }
}

//─── DATA LOAD ───────────────────────────────────────────────
async function loadData() {
  const def = examDef(state.exam);
  const [questionsRes, fixesRes] = await Promise.all([
    fetch(def.questions),
    fetch(def.fixes),
  ]);
  state.questions = questionsRes.ok ? await questionsRes.json() : [];
  state.conceptFixes = fixesRes.ok ? await fixesRes.json() : {};
  state.progress = await loadProgress();
  state.overrides = await loadOverrides();
  // Initialize progress for any new question; migrate older saves
  let migrated = false;
  // 1. Dedupe migration: old per-pretest IDs → canonical IDs via q.sources
  const validIds = new Set(state.questions.map(q => q.id));
  const orphans = Object.keys(state.progress).filter(id => !validIds.has(id));
  for (const oldId of orphans) {
    const m = oldId.match(/^p(\d+)q(\d+)$/);
    if (!m) { delete state.progress[oldId]; migrated = true; continue; }
    const pretest = Number(m[1]), qnum = Number(m[2]);
    const canon = state.questions.find(q =>
      (q.sources || []).some(s => s.pretest === pretest && s.qnum === qnum)
    );
    if (canon) {
      const old = state.progress[oldId];
      const tgt = state.progress[canon.id];
      if (!tgt) {
        state.progress[canon.id] = old;
      } else {
        // Merge by taking the more-advanced progress across both
        tgt.seen = (tgt.seen || 0) + (old.seen || 0);
        tgt.correct = (tgt.correct || 0) + (old.correct || 0);
        tgt.lastSeen = Math.max(tgt.lastSeen || 0, old.lastSeen || 0);
        tgt.updated_at = Math.max(tgt.updated_at || 0, old.updated_at || 0);
        tgt.interval = Math.max(tgt.interval || 0, old.interval || 0);
        tgt.ease = Math.max(tgt.ease ?? 2.5, old.ease ?? 2.5);
        tgt.due = Math.max(tgt.due || 0, old.due || 0);
        const rank = { new: 0, learning: 1, good: 2 };
        if ((rank[old.status] ?? 0) > (rank[tgt.status] ?? 0)) tgt.status = old.status;
      }
    }
    delete state.progress[oldId];
    migrated = true;
  }
  // 2. Fill defaults + migrate SRS fields for every current question
  for (const q of state.questions) {
    const p = state.progress[q.id];
    if (!p) {
      state.progress[q.id] = defaultProgress();
      migrated = true;
    } else if (p.ease === undefined || p.interval === undefined || p.due === undefined) {
      migrateProgress(p);
      migrated = true;
    }
  }
  if (migrated) saveProgress();
}

//─── UTILITIES ───────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function uniqueObjs() {
  const objs = [...new Set(state.questions.map(q => q.obj))].filter(o => o !== '?');
  // Sort numerically (1.1, 1.2, 2.1, ..., 5.6)
  objs.sort((a, b) => {
    const [am, an] = a.split('.').map(Number);
    const [bm, bn] = b.split('.').map(Number);
    return am - bm || an - bn;
  });
  return objs;
}

// Merge a base question with any user-added override (options, image, images)
function getQuestion(q) {
  const o = state.overrides[q.id];
  return o ? { ...q, ...o } : q;
}

function filteredQuestions() {
  let qs = state.questions.slice();
  if (state.filter.obj) qs = qs.filter(q => q.obj === state.filter.obj);
  if (state.filter.due) qs = qs.filter(isDue);
  if (state.filter.search) {
    const q = state.filter.search.toLowerCase();
    qs = qs.filter(x =>
      x.question.toLowerCase().includes(q) ||
      (x.explanation || '').toLowerCase().includes(q)
    );
  }
  if (state.shuffle) {
    const key = `${state.filter.obj}|${state.filter.due}|${state.filter.search}|${qs.length}|${qs.map(x=>x.id).join(',').slice(0,40)}`;
    if (!state._shuffleCache || state._shuffleCache.key !== key) {
      const shuffled = qs.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      state._shuffleCache = { key, list: shuffled };
    }
    return state._shuffleCache.list;
  }
  return qs;
}

function dueCount() {
  return state.questions.filter(isDue).length;
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateHUD() {
  const hud = $('#progress-hud');
  if (!hud) return;
  const parts = [];
  if (state.session) {
    if (state.session.endsAt) parts.push(`⏱ ${formatRemaining(state.session.endsAt - Date.now())}`);
    if (state.session.targetCards) {
      const done = state.session.ratedIds.size;
      parts.push(`🎯 ${done}/${state.session.targetCards}`);
    }
  }
  if (pref('anxiety') !== 'on' && (state.mode === 'study' || state.mode === 'quiz')) {
    const qs = filteredQuestions();
    const total = qs.length;
    const idx = state.currentIndex + 1;
    parts.push(total > 0 ? `${Math.min(idx, total)} / ${total}` : `0 / 0`);
    if (!state.filter.due) parts.push(`${dueCount()} due`);
  }
  hud.textContent = parts.join(' · ');
}

//─── MODE: STUDY (flashcards with self-rating) ──────────────
function renderStudy() {
  $('#mode-title').textContent = 'Study';
  document.documentElement.toggleAttribute('data-revealed', !!state.revealed);
  const qs = filteredQuestions();
  if (qs.length === 0) {
    const msg = state.filter.due
      ? ['✨ All caught up!', 'No cards due right now — come back later, or tap Due again to turn it off and study anything.', 'celebrate']
      : state.filter.search
      ? ['Hmm, nothing matches', `Nothing for "${escapeHtml(state.filter.search)}". Try a different word or clear the search.`, 'sleep']
      : ['No questions', 'Pick an objective below or clear the filter.', 'sleep'];
    $('#main').innerHTML = filterBarHTML() + emptyHTML(msg[0], msg[1], msg[2]);
    renderFilterBar();
    return;
  }
  if (state.currentIndex >= qs.length) state.currentIndex = 0;
  const baseQ = qs[state.currentIndex];
  const q = getQuestion(baseQ);
  const prog = state.progress[q.id];

  if (state.editing) {
    $('#main').innerHTML = `${filterBarHTML()}${renderEditFormHTML(q)}`;
    renderFilterBar();
    updateHUD();
    attachEditEvents(q);
    return;
  }

  const edited = !!state.overrides[q.id];
  const sources = q.sources || [{ pretest: q.pretest, qnum: q.qnum }];
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        <span class="tag" title="Appeared on: ${sources.map(s => `P${s.pretest}Q${s.qnum}`).join(', ')}">P${q.pretest} Q${q.qnum}</span>
        ${sources.length > 1 ? `<span class="tag repeats" title="You missed this on ${sources.length} pretests: ${sources.map(s => `P${s.pretest}Q${s.qnum}`).join(', ')}">🔁 ${sources.length}×</span>` : ''}
        ${prog.seen > 0 ? `<span class="tag numeric">Seen ${prog.seen}×</span>` : ''}
        ${edited ? '<span class="tag edited">✏️ Edited</span>' : ''}
        <button class="tag tag-btn" id="edit-btn" title="Add/edit options and image">✏️ Edit</button>
      </div>
      <div class="card-question">${escapeHtml(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        ${renderWrongPickHTML(q, 'study')}
        <div class="card-section right">
          <div class="label">Correct answer & explanation</div>
          ${formatExplanation(q.explanation)}
        </div>
        <div class="btn-row">
          <button class="action bad" data-rate="again">Again</button>
          <button class="action warn" data-rate="hard">Hard</button>
          <button class="action good" data-rate="good">Good</button>
          <button class="action primary" data-rate="easy">Easy</button>
        </div>
      ` : `
        <div class="btn-row">
          <button class="action" id="prev-btn" aria-label="Previous">← Prev</button>
          <button class="action primary" id="reveal-btn">Reveal answer</button>
          <button class="action" id="skip-btn">Skip →</button>
        </div>
      `}
    </div>
  `;
  renderFilterBar();
  updateHUD();
  attachStudyEvents(q);
  $('#edit-btn')?.addEventListener('click', () => { state.editing = true; renderStudy(); });
}

function attachStudyEvents(q) {
  const reveal = $('#reveal-btn');
  if (reveal) reveal.addEventListener('click', () => { state.revealed = true; renderStudy(); });
  const skip = $('#skip-btn');
  if (skip) skip.addEventListener('click', () => { nextQuestion(); });
  const prev = $('#prev-btn');
  if (prev) prev.addEventListener('click', () => { prevQuestion(); });
  attachOptionEvents(() => renderStudy());
  $$('[data-rate]').forEach(btn => btn.addEventListener('click', () => {
    const rate = btn.dataset.rate;
    recordRating(q.id, rate);
    nextQuestion();
  }));
}

function attachOptionEvents(rerender) {
  const items = $$('.q-options li.q-option');
  const pick = (li) => {
    if (state.revealed) return;
    state.selectedOption = li.dataset.option;
    haptic(5);
    rerender();
  };
  items.forEach((li, i) => {
    li.addEventListener('click', () => pick(li));
    // Radio-group keyboard pattern: Enter/Space selects; arrows move focus.
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(li);
        return;
      }
      if (state.revealed) return;
      let next = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      if (next) { e.preventDefault(); next.focus(); }
    });
  });
}

function recordRating(qid, rate) {
  const p = state.progress[qid];
  p.seen++;
  p.lastSeen = Date.now();
  p.updated_at = p.lastSeen;
  if (rate === 'good' || rate === 'easy') p.correct++;
  schedule(p, rate);
  haptic(10);
  saveProgress();
  onCardRated(qid);
}

function nextQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  state.selectedOption = null;
  if (qs.length === 0) { renderStudy(); return; }
  state.history.push(state.currentIndex);
  if (state.history.length > 50) state.history.shift();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  renderStudy();
}

function prevQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  state.selectedOption = null;
  if (qs.length === 0) { renderStudy(); return; }
  if (state.history.length > 0) {
    state.currentIndex = state.history.pop();
  } else {
    state.currentIndex = state.currentIndex === 0 ? qs.length - 1 : state.currentIndex - 1;
  }
  renderStudy();
}

//─── MODE: QUIZ (same as study but tracks right/wrong explicitly) ──
function renderQuiz() {
  $('#mode-title').textContent = 'Quiz';
  document.documentElement.toggleAttribute('data-revealed', !!state.revealed);
  const qs = filteredQuestions();
  if (qs.length === 0) {
    const msg = state.filter.due
      ? ['✨ All caught up!', 'Nothing due for Quiz — tap Due to turn it off and pick anything.', 'celebrate']
      : state.filter.search
      ? ['Hmm, nothing matches', `No match for "${escapeHtml(state.filter.search)}" — try another word.`, 'sleep']
      : ['No questions', 'Pick an objective or clear the filter.', 'sleep'];
    $('#main').innerHTML = filterBarHTML() + emptyHTML(msg[0], msg[1], msg[2]);
    renderFilterBar();
    return;
  }
  if (state.currentIndex >= qs.length) state.currentIndex = 0;
  const baseQ = qs[state.currentIndex];
  const q = getQuestion(baseQ);
  const prog = state.progress[q.id];
  const accuracy = prog.seen > 0 ? Math.round((prog.correct / prog.seen) * 100) : null;

  if (state.editing) {
    $('#main').innerHTML = `${filterBarHTML()}${renderEditFormHTML(q)}`;
    renderFilterBar();
    updateHUD();
    attachEditEvents(q);
    return;
  }

  const edited = !!state.overrides[q.id];
  const sources = q.sources || [{ pretest: q.pretest, qnum: q.qnum }];
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        ${sources.length > 1 ? `<span class="tag repeats" title="You missed this on ${sources.length} pretests">🔁 ${sources.length}×</span>` : ''}
        ${accuracy !== null ? `<span class="tag numeric">${accuracy}% (${prog.correct}/${prog.seen})</span>` : ''}
        ${edited ? '<span class="tag edited">✏️ Edited</span>' : ''}
        <button class="tag tag-btn" id="edit-btn" title="Add/edit options and image">✏️ Edit</button>
      </div>
      <div class="card-question">${escapeHtml(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        ${renderWrongPickHTML(q, 'quiz')}
        <div class="card-section right">
          <div class="label">Correct answer & explanation</div>
          ${formatExplanation(q.explanation)}
        </div>
        <div class="btn-row">
          <button class="action bad" data-qa="wrong">I got it wrong</button>
          <button class="action good" data-qa="right">I got it right</button>
        </div>
      ` : `
        <p style="color: var(--text-dim); font-size: 14px; margin-bottom: 16px;">
          Think of your answer, then tap reveal.
        </p>
        <div class="btn-row">
          <button class="action" id="prev-btn" aria-label="Previous">← Prev</button>
          <button class="action primary" id="reveal-btn">Reveal</button>
          <button class="action" id="skip-btn">Skip →</button>
        </div>
      `}
    </div>
  `;
  renderFilterBar();
  updateHUD();
  const reveal = $('#reveal-btn');
  if (reveal) reveal.addEventListener('click', () => { state.revealed = true; renderQuiz(); });
  const skip = $('#skip-btn');
  if (skip) skip.addEventListener('click', () => { nextQuizQuestion(); });
  const prev = $('#prev-btn');
  if (prev) prev.addEventListener('click', () => { prevQuizQuestion(); });
  $('#edit-btn')?.addEventListener('click', () => { state.editing = true; renderQuiz(); });
  attachOptionEvents(() => renderQuiz());
  $$('[data-qa]').forEach(btn => btn.addEventListener('click', () => {
    const right = btn.dataset.qa === 'right';
    const p = state.progress[q.id];
    p.seen++;
    p.lastSeen = Date.now();
    p.updated_at = p.lastSeen;
    if (right) p.correct++;
    schedule(p, right ? 'good' : 'again');
    haptic(10);
    saveProgress();
    onCardRated(q.id);
    nextQuizQuestion();
  }));
}

function nextQuizQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  state.selectedOption = null;
  if (qs.length === 0) { renderQuiz(); return; }
  state.history.push(state.currentIndex);
  if (state.history.length > 50) state.history.shift();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  renderQuiz();
}

function prevQuizQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  state.selectedOption = null;
  if (qs.length === 0) { renderQuiz(); return; }
  if (state.history.length > 0) {
    state.currentIndex = state.history.pop();
  } else {
    state.currentIndex = state.currentIndex === 0 ? qs.length - 1 : state.currentIndex - 1;
  }
  renderQuiz();
}

//─── MODE: READING (concept fix sheets) ──────────────────────
function renderReading() {
  $('#mode-title').textContent = 'Reading';
  $('#progress-hud').textContent = '';
  const objs = Object.keys(state.conceptFixes).sort((a, b) => {
    const [am, an] = a.split('.').map(Number);
    const [bm, bn] = b.split('.').map(Number);
    return am - bm || an - bn;
  });

  if (objs.length === 0) {
    $('#main').innerHTML = emptyHTML(
      'No concept fixes yet',
      `${examDef(state.exam).label} has no reading content. Populate ${examDef(state.exam).fixes} and hard-refresh.`,
      'sleep'
    );
    return;
  }

  const html = objs.map(obj => {
    const fix = state.conceptFixes[obj];
    return `
      <div class="obj-section">
        <h2>OBJ ${obj} — ${escapeHtml(fix.title)}</h2>
        ${fix.content}
      </div>
    `;
  }).join('');

  $('#main').innerHTML = `<div class="reading-list">${html}</div>`;
}

//─── MODE: STATS ─────────────────────────────────────────────
function renderStats() {
  $('#mode-title').textContent = 'Stats';
  $('#progress-hud').textContent = '';
  const qs = state.questions;
  const seen = qs.filter(q => state.progress[q.id].seen > 0);
  const mastered = qs.filter(q => state.progress[q.id].status === 'good');
  const totalCorrect = qs.reduce((s, q) => s + state.progress[q.id].correct, 0);
  const totalSeen = qs.reduce((s, q) => s + state.progress[q.id].seen, 0);
  const acc = totalSeen > 0 ? Math.round((totalCorrect / totalSeen) * 100) : 0;

  // Per-OBJ breakdown
  const objs = uniqueObjs();
  const objStats = objs.map(obj => {
    const objQs = qs.filter(q => q.obj === obj);
    const objSeen = objQs.reduce((s, q) => s + state.progress[q.id].seen, 0);
    const objCorrect = objQs.reduce((s, q) => s + state.progress[q.id].correct, 0);
    const objAcc = objSeen > 0 ? Math.round((objCorrect / objSeen) * 100) : 0;
    const objMastered = objQs.filter(q => state.progress[q.id].status === 'good').length;
    return { obj, total: objQs.length, seen: objSeen, accuracy: objAcc, mastered: objMastered };
  });

  const streak = getStreak();
  $('#main').innerHTML = `
    <div class="stats-wrap">
      <h3 class="stats-h">Active exam</h3>
      <div class="settings-panel">
        <div class="settings-row">
          <span id="exam-label">Dataset</span>
          <span class="seg-control" data-exam-switch role="radiogroup" aria-labelledby="exam-label">
            ${EXAM_IDS.map(id => `
              <button data-exam="${id}" role="radio"
                      aria-checked="${state.exam === id ? 'true' : 'false'}"
                      class="${state.exam === id ? 'active' : ''}">
                ${examDef(id).label.replace(/\s*\(.*\)$/, '')}
              </button>
            `).join('')}
          </span>
        </div>
        ${qs.length === 0 ? `
          <div class="settings-row">
            <span class="settings-meta">
              <strong>${escapeHtml(examDef(state.exam).label)} has no questions yet.</strong>
              <br>Drop your extracted questions into <code>${escapeHtml(examDef(state.exam).questions)}</code>
              and hard-refresh the app. See README → "Adding a new exam dataset".
            </span>
          </div>
        ` : `
          <div class="settings-row">
            <span class="settings-meta">
              ${qs.length} cards in ${escapeHtml(examDef(state.exam).label)}. Progress is tracked separately per exam.
            </span>
          </div>
        `}
      </div>

      <div class="stats-row numeric-ui">
        <div class="stat-card">
          <div class="number">${seen.length}</div>
          <div class="label">Seen</div>
        </div>
        <div class="stat-card">
          <div class="number">${mastered.length}</div>
          <div class="label">Mastered</div>
        </div>
        <div class="stat-card">
          <div class="number">${qs.length}</div>
          <div class="label">Total</div>
        </div>
        <div class="stat-card">
          <div class="number">${acc}%</div>
          <div class="label">Accuracy</div>
        </div>
      </div>
      <div class="stats-row">
        <div class="stat-card">
          <div class="number">🔥 ${streak.count}</div>
          <div class="label">Day streak</div>
        </div>
        <div class="stat-card">
          <div class="number">${streak.today}</div>
          <div class="label">Today</div>
        </div>
      </div>

      <h3 class="stats-h">Focus session</h3>
      <div class="settings-panel">
        ${state.session ? `
          <div class="settings-row">
            <span>Session running — ${state.session.targetDesc}${state.session.endsAt ? ` · ${formatRemaining(state.session.endsAt - Date.now())} left` : ''}${state.session.targetCards ? ` · ${state.session.ratedIds.size}/${state.session.targetCards} done` : ''}</span>
            <button class="small-btn" id="session-end">End now</button>
          </div>
        ` : `
          <div class="settings-row">
            <span>Time</span>
            <span class="settings-actions">
              <button class="small-btn" data-session-min="5">5 min</button>
              <button class="small-btn" data-session-min="15">15 min</button>
              <button class="small-btn" data-session-min="25">25 min</button>
            </span>
          </div>
          <div class="settings-row">
            <span>Card count</span>
            <span class="settings-actions">
              <button class="small-btn" data-session-cards="1">1</button>
              <button class="small-btn" data-session-cards="3">3</button>
              <button class="small-btn" data-session-cards="5">5</button>
              <button class="small-btn" data-session-cards="10">10</button>
            </span>
          </div>
        `}
      </div>

      <h3 class="stats-h">Accessibility</h3>
      <div class="settings-panel">
        <div class="settings-row">
          <span id="pref-size-label">Text size</span>
          <span class="seg-control" data-pref="size" role="radiogroup" aria-labelledby="pref-size-label">
            <button data-val="small" role="radio" aria-checked="${pref('size')==='small'?'true':'false'}" class="${pref('size')==='small'?'active':''}" aria-label="Small">S</button>
            <button data-val="medium" role="radio" aria-checked="${pref('size')==='medium'?'true':'false'}" class="${pref('size')==='medium'?'active':''}" aria-label="Medium">M</button>
            <button data-val="large" role="radio" aria-checked="${pref('size')==='large'?'true':'false'}" class="${pref('size')==='large'?'active':''}" aria-label="Large">L</button>
            <button data-val="xlarge" role="radio" aria-checked="${pref('size')==='xlarge'?'true':'false'}" class="${pref('size')==='xlarge'?'active':''}" aria-label="Extra large">XL</button>
          </span>
        </div>
        <div class="settings-row">
          <span id="pref-font-label">Font</span>
          <span class="seg-control" data-pref="font" role="radiogroup" aria-labelledby="pref-font-label">
            <button data-val="system" role="radio" aria-checked="${pref('font')==='system'?'true':'false'}" class="${pref('font')==='system'?'active':''}">System</button>
            <button data-val="atkinson" role="radio" aria-checked="${pref('font')==='atkinson'?'true':'false'}" class="${pref('font')==='atkinson'?'active':''}">Atkinson</button>
            <button data-val="opendyslexic" role="radio" aria-checked="${pref('font')==='opendyslexic'?'true':'false'}" class="${pref('font')==='opendyslexic'?'active':''}">OpenDyslexic</button>
          </span>
        </div>
        <label class="settings-row">
          <span>High contrast</span>
          <input type="checkbox" data-pref="contrast" data-on="high" data-off="normal" ${pref('contrast')==='high'?'checked':''}>
        </label>
        <label class="settings-row">
          <span>Reduce motion</span>
          <input type="checkbox" data-pref="motion" data-on="reduced" data-off="full" ${pref('motion')==='reduced'?'checked':''}>
        </label>
        <label class="settings-row">
          <span>Haptic feedback</span>
          <input type="checkbox" data-pref="haptics" data-on="on" data-off="off" ${pref('haptics')==='on'?'checked':''}>
        </label>
        <label class="settings-row">
          <span>Auto-sync to cloud (every 5s after save)</span>
          <input type="checkbox" data-pref="autosync" data-on="on" data-off="off" ${pref('autosync')==='on'?'checked':''}>
        </label>
        <label class="settings-row" title="Hides accuracy %, progress numbers, and mastery bars. Keeps streak + session timer.">
          <span>Anxiety Mode (hide numbers)</span>
          <input type="checkbox" data-pref="anxiety" data-on="on" data-off="off" ${pref('anxiety')==='on'?'checked':''}>
        </label>
        <label class="settings-row">
          <span>Shake to toggle shuffle (iOS)</span>
          <input type="checkbox" id="shake-toggle" data-pref="shake" data-on="on" data-off="off" ${pref('shake')==='on'?'checked':''}>
        </label>
        <div class="settings-row">
          <span id="pref-sound-label">Focus sound</span>
          <span class="seg-control" data-pref="sound" role="radiogroup" aria-labelledby="pref-sound-label">
            <button data-val="off" role="radio" aria-checked="${pref('sound')==='off'?'true':'false'}" class="${pref('sound')==='off'?'active':''}">Off</button>
            <button data-val="white" role="radio" aria-checked="${pref('sound')==='white'?'true':'false'}" class="${pref('sound')==='white'?'active':''}">White</button>
            <button data-val="pink" role="radio" aria-checked="${pref('sound')==='pink'?'true':'false'}" class="${pref('sound')==='pink'?'active':''}">Pink</button>
            <button data-val="brown" role="radio" aria-checked="${pref('sound')==='brown'?'true':'false'}" class="${pref('sound')==='brown'?'active':''}">Brown</button>
          </span>
        </div>
      </div>

      <h3 class="stats-h numeric-ui">Mastery by Objective</h3>
      <div class="obj-bar-list numeric-ui">
        ${objStats.map(s => `
          <div class="obj-bar">
            <div class="obj-label">OBJ ${s.obj}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${s.total > 0 ? (s.mastered / s.total) * 100 : 0}%"></div>
            </div>
            <div class="obj-count">${s.mastered}/${s.total}</div>
          </div>
        `).join('')}
      </div>

      <h3 class="stats-h">Options</h3>
      <div class="settings-panel">
        <label class="settings-row">
          <span>🔀 Shuffle questions</span>
          <input type="checkbox" id="shuffle-toggle" ${state.shuffle ? 'checked' : ''}>
        </label>
        <div class="settings-row">
          <span>💾 Progress</span>
          <span class="settings-actions">
            <button class="small-btn" id="export-btn">Export</button>
            <button class="small-btn" id="import-btn">Import</button>
          </span>
        </div>
        <div class="settings-row">
          <span>✏️ Question edits <span class="settings-count">${Object.keys(state.overrides).length}</span></span>
          <span class="settings-actions">
            <button class="small-btn" id="export-overrides-btn">Export</button>
            <button class="small-btn" id="import-overrides-btn">Import</button>
          </span>
        </div>
      </div>

      <h3 class="stats-h">App lock (encrypted at rest)</h3>
      <div class="settings-panel">
        ${isPinSet() ? `
          <div class="settings-row">
            <span>
              <strong>PIN lock is on.</strong>
              <span class="settings-meta" style="display:block; margin-top:2px;">
                Progress, edits, and drawings are AES-GCM encrypted in your browser.
                Key lives in memory only — you'll re-enter the PIN next launch.
              </span>
            </span>
            <span class="settings-actions">
              <button class="small-btn" id="pin-change">Change</button>
              <button class="small-btn" id="pin-remove">Remove</button>
            </span>
          </div>
        ` : `
          <div class="settings-row">
            <span>
              Lock the app with a PIN. Your saved progress, question edits, and
              scratchpad drawings get encrypted on device — unreadable without
              the PIN, even via DevTools.
            </span>
            <span class="settings-actions">
              <button class="small-btn" id="pin-setup">Set PIN</button>
            </span>
          </div>
        `}
      </div>

      <h3 class="stats-h">Cloud sync (Supabase)</h3>
      <div class="settings-panel">
        <div class="settings-stack">
          <label class="settings-vrow">
            <span class="settings-vlabel">Project URL</span>
            <input id="cloud-url" type="url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(getCloudCfg().url)}">
          </label>
          <label class="settings-vrow">
            <span class="settings-vlabel">Anon key</span>
            <input id="cloud-key" type="password" placeholder="eyJ…" value="${escapeHtml(getCloudCfg().key)}">
          </label>
          <label class="settings-vrow">
            <span class="settings-vlabel">Sync key (any string you pick — same on every device)</span>
            <input id="cloud-sync" type="text" placeholder="amanda-aplus" value="${escapeHtml(getCloudCfg().syncKey)}">
          </label>
          <div class="settings-actions" style="justify-content: space-between; padding: 4px 0;">
            <span class="settings-meta" id="cloud-status">${
              localStorage.getItem('supabase.lastSync')
                ? `Last sync: ${new Date(localStorage.getItem('supabase.lastSync')).toLocaleString()}`
                : 'Not yet synced.'
            }</span>
            <span class="settings-actions">
              <button class="small-btn" id="cloud-save">Save</button>
              <button class="small-btn" id="cloud-pull">⬇ Pull</button>
              <button class="small-btn" id="cloud-push">⬆ Push</button>
            </span>
          </div>
        </div>
      </div>

      <button class="reset-btn" id="reset-btn">Reset progress for ${escapeHtml(examDef(state.exam).label)}</button>
    </div>
  `;
  $('#reset-btn').addEventListener('click', async () => {
    if (confirm(`Reset ${examDef(state.exam).label} progress? This cannot be undone. Progress for other exams is unaffected.`)) {
      await clearProgress();
      for (const q of state.questions) {
        state.progress[q.id] = defaultProgress();
      }
      await saveProgress();
      renderStats();
    }
  });
  $('#export-btn')?.addEventListener('click', exportProgress);
  $('#import-btn')?.addEventListener('click', importProgress);
  $('#export-overrides-btn')?.addEventListener('click', exportOverrides);
  $('#import-overrides-btn')?.addEventListener('click', importOverrides);
  $('#shuffle-toggle')?.addEventListener('change', (e) => {
    state.shuffle = e.target.checked;
    localStorage.setItem('shuffle', state.shuffle ? 'true' : 'false');
    state._shuffleCache = null;
  });

  // Accessibility: segmented controls (size / font / sound)
  $$('.seg-control[data-pref]').forEach(group => {
    const key = group.dataset.pref;
    group.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      setPref(key, btn.dataset.val);
      if (key === 'sound') setSound(btn.dataset.val);
      renderStats();
    }));
  });
  // Exam switcher: different data attribute so it doesn't collide with prefs
  $$('[data-exam-switch] button[data-exam]').forEach(btn => {
    btn.addEventListener('click', () => switchExam(btn.dataset.exam));
  });
  // Accessibility: checkboxes (contrast / motion / haptics / autosync / anxiety / shake)
  $$('input[type="checkbox"][data-pref]').forEach(input => {
    input.addEventListener('change', async (e) => {
      const key = input.dataset.pref;
      const val = e.target.checked ? input.dataset.on : input.dataset.off;
      if (key === 'shake' && val === 'on') {
        const granted = await enableShake();
        if (!granted) { e.target.checked = false; return; }
      } else if (key === 'shake' && val === 'off') {
        disableShake();
      }
      setPref(key, val);
      if (key === 'anxiety') updateHUD();
    });
  });
  // Focus session buttons (time-based or card-count)
  $$('button[data-session-min]').forEach(btn => btn.addEventListener('click', () => {
    startSession({ minutes: Number(btn.dataset.sessionMin) });
    renderStats();
  }));
  $$('button[data-session-cards]').forEach(btn => btn.addEventListener('click', () => {
    startSession({ targetCards: Number(btn.dataset.sessionCards) });
    renderStats();
  }));
  $('#session-end')?.addEventListener('click', () => { endSession(false); renderStats(); });

  $('#pin-setup')?.addEventListener('click', () => pinSetupFlow());
  $('#pin-change')?.addEventListener('click', () => pinChangeFlow());
  $('#pin-remove')?.addEventListener('click', () => pinRemoveFlow());

  $('#cloud-save')?.addEventListener('click', () => {
    saveCloudCfg($('#cloud-url').value.trim(), $('#cloud-key').value.trim(), $('#cloud-sync').value.trim());
    setCloudStatus('Configuration saved.');
  });
  $('#cloud-push')?.addEventListener('click', async () => {
    setCloudStatus('Pushing…');
    try {
      saveCloudCfg($('#cloud-url').value.trim(), $('#cloud-key').value.trim(), $('#cloud-sync').value.trim());
      await cloudPush();
      setCloudStatus(`Pushed ${new Date().toLocaleTimeString()}`);
    } catch (e) { setCloudStatus(`Push failed: ${e.message}`, true); }
  });
  $('#cloud-pull')?.addEventListener('click', async () => {
    if (!confirm('Pull will overwrite local progress with cloud data. Continue?')) return;
    setCloudStatus('Pulling…');
    try {
      saveCloudCfg($('#cloud-url').value.trim(), $('#cloud-key').value.trim(), $('#cloud-sync').value.trim());
      await cloudPull();
      setCloudStatus(`Pulled ${new Date().toLocaleTimeString()}`);
      renderStats();
    } catch (e) { setCloudStatus(`Pull failed: ${e.message}`, true); }
  });
}

function setCloudStatus(text, isError = false) {
  const el = $('#cloud-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--bad)' : 'var(--text-dim)';
}

//─── FILTER BAR (shared by Study + Quiz) ─────────────────────
function filterBarHTML() {
  const objs = uniqueObjs();
  const counts = {};
  for (const o of objs) counts[o] = state.questions.filter(q => q.obj === o).length;
  return `
    <div class="search-row" role="search">
      <input id="search-input" type="search" placeholder="Search question text…"
             aria-label="Search questions"
             value="${escapeHtml(state.filter.search)}" autocomplete="off">
      ${state.filter.search ? '<button id="search-clear" class="small-btn" aria-label="Clear search">✕</button>' : ''}
    </div>
    <div class="filter-bar" role="group" aria-label="Filter questions">
      <button class="due-chip ${state.filter.due ? 'active' : ''}" data-filter="due"
              aria-pressed="${state.filter.due ? 'true' : 'false'}">
        ${state.filter.due ? '✓ ' : ''}Due (${dueCount()})
      </button>
      <button class="${state.filter.obj === null ? 'active' : ''}" data-filter="all"
              aria-pressed="${state.filter.obj === null ? 'true' : 'false'}">All (${state.questions.length})</button>
      ${objs.map(o => `
        <button class="${state.filter.obj === o ? 'active' : ''}" data-filter="${o}"
                aria-pressed="${state.filter.obj === o ? 'true' : 'false'}">
          OBJ ${o} (${counts[o]})
        </button>
      `).join('')}
    </div>
  `;
}

function renderFilterBar() {
  $$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    if (f === 'due') state.filter.due = !state.filter.due;
    else if (f === 'all') state.filter.obj = null;
    else state.filter.obj = f;
    state.currentIndex = 0;
    state.revealed = false;
    state.editing = false;
    state.selectedOption = null;
    state.history = [];
    state._shuffleCache = null;
    if (state.mode === 'study') renderStudy();
    else if (state.mode === 'quiz') renderQuiz();
  }));

  const searchInput = $('#search-input');
  if (searchInput) {
    // Re-apply so caret isn't lost when the filter bar rerenders
    let debounce;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounce);
      const val = e.target.value;
      debounce = setTimeout(() => {
        state.filter.search = val;
        state.currentIndex = 0;
        state.revealed = false;
        state.editing = false;
        state.selectedOption = null;
        state.history = [];
        state._shuffleCache = null;
        if (state.mode === 'study') renderStudy();
        else if (state.mode === 'quiz') renderQuiz();
        // Restore focus + caret after rerender
        const again = $('#search-input');
        if (again) { again.focus(); again.setSelectionRange(val.length, val.length); }
      }, 200);
    });
  }
  const searchClear = $('#search-clear');
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      state.filter.search = '';
      state.currentIndex = 0;
      state.revealed = false;
      state.editing = false;
      state.selectedOption = null;
      state.history = [];
      state._shuffleCache = null;
      if (state.mode === 'study') renderStudy();
      else if (state.mode === 'quiz') renderQuiz();
    });
  }
}

//─── SCRATCH PAD (Apple Pencil) ──────────────────────────────
function renderScratchpadHTML(q) {
  // PBQ with an image → overlay mode: canvas layered over the image so the
  // user can annotate / label components directly.
  const hasImage = q && (q.image || (q.images && q.images.length));
  if (hasImage) {
    const src = q.image || q.images[0];
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

function attachScratchpadEvents(q) {
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

//─── QUESTION IMAGE + OPTIONS ────────────────────────────────
function renderImageHTML(q) {
  // Support both `image` (single path) and `images` (array)
  const imgs = q.images || (q.image ? [q.image] : []);
  if (imgs.length > 0) {
    return `<div class="q-images">${imgs.map(src =>
      `<img src="${escapeHtml(src)}" alt="Question figure" loading="lazy">`
    ).join('')}</div>`;
  }
  // PBQ with no image → make it clear it's missing
  if (q.qtype === 'PBQ') {
    return `<div class="q-image-missing">
      <strong>⚠️ Image not available.</strong>
      This PBQ references a figure from the original pretest. Drop a PNG/JPG at
      <code>images/${escapeHtml(q.id)}.png</code> and add <code>"image": "images/${escapeHtml(q.id)}.png"</code>
      to this question in <code>data/questions.json</code> to show it here.
      The explanation below still describes what was being asked.
    </div>`;
  }
  return '';
}

// Render the "wrong pick" callout shown on reveal. Returns '' when there's
// no wrong-pick data for this card (e.g. p1q36 has been deduped from five
// pretest versions, so preserving a single per-version wrong pick would be
// misleading). `mode` is 'study' | 'quiz' — changes the label wording.
function renderWrongPickHTML(q, mode) {
  const picks = Array.isArray(q.wrong_picks) ? q.wrong_picks.filter(Boolean) : [];
  const single = (q.wrong_pick || '').trim();
  if (picks.length === 0 && !single) return '';
  const label = mode === 'quiz'
    ? `Common wrong pick${picks.length > 1 ? `s (${picks.length})` : ''}`
    : `You picked (wrong)${picks.length > 1 ? ` — ${picks.length} different ways` : ''}`;
  const body = picks.length > 1
    ? `<ul class="wrong-picks">${picks.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : `<p>${escapeHtml(picks[0] || single)}</p>`;
  return `
    <div class="card-section wrong">
      <div class="label">${label}</div>
      ${body}
    </div>`;
}

function renderOptionsHTML(q) {
  if (!Array.isArray(q.options) || q.options.length === 0) return '';
  const picked = state.selectedOption;
  const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  // Multiple Answer questions use correct_picks (array); single-answer uses correct_short.
  const correctSet = new Set(
    Array.isArray(q.correct_picks) && q.correct_picks.length
      ? q.correct_picks.map(norm)
      : q.correct_short ? [norm(q.correct_short)] : []
  );
  const isCorrect = (opt) => correctSet.has(norm(opt));
  const cls = (opt) => {
    const c = ['q-option'];
    if (!state.revealed) {
      if (picked === opt) c.push('picked');
    } else {
      if (isCorrect(opt)) c.push('correct');
      else if (picked === opt) c.push('wrong');
      if (picked === opt) c.push('yours');
    }
    return c.join(' ');
  };
  // role=radio + aria-checked makes screen readers announce each option as a
  // choice; tabindex lets keyboard users focus the first option and arrow
  // through the rest (see attachOptionEvents).
  return `
    <ol class="q-options" type="A" role="radiogroup" aria-label="Answer choices">
      ${q.options.map((opt, i) => {
        const checked = picked === opt;
        const tab = (picked ? checked : i === 0) ? 0 : -1;
        const describe = state.revealed
          ? (isCorrect(opt) ? ' (correct answer)' : checked ? ' (your pick, incorrect)' : '')
          : '';
        return `<li class="${cls(opt)}" role="radio"
            aria-checked="${checked ? 'true' : 'false'}"
            tabindex="${tab}"
            data-option="${escapeHtml(opt)}"
            aria-label="${escapeHtml(opt + describe)}">${escapeHtml(opt)}</li>`;
      }).join('')}
    </ol>`;
}

//─── IN-APP QUESTION EDITOR ──────────────────────────────────
function renderEditFormHTML(q) {
  const optsText = (q.options || []).join('\n');
  const imgVal = q.image || (q.images && q.images[0]) || '';
  return `
    <div class="card edit-card">
      <h3 class="edit-title">Edit question <span class="edit-id">${escapeHtml(q.id)}</span></h3>
      <p class="edit-question">${escapeHtml(q.question)}</p>

      <label class="edit-field">
        <span class="edit-label">Multiple-choice options (one per line)</span>
        <textarea id="edit-options" rows="6" placeholder="Cable modem&#10;DSL&#10;ONT&#10;SDN">${escapeHtml(optsText)}</textarea>
        <span class="edit-hint">Tip: enter the four answer choices. Order doesn't matter — the app doesn't grade clicks.</span>
      </label>

      <label class="edit-field">
        <span class="edit-label">Image URL (PBQs)</span>
        <input id="edit-image" type="text" value="${escapeHtml(imgVal)}" placeholder="images/${escapeHtml(q.id)}.png or https://…">
        <span class="edit-hint">Drop a PNG/JPG into the project's <code>images/</code> folder and use that path, or paste any URL.</span>
      </label>

      <div class="btn-row">
        <button class="action" id="edit-cancel">Cancel</button>
        ${state.overrides[q.id] ? '<button class="action bad" id="edit-clear">Clear edits</button>' : ''}
        <button class="action primary" id="edit-save">Save</button>
      </div>
    </div>
  `;
}

function attachEditEvents(q) {
  const close = () => {
    state.editing = false;
    if (state.mode === 'study') renderStudy();
    else if (state.mode === 'quiz') renderQuiz();
  };
  $('#edit-cancel').addEventListener('click', close);
  $('#edit-clear')?.addEventListener('click', async () => {
    delete state.overrides[q.id];
    await saveOverrides();
    close();
  });
  $('#edit-save').addEventListener('click', async () => {
    const optsText = $('#edit-options').value.trim();
    const imgVal = $('#edit-image').value.trim();
    const override = {};
    if (optsText) {
      override.options = optsText.split('\n').map(s => s.trim()).filter(Boolean);
    }
    if (imgVal) override.image = imgVal;
    if (Object.keys(override).length === 0) {
      delete state.overrides[q.id];
    } else {
      state.overrides[q.id] = override;
    }
    await saveOverrides();
    close();
  });
}

//─── HELPERS ─────────────────────────────────────────────────

function emptyHTML(title, sub, mood = 'sleep') {
  return `<div class="empty-state">
    <div class="empty-mascot">${MASCOT(mood)}</div>
    <h3>${title}</h3>
    <p>${sub}</p>
  </div>`;
}

//─── ROUTING ─────────────────────────────────────────────────
async function switchExam(newExam) {
  if (!EXAM_IDS.includes(newExam) || newExam === state.exam) return;
  // Persist current exam's progress before switching to avoid losing any
  // rating that happened between the last save and the switch click.
  await saveProgress();
  await saveOverrides();
  state.exam = newExam;
  localStorage.setItem('exam', newExam);
  // Reset nav + filter state so we don't point at a card index that doesn't
  // exist in the new dataset.
  state.filter = { obj: null, due: false, search: '' };
  state.currentIndex = 0;
  state.revealed = false;
  state.editing = false;
  state.selectedOption = null;
  state.history = [];
  state._shuffleCache = null;
  try { await loadData(); }
  catch (e) { toast('Couldn\'t load ' + examDef(newExam).label + ': ' + e.message, 'error', 5000); }
  toast('Switched to ' + examDef(newExam).label, 'info');
  // If the active tab is Stats we re-render Stats; otherwise jump to Study.
  if (state.mode === 'stats') renderStats();
  else setMode('study');
}

function setMode(mode) {
  state.mode = mode;
  state.currentIndex = 0;
  state.revealed = false;
  state.editing = false;
  state.selectedOption = null;
  state.history = [];
  state._shuffleCache = null;
  $$('.tab').forEach(t => {
    const active = t.dataset.mode === mode;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (mode === 'study') renderStudy();
  else if (mode === 'quiz') renderQuiz();
  else if (mode === 'reading') renderReading();
  else if (mode === 'stats') renderStats();
}

//─── FOCUS SOUND (Web Audio, no downloads) ───────────────────
let _audioCtx = null;
let _audioSrc = null;
let _audioGain = null;

function generateNoiseBuffer(ctx, type) {
  const size = 2 * ctx.sampleRate;  // 2 seconds, looped
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (type === 'white') {
    for (let i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
  } else if (type === 'pink') {
    // Voss-McCartney approximation — cheap, good enough
    let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
    for (let i = 0; i < size; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < size; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

function setSound(type) {
  if (_audioSrc) { try { _audioSrc.stop(); } catch {} _audioSrc = null; }
  if (type === 'off') return;
  if (!_audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    _audioCtx = new Ctor();
  }
  _audioCtx.resume();
  if (!_audioGain) {
    _audioGain = _audioCtx.createGain();
    _audioGain.gain.value = 0.15;
    _audioGain.connect(_audioCtx.destination);
  }
  const src = _audioCtx.createBufferSource();
  src.buffer = generateNoiseBuffer(_audioCtx, type);
  src.loop = true;
  src.connect(_audioGain);
  src.start();
  _audioSrc = src;
}

//─── SHAKE TO SHUFFLE (DeviceMotion, iOS-permission-aware) ───
let _shakeInstalled = false;
let _shakeLastFire = 0;

function onShakeMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
  const now = Date.now();
  if (mag > 25 && now - _shakeLastFire > 1200) {
    _shakeLastFire = now;
    haptic([20, 40, 20]);
    state.shuffle = !state.shuffle;
    localStorage.setItem('shuffle', state.shuffle ? 'true' : 'false');
    state._shuffleCache = null;
    if (state.mode === 'study') renderStudy();
    else if (state.mode === 'quiz') renderQuiz();
  }
}

async function enableShake() {
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

function disableShake() {
  if (!_shakeInstalled) return;
  window.removeEventListener('devicemotion', onShakeMotion);
  _shakeInstalled = false;
}

//─── FOCUS MODE ──────────────────────────────────────────────
function toggleFocus() {
  state.focus = !state.focus;
  document.documentElement.toggleAttribute('data-focus', state.focus);
  haptic(5);
  const btn = $('#focus-btn');
  if (btn) {
    btn.textContent = state.focus ? '🔓' : '🔒';
    btn.setAttribute('aria-pressed', state.focus ? 'true' : 'false');
  }
}

//─── THEME (auto / light / dark) ─────────────────────────────
function setTheme(theme) {
  // theme: 'auto' | 'light' | 'dark'
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }
  const btn = $('#theme-btn');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🌓';
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const current = localStorage.getItem('theme') || 'auto';
  const next = order[(order.indexOf(current) + 1) % order.length];
  setTheme(next);
  haptic(5);
}

//─── EXPORT / IMPORT PROGRESS ────────────────────────────────
function exportProgress() {
  const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aplus-study-progress-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importProgress() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object of { questionId: progress }');
      const cardCount = Object.keys(data).length;
      if (!confirm(`Replace progress with ${cardCount} cards from this file?`)) return;
      state.progress = data;
      for (const q of state.questions) {
        if (!state.progress[q.id]) state.progress[q.id] = defaultProgress();
        else migrateProgress(state.progress[q.id]);
      }
      await saveProgress();
      renderStats();
      toast('Progress imported.', 'success');
    } catch (e) {
      toast('Import failed: ' + e.message, 'error', 5000);
    }
  });
  input.click();
}

function exportOverrides() {
  const blob = new Blob([JSON.stringify(state.overrides, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aplus-study-overrides-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importOverrides() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object of { questionId: { options?, image? } }');
      const choice = confirm(`Merge ${Object.keys(data).length} edits into existing overrides?\n\nClick OK to merge (existing edits kept), Cancel to replace.`);
      state.overrides = choice ? { ...state.overrides, ...data } : data;
      await saveOverrides();
      renderStats();
      toast('Overrides imported.', 'success');
    } catch (e) {
      toast('Import failed: ' + e.message, 'error', 5000);
    }
  });
  input.click();
}

//─── SUPABASE CLOUD SYNC (optional) ──────────────────────────
// Stores progress + overrides in a single Postgres row keyed by sync_key.
// User configures URL + anon key + sync_key once, then can push / pull.
function getCloudCfg() {
  return {
    url: (localStorage.getItem('supabase.url') || '').trim().replace(/\/+$/, ''),
    key: (localStorage.getItem('supabase.key') || '').trim(),
    syncKey: (localStorage.getItem('supabase.syncKey') || '').trim(),
  };
}

function saveCloudCfg(url, key, syncKey) {
  localStorage.setItem('supabase.url', url);
  localStorage.setItem('supabase.key', key);
  localStorage.setItem('supabase.syncKey', syncKey);
}

function cloudHeaders(key, extra = {}) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Cloud payload v2 bundles every exam's progress + overrides in one row so a
// single push/pull syncs Core 1 and Core 2 together. v1 payloads (pre-multi-
// exam) are auto-migrated into the "core1" slot on pull.
async function gatherAllExamsForCloud() {
  // Read the other exams straight from IDB (decrypted with the session key
  // if the PIN is on), while the active exam lives in state.
  const progress = {};
  const overrides = {};
  for (const id of EXAM_IDS) {
    if (id === state.exam) {
      progress[id] = state.progress;
      overrides[id] = state.overrides;
    } else {
      progress[id] = await loadProgress(id);
      overrides[id] = await loadOverrides(id);
    }
  }
  return { progress, overrides };
}

async function cloudPush() {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const bundle = await gatherAllExamsForCloud();
  const body = JSON.stringify({
    sync_key: syncKey,
    data: { version: 2, progress: bundle.progress, overrides: bundle.overrides },
    updated_at: new Date().toISOString(),
  });
  const res = await fetch(`${url}/rest/v1/progress`, {
    method: 'POST',
    headers: cloudHeaders(key, { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body,
  });
  if (!res.ok) throw new Error(`Push ${res.status}: ${(await res.text()).slice(0, 200)}`);
  localStorage.setItem('supabase.lastSync', new Date().toISOString());
}

function normalizeCloudData(data) {
  // v1 (legacy): { progress: {id: {...}}, overrides: {...} } — single-exam.
  // v2:         { progress: {examId: {id: {...}}}, overrides: {examId: {...}} }
  if (data?.version === 2) {
    return { progress: data.progress || {}, overrides: data.overrides || {} };
  }
  return {
    progress:  { core1: data?.progress  || {} },
    overrides: { core1: data?.overrides || {} },
  };
}

async function cloudPull({ merge = true } = {}) {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const res = await fetch(`${url}/rest/v1/progress?sync_key=eq.${encodeURIComponent(syncKey)}&select=data,updated_at`, {
    headers: cloudHeaders(key),
  });
  if (!res.ok) throw new Error(`Pull ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`No row found for sync key "${syncKey}"`);
  const { progress: cloudProgressByExam, overrides: cloudOverridesByExam } = normalizeCloudData(rows[0].data || {});

  for (const examId of EXAM_IDS) {
    const cloudProgress  = cloudProgressByExam[examId]  || {};
    const cloudOverrides = cloudOverridesByExam[examId] || {};
    const isActive = examId === state.exam;
    const local = isActive
      ? { progress: state.progress,  overrides: state.overrides }
      : { progress: await loadProgress(examId), overrides: await loadOverrides(examId) };

    if (merge) {
      // Per-card last-write-wins using updated_at (falls back to lastSeen)
      for (const [id, cp] of Object.entries(cloudProgress)) {
        const lp = local.progress[id];
        if (!lp) { local.progress[id] = cp; continue; }
        const cTime = cp.updated_at || cp.lastSeen || 0;
        const lTime = lp.updated_at || lp.lastSeen || 0;
        if (cTime > lTime) local.progress[id] = cp;
      }
      // Overrides: prefer the side with more fields (naïve — rare to concurrently edit)
      for (const [id, co] of Object.entries(cloudOverrides)) {
        const lo = local.overrides[id];
        if (!lo || Object.keys(co).length > Object.keys(lo).length) {
          local.overrides[id] = co;
        }
      }
    } else {
      local.progress = cloudProgress;
      local.overrides = cloudOverrides;
    }

    if (isActive) {
      state.progress  = local.progress;
      state.overrides = local.overrides;
      // Re-apply defaults/migrations for cards the cloud didn't cover
      for (const q of state.questions) {
        if (!state.progress[q.id]) state.progress[q.id] = defaultProgress();
        else migrateProgress(state.progress[q.id]);
      }
      await saveProgress();
      await saveOverrides();
    } else {
      // Write the updated row back under the right exam's key
      const savedExam = state.exam;
      state.exam = examId;
      const savedProgress = state.progress, savedOverrides = state.overrides;
      state.progress  = local.progress;
      state.overrides = local.overrides;
      await saveProgress();
      await saveOverrides();
      state.exam = savedExam;
      state.progress  = savedProgress;
      state.overrides = savedOverrides;
    }
  }
  localStorage.setItem('supabase.lastSync', new Date().toISOString());
}

//─── KEYBOARD SHORTCUTS ──────────────────────────────────────
function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Let the user type in inputs/textareas
    if (e.target.matches('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();

    // Global shortcuts
    if (key === 't') { e.preventDefault(); cycleTheme(); return; }
    if (key === 'f') { e.preventDefault(); toggleFocus(); return; }
    if (key === 'escape' && state.focus) { e.preventDefault(); toggleFocus(); return; }

    // Study / Quiz navigation
    if (state.mode === 'study' || state.mode === 'quiz') {
      if (key === 'arrowright' || key === 'k' || key === 'n') {
        e.preventDefault();
        state.mode === 'study' ? nextQuestion() : nextQuizQuestion();
        return;
      }
      if (key === 'arrowleft' || key === 'j' || key === 'p') {
        e.preventDefault();
        state.mode === 'study' ? prevQuestion() : prevQuizQuestion();
        return;
      }
      if (key === ' ' || key === 'enter' || key === 'r') {
        e.preventDefault();
        if (!state.revealed) {
          state.revealed = true;
          state.mode === 'study' ? renderStudy() : renderQuiz();
        } else if (state.mode === 'study') {
          // When revealed in Study: space/enter advances with a "good" rating
          const qs = filteredQuestions();
          if (qs.length > 0) {
            recordRating(qs[state.currentIndex].id, 'good');
            nextQuestion();
          }
        } else {
          // In Quiz, don't fabricate a right/wrong — require an explicit tap
          // on "I got it right/wrong". Space/Enter just skips forward.
          nextQuizQuestion();
        }
        return;
      }
      // Study-only rating shortcuts 1..4
      if (state.mode === 'study' && state.revealed && ['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const rate = ['again', 'hard', 'good', 'easy'][Number(key) - 1];
        const qs = filteredQuestions();
        if (qs.length > 0) {
          recordRating(qs[state.currentIndex].id, rate);
          nextQuestion();
        }
        return;
      }
    }
  });
}

//─── SWIPE (swipe left to advance in Study/Quiz) ─────────────
function installSwipe() {
  const main = $('#main');
  let sx = 0, sy = 0, tracking = false, pid = null;
  main.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'study' && state.mode !== 'quiz') return;
    // Don't hijack taps on interactive elements or the scratchpad
    if (e.target.closest('button, input, a, canvas, .filter-bar, .scratchpad-wrap')) return;
    sx = e.clientX; sy = e.clientY;
    tracking = true;
    pid = e.pointerId;
  });
  main.addEventListener('pointerup', (e) => {
    if (!tracking || e.pointerId !== pid) return;
    tracking = false;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx < 0) {
      haptic(15);
      if (state.mode === 'study') nextQuestion();
      else nextQuizQuestion();
    }
  });
  main.addEventListener('pointercancel', () => { tracking = false; });
}

//─── LOCK SCREEN (PIN unlock) ────────────────────────────────
// Shown on boot when pin.setup is present. Resolves with an AES-GCM key on
// success, or null if the user used "Forgot PIN" to wipe local data.
function showLockScreen() {
  return new Promise((resolve) => {
    const html = `
      <div id="lock-overlay" role="dialog" aria-modal="true" aria-labelledby="lock-title">
        <div class="lock-card">
          <div class="lock-icon" aria-hidden="true">🔒</div>
          <h2 id="lock-title">Unlock A+ Study</h2>
          <p class="lock-sub">Enter your PIN to decrypt your progress.</p>
          <form id="lock-form">
            <input id="lock-pin" type="password" inputmode="numeric"
                   autocomplete="off" autocorrect="off" autocapitalize="off"
                   spellcheck="false" placeholder="PIN" aria-label="PIN"
                   enterkeyhint="go">
            <div class="lock-error" id="lock-error" role="alert" hidden></div>
            <button type="submit" class="action primary" id="lock-submit">Unlock</button>
          </form>
          <button class="lock-forgot" id="lock-forgot">Forgot PIN — wipe local data</button>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const overlay = $('#lock-overlay');
    const input = $('#lock-pin');
    const submit = $('#lock-submit');
    const errEl = $('#lock-error');
    setTimeout(() => input.focus(), 50);

    const setError = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    };

    $('#lock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value;
      if (!pin) { setError('Enter your PIN.'); return; }
      const setup = getPinSetup();
      if (!setup) { overlay.remove(); resolve(null); return; }
      submit.disabled = true;
      submit.textContent = 'Unlocking…';
      try {
        const key = await deriveKey(pin, setup.salt, setup.iterations);
        if (!(await verifyPin(key, setup.verification))) {
          setError('Wrong PIN. Try again.');
          haptic([30, 60, 30]);
          input.value = '';
          input.focus();
          submit.disabled = false;
          submit.textContent = 'Unlock';
          return;
        }
        overlay.remove();
        resolve(key);
      } catch (err) {
        setError(`Couldn't unlock: ${err.message}`);
        submit.disabled = false;
        submit.textContent = 'Unlock';
      }
    });

    $('#lock-forgot').addEventListener('click', async () => {
      if (!confirm(
        'This will WIPE all local progress, question edits, and drawings.\n\n' +
        'Only do this if you truly forgot your PIN. If you have Supabase sync set up ' +
        'on another device, you can push from there after wiping. Continue?'
      )) return;
      await wipeEncryptedStores();
      clearPinSetup();
      overlay.remove();
      resolve(null);
    });
  });
}

async function wipeEncryptedStores() {
  try {
    const db = await openDB();
    await new Promise((done) => {
      const tx = db.transaction([STORE, OSTORE, DSTORE], 'readwrite');
      tx.objectStore(STORE).clear();
      tx.objectStore(OSTORE).clear();
      tx.objectStore(DSTORE).clear();
      tx.oncomplete = done;
      tx.onerror = done;
    });
  } catch (e) { console.warn('Wipe failed', e); }
}

async function rekeyAllDrawings(newKey, oldKey) {
  // Walk every drawing record and re-encrypt under the new key (or plaintext
  // when newKey === null). Runs in a single transaction so a crash halfway
  // through leaves the store consistent.
  try {
    const db = await openDB();
    const keys = await new Promise((res) => {
      const tx = db.transaction(DSTORE, 'readonly');
      const r = tx.objectStore(DSTORE).getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
    for (const k of keys) {
      const raw = await idbGet(DSTORE, k);
      if (raw == null) continue;
      const plain = isEncryptedBlob(raw)
        ? (oldKey ? await decryptJSON(oldKey, raw) : null)
        : raw;
      if (plain == null) continue;
      const next = newKey ? await encryptJSON(newKey, plain) : plain;
      await idbPut(DSTORE, k, next);
    }
  } catch (e) { console.warn('Drawing re-key failed', e); }
}

async function pinSetupFlow() {
  const pin  = prompt('Choose a PIN. 4+ characters. This encrypts your progress on this device — losing it means losing local data unless you\'ve pushed to Supabase.');
  if (pin == null) return;  // cancelled
  if (pin.length < 4) { toast('PIN must be at least 4 characters.', 'error'); return; }
  const confirmPin = prompt('Re-enter the PIN to confirm.');
  if (confirmPin !== pin) { toast('PINs didn\'t match. PIN not set.', 'error'); return; }

  toast('Encrypting local data…', 'info', 4000);
  const salt = randomSaltB64();
  const key = await deriveKey(pin, salt);
  const verification = await makeVerificationBlob(key);
  // Encrypt everything currently in memory/disk under the new key.
  state._cryptoKey = key;
  await saveProgress();
  await saveOverrides();
  await rekeyAllDrawings(key, null);
  savePinSetup({ v: 1, salt, iterations: 310_000, verification });
  toast('PIN set. Data is now encrypted on this device.', 'success', 4500);
  renderStats();
}

async function pinChangeFlow() {
  if (!state._cryptoKey) { toast('Unlock required — reload and enter current PIN.', 'error'); return; }
  const current = prompt('Enter your CURRENT PIN.');
  if (current == null) return;
  const setup = getPinSetup();
  const testKey = await deriveKey(current, setup.salt, setup.iterations);
  if (!(await verifyPin(testKey, setup.verification))) {
    toast('Current PIN is wrong.', 'error'); return;
  }
  const next = prompt('Choose a NEW PIN. 4+ characters.');
  if (next == null) return;
  if (next.length < 4) { toast('New PIN must be at least 4 characters.', 'error'); return; }
  const confirmNext = prompt('Re-enter the new PIN to confirm.');
  if (confirmNext !== next) { toast('New PINs didn\'t match. PIN unchanged.', 'error'); return; }

  toast('Re-encrypting local data…', 'info', 4000);
  const salt = randomSaltB64();
  const newKey = await deriveKey(next, salt);
  const verification = await makeVerificationBlob(newKey);
  const oldKey = state._cryptoKey;
  state._cryptoKey = newKey;
  await saveProgress();
  await saveOverrides();
  await rekeyAllDrawings(newKey, oldKey);
  savePinSetup({ v: 1, salt, iterations: 310_000, verification });
  toast('PIN changed.', 'success');
  renderStats();
}

async function pinRemoveFlow() {
  if (!state._cryptoKey) { toast('Unlock required — reload and enter current PIN.', 'error'); return; }
  if (!confirm(
    'Remove the PIN? Your local data will be decrypted back to plaintext ' +
    'and anyone with access to this device can read it. Continue?'
  )) return;
  const oldKey = state._cryptoKey;
  state._cryptoKey = null;
  await saveProgress();
  await saveOverrides();
  await rekeyAllDrawings(null, oldKey);
  clearPinSetup();
  toast('PIN removed. Local data is now plaintext.', 'info', 4500);
  renderStats();
}

//─── INIT ────────────────────────────────────────────────────
//─── WELCOME / LANDING SCREEN ─────────────────────────────────
function showWelcome() {
  const streak = getStreak();
  const due = dueCount();
  const total = state.questions.length;
  const seen = state.questions.filter(q => state.progress[q.id]?.seen > 0).length;
  const returningUser = seen > 0;

  const greeting = returningUser
    ? `Welcome back${streak.count > 0 ? ` — 🔥 ${streak.count}-day streak` : ''}.`
    : `Welcome to your CompTIA A+ Core 1 study app.`;

  const subtitle = returningUser
    ? `${due} card${due === 1 ? '' : 's'} due today · ${seen}/${total} cards seen so far.`
    : `${total} flashcards built from the questions you missed across your pretests. Spaced repetition brings the tough ones back.`;

  const html = `
    <div id="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div class="welcome-card">
        <button class="welcome-close" id="welcome-close" aria-label="Close">✕</button>
        <div class="welcome-mascot" aria-hidden="true">${MASCOT(returningUser && streak.count > 0 ? 'celebrate' : 'wave')}</div>
        <h2 id="welcome-title">${greeting}</h2>
        <p class="welcome-sub">${subtitle}</p>

        <h3>Pick your starting point</h3>
        <div class="welcome-actions">
          <button class="welcome-btn primary" data-welcome="due">
            <span class="wbtn-title">📚 Study due cards</span>
            <span class="wbtn-sub">${due} due now${streak.today > 0 ? ` · ${streak.today} done today` : ''}</span>
          </button>
          <button class="welcome-btn" data-welcome="micro">
            <span class="wbtn-title">🎯 Just 5 cards</span>
            <span class="wbtn-sub">A micro-goal. One-and-done ≤ 5 min.</span>
          </button>
          <button class="welcome-btn" data-welcome="session15">
            <span class="wbtn-title">⏱ 15-min focus session</span>
            <span class="wbtn-sub">Countdown in header. End early anytime.</span>
          </button>
          <button class="welcome-btn" data-welcome="reading">
            <span class="wbtn-title">📖 Read concept sheets</span>
            <span class="wbtn-sub">No flashcards. Just the fix notes per OBJ.</span>
          </button>
          <button class="welcome-btn" data-welcome="stats">
            <span class="wbtn-title">📊 See my progress</span>
            <span class="wbtn-sub">Mastery by OBJ, streak, accessibility settings.</span>
          </button>
        </div>

        <details class="welcome-help">
          <summary>How the interface works</summary>
          <ul>
            <li><strong>Tap an option</strong> (A/B/C/D) to pick your answer — blue border shows your choice.</li>
            <li><strong>Tap Reveal</strong> (or press <kbd>Space</kbd>) to check — correct answer highlights green, your wrong pick goes red.</li>
            <li><strong>Rate</strong> Again / Hard / Good / Easy to schedule next review (spaced repetition).</li>
            <li><strong>Swipe left</strong> on iPhone (or Skip →) to move on.</li>
            <li><strong>✏️ Edit</strong> on each card to fix options or add a PBQ image.</li>
            <li><strong>🔒 Focus Mode</strong> in header (or press <kbd>F</kbd>) hides chrome when overstimulated.</li>
            <li><strong>🌓 Theme</strong> cycles auto / light / dark. Stats → Accessibility has text size, dyslexic fonts, anxiety mode (hides numbers), high contrast, and more.</li>
            <li><strong>Apple Pencil</strong>: scratchpad auto-saves per card. On PBQ cards, draw on top of the image to label components from memory.</li>
          </ul>
        </details>

        <label class="welcome-dismiss">
          <input type="checkbox" id="welcome-dismiss-permanent">
          Don't show this on every load
        </label>
      </div>
    </div>
  `;
  // Re-opening from the header Help button should replace, not stack
  $('#welcome-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);

  const overlay = $('#welcome-overlay');
  const previouslyFocused = document.activeElement;
  const focusablesFor = () => [...overlay.querySelectorAll(
    'button, [href], input, [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.disabled && el.offsetParent !== null);
  const onKeydown = (e) => {
    if ($('#welcome-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(null); return; }
    if (e.key !== 'Tab') return;
    // Simple focus trap — cycle Tab / Shift+Tab within the dialog
    const f = focusablesFor();
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const close = (action) => {
    const dismissPerm = $('#welcome-dismiss-permanent')?.checked;
    if (dismissPerm) localStorage.setItem('welcomeDismissed', '1');
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    // Restore focus to the trigger so keyboard users aren't dumped at <body>
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    const studyActions = new Set(['due', 'micro', 'session15']);
    if (action === 'due') { state.filter.due = true; setMode('study'); }
    else if (action === 'micro') { startSession({ targetCards: 5 }); setMode('study'); }
    else if (action === 'session15') { startSession({ minutes: 15 }); setMode('study'); }
    else if (action === 'reading') { setMode('reading'); }
    else if (action === 'stats') { setMode('stats'); }
    // For Study-focused actions, auto-enter Focus Mode: hides tab bar, filter
    // bar, HUD, and card meta so it's just the card. Exit with F or the 🔓 button.
    if (studyActions.has(action) && !state.focus) toggleFocus();
  };

  $('#welcome-close').addEventListener('click', () => close(null));
  $$('[data-welcome]').forEach(btn =>
    btn.addEventListener('click', () => close(btn.dataset.welcome))
  );
  document.addEventListener('keydown', onKeydown);
  // Focus the primary action so keyboard + screen-reader users land in the
  // dialog immediately instead of at <body>.
  setTimeout(() => {
    const primary = overlay.querySelector('[data-welcome="due"]') || overlay.querySelector('button');
    primary?.focus();
  }, 0);
}

async function init() {
  // Prefs / theme / shuffle all load before any render so first paint is correct
  applyPrefs();
  // Active exam is persisted separately so the PIN gate can still unlock the
  // right encrypted progress blob on first load.
  const savedExam = localStorage.getItem('exam');
  if (EXAM_IDS.includes(savedExam)) state.exam = savedExam;
  setTheme(localStorage.getItem('theme') || 'auto');
  state.shuffle = localStorage.getItem('shuffle') === 'true';
  if (pref('sound') !== 'off') setSound(pref('sound'));  // ambient noise restores (needs gesture on some browsers)
  if (pref('shake') === 'on') enableShake().catch(() => {});

  $('#theme-btn')?.addEventListener('click', cycleTheme);
  $('#focus-btn')?.addEventListener('click', toggleFocus);
  $('#help-btn')?.addEventListener('click', showWelcome);

  // If the user set a PIN on a prior session, gate everything behind it
  // before any sensitive data is loaded. A null key (returned after "Forgot
  // PIN → wipe") means the stores are cleared; loadData will see no data
  // and fall back to defaults.
  if (isPinSet()) {
    state._cryptoKey = await showLockScreen();
  }

  try {
    await loadData();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><h3>Couldn't load data</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  installSwipe();
  installKeyboard();
  setMode('study');

  // Show welcome on first visit (or every load until user ticks "don't show again").
  // Skippable via ?skipWelcome=1 for tests.
  if (!localStorage.getItem('welcomeDismissed') && !location.search.includes('skipWelcome')) {
    showWelcome();
  }

  // Register service worker for offline
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed:', err));
  }
}

init();

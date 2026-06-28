// A+ Study — single-file PWA logic
// Modules: State, DB, Study, Quiz, Reading, Stats, ScratchPad, Router

import {
  MIN, DAY, MAX_INTERVAL_DAYS,
  defaultProgress, migrateProgress, schedule,
  escapeHtml, normalizeOption, formatExplanation, formatQuestion,
  orderDeck, nextIntervalLabel, /* recommendedRating no longer used in UI; kept in lib.mjs + tests */
  shuffleOptionsForCard,
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
  core2: {
    id: 'core2',
    label: 'Core 2 (220-1202)',
    questions: 'data/core2/questions.json',
    fixes: 'data/core2/concept-fixes.json',
  },
};
const EXAM_IDS = Object.keys(EXAMS);
function examDef(id) { return EXAMS[id] || EXAMS.core2; }

// Exam target date (ISO yyyy-mm-dd) per exam. Used to drive the header
// countdown and the urgency styling on the welcome screen.
function getExamDate(examId) {
  return localStorage.getItem(`exam.${examId}.date`) || '';
}
function setExamDate(examId, iso) {
  if (!iso) localStorage.removeItem(`exam.${examId}.date`);
  else lsSet(`exam.${examId}.date`, iso);
}
function daysUntilExam(examId = state?.exam) {
  const iso = getExamDate(examId);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

//─── GLOBAL STATE ────────────────────────────────────────────
const state = {
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
  else lsSet(`pref.${key}`, value);
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
  return (state.progress[q.id]?.due || 0) <= Date.now();
}

function haptic(pattern = 10) {
  if (pref('haptics') === 'off') return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

//─── CONFETTI (celebration bursts) ───────────────────────────
// Tiny DOM-based confetti so it works offline without canvas bookkeeping.
// Honors reduce-motion (OS setting + the app's own toggle).
const CONFETTI_COLORS = ['#ffd700', '#ff80ab', '#80d8ff', '#4ade80', '#fbbf24', '#c084fc', '#ff87b2'];
function celebrate({ sourceEl = null, intensity = 30, duration = 1400 } = {}) {
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

//─── DAILY ACTIVITY (heatmap source) ─────────────────────────
function bumpActivity() {
  try {
    const a = getActivity();
    const k = todayKey();
    a[k] = (a[k] || 0) + 1;
    // Prune anything older than 180 days — the heatmap only shows 90
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;
    for (const key of Object.keys(a)) if (key < cutoffKey) delete a[key];
    lsSet('activity', JSON.stringify(a));
  } catch {}
}
function getActivity() {
  try { return JSON.parse(localStorage.getItem('activity') || '{}'); }
  catch { return {}; }
}

//─── CELEBRATION TRIGGERS (objective mastery + streak milestones) ───
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

function celebratedFlag(key) {
  try { return !!JSON.parse(localStorage.getItem('celebrated') || '{}')[key]; }
  catch { return false; }
}
function markCelebrated(key) {
  try {
    const c = JSON.parse(localStorage.getItem('celebrated') || '{}');
    c[key] = true;
    lsSet('celebrated', JSON.stringify(c));
  } catch {}
}

function checkObjectiveMastered(obj) {
  if (!obj || obj === '?') return false;
  const qs = state.questions.filter(q => q.obj === obj);
  if (qs.length === 0) return false;
  return qs.every(q => state.progress[q.id]?.status === 'good');
}

function maybeFireObjectiveCelebration(obj) {
  if (!obj) return;
  const key = `obj:${state.exam}:${obj}`;
  if (celebratedFlag(key)) return;
  if (!checkObjectiveMastered(obj)) return;
  markCelebrated(key);
  celebrate({ intensity: 45, duration: 1700 });
  toast(`🎉 Objective ${obj} mastered — every card rated Good.`, 'success', 5000);
}

function maybeFireStreakCelebration(newCount) {
  for (const n of STREAK_MILESTONES) {
    if (newCount !== n) continue;
    const key = `streak:${n}`;
    if (celebratedFlag(key)) return;
    markCelebrated(key);
    celebrate({ intensity: 50, duration: 1800 });
    toast(`🔥 ${n}-day streak. You keep showing up.`, 'success', 5500);
    return;
  }
}

// GitHub-style heatmap of daily cards-rated for the last 90 days. Columns
// are weeks; rows are days of the week. Color intensity bands mirror the
// GitHub scale so it feels familiar.
// Quiz history chart: small inline SVG line/dot of scores per session.
// Rendered into Stats so users see whether they're trending up. Empty state
// (no sessions yet) returns '' — no UI noise until there's data to show.
function renderQuizHistoryHTML() {
  const history = loadQuizHistory();
  if (history.length === 0) return '';
  const W = 300, H = 110, PAD_L = 28, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const n = history.length;
  const x = (i) => n === 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW;
  const y = (score) => PAD_T + (1 - score / 100) * innerH;
  const points = history.map((e, i) => `${x(i).toFixed(1)},${y(e.score).toFixed(1)}`).join(' ');
  const dots = history.map((e, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(e.score).toFixed(1)}" r="3.5" fill="${e.score >= 75 ? 'var(--good)' : 'var(--bad)'}" />`
  ).join('');
  // 75% pass-line
  const passY = y(75).toFixed(1);
  const best = Math.max(...history.map(e => e.score));
  const avg = Math.round(history.reduce((s, e) => s + e.score, 0) / history.length);
  const last = history[history.length - 1];
  return `
    <h3 class="stats-h numeric-ui">Quiz history</h3>
    <div class="quiz-history numeric-ui">
      <div class="qh-meta">
        <div class="qh-stat"><span class="qh-num">${history.length}</span><span class="qh-label">sessions</span></div>
        <div class="qh-stat"><span class="qh-num">${best}%</span><span class="qh-label">best</span></div>
        <div class="qh-stat"><span class="qh-num">${avg}%</span><span class="qh-label">avg</span></div>
        <div class="qh-stat"><span class="qh-num">${last.score}%</span><span class="qh-label">last</span></div>
      </div>
      <svg class="qh-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Quiz score history">
        <line x1="${PAD_L}" y1="${passY}" x2="${W - PAD_R}" y2="${passY}" stroke="var(--good)" stroke-width="1" stroke-dasharray="4 3" opacity="0.5" />
        <text x="${W - PAD_R - 2}" y="${(parseFloat(passY) - 3).toFixed(1)}" font-size="9" fill="var(--text-dim)" text-anchor="end">75% pass</text>
        <text x="${PAD_L - 4}" y="${(PAD_T + 6).toFixed(1)}" font-size="9" fill="var(--text-dim)" text-anchor="end">100</text>
        <text x="${PAD_L - 4}" y="${(PAD_T + innerH + 3).toFixed(1)}" font-size="9" fill="var(--text-dim)" text-anchor="end">0</text>
        ${n > 1 ? `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" />` : ''}
        ${dots}
      </svg>
    </div>`;
}

function renderHeatmapHTML() {
  const activity = getActivity();
  const DAYS = 90;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Align the last column to today; walk backwards by `DAYS` days, padding
  // with blank cells so the first column is a full Sun–Sat.
  const cells = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const count = activity[key] || 0;
    cells.push({ key, count, d });
  }
  // Pad at the start so the first cell lands on a Sunday column
  const firstDow = cells[0].d.getDay();
  const padded = Array.from({ length: firstDow }, () => null).concat(cells);
  // Break into columns of 7
  const cols = [];
  for (let i = 0; i < padded.length; i += 7) cols.push(padded.slice(i, i + 7));

  const level = (n) =>
    n === 0 ? 0 :
    n < 3   ? 1 :
    n < 8   ? 2 :
    n < 20  ? 3 : 4;

  const total = Object.values(activity).reduce((s, n) => s + n, 0);
  const activeDays = Object.values(activity).filter(n => n > 0).length;

  return `
    <div class="heatmap">
      <div class="heatmap-grid" role="img" aria-label="${total} cards rated across ${activeDays} active days in the last 90 days">
        ${cols.map(col => `
          <div class="heatmap-col">
            ${col.map(cell => cell
              ? `<div class="heatmap-cell" data-lvl="${level(cell.count)}" title="${cell.key} · ${cell.count} card${cell.count === 1 ? '' : 's'}"></div>`
              : `<div class="heatmap-cell heatmap-cell-empty" aria-hidden="true"></div>`
            ).join('')}
          </div>
        `).join('')}
      </div>
      <div class="heatmap-legend">
        <span>${total} cards · ${activeDays} active day${activeDays === 1 ? '' : 's'}</span>
        <span class="heatmap-scale">
          less
          <span class="heatmap-cell" data-lvl="0"></span>
          <span class="heatmap-cell" data-lvl="1"></span>
          <span class="heatmap-cell" data-lvl="2"></span>
          <span class="heatmap-cell" data-lvl="3"></span>
          <span class="heatmap-cell" data-lvl="4"></span>
          more
        </span>
      </div>
    </div>`;
}

//─── TOAST (non-blocking notice; gentler than alert() for AuDHD users) ──
// Queues messages, shows each for a few seconds. Tap to dismiss early.
const _toastQueue = [];
let _toastShowing = false;
function toast(msg, kind = 'info', ms = 3500, onTap = null) {
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

//─── SESSION (Pomodoro or card-count micro-goal) ─────────────
// Cram session: walks through every card in the current filter once, then
// loops anything you rated Again/Hard back through the queue until cleared.
// Designed for crunch-time studying when you have a deadline and can't trust
// the spaced-repetition queue to surface unseen cards.
function startCram() {
  const qs = state.questions.slice();
  // Shuffle once for variety
  const seed = (Date.now() & 0x7fffffff) || 1;
  const rng = (function (s) { let t = s >>> 0; return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; })(seed);
  const queue = qs.map(q => q.id);
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  state.cram = {
    active: true,
    startedAt: Date.now(),
    queue,
    originalCount: queue.length,
    cleared: 0,
  };
  // Cram clears all filters and uses sequential order so the queue is the
  // single source of truth for what's shown.
  state.filter = { obj: null, due: false, weakest: false, hard: false, search: '' };
  state.currentIndex = 0;
  state.history = [];
  state._orderCache = null;
  setMode('study');
  toast(`Cram started — ${queue.length} cards. Rate Good/Easy to clear; Again/Hard loops them back.`, 'info', 4500);
}
function endCram(announce = true) {
  if (!state.cram) return;
  const { cleared, originalCount } = state.cram;
  state.cram = null;
  state.currentIndex = 0;
  state._orderCache = null;
  if (announce) toast(`Cram ended — cleared ${cleared} of ${originalCount}.`, 'success');
  if (state.mode === 'study') renderStudy();
}
// Called from recordRating when cram is active. Updates the queue based on
// the user's rating: Good/Easy clears the card, Again/Hard sends it to the
// back. When the queue empties, we celebrate and end the session.
function onCramRated(qid, rate) {
  if (!state.cram || !state.cram.active) return;
  const q = state.cram.queue;
  const idx = q.indexOf(qid);
  if (idx === -1) return;  // already cleared on a previous pass
  q.splice(idx, 1);
  if (rate === 'good' || rate === 'easy') {
    state.cram.cleared++;
  } else {
    q.push(qid);
  }
  if (q.length === 0) {
    // Capture count + cram-instance reference before the timer fires.
    // state.cram may be null'd by an end-now tap or a switchExam in the
    // 200 ms window (which would throw on .originalCount), OR replaced
    // with a NEW cram if the user restarts immediately — which would
    // have us endCram() the wrong instance. Compare identity at fire
    // time and bail if it doesn't match.
    const total = state.cram.originalCount;
    const cramRef = state.cram;
    celebrate({ intensity: 80, duration: 2200 });
    setTimeout(() => {
      if (state.cram !== cramRef) return;  // user already moved on
      toast(`🎉 Cram complete — all ${total} cards cleared!`, 'success', 5000);
      endCram(false);
    }, 200);
  }
}

function startSession({ minutes = 0, targetCards = 0, rapid = false } = {}) {
  state.session = {
    endsAt: minutes > 0 ? Date.now() + minutes * MIN : null,
    targetCards: targetCards > 0 ? targetCards : null,
    ratedIds: new Set(),
    length: minutes,
    rapid,
    targetDesc: rapid
      ? '⚡ 60s rapid fire'
      : targetCards > 0 ? `${targetCards} card${targetCards === 1 ? '' : 's'}` : `${minutes} min`,
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
      : sess.rapid
        ? `⚡ ${reviewed} card${reviewed === 1 ? '' : 's'} in 60 seconds. Nice sprint.`
        : `Session done. ${reviewed} card${reviewed === 1 ? '' : 's'} reviewed. 🎉`;
    haptic([80, 60, 80]);
    if (reviewed > 0) celebrate({ intensity: sess.rapid ? 50 : 36, duration: 1600 });
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
  bumpActivity();
  // Celebrate when this rating just pushed an objective to full mastery
  const q = state.questions.find(x => x.id === qid);
  if (q) maybeFireObjectiveCelebration(q.obj);
  scheduleAutoSync();
}

//─── DAILY STREAK ────────────────────────────────────────────
// Defensive wrapper around localStorage.setItem. iOS Safari private mode
// can have 0 quota; quota-exceeded errors would otherwise bubble up and
// crash bumpStreak / savePinSetup / activity tracking / preferences saves
// — leaving the user with a silently-broken streak or PIN that won't
// save. Logs once per session per key on failure; surfaces a single
// toast the first time it fails so the user knows something's off.
const _lsFailed = new Set();
let _lsToastedThisSession = false;
function lsSet(key, value) {
  try {
    // Bracket access so the global replace_all below this function
    // doesn't recursively rewrite this line.
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

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Minimum cards rated before today counts as a streak day. Tying the
// streak to real retrieval — not a single "tap to keep the flame" —
// makes the habit signal more honest. 3 is small enough to feel
// achievable, big enough to require actual recall practice.
const STREAK_MIN_CARDS = 3;
function bumpStreak() {
  const today = todayKey();
  const lastEarned = localStorage.getItem('streak.lastDay');
  // Reset today's counter if the calendar day rolled over since it was set.
  const cardsDay = localStorage.getItem('streak.cardsDay');
  let cardsToday = Number(localStorage.getItem('streak.todayCards') || '0');
  if (cardsDay !== today) {
    cardsToday = 0;
    lsSet('streak.cardsDay', today);
  }
  cardsToday += 1;
  lsSet('streak.todayCards', String(cardsToday));
  if (cardsToday < STREAK_MIN_CARDS) return;     // threshold not met
  if (lastEarned === today) return;              // already earned today

  // Earn today: compute new count from prior earned day.
  let count = Number(localStorage.getItem('streak.count') || '0');
  if (lastEarned) {
    const [ly, lm, ld] = lastEarned.split('-').map(Number);
    const lastDate = new Date(ly, lm - 1, ld);
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((y - lastDate) / (24*60*60*1000));
    if (diffDays === 1) {
      count = count + 1;                      // streak continues
    } else if (diffDays === 0 || diffDays === -1) {
      // diffDays=0: edge case (today === lastEarned but lastEarned !==
      // today check passed before reaching here — possible during a clock
      // adjustment); preserve count.
      // diffDays=-1: user crossed an international date line backwards
      // OR system clock just adjusted backward by ~24h. Preserve count
      // rather than punish a traveler / NTP-correcting device.
      count = Math.max(1, count);
    } else {
      // diffDays >= 2: real gap, reset.
      // diffDays <= -2: clock jumped backwards by multiple days — likely
      // wrong-clock state, also reset to 1 so we don't double-credit.
      count = 1;
    }
  } else {
    count = 1;
  }
  lsSet('streak.lastDay', today);
  lsSet('streak.count', String(count));
  // Subtle celebration the first time the threshold is crossed today.
  toast(`🔥 ${count}-day streak — today's earned.`, 'success', 2500);
  maybeFireStreakCelebration(count);
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

const DB_NAME = 'aplus-study';
const DB_VERSION = 5;
const STORE = 'progress';
const OSTORE = 'overrides';   // per-question edits: { [qid]: {options?, image?, images?} }
const DSTORE = 'drawings';    // per-question scratchpad canvas PNGs (base64 dataURL)
const RSTORE = 'reference';   // user's reference book PDF (per-exam): { blob, name, size, pageCount, uploadedAt, pageText? }
const ESTORE = 'examEvents';  // outcome-loop log: { [examEventId]: ExamEvent }. PR #67. See ExamEvent shape comment near loadExamEvents().

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(OSTORE)) db.createObjectStore(OSTORE);
      if (!db.objectStoreNames.contains(DSTORE)) db.createObjectStore(DSTORE);
      if (!db.objectStoreNames.contains(RSTORE)) db.createObjectStore(RSTORE);
      if (!db.objectStoreNames.contains(ESTORE)) db.createObjectStore(ESTORE);
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
function savePinSetup(setup) { lsSet(PIN_SETUP_KEY, JSON.stringify(setup)); }
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

// Per-exam keys so each exam's progress lives in its own slot.
async function loadProgress(examId = state.exam) {
  try {
    const raw = await idbGet(STORE, examId);
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
// One-time-per-session warning so the user knows their FSRS progress
// stopped persisting (IDB blocked, quota exhausted, etc.) instead of
// silently studying with ratings that won't survive a tab close.
let _idbFailToasted = false;
async function saveProgress(examId = state.exam) {
  try { await idbPut(STORE, examId, await maybeEncrypt(state.progress)); }
  catch (e) {
    console.warn('Save progress failed', e);
    if (!_idbFailToasted) {
      _idbFailToasted = true;
      try { toast('Couldn\'t save progress to device storage. Ratings may not persist after closing.', 'error', 6000); } catch {}
    }
  }
}
async function clearProgress(examId = state.exam) {
  try {
    await idbDelete(STORE, examId);
    state.progress = {};
  } catch (e) { console.warn('Clear failed', e); }
}

async function loadOverrides(examId = state.exam) {
  try {
    const raw = await idbGet(OSTORE, examId);
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
async function saveOverrides(examId = state.exam) {
  try { await idbPut(OSTORE, examId, await maybeEncrypt(state.overrides)); }
  catch (e) { console.warn('Save overrides failed', e); }
}

//─── EXAM-OUTCOME LOG (PR #67) ───────────────────────────────
// Stored shape (per exam attempt — one record per exam taken):
//   {
//     id: 'evt-<ms>',                  // primary key, sortable
//     exam: 'core2',                   // dataset id (state.exam)
//     examDateISO: '2026-07-15',       // user-supplied
//     loggedAtMs: 1721059200000,
//     // Pre-exam (may be null if user only logs after the fact):
//     pre: { predictedReadinessPct: 78, selfPredictedPct: 75, confidencePct: 60 } | null,
//     // Post-exam:
//     post: {
//       actualScorePct: 82,            // user types from CompTIA score report
//       postdictionPct: 70,            // gut % right after, before learning score
//       passed: true,                  // derived vs MOCK_EXAM_PASS_PCT
//       lovettGap: 'I overestimated…',
//       lovettStrategies: ['mocks','quiz','reading'],
//       lovettForward: 'More mocks earlier next time.',
//     } | null,
//   }
// Persisted under a single IDB key per exam dataset (the value is an
// ARRAY of events), encrypted under the PIN if one's set. Calibration
// metrics only compute meaningfully at n >= 3 per the WWC SCED standard
// surfaced by the metacognition research; below that, the UI labels
// the data 'anecdotal'.
async function loadExamEvents(examId = state.exam) {
  try {
    const raw = await idbGet(ESTORE, examId);
    return (await maybeDecrypt(raw, [])) || [];
  } catch (e) { if (e.message === 'locked') throw e; return []; }
}
async function saveExamEvents(events, examId = state.exam) {
  try { await idbPut(ESTORE, examId, await maybeEncrypt(events)); }
  catch (e) { console.warn('Save exam events failed', e); }
}
async function appendExamEvent(event) {
  const list = await loadExamEvents();
  list.push(event);
  await saveExamEvents(list);
  return list;
}
// Compute calibration metrics on the events that have both pre.predictedReadinessPct
// and post.actualScorePct. Returns null when n < 3 — the threshold the
// metacognition research flagged as the WWC single-case-design floor
// for "without reservations."
function computeCalibrationMetrics(events) {
  const ws = events.filter(e => e?.pre?.predictedReadinessPct != null && e?.post?.actualScorePct != null);
  if (ws.length < 3) return null;
  const diffs = ws.map(e => e.pre.predictedReadinessPct - e.post.actualScorePct);
  const signedBias = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const mae = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
  // Brier-style component for the "are they expected to pass?" prediction.
  // Treats predicted probability of pass as predicted/100, outcome as 0/1.
  const brierItems = ws.filter(e => e.post.passed !== undefined);
  const brier = brierItems.length === 0 ? null
    : brierItems.reduce((s, e) => {
        const p = (e.pre.predictedReadinessPct || 0) / 100;
        const o = e.post.passed ? 1 : 0;
        return s + (p - o) * (p - o);
      }, 0) / brierItems.length;
  return { n: ws.length, signedBias, mae, brier };
}

async function hydrateOutcomesPanel() {
  const host = $('#outcomes-panel');
  if (!host) return;
  let events;
  try { events = await loadExamEvents(); }
  catch (e) { if (e.message === 'locked') { host.innerHTML = '<p class="outcomes-empty">Unlock with your PIN to view the outcome log.</p>'; return; } events = []; }

  // Compute calibration stats only when we have ≥3 attempts. Below that
  // threshold, the metacognition research's punchline applies: anything
  // we'd display is anecdotal, so just say so honestly.
  const metrics = computeCalibrationMetrics(events);
  const n = events.length;

  // Calibration scatter — a tiny SVG showing predicted vs actual %.
  // Diagonal = perfect calibration. Above = under-confident; below =
  // over-confident. One dot per attempt; pass/fail tints the dot.
  const SVG_SIZE = 240, PAD = 24;
  const dots = events.map(e => {
    const p = e?.pre?.predictedReadinessPct;
    const a = e?.post?.actualScorePct;
    if (p == null || a == null) return '';
    const x = PAD + (p / 100) * (SVG_SIZE - 2 * PAD);
    const y = SVG_SIZE - PAD - (a / 100) * (SVG_SIZE - 2 * PAD);
    const tint = e.post.passed ? 'var(--good)' : 'var(--bad)';
    return `<circle cx="${x}" cy="${y}" r="5" fill="${tint}" stroke="var(--surface)" stroke-width="2"></circle>`;
  }).join('');
  const scatter = `
    <svg viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" class="outcome-scatter" role="img" aria-label="Predicted vs actual exam scores">
      <rect x="${PAD}" y="${PAD}" width="${SVG_SIZE-2*PAD}" height="${SVG_SIZE-2*PAD}" fill="var(--surface-2)" stroke="var(--border)" />
      <line x1="${PAD}" y1="${SVG_SIZE-PAD}" x2="${SVG_SIZE-PAD}" y2="${PAD}" stroke="var(--border)" stroke-dasharray="3,3" />
      <text x="${SVG_SIZE/2}" y="${SVG_SIZE-4}" text-anchor="middle" font-size="10" fill="var(--text-dim)">predicted readiness %</text>
      <text x="6" y="${SVG_SIZE/2}" text-anchor="middle" font-size="10" fill="var(--text-dim)" transform="rotate(-90, 6, ${SVG_SIZE/2})">actual score %</text>
      ${dots}
    </svg>`;

  const metricsHTML = metrics ? `
    <div class="outcome-metrics">
      <div class="outcome-metric"><div class="outcome-metric-label">Mean signed bias</div><div class="outcome-metric-value ${metrics.signedBias > 5 ? 'over' : metrics.signedBias < -5 ? 'under' : ''}">${metrics.signedBias > 0 ? '+' : ''}${metrics.signedBias.toFixed(1)}%</div><div class="outcome-metric-help">${metrics.signedBias > 5 ? 'overconfident' : metrics.signedBias < -5 ? 'underconfident' : 'well-calibrated'}</div></div>
      <div class="outcome-metric"><div class="outcome-metric-label">Mean absolute error</div><div class="outcome-metric-value">${metrics.mae.toFixed(1)}%</div><div class="outcome-metric-help">avg |pred − actual|</div></div>
      ${metrics.brier != null ? `<div class="outcome-metric"><div class="outcome-metric-label">Brier (pass)</div><div class="outcome-metric-value">${metrics.brier.toFixed(3)}</div><div class="outcome-metric-help">lower = better</div></div>` : ''}
    </div>` : '';

  const anecdoteBanner = n < 3 ? `
    <div class="outcome-anecdote">
      <strong>Anecdotal until ${3 - n} more attempt${3 - n === 1 ? '' : 's'}.</strong>
      Calibration metrics need ≥3 exam events per the WWC single-case-design
      standard. Until then, the dots are just dots.
    </div>` : '';

  const list = events.length === 0 ? '' : `
    <details class="outcome-list">
      <summary>${events.length} attempt${events.length === 1 ? '' : 's'} logged</summary>
      <ul>
        ${events.slice().reverse().map(e => `
          <li>
            <strong>${escapeHtml(e.examDateISO || new Date(e.loggedAtMs).toISOString().slice(0,10))}</strong>
            ${e.post?.actualScorePct != null ? `· ${e.post.actualScorePct}% ${e.post.passed ? '✓' : '✗'}` : '· result pending'}
            ${e.pre?.predictedReadinessPct != null ? `· predicted ${e.pre.predictedReadinessPct}%` : ''}
          </li>`).join('')}
      </ul>
    </details>`;

  host.innerHTML = `
    <p class="outcomes-blurb">
      Log every real exam attempt — even one. Future attempts get compared
      against your predicted readiness so you can see whether the app's
      number is trustworthy. Local only; not synced.
    </p>
    ${anecdoteBanner}
    ${n > 0 ? `<div class="outcome-scatter-wrap">${scatter}</div>` : ''}
    ${metricsHTML}
    ${list}
    <div class="settings-actions" style="margin-top: 12px;">
      <button class="action" id="outcome-log-btn">📊 Log an exam attempt</button>
    </div>
  `;
  $('#outcome-log-btn')?.addEventListener('click', () => openOutcomeLogDialog());
}

// Single dialog that captures the full ExamEvent in one form. Skip
// fields don't break anything — predictedReadiness is auto-filled from
// the current readiness number; everything else is optional but
// strongly suggested in the prompt copy.
function openOutcomeLogDialog() {
  // Snapshot the current app-predicted readiness so we capture what
  // the user actually saw at log time, not at form-submit time.
  const currentReadiness = (() => {
    const history = loadQuizHistory(state.exam).slice(-5);
    const totalQ = history.reduce((n, e) => n + (e.total || 0), 0);
    const correctQ = history.reduce((n, e) => n + (e.correct || 0), 0);
    return totalQ >= 40 ? Math.round((correctQ / totalQ) * 100) : null;
  })();
  const today = new Date().toISOString().slice(0,10);
  const overlay = document.createElement('div');
  overlay.id = 'outcome-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'outcome-title');
  overlay.innerHTML = `
    <div class="outcome-card">
      <button class="welcome-close" id="outcome-close" aria-label="Cancel">✕</button>
      <h2 id="outcome-title">Log an exam attempt</h2>
      <p class="outcome-intro">
        Capture what the app predicted, what you guessed, and what you actually scored.
        After 3+ attempts the calibration view starts to mean something.
      </p>
      <form id="outcome-form">
        <label class="outcome-field">
          <span class="outcome-label">Exam date</span>
          <input type="date" id="outcome-date" value="${today}" required>
        </label>

        <fieldset class="outcome-group">
          <legend>Before the exam</legend>
          <label class="outcome-field">
            <span class="outcome-label">App's predicted readiness % <span class="outcome-meta">(auto)</span></span>
            <input type="number" id="outcome-app-pred" min="0" max="100" step="1" value="${currentReadiness ?? ''}" placeholder="e.g. 78">
          </label>
          <label class="outcome-field">
            <span class="outcome-label">Your own prediction %</span>
            <input type="number" id="outcome-self-pred" min="0" max="100" step="1" placeholder="What did you guess you'd score?">
          </label>
          <label class="outcome-field">
            <span class="outcome-label">Your confidence (0–100)</span>
            <input type="number" id="outcome-confidence" min="0" max="100" step="1" placeholder="How sure were you?">
          </label>
        </fieldset>

        <fieldset class="outcome-group">
          <legend>After the exam</legend>
          <label class="outcome-field">
            <span class="outcome-label">Actual score % (from CompTIA score report)</span>
            <input type="number" id="outcome-actual" min="0" max="100" step="0.1" placeholder="e.g. 82" required>
          </label>
          <label class="outcome-field">
            <span class="outcome-label">Postdiction % <span class="outcome-meta">(your guess right after — before seeing the score)</span></span>
            <input type="number" id="outcome-postdict" min="0" max="100" step="1">
          </label>
        </fieldset>

        <fieldset class="outcome-group">
          <legend>Reflection (Lovett wrapper)</legend>
          <label class="outcome-field">
            <span class="outcome-label">One sentence on the prediction-vs-actual gap</span>
            <textarea id="outcome-gap" rows="2" placeholder="e.g. I overestimated my OBJ 2.x readiness — I'd skipped a domain."></textarea>
          </label>
          <span class="outcome-label">Which study activities did you use?</span>
          <div class="outcome-strategies">
            ${['Study cards', 'Practice quizzes', 'Reading sheets', 'Timed mocks', 'Reference book'].map(s =>
              `<label class="outcome-strategy"><input type="checkbox" value="${escapeHtml(s)}"> ${escapeHtml(s)}</label>`
            ).join('')}
          </div>
          <label class="outcome-field" style="margin-top: 10px;">
            <span class="outcome-label">One concrete change for next cycle</span>
            <textarea id="outcome-forward" rows="2" placeholder="e.g. Take a timed 90-Q mock under exam conditions every Sunday."></textarea>
          </label>
        </fieldset>

        <div class="outcome-actions">
          <button type="button" class="action" id="outcome-cancel">Cancel</button>
          <button type="submit" class="action primary" id="outcome-save">Save attempt</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
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
  document.addEventListener('keydown', onKey);
  $('#outcome-close').addEventListener('click', close);
  $('#outcome-cancel').addEventListener('click', close);
  $('#outcome-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const intField = (id) => {
      const v = $(`#${id}`)?.value?.trim();
      if (v === '' || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const actual = intField('outcome-actual');
    if (actual == null) { toast('Actual score is required.', 'error'); return; }
    const strategies = [...overlay.querySelectorAll('.outcome-strategy input:checked')].map(c => c.value);
    const event = {
      id: 'evt-' + Date.now(),
      exam: state.exam,
      examDateISO: $('#outcome-date').value || today,
      loggedAtMs: Date.now(),
      pre: {
        predictedReadinessPct: intField('outcome-app-pred'),
        selfPredictedPct: intField('outcome-self-pred'),
        confidencePct: intField('outcome-confidence'),
      },
      post: {
        actualScorePct: actual,
        postdictionPct: intField('outcome-postdict'),
        passed: actual >= MOCK_EXAM_PASS_PCT,
        lovettGap: $('#outcome-gap').value.trim(),
        lovettStrategies: strategies,
        lovettForward: $('#outcome-forward').value.trim(),
      },
    };
    await appendExamEvent(event);
    close();
    toast('Logged. The calibration view will sharpen as you add more attempts.', 'success', 4500);
    hydrateOutcomesPanel();
  });
}

//─── DATA LOAD ───────────────────────────────────────────────
// Critical-path: questions.json blocks first paint (the Study tab is
// the default landing). concept-fixes.json is deferred — only Reading
// uses it, and renderReading awaits state._conceptFixesPromise if the
// data hasn't landed yet. Saves ~275ms off cold mobile boot.
async function loadData() {
  const def = examDef(state.exam);
  // Kick off the concept-fixes fetch in parallel but don't await it.
  // Cached on state for renderReading + the renderReading-side wait.
  state._conceptFixesPromise = fetch(def.fixes)
    .then(r => r.ok ? r.json() : {})
    .then(j => { state.conceptFixes = j; return j; })
    .catch(() => { state.conceptFixes = {}; return {}; });
  const questionsRes = await fetch(def.questions);
  state.questions = questionsRes.ok ? await questionsRes.json() : [];
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

// Weakest-N list: cards with at least one attempt, ranked by lowest accuracy
// then by highest seen-count (to break ties toward "cards you keep missing").
// Unseen cards don't count — they're not weak, they're unread.
const WEAKEST_LIMIT = 10;
function weakestIdSet() {
  const withAttempts = state.questions
    .map(q => {
      const p = state.progress[q.id] || {};
      const seen = p.seen || 0;
      const acc = seen > 0 ? (p.correct || 0) / seen : 1;
      return { id: q.id, seen, acc };
    })
    .filter(x => x.seen > 0);
  withAttempts.sort((a, b) => a.acc - b.acc || b.seen - a.seen);
  return new Set(withAttempts.slice(0, WEAKEST_LIMIT).map(x => x.id));
}

function filteredQuestions() {
  // Cram session: queue is the source of truth, ignore filters + cache
  if (state.cram?.active) {
    const byId = Object.fromEntries(state.questions.map(q => [q.id, q]));
    return state.cram.queue.map(id => byId[id]).filter(Boolean);
  }
  let qs = state.questions.slice();
  if (state.filter.obj) qs = qs.filter(q => q.obj === state.filter.obj);
  if (state.filter.due) qs = qs.filter(isDue);
  if (state.filter.weakest) {
    const ids = weakestIdSet();
    qs = qs.filter(q => ids.has(q.id));
  }
  if (state.filter.hard) {
    qs = qs.filter(q => {
      const r = state.progress[q.id]?.lastRating;
      return r === 'hard' || r === 'again';
    });
  }
  if (state.filter.search) {
    const q = state.filter.search.toLowerCase();
    qs = qs.filter(x =>
      x.question.toLowerCase().includes(q) ||
      (x.explanation || '').toLowerCase().includes(q)
    );
  }
  // Order the deck via orderDeck() unless explicitly sequential. Cached per
  // (filter × order × deck-identity) so Prev/Next don't reshuffle mid-session.
  if (state._orderSeed === null) state._orderSeed = (Date.now() & 0x7fffffff) || 1;
  // Cheap rolling-hash of the full id list. Previously we sliced to 40 chars
  // which collided when filter membership changed but length + the first ~5
  // IDs stayed identical (e.g. rating a mid-deck Hard card Good while another
  // entered the Hard set) — returning stale order with cards no longer in
  // the filter. Hashing the full list catches every membership change.
  let _idHash = 0;
  for (const x of qs) for (let i = 0; i < x.id.length; i++) _idHash = ((_idHash * 31 + x.id.charCodeAt(i)) | 0);
  const key = `${state.order}|${state.filter.obj}|${state.filter.due}|${state.filter.weakest}|${state.filter.hard}|${state.filter.search}|${qs.length}|${_idHash}`;
  if (!state._orderCache || state._orderCache.key !== key) {
    const list = orderDeck(qs, state.progress, { mode: state.order, seed: state._orderSeed });
    state._orderCache = { key, list };
  }
  return state._orderCache.list;
}

function dueCount() {
  return state.questions.filter(isDue).length;
}
function weakestCount() {
  return weakestIdSet().size;
}
// Cards the user most recently rated Hard or Again — the "still shaky" set.
function hardCount() {
  return state.questions.filter(q => {
    const r = state.progress[q.id]?.lastRating;
    return r === 'hard' || r === 'again';
  }).length;
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
  // Exam countdown is always visible so the deadline stays top-of-mind.
  // Urgency class kicks in when ≤7 days remain; hidden in Anxiety Mode
  // along with other numeric progress feedback.
  const days = daysUntilExam(state.exam);
  hud.classList.remove('hud-urgent', 'hud-soon', 'hud-past');
  if (days !== null && pref('anxiety') !== 'on') {
    const short = examDef(state.exam).label.replace(/\s*\(.*\)$/, '');
    let label;
    if (days < 0)       { label = `${short} exam was ${-days}d ago`; hud.classList.add('hud-past'); }
    else if (days === 0){ label = `${short} · TODAY`; hud.classList.add('hud-urgent'); }
    else if (days <= 7) { label = `${short} · ${days}d`; hud.classList.add('hud-urgent'); }
    else if (days <= 30){ label = `${short} · ${days}d`; hud.classList.add('hud-soon'); }
    else                { label = `${short} · ${days}d`; }
    parts.push(`⏳ ${label}`);
  }
  if (state.cram?.active) {
    const remaining = state.cram.queue.length;
    parts.push(`🔥 Cram ${state.cram.cleared}/${state.cram.originalCount}` + (remaining ? ` · ${remaining} to go` : ''));
  }
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
    // Skip the "X due" counter when X equals the total questions — fresh
    // users see everything as due, so the number duplicates the deck size
    // and (per the QA pass) overwhelms a beginner. Once they rate even one
    // card, the count diverges and re-appears.
    if (!state.filter.due) {
      const due = dueCount();
      if (due > 0 && due < state.questions.length) parts.push(`${due} due`);
    }
  }
  hud.textContent = parts.join(' · ');
  updateDueBadge();
}

// Spaced-repetition "due" pill on the Study tab. Mirrors the HUD's
// anxiety-mode suppression so the count stays consistent.
function updateDueBadge() {
  const badge = $('#study-due-badge');
  if (!badge) return;
  // "Review backlog": cards already SEEN that have come due again. New
  // unseen cards are deliberately excluded — counting them would just
  // mirror the deck size on a fresh install and never feel like a backlog.
  // Suppressed in Anxiety Mode (hides numeric pressure cues).
  const due = pref('anxiety') === 'on' ? 0
    : state.questions.filter(q => (state.progress[q.id]?.seen || 0) > 0 && isDue(q)).length;
  if (due > 0) {
    badge.textContent = due > 99 ? '99+' : String(due);
    badge.hidden = false;
    badge.setAttribute('aria-hidden', 'false');
    badge.setAttribute('aria-label', `${due} cards due for review`);
  } else {
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
  }
}

//─── MODE: STUDY (flashcards with self-rating) ──────────────
function renderStudy() {
  $('#mode-title').textContent = 'Study';
  document.documentElement.toggleAttribute('data-revealed', !!state.revealed);
  const qs = filteredQuestions();
  if (qs.length === 0) {
    const msg = state.filter.weakest
      ? ['Nothing weak yet', 'Weakest shows cards you\'ve missed before. Rate a few cards and come back — that list builds itself.']
      : state.filter.due
      ? ['✨ All caught up!', 'No cards due right now — come back later, or tap Due again to turn it off and study anything.']
      : state.filter.search
      ? ['Hmm, nothing matches', `Nothing for "${escapeHtml(state.filter.search)}". Try a different word or clear the search.`]
      : ['No questions', 'Pick an objective below or clear the filter.'];
    $('#main').innerHTML = filterBarHTML() + emptyHTML(msg[0], msg[1]);
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
  // Only animate the card on question change, not on reveal-toggle rerenders
  const sameCard = state._lastRenderedCard === q.id;
  let cardClass = sameCard ? 'card' : 'card card-fresh';
  state._lastRenderedCard = q.id;
  // Preserve the scroll position across SAME-CARD re-renders. Picking an
  // option and revealing both rebuild #main via innerHTML, which resets
  // scrollTop to 0 — that mid-card jump-to-top is the "the screen resizes
  // when I tap an answer" report. We restore it after the swap. On a real
  // card *change* we intentionally start at the top (prevScroll stays 0).
  const prevScroll = sameCard ? ($('#main')?.scrollTop || 0) : 0;
  // If we're in the first 500ms after reveal, paint the whole card with
  // pointer-events: none. Every other guard (rate-row arming, JS timestamp
  // checks in nextQuestion/prevQuestion, swipe target check) catches a
  // specific path; this is the catch-all that makes ANY accidental click
  // on the card during the reveal-transition window impossible.
  const sinceReveal = Date.now() - (state._revealedAt || 0);
  if (state.revealed && sinceReveal < 800) cardClass += ' card-just-revealed';
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="${cardClass}">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        ${(() => {
          // Pretest-sourced questions render the familiar P{n}Q{n} badge.
          // Questions from other sources (e.g. the YouTube set, where
          // sources[i].source is a non-pretest identifier) fall back to
          // showing the question id, since pretest/qnum aren't defined.
          // Both wrap in .tag-source-id — hidden by default in styles.css
          // to keep the beginner card clear of internal IDs. The Edit
          // button still works; Amanda can recover the id from the editor.
          const isPretest = typeof q.pretest === 'number' && typeof q.qnum === 'number';
          if (isPretest) {
            return `<span class="tag tag-source-id" title="Appeared on: ${sources.map(s => `P${s.pretest}Q${s.qnum}`).join(', ')}">P${q.pretest} Q${q.qnum}</span>`;
          }
          const srcTitle = q.sources?.[0]?.source
            ? `Source: ${escapeHtml(q.sources[0].source)}`
            : `Source: ${escapeHtml(q.id)}`;
          return `<span class="tag tag-source-id" title="${srcTitle}">${escapeHtml(q.id)}</span>`;
        })()}
        ${sources.length > 1 ? `<span class="tag repeats" title="You missed this on ${sources.length} pretests: ${sources.map(s => `P${s.pretest}Q${s.qnum}`).join(', ')}">🔁 ${sources.length}×</span>` : ''}
        ${prog.seen > 0 ? `<span class="tag numeric">Seen ${prog.seen}×</span>` : ''}
        ${edited ? '<span class="tag edited">✏️ Edited</span>' : ''}
        <button class="tag tag-btn" id="edit-btn" title="Add/edit options and image">✏️ Edit</button>
      </div>
      <div class="card-question">${formatQuestion(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        <div class="card-section right">
          <div class="label">Correct answer & explanation</div>
          ${renderYourPickHTML(q)}
          ${formatExplanation(q.explanation)}
          ${renderLearnMoreHTML(q)}
        </div>
        ${renderRatingButtonsHTML(q)}
      ` : (() => {
        // Reveal is gated on a real retrieval attempt: the user must either
        // pick an answer or explicitly tap "I don't know" (free-recall
        // commit). The audit's biggest pedagogy gain — converts a recognition
        // task (seeing the answer with options visible) into actual
        // retrieval. The "I don't know" affordance prevents getting stuck
        // when the user genuinely doesn't have a guess.
        const hasOptions = Array.isArray(q.options) && q.options.length > 0;
        const ma = isMultipleAnswer(q);
        // For multi-answer questions, the audit's retrieval principle says:
        // pick the FULL answer set, not just one. Match Quiz mode's needCount
        // logic: default to q.correct_picks.length, fall back to 2 if
        // correct_picks isn't an array. Single-answer keeps needCount=1.
        const needCount = ma
          ? (Array.isArray(q.correct_picks) ? q.correct_picks.length : 2)
          : 1;
        const pickedCount = ma
          ? (state.selectedOptions || []).length
          : (state.selectedOption ? 1 : 0);
        const picked = pickedCount >= needCount;
        // No-options qtype (free-text, image-only PBQ stems): Reveal is
        // always enabled; the question itself IS the retrieval prompt.
        const armed = !hasOptions || picked || state.committed;
        const revealLabel = armed ? 'Reveal answer<span class="kbd-hint" aria-hidden="true">Space</span>'
                                  : (ma ? `Pick ${needCount} answers, then reveal (${pickedCount}/${needCount})`
                                        : 'Pick an answer, then reveal');
        return `
        <div class="btn-row btn-row-nav">
          <button class="action nav-btn" id="prev-btn" aria-label="Previous card" title="Previous">←</button>
          <button class="action primary" id="reveal-btn"${armed ? '' : ' disabled aria-disabled="true"'}>${revealLabel}</button>
          <button class="action nav-btn" id="skip-btn" aria-label="Skip without rating" title="Skip without rating">→</button>
        </div>
        ${hasOptions && !picked && !state.committed ? `
          <button type="button" class="action idk-btn" id="idk-btn"
                  aria-label="I don't know — reveal without picking">
            🤷 I don't know — show me
          </button>
          <p class="idk-note">Tip: even a guess is better than skipping. The point is committing first, then learning.</p>
        ` : ''}`;
      })()}
    </div>
  `;
  renderFilterBar();
  updateHUD();
  attachStudyEvents(q);
  // Restore pre-render scroll on same-card rerenders (see prevScroll above)
  // so tapping an option / revealing doesn't snap the card to the top.
  if (sameCard && prevScroll) { const m = $('#main'); if (m) m.scrollTop = prevScroll; }
  $('#edit-btn')?.addEventListener('click', () => { state.editing = true; renderStudy(); });
  // Keyboard / SR users would otherwise lose focus to <body> on every
  // innerHTML swap. Restore focus to the primary action (Reveal pre-
  // reveal, first rate button after). Skipped if focus is already on
  // something else (the user moved it themselves).
  restoreFocusAfterRender();
}

function attachStudyEvents(q) {
  // "I don't know — show me" — explicit free-recall commit. Arms Reveal
  // without requiring a guess so users aren't stuck when they truly can't
  // produce an answer (still pedagogically better than skipping: the
  // commit "I don't know this one" is itself a useful self-assessment
  // for the rating step).
  $('#idk-btn')?.addEventListener('click', () => {
    state.committed = true;
    haptic(5);
    renderStudy();
  });
  const reveal = $('#reveal-btn');
  if (reveal) reveal.addEventListener('click', () => {
    if (reveal.disabled) return;  // belt-and-suspenders against keyboard chord bypass
    state.revealed = true;
    state._revealedAt = Date.now();  // timestamp so rating buttons ignore ghost clicks
    stopSpeaking();
    // Announce verdict to screen readers — visual cue (red X / green check)
    // alone isn't enough for SR users. Build a short string from the user's
    // pick vs. the correct answer, then re-render.
    const correctPicks = Array.isArray(q.correct_picks) ? q.correct_picks : (q.correct_short ? [q.correct_short] : []);
    const picks = Array.isArray(q.correct_picks)
      ? (state.selectedOptions || [])
      : (state.selectedOption ? [state.selectedOption] : []);
    const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const got = picks.length && picks.length === correctPicks.length &&
                [...picks].every(p => correctPicks.some(c => norm(p) === norm(c)));
    const msg = picks.length === 0
      ? `Answer revealed. Correct: ${correctPicks.join(', ')}.`
      : (got ? `Correct — you picked ${picks.join(', ')}.`
             : `Incorrect — you picked ${picks.join(', ')}. The correct answer is ${correctPicks.join(', ')}.`);
    announce(msg, true);
    renderStudy();
  });
  const skip = $('#skip-btn');
  if (skip) skip.addEventListener('click', () => { nextQuestion(); });
  const prev = $('#prev-btn');
  if (prev) prev.addEventListener('click', () => { prevQuestion(); });
  attachOptionEvents(() => renderStudy());
  // Reference-book "Open p. N" — opens the in-app PDF viewer at the page.
  $$('.learn-more-btn.pageref').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = parseInt(btn.dataset.pageRef, 10);
      if (page) openReferenceViewer(page);
    });
  });
  // Auto-suggest: if a reference book is loaded AND indexed, look up a
  // probable page for this question and offer "Suggest p. N · Set" UI.
  // Lazy / async so it doesn't block the render.
  hydrateLearnMoreSuggest(q);
  // Arm the rate buttons AND the rate-header (containing the Back button) for
  // 500ms after they appear. Until then `.rate-row-arming` disables pointer
  // events via CSS — even a ghost-click can't land on a rate or Back button.
  // The JS timestamp guard below is a backup if the class somehow doesn't apply.
  const armed = $$('.rate-row-arming');
  if (armed.length) setTimeout(() => armed.forEach(el => el.classList.remove('rate-row-arming')), 800);
  // Catch-all: drop the .card-just-revealed pointer-events:none lock after the
  // window expires so the user can interact normally with the post-reveal card.
  // 800ms covers iOS Safari's lingering tap-delay even when user-scalable=no
  // is set (it doesn't fully eliminate the delay on every iOS version).
  const justRevealed = $('.card-just-revealed');
  if (justRevealed) setTimeout(() => justRevealed.classList.remove('card-just-revealed'), 800);
  // "← Back" link inside the rate header — lets the user undo a misregistered
  // tap on Reveal that landed somewhere unexpected, without having to wait
  // until they're on the next card and then navigate back.
  $('#rate-back-btn')?.addEventListener('click', () => prevQuestion());
  // First-reveal SRS hint: dismiss explicitly via "Got it ✕"…
  $('#rate-hint-dismiss')?.addEventListener('click', () => {
    lsSet('srsHintSeen', '1');
    $('#rate-hint')?.remove();
  });
  $$('[data-rate]').forEach(btn => btn.addEventListener('click', () => {
    if (Date.now() - (state._revealedAt || 0) < 800) return;
    // …or implicitly by the act of rating a card. Either way it's gone.
    if (localStorage.getItem('srsHintSeen') !== '1') lsSet('srsHintSeen', '1');
    const rate = btn.dataset.rate;
    recordRating(q.id, rate);
    nextQuestion();
  }));
}

function isMultipleAnswer(q) {
  return q.qtype === 'Multiple Answer' ||
    (Array.isArray(q.correct_picks) && q.correct_picks.length > 1);
}

function attachOptionEvents(rerender) {
  const q = state._currentQ;
  const ma = q && isMultipleAnswer(q);
  const items = $$('.q-options li.q-option');
  const pick = (li) => {
    if (state.revealed) return;
    const opt = li.dataset.option;
    if (ma) {
      // Toggle: add or remove from the selectedOptions array
      const arr = state.selectedOptions || [];
      const idx = arr.indexOf(opt);
      if (idx === -1) arr.push(opt);
      else arr.splice(idx, 1);
      state.selectedOptions = arr;
    } else {
      state.selectedOption = opt;
    }
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
  // Defensive: loadData seeds a row for every loaded question, so this is
  // only reachable if a quiz session is mid-flight when switchExam/reset
  // wipes state.progress out from under it. Bail rather than crash.
  if (!p) return;
  p.seen++;
  p.lastSeen = Date.now();
  p.updated_at = p.lastSeen;
  p.lastRating = rate;  // remembered for the "Hard" filter chip
  if (rate === 'good' || rate === 'easy') p.correct++;
  // Pass an exam-aware interval cap. With no exam date set, schedule()
  // falls back to its 30-day default. With one set, never schedule past
  // the exam itself — testing a card 5 days after the exam wastes effort
  // and inflates the readiness "covered" count.
  const days = daysUntilExam(state.exam);
  // Exam-aware retention escalation (deep-research / FSRS community consensus
  // for short-horizon high-stakes prep). Sits on top of the canonical
  // FSRS-4 curve (PR #65) so the constant actually means what it says:
  //   - no exam date / >14 days:  0.90 (canonical default)
  //   - 8-14 days out:            0.93 (~half the canonical interval)
  //   - <=7 days out:             0.95 (~1/3 the canonical interval)
  // Above 0.95 the relearning-cost curve goes U-shaped per fsrs4anki
  // tutorial; capping at 0.95 trades off insurance against last-week
  // forgetting against review-load explosion.
  const targetRetention = days === null || days > 14 ? 0.90
                        : days >  7 ? 0.93
                        : 0.95;
  schedule(p, rate, undefined, days !== null && days > 0 ? days : undefined, targetRetention);
  haptic(10);
  saveProgress();
  onCardRated(qid);
  onCramRated(qid, rate);
}

function nextQuestion() {
  // Note: the 800ms ghost-click guard used to sit here too, blocking the
  // function for any caller. That silently swallowed keyboard rates (1-4
  // press immediately after Space-reveal). The rate-btn CLICK handler
  // keeps its own 800ms guard (that's the actual ghost-click vector);
  // keyboard / Next-button / swipe paths now advance immediately.
  const qs = filteredQuestions();
  state.revealed = false;
  stopSpeaking();
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  if (qs.length === 0) { renderStudy(); return; }
  // Push the current card's ID (not its index) so Prev finds the right card
  // even if the deck reorders or shrinks (e.g. after rating with a Due filter).
  if (qs[state.currentIndex]) state.history.push(qs[state.currentIndex].id);
  if (state.history.length > 50) state.history.shift();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  renderStudy();
}

function prevQuestion() {
  // Guard removed — see nextQuestion. Keyboard / arrow / swipe paths
  // shouldn't be blocked.
  const qs = filteredQuestions();
  state.revealed = false;
  stopSpeaking();
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  if (qs.length === 0) { renderStudy(); return; }
  if (state.history.length > 0) {
    const prevId = state.history.pop();
    const idx = qs.findIndex(q => q.id === prevId);
    if (idx !== -1) {
      state.currentIndex = idx;
    } else {
      // Card was filtered out of the current deck (e.g. it's no longer due).
      // Fall back to one-step backward so Prev does *something* sensible.
      state.currentIndex = state.currentIndex === 0 ? qs.length - 1 : state.currentIndex - 1;
    }
  } else {
    state.currentIndex = state.currentIndex === 0 ? qs.length - 1 : state.currentIndex - 1;
  }
  renderStudy();
}

//─── MODE: QUIZ (exam simulator — pick and score, no hints) ──
function renderQuiz() {
  document.documentElement.removeAttribute('data-revealed');
  if (!state.quizSession) { renderQuizStart(); return; }
  if (state.quizSession.done) { renderQuizResults(); return; }
  renderQuizCard();
}

function renderQuizStart() {
  const available = filteredQuestions();
  const total = available.length;
  $('#mode-title').textContent = 'Quiz';
  const sizes = [
    { n: 20, label: '20 questions — Quick test' },
    { n: 40, label: '40 questions — Half exam' },
    { n: 90, label: '90 questions — Full practice exam' },
  ];
  const btns = sizes.map(({ n, label }) => {
    const count = Math.min(n, total);
    const disabled = total < 5 ? 'disabled' : '';
    const note = total < n && total >= 5 ? ` (only ${total} available)` : '';
    return `<button class="action quiz-size-btn" data-size="${count}" ${disabled}>${label}${note}</button>`;
  }).join('');
  // Mock-exam mode — separate CTA so it can't be picked accidentally
  // while looking for a practice quiz. Deep-research Q3 specifically
  // called out timed mocks under exam conditions as the highest-leverage
  // study activity the app was missing. Available only when there are
  // enough Qs for a full 90-card simulation.
  const mockEnabled = total >= 90;
  const mockBtn = `
    <div class="mock-start-row">
      <button class="action mock-start-btn" data-mock ${mockEnabled ? '' : 'disabled'}>
        ⏱️ Mock exam — 90 questions, 90 min, exam conditions
      </button>
      <p class="mock-start-desc">
        ${mockEnabled
          ? `No per-question feedback until the end. Hard pass mark: 700/900 (77.8%) — matches CompTIA A+ Core 2 scoring.`
          : `Clear the filter so all ${state.questions.length} questions are available, then come back.`}
      </p>
    </div>`;
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card quiz-start">
      <div class="quiz-start-icon">🎯</div>
      <h2 class="quiz-start-title">Practice Quiz</h2>
      <p class="quiz-start-desc">Pick your answers with no hints. You'll see your score and a list of anything you missed at the end.</p>
      <p class="quiz-avail">${total} question${total !== 1 ? 's' : ''} available${state.filter.obj ? ` in OBJ ${state.filter.obj}` : ''}</p>
      <div class="quiz-size-btns">${btns}</div>
      ${total < 5 ? '<p class="quiz-start-warn">Clear the filter to get more questions.</p>' : ''}
      ${mockBtn}
    </div>
  `;
  renderFilterBar();
  $$('[data-size]').forEach(btn => btn.addEventListener('click', () => {
    const n = Math.min(parseInt(btn.dataset.size, 10), total);
    if (n >= 1) startQuiz(n, available);
  }));
  $('[data-mock]')?.addEventListener('click', () => startMockExam());
}

function startQuiz(n, available) {
  const qs = (available || filteredQuestions()).slice(0, n);
  state.quizSession = {
    questions: qs,
    answers: {},
    current: 0,
    startedAt: Date.now(),
    done: false,
  };
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  renderQuizCard();
}

// Mock-exam mode: 90 random questions, 90-minute countdown, NO per-
// question feedback (matches real CompTIA A+ Core 2 conditions). The
// deep-research recommended 2-3 of these under exam conditions before
// the real test. Stored in quizHistory with mock:true so the readiness
// banner can weight mock results more heavily than open-book practice
// in a future PR.
const MOCK_EXAM_DURATION_MIN = 90;
const MOCK_EXAM_QUESTION_COUNT = 90;
const MOCK_EXAM_PASS_PCT = 77.8;  // 700/900, CompTIA's scaled cutoff
function startMockExam() {
  // Draw a fresh random sample from the FULL question bank — not
  // filteredQuestions(). A mock under exam conditions has to mirror the
  // real exam's domain coverage; respecting a chip filter would
  // accidentally narrow the draw.
  const all = state.questions.slice();
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const qs = all.slice(0, Math.min(MOCK_EXAM_QUESTION_COUNT, all.length));
  state.quizSession = {
    questions: qs,
    answers: {},
    current: 0,
    startedAt: Date.now(),
    endsAt: Date.now() + MOCK_EXAM_DURATION_MIN * 60 * 1000,
    mock: true,
    done: false,
  };
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  installMockExamTicker();
  renderQuizCard();
}

// Drives the visible countdown in the header and force-finishes the
// session when time runs out.
function installMockExamTicker() {
  if (state._quizTick) clearInterval(state._quizTick);
  state._quizTick = setInterval(() => {
    const s = state.quizSession;
    if (!s || !s.mock || s.done) {
      clearInterval(state._quizTick);
      state._quizTick = null;
      return;
    }
    const remainMs = s.endsAt - Date.now();
    if (remainMs <= 0) {
      // Time's up: silently mark all unanswered as skipped and finish.
      for (const q of s.questions) {
        if (!s.answers[q.id]) recordQuizAnswer(getQuestion(q), []);
      }
      s.done = true;
      clearInterval(state._quizTick);
      state._quizTick = null;
      if (state.mode === 'quiz') renderQuizResults();
      return;
    }
    // Update the visible countdown in the mode-title HUD without a full
    // re-render — the question card shouldn't flicker every second.
    const el = $('#mock-countdown');
    if (el) el.textContent = formatMockCountdown(remainMs);
  }, 1000);
}
function formatMockCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderQuizCard() {
  const session = state.quizSession;
  if (!session) { renderQuizStart(); return; }
  const { questions, answers, current } = session;
  if (current >= questions.length) { session.done = true; renderQuizResults(); return; }

  const baseQ = questions[current];
  const q = getQuestion(baseQ);
  const answered = answers[q.id];
  const total = questions.length;
  const pct = Math.round((current / total) * 100);

  const options = shuffleOptionsForCard(q.options || [], q.id);
  const ma = isMultipleAnswer(q);
  const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const correctSet = new Set(
    Array.isArray(q.correct_picks) && q.correct_picks.length
      ? q.correct_picks.map(norm)
      : q.correct_short ? [norm(q.correct_short)] : []
  );
  const isCorrect = (opt) => correctSet.has(norm(opt));

  let pickedSet;
  if (answered) {
    pickedSet = new Set(answered.picked || []);
  } else {
    pickedSet = ma
      ? new Set(state.selectedOptions || [])
      : new Set(state.selectedOption ? [state.selectedOption] : []);
  }

  // Mock-exam mode suppresses per-question feedback to match real
  // CompTIA conditions. After recordQuizAnswer fires, the option is
  // still styled as just-picked, not as correct/wrong, and the
  // explanation block is hidden — all feedback comes at the results
  // screen at the end.
  const mock = session.mock === true;
  const optCls = (opt) => {
    if (answered && !mock) {
      if (isCorrect(opt)) return 'q-option correct';
      if (pickedSet.has(opt)) return 'q-option wrong';
      return 'q-option revealed-other';
    }
    return pickedSet.has(opt) ? 'q-option picked' : 'q-option';
  };

  const LETTERS = 'ABCDEFGHIJ';
  const needCount = ma ? (Array.isArray(q.correct_picks) ? q.correct_picks.length : 2) : 1;
  const hint = ma && !answered
    ? `<div class="ma-hint">Select ${needCount} answers — tap again to deselect. Picked ${pickedSet.size} of ${needCount}.</div>`
    : '';

  const optionsHTML = options.length === 0 ? '' : `
    ${hint}
    <ol class="q-options${ma ? ' q-options-ma' : ''}" role="${ma ? 'group' : 'radiogroup'}" aria-label="Answer choices">
      ${options.map((opt, i) => {
        const checked = pickedSet.has(opt);
        const tab = (pickedSet.size ? checked : i === 0) ? 0 : -1;
        const letter = LETTERS[i] || String(i + 1);
        const describe = (answered && !mock)
          ? (isCorrect(opt) ? ' (correct answer)' : checked ? ' (your pick, incorrect)' : '')
          : '';
        return `<li class="${optCls(opt)}" role="${ma ? 'checkbox' : 'radio'}"
            aria-checked="${checked ? 'true' : 'false'}"
            tabindex="${tab}"
            data-option="${escapeHtml(opt)}"
            aria-label="${escapeHtml(letter + '. ' + opt + describe)}">
          <span class="q-letter" aria-hidden="true">${letter}</span>
          <span class="q-text">${escapeHtml(opt)}</span>
          <span class="q-status" aria-hidden="true"></span>
        </li>`;
      }).join('')}
    </ol>`;

  const isLast = current + 1 >= total;
  const actionBar = answered
    ? `<div class="btn-row">
        <button class="action primary" id="quiz-next-btn">${isLast ? 'See results →' : 'Next →'}</button>
       </div>`
    : ma
    ? `<div class="btn-row">
        <button class="action primary" id="quiz-submit-btn"${pickedSet.size < needCount ? ' disabled' : ''}>Submit answer</button>
        <button class="action" id="quiz-skip-btn">Skip</button>
       </div>`
    : `<div class="btn-row">
        <button class="action" id="quiz-skip-btn">Skip</button>
       </div>`;

  if (mock) {
    const remain = Math.max(0, (session.endsAt || Date.now()) - Date.now());
    // Visible countdown lives inline so the setInterval in
    // installMockExamTicker can update just this node, not re-render the card.
    $('#mode-title').innerHTML = `Mock ${current + 1}/${total} · <span id="mock-countdown" class="mock-countdown">${formatMockCountdown(remain)}</span>`;
  } else {
    $('#mode-title').textContent = `Quiz ${current + 1}/${total}`;
  }
  // Lock the card for 800ms after answering so a ghost-click can't tap "Next"
  // before the user has read the correct/wrong feedback.
  const sinceAns = Date.now() - (state._revealedAt || 0);
  const quizCardClass = 'card card-fresh' + (answered && sinceAns < 800 ? ' card-just-revealed' : '');
  $('#main').innerHTML = `
    <div class="${quizCardClass}">
      <div class="quiz-progress-bar" role="progressbar" aria-valuenow="${current}" aria-valuemin="0" aria-valuemax="${total}" aria-label="Question ${current + 1} of ${total}">
        <div class="quiz-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        <span class="tag quiz-counter">${current + 1} / ${total}</span>
        <button class="tag tag-btn quiz-abandon-btn" title="End this quiz">✕ End quiz</button>
      </div>
      <div class="card-question">${formatQuestion(q.question)}</div>
      ${renderImageHTML(q)}
      ${optionsHTML}
      ${actionBar}
    </div>
  `;
  // (no renderFilterBar here — the filter+search bar is intentionally
  // hidden during an active quiz; chips don't apply to a fixed session.)

  $('.quiz-abandon-btn')?.addEventListener('click', () => {
    if (Object.keys(session.answers).length === 0 || confirm('End this quiz? Your progress will be lost.')) {
      state.quizSession = null;
      if (state._quizTick) { clearInterval(state._quizTick); state._quizTick = null; }
      renderQuizStart();
    }
  });

  if (answered) {
    // Drop the .card-just-revealed lock once the 800ms window expires so the
    // user can tap Next manually as soon as they've read the explanation.
    const justRevealedQuiz = $('.card-just-revealed');
    if (justRevealedQuiz) setTimeout(() => justRevealedQuiz.classList.remove('card-just-revealed'), 800);
    const nextBtn = $('#quiz-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', (e) => {
      // Ghost-click guard scoped to pointer events: a tap that fires within
      // 800ms of the original pick is almost certainly the pick-tap leaking
      // through layout shift. Keyboard / swipe / touch-with-pointer-event
      // paths advance immediately (none has a ghost-click risk).
      if (e.pointerType !== 'keyboard' && Date.now() - (state._revealedAt || 0) < 800) return;
      advanceQuiz();
    });
    // No auto-advance: classmates reported the previous 1.8 s timeout rushed
    // them past the explanation. The Next → button (and Space/Enter, and
    // swipe-left) all advance manually; the user paces themselves.
  } else {
    const items = $$('.q-options li.q-option');
    state._currentQ = q;
    items.forEach(li => {
      li.addEventListener('click', () => {
        if (session.answers[q.id]) return;
        const opt = li.dataset.option;
        if (ma) {
          const arr = state.selectedOptions || [];
          const idx = arr.indexOf(opt);
          if (idx === -1) arr.push(opt);
          else arr.splice(idx, 1);
          state.selectedOptions = arr;
          renderQuizCard();
        } else {
          recordQuizAnswer(q, [opt]);
        }
      });
    });
    $('#quiz-submit-btn')?.addEventListener('click', () => {
      if (!session.answers[q.id]) recordQuizAnswer(q, state.selectedOptions || []);
    });
    $('#quiz-skip-btn')?.addEventListener('click', () => {
      recordQuizAnswer(q, []);
    });
  }
  // Restore focus after the innerHTML swap (same rationale as renderStudy).
  restoreFocusAfterRender();
}

function recordQuizAnswer(q, picked) {
  const session = state.quizSession;
  if (!session || session.answers[q.id]) return;
  const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const correctSet = new Set(
    Array.isArray(q.correct_picks) && q.correct_picks.length
      ? q.correct_picks.map(norm)
      : q.correct_short ? [norm(q.correct_short)] : []
  );
  const pickedNorm = new Set(picked.map(norm));
  let isRight;
  if (picked.length === 0) {
    isRight = false;
  } else if (isMultipleAnswer(q)) {
    isRight = pickedNorm.size === correctSet.size && [...correctSet].every(c => pickedNorm.has(c));
  } else {
    isRight = pickedNorm.size === 1 && [...pickedNorm].every(p => correctSet.has(p));
  }
  session.answers[q.id] = {
    picked: picked.slice(),
    isRight,
    correctShort: q.correct_short || (Array.isArray(q.correct_picks) ? q.correct_picks.join(', ') : ''),
  };
  recordRating(q.id, isRight ? 'good' : 'again');
  // Reuse the Study mode reveal-window lock so a ghost-click right after
  // picking can't auto-advance past the answer feedback.
  state._revealedAt = Date.now();
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  // Announce verdict to screen readers — visual marking alone isn't
  // accessible. Built from session.answers so it stays consistent with
  // what the card now displays.
  const correctShort = session.answers[q.id].correctShort;
  announce(picked.length === 0
    ? `Skipped. Correct: ${correctShort}.`
    : (isRight ? `Correct — you picked ${picked.join(', ')}.`
               : `Incorrect — you picked ${picked.join(', ')}. The correct answer is ${correctShort}.`), true);
  haptic(10);
  renderQuizCard();
}

function advanceQuiz() {
  // Guard moved to the Next button's click handler (the only ghost-click
  // path) — keyboard / swipe advance immediately.
  const session = state.quizSession;
  if (!session) return;
  session.current++;
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  if (session.current >= session.questions.length) {
    session.done = true;
    renderQuizResults();
  } else {
    renderQuizCard();
  }
}

// Quiz history is stored per-exam in localStorage so users see their
// progression without it polluting the cross-device sync payload.
const QUIZ_HISTORY_KEY = (exam) => `quizHistory.${exam}`;
const QUIZ_HISTORY_LIMIT = 50;
function loadQuizHistory(exam = state.exam) {
  try {
    const raw = localStorage.getItem(QUIZ_HISTORY_KEY(exam));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function recordQuizHistory(entry) {
  const exam = entry.exam || state.exam;
  const list = loadQuizHistory(exam);
  // Idempotency: skip if we already recorded a session with this startedAt
  if (list.some(e => e.startedAt === entry.startedAt)) return;
  list.push(entry);
  if (list.length > QUIZ_HISTORY_LIMIT) list.splice(0, list.length - QUIZ_HISTORY_LIMIT);
  lsSet(QUIZ_HISTORY_KEY(exam), JSON.stringify(list));  // lsSet swallows quota errors itself
}

function renderQuizResults() {
  const session = state.quizSession;
  const total = session.questions.length;
  const correct = Object.values(session.answers).filter(a => a.isRight).length;
  const answered = Object.keys(session.answers).length;
  const skipped = total - answered;
  const score = Math.round((correct / total) * 100);
  const elapsed = Math.round((Date.now() - session.startedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const mock = session.mock === true;
  // Real CompTIA A+ Core 2 cutoff is 700/900 (~77.8%) on a scaled
  // score — that's the line for mock results. Practice quizzes still
  // use the looser 75% heuristic.
  const passed = mock ? (score >= MOCK_EXAM_PASS_PCT) : (score >= 75);
  // Stop the countdown the moment the user sees the score (auto-finish
  // already stops it; this catches normal end-of-deck completion).
  if (mock && state._quizTick) { clearInterval(state._quizTick); state._quizTick = null; }

  // Per-objective breakdown for mock results (CompTIA's score report
  // ships a similar by-domain rollup). Computed once here, reused in
  // the render block below.
  const objBreakdown = mock ? (() => {
    const buckets = new Map();  // obj → { total, correct }
    for (const bq of session.questions) {
      const obj = bq.obj || '?';
      const a = session.answers[bq.id];
      const b = buckets.get(obj) || { total: 0, correct: 0 };
      b.total++;
      if (a && a.isRight) b.correct++;
      buckets.set(obj, b);
    }
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })() : [];

  // Persist this quiz to history (idempotent — keyed on startedAt so re-renders
  // of the results screen don't double-record). Capped at 50 to keep
  // localStorage tiny.
  recordQuizHistory({
    startedAt: session.startedAt,
    finishedAt: Date.now(),
    total,
    correct,
    skipped,
    score,
    elapsedSec: elapsed,
    exam: state.exam,
    mock,   // distinguishes mock (closed-book, timed) from practice quiz history
  });

  const wrong = session.questions.filter(bq => {
    const a = session.answers[bq.id];
    return !a || !a.isRight;
  });

  const wrongHTML = wrong.length === 0 ? '' : `
    <div class="quiz-missed">
      <h3 class="quiz-missed-title">Missed (${wrong.length})</h3>
      <ul class="quiz-missed-list">
        ${wrong.map(bq => {
          const q = getQuestion(bq);
          const a = session.answers[q.id];
          const preview = q.question.length > 90 ? q.question.slice(0, 90) + '…' : q.question;
          return `<li class="quiz-missed-item">
            <span class="quiz-missed-q">${escapeHtml(preview)}</span>
            ${a ? `<span class="quiz-missed-ans">✓ ${escapeHtml(a.correctShort)}</span>` : '<span class="quiz-missed-ans quiz-skipped">Skipped</span>'}
          </li>`;
        }).join('')}
      </ul>
    </div>`;

  // Per-OBJ breakdown block, mock-only — matches CompTIA's score
  // report style so the user knows which domain to focus next pass.
  const objHTML = !mock || objBreakdown.length === 0 ? '' : `
    <div class="mock-obj-breakdown">
      <h3 class="mock-obj-title">By objective</h3>
      <ul class="mock-obj-list">
        ${objBreakdown.map(([obj, b]) => {
          const pct = Math.round((b.correct / b.total) * 100);
          const tier = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
          return `<li class="mock-obj-row" data-tier="${tier}">
            <span class="mock-obj-name">OBJ ${escapeHtml(obj)}</span>
            <span class="mock-obj-bar"><span class="mock-obj-fill" style="width:${pct}%"></span></span>
            <span class="mock-obj-count">${b.correct}/${b.total}</span>
          </li>`;
        }).join('')}
      </ul>
    </div>`;

  $('#mode-title').textContent = mock ? 'Mock results' : 'Quiz';
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card quiz-results${mock ? ' mock-results' : ''}">
      ${mock ? '<div class="mock-badge">⏱️ Timed mock exam</div>' : ''}
      <div class="quiz-score-circle ${passed ? 'pass' : 'fail'}">
        <span class="quiz-score-pct">${score}%</span>
        <span class="quiz-score-label">${passed ? 'Pass ✓' : 'Keep going'}</span>
      </div>
      <p class="quiz-result-detail">${correct} / ${total} correct · ${elapsedStr}${skipped > 0 ? ` · ${skipped} skipped` : ''}</p>
      <p class="quiz-pass-note">${
        mock
          ? (passed
              ? `🎉 Above the ${MOCK_EXAM_PASS_PCT}% mock-exam pass mark (CompTIA's 700/900 scaled cutoff).`
              : `Below the ${MOCK_EXAM_PASS_PCT}% mock-exam pass mark (CompTIA's 700/900 cutoff). Focus on the weakest objectives below.`)
          : (passed
              ? '🎉 CompTIA A+ pass threshold is ~75%. Great work!'
              : 'Target 75%+ before the real exam. Keep studying!')
      }</p>
      <div class="btn-row">
        <button class="action primary" id="quiz-new-btn">${mock ? 'Run another mock' : 'New quiz'}</button>
        ${wrong.length > 0 ? `<button class="action" id="quiz-review-btn">Study missed (${wrong.length})</button>` : ''}
      </div>
      ${objHTML}
      ${wrongHTML}
    </div>
  `;
  renderFilterBar();

  $('#quiz-new-btn')?.addEventListener('click', () => {
    state.quizSession = null;
    renderQuizStart();
  });
  $('#quiz-review-btn')?.addEventListener('click', () => {
    // Wrong answers were just rated 'again', so they'll surface at the top of the Study deck
    state.quizSession = null;
    setMode('study');
  });
}

//─── MODE: READING (concept fix sheets) ──────────────────────
function renderReading() {
  $('#mode-title').textContent = 'Reading';
  $('#progress-hud').textContent = '';
  // concept-fixes is deferred at boot. If the user hits Reading before
  // it's landed, show a loading state + re-render when the fetch resolves.
  if (Object.keys(state.conceptFixes).length === 0 && state._conceptFixesPromise) {
    $('#main').innerHTML = '<div class="empty-state"><div class="icon">📖</div><h3>Loading reading sheets…</h3></div>';
    state._conceptFixesPromise.then(() => { if (state.mode === 'reading') renderReading(); });
    return;
  }
  const objs = Object.keys(state.conceptFixes).sort((a, b) => {
    // Pin priority sections (mnemonics, troubleshooting) to the top in a fixed
    // order. Numeric OBJ X.Y keys sort numerically below them.
    const PRIORITY = { mnemonics: -2, troubleshooting: -1 };
    if (a in PRIORITY || b in PRIORITY) return (PRIORITY[a] ?? 99) - (PRIORITY[b] ?? 99);
    const [am, an] = a.split('.').map(Number);
    const [bm, bn] = b.split('.').map(Number);
    return am - bm || an - bn;
  });

  if (objs.length === 0) {
    $('#main').innerHTML = emptyHTML(
      'No concept fixes yet',
      `${examDef(state.exam).label} has no reading content. Populate ${examDef(state.exam).fixes} and hard-refresh.`
    );
    return;
  }

  const sectionId = obj => `obj-${obj.replace(/\./g, '-')}`;
  const tocHtml = `
    <nav class="reading-toc" aria-label="Reading sections">
      <div class="reading-toc-title">Sections</div>
      <div class="reading-toc-search-row">
        <input id="reading-toc-search" type="search" class="reading-toc-search"
               placeholder="Filter sections… (e.g. RAID, 1.2)"
               aria-label="Filter reading sections" autocomplete="off">
      </div>
      <ol class="reading-toc-list">
        ${objs.map(obj => {
          const fix = state.conceptFixes[obj];
          // Numeric keys (4.2, 5.5, …) get an "OBJ" prefix; named priority
          // keys (mnemonics, troubleshooting) get title-cased on their own.
          const isNumeric = /^\d+\.\d+$/.test(obj);
          const label = isNumeric ? `OBJ ${obj}` : obj.charAt(0).toUpperCase() + obj.slice(1);
          const haystack = `${label} ${fix.title}`.toLowerCase();
          return `<li data-toc-search="${escapeHtml(haystack)}"><a href="#${sectionId(obj)}" class="reading-toc-link" data-toc="${escapeHtml(obj)}">
            <span class="reading-toc-num">${escapeHtml(label)}</span>
            <span class="reading-toc-text">${escapeHtml(fix.title)}</span>
          </a></li>`;
        }).join('')}
      </ol>
      <p class="reading-toc-empty" hidden>No sections match.</p>
    </nav>`;

  const sectionsHtml = objs.map(obj => {
    const fix = state.conceptFixes[obj];
    const isNumeric = /^\d+\.\d+$/.test(obj);
    const heading = isNumeric ? `OBJ ${obj} — ${escapeHtml(fix.title)}` : escapeHtml(fix.title);
    // Numeric OBJ sheets get a "Test yourself" CTA that jumps into Study
    // filtered to that objective. Reading alone is encoding, not
    // retrieval — converting passive reading into a read→retrieve loop
    // is the highest-impact retention move at near-zero cost.
    const testYourselfBtn = isNumeric ? `
        <div class="reading-test-row">
          <button type="button" class="action primary reading-test-btn" data-test-obj="${escapeHtml(obj)}">
            🎯 Test yourself on OBJ ${obj}
          </button>
          <span class="reading-test-note">Skim ≠ remember. A 3-question retrieval check beats re-reading.</span>
        </div>` : '';
    return `
      <section class="obj-section" id="${sectionId(obj)}" aria-labelledby="${sectionId(obj)}-h">
        <h2 id="${sectionId(obj)}-h">${heading}</h2>
        ${fix.content}
        ${testYourselfBtn}
        <a href="#" class="reading-top-link" aria-label="Back to top">↑ Top</a>
      </section>
    `;
  }).join('');

  $('#main').innerHTML = `
    <div class="reading-wrap">
      ${tocHtml}
      <div class="reading-list">${sectionsHtml}</div>
    </div>`;

  // Live filter for the section list — type an OBJ number or a keyword
  // (e.g. "RAID", "1.2") to narrow a long TOC instead of eyeballing it.
  // Filters only the nav list; the reading sections themselves stay put.
  const tocSearch = $('#reading-toc-search');
  if (tocSearch) {
    tocSearch.addEventListener('input', () => {
      const q = tocSearch.value.trim().toLowerCase();
      let any = false;
      $$('.reading-toc-list li').forEach(li => {
        const show = !q || (li.dataset.tocSearch || '').includes(q);
        li.hidden = !show;
        if (show) any = true;
      });
      const empty = $('.reading-toc-empty');
      if (empty) empty.hidden = any || !q;
    });
  }
  // Smooth scroll for the "back to top" links and TOC anchors. Keeps URL hash
  // in sync so users can deep-link to a section.
  $$('.reading-toc-link').forEach(a => {
    a.addEventListener('click', (e) => {
      const target = $(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });
  $$('.reading-top-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      history.replaceState(null, '', '#');
    });
  });
  // "Test yourself on OBJ N.M" — filter Study to that objective + start
  // an N-card micro-session so the user actually retrieves what they
  // just read instead of just scrolling on.
  $$('.reading-test-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const obj = btn.dataset.testObj;
      if (!obj) return;
      state.filter = { obj, due: false, weakest: false, hard: false, search: '' };
      state.currentIndex = 0;
      state._orderCache = null;
      startSession({ targetCards: 3 });
      setMode('study');
    });
  });
  // If the URL already has a hash, jump there after layout settles.
  // Validate the hash format strictly — querySelector throws on malformed
  // selectors, so a hash like `#obj-"];alert(1);[` would silently break
  // the scroll. Only allow alnum / hyphen / dot after the `#obj-` prefix
  // (matches the sectionId pattern used by Reading sheets).
  if (location.hash && /^#obj-[a-z0-9.-]+$/i.test(location.hash)) {
    setTimeout(() => {
      try { $(location.hash)?.scrollIntoView({ behavior: 'instant', block: 'start' }); }
      catch {}
    }, 50);
  }
}

//─── MODE: STATS ─────────────────────────────────────────────
function renderStats() {
  $('#mode-title').textContent = 'Stats';
  $('#progress-hud').textContent = '';
  const qs = state.questions;
  // Defensive against the tight race window during exam-switch + sync
  // where state.questions has been swapped but state.progress hasn't
  // been re-seeded yet. Without `?.`, the filter throws Cannot-read-seen
  // and Stats blanks out.
  const seen = qs.filter(q => (state.progress[q.id]?.seen || 0) > 0);
  const mastered = qs.filter(q => state.progress[q.id]?.status === 'good');
  // Quiz-based accuracy mirrors the readiness banner (PR #40). Self-
  // rated study accuracy was misleading: easy to inflate to ~100% with
  // a handful of Good ratings on the cards you breezed through. The
  // user-visible "Accuracy" number should be the trustworthy one. If
  // the user hasn't taken enough quiz to be calibrated yet, show "—"
  // and let the readiness banner direct them to start one.
  const ACC_MIN_QS = 20;
  const ACC_RECENT_SESSIONS = 5;
  const accHistory = loadQuizHistory(state.exam).slice(-ACC_RECENT_SESSIONS);
  const accTotal = accHistory.reduce((n, e) => n + (e.total || 0), 0);
  const accCorrect = accHistory.reduce((n, e) => n + (e.correct || 0), 0);
  const accReady = accTotal >= ACC_MIN_QS;
  const acc = accReady ? Math.round((accCorrect / accTotal) * 100) : null;

  // Per-OBJ breakdown
  const objs = uniqueObjs();
  const objStats = objs.map(obj => {
    const objQs = qs.filter(q => q.obj === obj);
    const objSeen = objQs.reduce((s, q) => s + (state.progress[q.id]?.seen || 0), 0);
    const objCorrect = objQs.reduce((s, q) => s + (state.progress[q.id]?.correct || 0), 0);
    const objAcc = objSeen > 0 ? Math.round((objCorrect / objSeen) * 100) : 0;
    const objMastered = objQs.filter(q => state.progress[q.id]?.status === 'good').length;
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
        ${EXAM_IDS.map(id => {
          const d = daysUntilExam(id);
          const urgency = d === null ? '' : d < 0 ? ' hud-past' : d <= 7 ? ' hud-urgent' : d <= 30 ? ' hud-soon' : '';
          const countdown = d === null
            ? '<span class="settings-meta">no date set</span>'
            : d < 0 ? `<span class="settings-meta${urgency}">was ${-d}d ago</span>`
            : d === 0 ? `<span class="settings-meta${urgency}">today</span>`
            : `<span class="settings-meta${urgency}">${d} day${d === 1 ? '' : 's'} away</span>`;
          return `
            <div class="settings-row">
              <span>${escapeHtml(examDef(id).label)} exam date</span>
              <span class="settings-actions" style="gap: 10px;">
                ${countdown}
                <input type="date" class="exam-date-input" data-exam-date="${id}"
                       value="${escapeHtml(getExamDate(id))}"
                       aria-label="Exam date for ${escapeHtml(examDef(id).label)}">
              </span>
            </div>
          `;
        }).join('')}
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

      ${(() => {
        // Exam-readiness, calibrated on cold-retrieval evidence (quiz scores)
        // rather than self-rated study accuracy. The old formula blended
        // lifetime study accuracy 0.6 + coverage 0.4, which inflated easily:
        // a learner who breezed through reveals rating "Good" could show
        // 85% "readiness" without ever being tested cold — a classic
        // pre-exam overconfidence trap (Koriat & Bjork foresight bias).
        //
        // New formula:
        //   - If <= 40 quiz questions answered total → don't show a %.
        //     Show a "not enough cold-test data yet" prompt instead. (We
        //     suggest a 40-Q quiz threshold since that's the half-exam
        //     option; 20 is also fine but noisier.)
        //   - Otherwise: average of the user's most-recent quiz sessions
        //     totaling >= 40 questions, weighted equally per question.
        //     Capped at the last 5 sessions to stay recent.
        //
        // Coverage still shown as context but no longer part of the score.
        const exam = daysUntilExam(state.exam);
        const examNote = exam === null ? '' : exam < 0 ? '' : exam <= 14
          ? ` · exam in <strong>${exam} day${exam === 1 ? '' : 's'}</strong>` : '';
        const QUIZ_MIN_QUESTIONS = 40;
        const RECENT_SESSIONS = 5;
        const history = loadQuizHistory(state.exam);
        const recent = history.slice(-RECENT_SESSIONS);
        const totalQ = recent.reduce((n, e) => n + (e.total || 0), 0);
        const correctQ = recent.reduce((n, e) => n + (e.correct || 0), 0);
        const sessionsLabel = `${recent.length} recent quiz${recent.length === 1 ? '' : 'zes'}`;
        if (totalQ < QUIZ_MIN_QUESTIONS) {
          const need = QUIZ_MIN_QUESTIONS - totalQ;
          return `
            <div class="readiness numeric-ui readiness-low" role="status" aria-label="Exam readiness not yet measurable">
              <div class="readiness-pct" style="font-size:36px">📊</div>
              <div class="readiness-text">
                <div class="readiness-verdict">Take a quiz to see your readiness</div>
                <div class="readiness-meta">
                  Readiness is now based on cold-test quizzes, not self-rated study.
                  ${totalQ === 0 ? 'Tap Quiz → 40 questions to start.' :
                    `${need} more quiz question${need === 1 ? '' : 's'} until we can show a calibrated score (${totalQ} of ${QUIZ_MIN_QUESTIONS} so far).`}
                  ${examNote}
                </div>
              </div>
            </div>`;
        }
        const ready = Math.round((correctQ / totalQ) * 100);
        const tier = ready >= 80 ? 'high' : ready >= 70 ? 'mid' : 'low';
        const verdict = ready >= 80 ? 'On track to pass (cold-test ≥ 80%)'
                      : ready >= 70 ? 'Close to the pass mark — keep drilling'
                      : 'Below the ~75% pass mark — drill weak areas';
        const coverageNote = qs.length ? ` · ${seen.length}/${qs.length} cards seen` : '';
        return `
          <div class="readiness numeric-ui readiness-${tier}" role="status" aria-label="Exam readiness ${ready} percent based on recent quiz performance">
            <div class="readiness-pct">${ready}%</div>
            <div class="readiness-text">
              <div class="readiness-verdict">${verdict}</div>
              <div class="readiness-meta">
                ${correctQ}/${totalQ} correct on ${sessionsLabel}${coverageNote}${examNote}
              </div>
            </div>
          </div>`;
      })()}

      ${seen.length === 0 ? `
        <div class="stats-empty">
          <p class="stats-empty-title">📊 Your stats will appear here</p>
          <p class="stats-empty-sub">Once you rate a few cards, this section fills in with your Seen / Mastered / Accuracy / streak — and a per-objective mastery breakdown lower down.</p>
        </div>
      ` : `
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
          <div class="stat-card" title="${accReady ? `Average correct across your last ${accHistory.length} quiz${accHistory.length===1?'':'zes'} (${accTotal} questions).` : `Take a quiz to see your cold-test accuracy. ${accTotal}/${ACC_MIN_QS} questions answered.`}">
            <div class="number">${accReady ? `${acc}%` : `${accTotal}/${ACC_MIN_QS}`}</div>
            <div class="label">${accReady ? 'Quiz accuracy' : 'Quiz Qs answered'}</div>
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
      `}

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
          <div class="settings-row">
            <span>⚡ Rapid fire <span class="settings-meta">60s sprint · rate as many as you can</span></span>
            <span class="settings-actions">
              <button class="small-btn" id="session-rapid">Start</button>
            </span>
          </div>
        `}
      </div>

      <h3 class="stats-h">Exam outcomes</h3>
      <div class="settings-panel" id="outcomes-panel">
        <!-- Populated asynchronously by hydrateOutcomesPanel() below.
             Placeholder copy stays put on render-fail, so the section
             always shows something. -->
        <div class="outcomes-loading">Loading outcome log…</div>
      </div>

      ${renderQuizHistoryHTML()}

      <h3 class="stats-h numeric-ui">Last 90 days</h3>
      <div class="numeric-ui">${renderHeatmapHTML()}</div>

      <h3 class="stats-h numeric-ui">Mastery by Objective</h3>
      <p class="stats-sub numeric-ui">Tap a row to drill that objective in Study.</p>
      <div class="obj-bar-list numeric-ui">
        ${objStats.map(s => {
          const pct = s.total > 0 ? (s.mastered / s.total) * 100 : 0;
          const tier = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : pct > 0 ? 'low' : 'none';
          const accLabel = s.seen > 0 ? `${s.accuracy}%` : '—';
          return `
          <button class="obj-bar" data-obj-drill="${escapeHtml(s.obj)}" aria-label="Drill OBJ ${escapeHtml(s.obj)} in Study mode" data-tier="${tier}">
            <div class="obj-label">OBJ ${escapeHtml(s.obj)}</div>
            <div class="bar-track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="OBJ ${escapeHtml(s.obj)} mastery">
              <div class="bar-fill" style="width: ${pct}%"></div>
            </div>
            <div class="obj-count">${s.mastered}/${s.total}</div>
            <div class="obj-acc">${accLabel}</div>
          </button>`;
        }).join('')}
      </div>

      ${renderReferenceBookHTML()}

      <details class="settings-collapse">
        <summary class="settings-summary">⚙️ Settings, accessibility &amp; tools</summary>

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

      <h3 class="stats-h">Options</h3>
      <div class="settings-panel">
        <div class="settings-row" title="Smart: due cards first, then new, then learning — randomized within each tier. Random: pure shuffle. Sequential: pretest order.">
          <span id="pref-order-label">🔀 Card order</span>
          <span class="seg-control" id="order-control" role="radiogroup" aria-labelledby="pref-order-label">
            <button data-val="smart" role="radio" aria-checked="${state.order==='smart'?'true':'false'}" class="${state.order==='smart'?'active':''}">Smart</button>
            <button data-val="random" role="radio" aria-checked="${state.order==='random'?'true':'false'}" class="${state.order==='random'?'active':''}">Random</button>
            <button data-val="sequential" role="radio" aria-checked="${state.order==='sequential'?'true':'false'}" class="${state.order==='sequential'?'active':''}">Sequential</button>
          </span>
        </div>
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

      <h3 class="stats-h">Share this app</h3>
      <div class="settings-panel share-panel">
        <div class="share-row">
          <img class="share-qr" src="icons/share-qr.svg" alt="QR code linking to https://aplusstudyapp.pages.dev" width="160" height="160">
          <div class="share-text">
            <p class="share-blurb">Point a phone camera at the QR code, or tap to copy the link to share with a classmate.</p>
            <button type="button" id="share-copy-btn" class="share-copy" data-url="https://aplusstudyapp.pages.dev">
              📋 <span class="share-url">aplusstudyapp.pages.dev</span>
            </button>
            <p class="settings-meta share-meta">Works offline once installed to the home screen. No account, no sign-up.</p>
          </div>
        </div>
      </div>

      <h3 class="stats-h">Cloud sync &amp; backup</h3>
      <div class="settings-panel">
        <button type="button" class="sync-open-row" id="open-sync-btn">
          <span class="sync-open-icon" aria-hidden="true">☁️</span>
          <span class="sync-open-text">
            <span class="sync-open-title">Sync &amp; backup</span>
            <span class="sync-open-sub" id="stats-sync-sub">${escapeHtml(syncStatusLine().text)}</span>
          </span>
          <span class="sync-open-chevron" aria-hidden="true">›</span>
        </button>
        <p class="settings-meta">Optional. Back up your progress and study across devices. Also on the ☁️ button at the top.</p>
      </div>

      <button class="reset-btn" id="reset-btn">Reset progress for ${escapeHtml(examDef(state.exam).label)}</button>
      </details>
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
  // Outcome log: populate asynchronously so renderStats stays sync.
  hydrateOutcomesPanel();
  $('#export-btn')?.addEventListener('click', exportProgress);
  $('#import-btn')?.addEventListener('click', importProgress);
  $('#export-overrides-btn')?.addEventListener('click', exportOverrides);
  $('#import-overrides-btn')?.addEventListener('click', importOverrides);
  $$('#order-control button').forEach(btn => btn.addEventListener('click', () => {
    state.order = btn.dataset.val;
    lsSet('order', state.order);
    state._orderCache = null;
    state._orderSeed = (Date.now() & 0x7fffffff) || 1;
    state.currentIndex = 0;
    state.history = [];
    renderStats();
  }));

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
  $$('input[data-exam-date]').forEach(input => {
    input.addEventListener('change', (e) => {
      setExamDate(input.dataset.examDate, e.target.value);
      updateHUD();
      renderStats();
    });
  });
  // Per-objective drill: tap a Mastery row to filter Study to just that obj.
  $$('[data-obj-drill]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.filter.obj = btn.dataset.objDrill;
      state.filter.due = false;
      state.filter.weakest = false;
      state.filter.hard = false;
      state.filter.search = '';
      state.currentIndex = 0;
      state._orderCache = null;
      setMode('study');
    });
  });
  // Reference book panel — async hydration of the upload status + actions
  hydrateReferenceBookPanel();
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
  $('#session-rapid')?.addEventListener('click', () => {
    startSession({ minutes: 1, rapid: true });
    setMode('study');
  });
  $('#session-end')?.addEventListener('click', () => { endSession(false); renderStats(); });

  $('#pin-setup')?.addEventListener('click', () => pinSetupFlow());
  $('#pin-change')?.addEventListener('click', () => pinChangeFlow());
  $('#pin-remove')?.addEventListener('click', () => pinRemoveFlow());

  $('#open-sync-btn')?.addEventListener('click', showSync);
  $('#share-copy-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const url = btn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      const label = btn.querySelector('.share-url');
      const original = label.textContent;
      label.textContent = 'Copied!';
      btn.classList.add('share-copied');
      setTimeout(() => { label.textContent = original; btn.classList.remove('share-copied'); }, 1600);
    } catch {
      // Clipboard API can be blocked in some contexts — fall back to a prompt
      // so the user can still grab the URL manually.
      window.prompt('Copy this URL:', url);
    }
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
  // Collapse the search + filter chip strip for fresh users (no progress
  // AND no active filter) — a beginner doesn't need three filter chips
  // and a search box visually competing with their first question. Once
  // they've rated even one card OR set any filter, the panel opens by
  // default and stays open. The user can always toggle it.
  const seen = state.questions.filter(q => state.progress[q.id]?.seen > 0).length;
  const hasActiveFilter = !!(state.filter.due || state.filter.weakest ||
    state.filter.hard || state.filter.obj !== null || state.filter.search);
  const openByDefault = seen > 0 || hasActiveFilter;
  return `
    <details class="filter-collapse" ${openByDefault ? 'open' : ''}>
      <summary class="filter-summary" aria-label="Show filters and search">
        <span class="filter-summary-label">🔍 Filter &amp; search</span>
        ${hasActiveFilter ? '<span class="filter-summary-pill">filter on</span>' : ''}
      </summary>
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
        <button class="weakest-chip ${state.filter.weakest ? 'active' : ''}" data-filter="weakest"
                aria-pressed="${state.filter.weakest ? 'true' : 'false'}"
                title="Your lowest-accuracy cards">
          ${state.filter.weakest ? '✓ ' : ''}🎯 Weakest (${weakestCount()})
        </button>
        <button class="hard-chip ${state.filter.hard ? 'active' : ''}" data-filter="hard"
                aria-pressed="${state.filter.hard ? 'true' : 'false'}"
                title="Cards you most recently rated Hard or Again — drill these before the exam">
          ${state.filter.hard ? '✓ ' : ''}🔥 Hard (${hardCount()})
        </button>
        <button class="${state.filter.obj === null ? 'active' : ''}" data-filter="all"
                aria-pressed="${state.filter.obj === null ? 'true' : 'false'}">All (${state.questions.length})</button>
        ${objs.map(o => `
          <button class="${state.filter.obj === o ? 'active' : ''}" data-filter="${escapeHtml(o)}"
                  aria-pressed="${state.filter.obj === o ? 'true' : 'false'}">
            OBJ ${escapeHtml(o)} (${counts[o]})
          </button>
        `).join('')}
      </div>
    </details>
  `;
}

function renderFilterBar() {
  $$('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    if (f === 'due')          state.filter.due = !state.filter.due;
    else if (f === 'weakest') state.filter.weakest = !state.filter.weakest;
    else if (f === 'hard')    state.filter.hard = !state.filter.hard;
    else if (f === 'all')     state.filter.obj = null;
    else                      state.filter.obj = f;
    state.currentIndex = 0;
    state.revealed = false;
    state.editing = false;
    state.selectedOption = null;
    state.selectedOptions = [];
    state.history = [];
    state._orderCache = null;
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
        state.selectedOptions = [];
        state.history = [];
        state._orderCache = null;
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
      state.selectedOptions = [];
      state.history = [];
      state._orderCache = null;
      if (state.mode === 'study') renderStudy();
      else if (state.mode === 'quiz') renderQuiz();
    });
  }
}

//─── SCRATCH PAD (Apple Pencil) ──────────────────────────────
function renderScratchpadHTML(q) {
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
  // Support both `image` (single path) and `images` (array). Filter to
  // safe sources only — defense in depth against a content-PR that
  // smuggles a http://evil/track.gif IP-leak pixel.
  const imgs = (q.images || (q.image ? [q.image] : [])).filter(isSafeImageSrc);
  if (imgs.length > 0) {
    // Wrapped in a button so the image is keyboard-focusable and
    // screen-readers announce "tap to enlarge". The click handler is
    // attached in installImageZoom() at app init time.
    return `<div class="q-images">${imgs.map(src =>
      `<button type="button" class="q-image-zoom" aria-label="Enlarge question figure"><img src="${escapeHtml(src)}" alt="Question figure" loading="lazy"></button>`
    ).join('')}</div>`;
  }
  // PBQ with no image → make it clear it's missing
  if (q.qtype === 'PBQ') {
    return `<div class="q-image-missing">
      <strong>⚠️ Image not available.</strong>
      This PBQ references a figure. Drop a PNG/JPG at
      <code>images/${escapeHtml(q.id)}.png</code> and add <code>"image": "images/${escapeHtml(q.id)}.png"</code>
      to this question in <code>${escapeHtml(examDef(state.exam).questions)}</code> to show it here.
      The explanation below still describes what was being asked.
    </div>`;
  }
  return '';
}

// Historical-miss footnote — what the user originally picked when taking
// the pretest(s) that generated this card. Rendered as a small labeled
// "Your pick" callout — shown above the explanation when the user picked
// an option pre-reveal. Reinforces the lesson by spelling out, in words,
// what they chose vs the correct answer (the colored option highlights
// already convey this visually but a text callout sticks better). Returns
// '' if the user revealed without picking (the recommended-rating "Hard"
// already covers that case).
// "Learn more" footer below the explanation. Three sources, in order:
//   1. Manual page ref the user set on this card (state.overrides[id].pageRef)
//   2. Auto-suggest if the reference book has been indexed
//   3. Generic "search the web" link as a last-resort fallback
// Renders nothing if there's no PDF and the question has no learnMore URL.
function renderLearnMoreHTML(q) {
  const parts = [];
  const pageRef = pageRefFor(q.id);
  if (pageRef) {
    parts.push(`<button type="button" class="learn-more-btn pageref" data-page-ref="${pageRef}" data-qid="${escapeHtml(q.id)}">📖 Open p. ${pageRef}</button>`);
  } else {
    // Placeholder — JS will swap in a "Suggest p. N" button if the book is
    // loaded + indexed and we find a match. Hidden by default.
    parts.push(`<span class="learn-more-suggest" data-qid="${escapeHtml(q.id)}" hidden></span>`);
  }
  // Normalize learnMore from any of: string | {url, label} | [string|{...}, ...]
  const links = normalizeLearnMore(q.learnMore);
  for (const l of links) {
    if (l.url) parts.push(`<a class="learn-more-btn external" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(l.label || 'Reference')}</a>`);
  }
  // Generic search fallback — uses the question's correct answer as the
  // search term so results stay topical without exposing the question text.
  const searchTerm = q.correct_short || (q.correct_picks || [])[0];
  if (searchTerm) {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent('CompTIA A+ ' + searchTerm)}`;
    parts.push(`<a class="learn-more-btn external" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">🔎 Search the web</a>`);
  }
  if (parts.length === 0) return '';
  return `<div class="learn-more">${parts.join('')}</div>`;
}

// Accepts: undefined | string | { url, label } | array of any of those.
// Returns: array of { url, label } objects (possibly empty).
// Only http/https URLs are safe to render as clickable anchors. escapeHtml
// stops attribute breakouts but does NOT block `javascript:` (which would
// execute on click). Drop anything that doesn't parse as a valid absolute
// http(s) URL, plus protocol-relative `//...` (treated as http per URL spec
// but ambiguous in offline context). Data-files only; this guards future
// content-PR poisoning of the questions bank.
function isSafeLearnMoreUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return false;
  try { return /^https?:$/i.test(new URL(u).protocol); }
  catch { return false; }
}
// Image src allowlist — restricts to https:// or data:image/* so a future
// content-PR can't smuggle a tracking pixel via http:// (IP leak + no
// transport encryption) or a data:text/html-disguised-as-image. CSP
// img-src is permissive (`self data: blob: https:`) so this is the
// stricter app-level gate. Used to filter q.image / q.images before
// they hit innerHTML.
function isSafeImageSrc(u) {
  if (typeof u !== 'string' || !u.trim()) return false;
  const s = u.trim();
  // Local relative paths (no protocol) are fine — they resolve under self.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return true;
  try {
    const p = new URL(s).protocol.toLowerCase();
    if (p === 'https:') return true;
    if (p === 'data:') return /^data:image\/(png|jpe?g|gif|svg\+xml|webp);/i.test(s);
    return false;
  } catch { return false; }
}
function normalizeLearnMore(m) {
  if (!m) return [];
  const arr = Array.isArray(m) ? m : [m];
  return arr.map(x => typeof x === 'string' ? { url: x, label: 'Reference' } : { url: x?.url, label: x?.label || 'Reference' })
            .filter(x => isSafeLearnMoreUrl(x.url));
}

// Async sidekick to renderLearnMoreHTML — populates the "Suggest p. N"
// affordance after the card renders, so we don't block on IDB / PDF.js.
async function hydrateLearnMoreSuggest(q) {
  // CSS.escape() handles any q.id that contains chars meaningful in CSS
  // selectors (`"`, `]`, etc.). Data convention restricts IDs to
  // alnum/_/- but defense in depth — and querySelector throws on
  // malformed selectors, silently breaking the suggestion.
  const sel = `.learn-more-suggest[data-qid="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(q.id) : q.id}"]`;
  let slot;
  try { slot = document.querySelector(sel); } catch { return; }
  if (!slot) return;
  const rec = await getReferenceBook();
  if (!rec || !rec.pageText) return;  // no book or not yet indexed
  const page = suggestPageForQuestion(q, rec.pageText);
  if (!page) return;
  slot.innerHTML = `
    <button type="button" class="learn-more-btn suggest" data-suggest-page="${page}" data-qid="${escapeHtml(q.id)}">
      📖 Suggest p. ${page}
    </button>`;
  slot.hidden = false;
  slot.querySelector('button')?.addEventListener('click', () => {
    setPageRefFor(q.id, page);
    toast(`Set p. ${page} for this card.`, 'success');
    if (state.mode === 'study') renderStudy();
  });
}

function renderYourPickHTML(q) {
  if (isMultipleAnswer(q)) {
    const picked = state.selectedOptions || [];
    if (picked.length === 0) return '';
    const correctSet = new Set((q.correct_picks || []).map(normalizeOption));
    const allRight = picked.length === correctSet.size && picked.every(p => correctSet.has(normalizeOption(p)));
    return `<div class="your-pick your-pick-${allRight ? 'right' : 'wrong'}">
      <span class="your-pick-label">${allRight ? '✓ You picked' : '✗ You picked'}:</span>
      <span class="your-pick-value">${escapeHtml(picked.join(', '))}</span>
      ${allRight ? '' : `<div class="your-pick-correct">Correct: ${escapeHtml((q.correct_picks || []).join(', '))}</div>`}
    </div>`;
  }
  const picked = state.selectedOption;
  if (!picked) return '';
  const right = normalizeOption(picked) === normalizeOption(q.correct_short || '');
  return `<div class="your-pick your-pick-${right ? 'right' : 'wrong'}">
    <span class="your-pick-label">${right ? '✓ You picked' : '✗ You picked'}:</span>
    <span class="your-pick-value">${escapeHtml(picked)}</span>
    ${right ? '' : `<div class="your-pick-correct">Correct: ${escapeHtml(q.correct_short || '')}</div>`}
  </div>`;
}

// note AFTER the explanation, not a prominent box above it, so it doesn't
// compete with "what did I just tap in this session" (which the option-row
// state colors already show). Returns '' when there's no pretest-miss data.
// 4-button FSRS rating row. NEUTRAL — no auto-highlighted button.
// Pre-PR-41 the app inferred a "recommended" rating from the user's MC
// pick (right→good, wrong→again, no-pick→hard) and visually starred that
// button as the default. Two pedagogy problems with that:
//   1) it short-circuited metacognition — accepting the default trained
//      learners to skip the self-judgment that self-rating IS;
//   2) a single MC click is a noisy 25%-base-rate proxy for memory
//      strength, so a lucky guess inflated the interval (good) and a
//      careless slip on a known card reset it (again). The scheduler
//      was eating guess-luck instead of recall difficulty.
// Now: the verdict line still shows correctness (so the user knows
// whether they picked right), but no button is pre-selected — they
// have to make the metacognitive call themselves.
function renderRatingButtonsHTML(q) {
  const p = state.progress[q.id] || {};
  const now = Date.now();
  // Interval previews under each rate button. These intentionally do NOT
  // apply recordRating's exam-date interval cap. The cap clamps every
  // interval down to "days until exam", which — within a week of the exam —
  // collapses Hard/Good/Easy to the SAME label (e.g. all "1 day"), making
  // the four buttons useless for telling the choices apart. That collapse
  // is the "all the difficulty buttons show the same time / 10h on every
  // answer" report. The preview's job is to show how each rating spaces the
  // card *relative to the others*, so we show the card's natural FSRS
  // interval (matching the documented "first-Good ≈ 5 days, first-Easy ≈ 12
  // days"). The exam cap still governs the ACTUAL next-due date in
  // recordRating — only the preview label is uncapped. We keep the
  // exam-aware retention escalation, which tightens the spacing as the exam
  // nears without flattening the four buttons into one value.
  const days = daysUntilExam(state.exam);
  const previewCap = undefined;
  const previewRetention = days === null || days > 14 ? 0.90
                         : days >  7 ? 0.93
                         : 0.95;
  // One-time SRS explainer (first reveal). Dismissed implicitly the
  // moment they tap any rate button.
  const srsHintSeen = localStorage.getItem('srsHintSeen') === '1';
  const srsHintHtml = srsHintSeen ? '' : `
    <div class="rate-hint" id="rate-hint" role="note">
      <strong>How rating works:</strong> these four buttons schedule when
      this card comes back. <em>Again</em> = a minute (you forgot).
      <em>Easy</em> = days (it was trivial). Pick what felt true —
      <strong>your self-judgment is the signal</strong>, not whether the
      MC click was right.
      <button type="button" class="rate-hint-dismiss" id="rate-hint-dismiss" aria-label="Dismiss hint">Got it ✕</button>
    </div>`;
  // Informational verdict only — does NOT pre-select a button.
  let verdict;
  if (isMultipleAnswer(q)) {
    const picks = state.selectedOptions || [];
    const correctArr = Array.isArray(q.correct_picks) ? q.correct_picks : [];
    const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const pickedSet = new Set(picks.map(norm));
    const correctSetN = new Set(correctArr.map(norm));
    const sameSize = pickedSet.size === correctSetN.size;
    const allMatch = sameSize && [...pickedSet].every(x => correctSetN.has(x));
    verdict = picks.length === 0 ? 'You didn\'t pick — judge how well you knew it cold.'
            : allMatch           ? '✓ Your picks matched. Rate your actual recall, not the click.'
            :                      '✗ Picks didn\'t match. Rate honestly — confidence matters.';
  } else {
    const picked = state.selectedOption;
    const correct = q.correct_short;
    const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const wasRight = picked && correct && norm(picked) === norm(correct);
    verdict = !picked            ? 'You didn\'t pick — judge how well you knew it cold.'
            : wasRight           ? '✓ You picked correctly. Was it confident or a lucky guess?'
            :                      '✗ You picked wrong. Was it close, or completely missed?';
  }
  const rates = [
    { key: 'again', cls: 'bad',    label: 'Again', kbd: '1' },
    { key: 'hard',  cls: 'warn',   label: 'Hard',  kbd: '2' },
    { key: 'good',  cls: 'good',   label: 'Good',  kbd: '3' },
    { key: 'easy',  cls: 'primary',label: 'Easy',  kbd: '4' },
  ];
  return `
    ${srsHintHtml}
    <div class="rate-header rate-row-arming">
      <div class="rate-title">How well did you know this?</div>
      <div class="rate-sub">${verdict}</div>
      <button type="button" class="rate-back-btn" id="rate-back-btn" aria-label="Go back to the previous card" title="Back to previous card">← Back</button>
    </div>
    <div class="btn-row rate-row rate-row-arming">
      ${rates.map(r => `
        <button class="action rate-btn ${r.cls}"
                data-rate="${r.key}"
                aria-label="${r.label} (key ${r.kbd}), next review in ${nextIntervalLabel(p, r.key, now, previewCap, previewRetention)}">
          <span class="rate-label">${r.label}<span class="kbd-hint" aria-hidden="true">${r.kbd}</span></span>
          <span class="rate-interval">${nextIntervalLabel(p, r.key, now, previewCap, previewRetention)}</span>
        </button>
      `).join('')}
    </div>`;
}

function renderOptionsHTML(q) {
  if (!Array.isArray(q.options) || q.options.length === 0) return '';
  state._currentQ = q;  // cached for attachOptionEvents to read qtype
  // Shuffle options into a stable per-card order so the correct answer isn't
  // always in the same slot, but the layout doesn't change on re-renders.
  const options = shuffleOptionsForCard(q.options, q.id);
  const ma = isMultipleAnswer(q);
  const pickedSet = ma
    ? new Set((state.selectedOptions || []))
    : new Set(state.selectedOption ? [state.selectedOption] : []);
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
    const correct = isCorrect(opt);
    const isPicked = pickedSet.has(opt);
    if (!state.revealed) {
      if (isPicked) c.push('picked');
    } else {
      if (correct) c.push('correct');
      else if (isPicked) c.push('wrong');
      if (!correct && !isPicked) c.push('revealed-other');
    }
    return c.join(' ');
  };
  const LETTERS = 'ABCDEFGHIJ';
  const needCount = ma
    ? (Array.isArray(q.correct_picks) ? q.correct_picks.length : 2)
    : 1;
  const hint = ma && !state.revealed
    ? `<div class="ma-hint">Select ${needCount} answers — tap again to deselect. Picked ${pickedSet.size} of ${needCount}.</div>`
    : '';
  const role = ma ? 'group' : 'radiogroup';
  const itemRole = ma ? 'checkbox' : 'radio';
  // role=radiogroup+radio for single-answer; role=group+checkbox for MA so
  // screen readers announce that multiple picks are allowed. Letter badge +
  // text + status icon are separate spans so each region styles independently.
  return `
    ${hint}
    <ol class="q-options${ma ? ' q-options-ma' : ''}" role="${role}" aria-label="Answer choices">
      ${options.map((opt, i) => {
        const checked = pickedSet.has(opt);
        const tab = (pickedSet.size ? checked : i === 0) ? 0 : -1;
        const correct = isCorrect(opt);
        const describe = state.revealed
          ? (correct ? ' (correct answer)' : checked ? ' (your pick, incorrect)' : '')
          : '';
        const letter = LETTERS[i] || String(i + 1);
        return `<li class="${cls(opt)}" role="${itemRole}"
            aria-checked="${checked ? 'true' : 'false'}"
            tabindex="${tab}"
            data-option="${escapeHtml(opt)}"
            aria-label="${escapeHtml(letter + '. ' + opt + describe)}">
          <span class="q-letter" aria-hidden="true">${letter}</span>
          <span class="q-text">${escapeHtml(opt)}</span>
          <span class="q-status" aria-hidden="true"></span>
        </li>`;
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

function emptyHTML(title, sub) {
  return `<div class="empty-state">
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
  lsSet('exam', newExam);
  // Reset nav + filter state so we don't point at a card index that doesn't
  // exist in the new dataset.
  state.filter = { obj: null, due: false, weakest: false, hard: false, search: '' };
  state.currentIndex = 0;
  state.revealed = false;
  state.editing = false;
  state.selectedOption = null;
  state.selectedOptions = [];
  state.committed = false;
  state.history = [];
  state._orderCache = null;
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
  state.selectedOptions = [];
  state.committed = false;
  state.history = [];
  state._orderCache = null;
  state._currentQ = null;  // was leaking across modes — diagnostics showed last study/quiz card as "current" even from Stats
  // Clear cross-mode UI flags that other branches key off. data-revealed was
  // set in renderStudy and never cleared on tab-switch, leaking a post-reveal
  // styling cue into Reading/Stats. Stop any in-flight TTS so the read-aloud
  // button doesn't keep speaking a card you've navigated away from.
  document.documentElement.removeAttribute('data-revealed');
  if (typeof stopSpeaking === 'function') stopSpeaking();
  // Stop the mock-exam ticker if the user nav'd away mid-mock — the
  // tick handler bails when state.mode !== 'quiz' anyway, but clearing
  // is cleaner than leaking the interval.
  if (state.mode !== 'quiz' && state._quizTick) { clearInterval(state._quizTick); state._quizTick = null; }
  $$('.tab').forEach(t => {
    const active = t.dataset.mode === mode;
    t.classList.toggle('active', active);
    // aria-current matches plain-nav semantics (not role=tablist); SR
    // announces "study, current page" rather than "tab 1 of 4 selected".
    if (active) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
    // Strip the leftover tablist attrs in case an old SW cache still serves
    // the old index.html — defensive belt-and-suspenders.
    t.removeAttribute('aria-selected');
    t.removeAttribute('role');
  });
  // Hold the screen on while the user is actively studying or quizzing.
  if (mode === 'study' || mode === 'quiz') acquireWakeLock();
  else releaseWakeLock();
  if (mode === 'study') renderStudy();
  else if (mode === 'quiz') renderQuiz();
  else if (mode === 'reading') renderReading();
  else if (mode === 'stats') renderStats();
  // Keep the Study-tab "due" pill fresh on every tab switch (renderStats
  // sets the HUD directly and doesn't call updateHUD).
  updateDueBadge();
  // Brief fade-in cue so mode swaps don't feel like a hard cut. Honors
  // prefers-reduced-motion (CSS rule turns the animation off). Only fires
  // on real mode changes, not on per-card re-renders within a mode.
  const main = $('#main');
  if (main) {
    main.classList.remove('mode-entering');
    // Force a reflow so re-adding the class restarts the animation
    void main.offsetWidth;
    main.classList.add('mode-entering');
    setTimeout(() => main.classList.remove('mode-entering'), 220);
  }
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
    // Shake reshuffles the current view (new seed) instead of flipping a boolean.
    state._orderSeed = (Date.now() & 0x7fffffff) || 1;
    state._orderCache = null;
    state.currentIndex = 0;
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

//─── READ ALOUD (Web Speech API) ─────────────────────────────
// Speaks the question, lettered options, and — if revealed — the correct
// answer + explanation. Toggles off on a second click. Cancels automatically
// on card change. Hidden when speechSynthesis isn't available.
const speech = {
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
  speakingForQ: null,   // question id currently being read, or null
  voice: null,           // cached preferred voice
};

function speechSupported() {
  return speech.supported && window.speechSynthesis;
}

// Pick the best available English voice. Quality varies a lot by OS.
// Preference order:
//   1. Apple's "Samantha" / "Alex" / "Daniel" — high-quality neural voices
//   2. Google's "Google US/UK English" voices on Android Chrome
//   3. Microsoft's "Aria" / "Jenny" / "Guy" neural voices on Edge/Windows
//   4. Any en-US / en-GB local voice
//   5. Anything English
const PREFERRED_VOICES = [
  // Apple
  /samantha/i, /^alex$/i, /^daniel$/i, /^karen$/i, /^moira$/i, /^tessa$/i,
  // Google (Android)
  /google.*us.*english/i, /google.*uk.*english.*female/i, /google.*english/i,
  // Microsoft Neural (Windows / Edge)
  /microsoft\s+(aria|jenny|sonia|guy|davis|jane)\b.*natural/i,
  /microsoft\s+(aria|jenny|sonia|guy|davis|jane)\b/i,
];
function pickBestVoice() {
  if (!speechSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Try each preference in order
  for (const pat of PREFERRED_VOICES) {
    const v = voices.find(v => pat.test(v.name) && v.lang.toLowerCase().startsWith('en'));
    if (v) return v;
  }
  // Local en-US over remote, then en-GB local, then any English
  const localEnUS = voices.find(v => v.lang === 'en-US' && v.localService);
  if (localEnUS) return localEnUS;
  const localEnGB = voices.find(v => v.lang === 'en-GB' && v.localService);
  if (localEnGB) return localEnGB;
  const anyEn = voices.find(v => v.lang.toLowerCase().startsWith('en'));
  return anyEn || voices[0];
}
// Voices load asynchronously on most browsers; refresh the cache when they arrive.
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { speech.voice = pickBestVoice(); };
}

function syncListenButton(speaking) {
  const btn = document.getElementById('listen-btn');
  if (!btn) return;
  btn.textContent = speaking ? '⏹' : '🔈';
  btn.setAttribute('aria-pressed', speaking ? 'true' : 'false');
  btn.title = speaking ? 'Stop reading' : 'Listen — read the card aloud';
}

function stopSpeaking() {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  speech.speakingForQ = null;
  syncListenButton(false);
}

function currentSpeakableCard() {
  // Returns the question object the user is currently looking at, if any.
  if (state.mode === 'study') {
    const qs = filteredQuestions();
    const baseQ = qs[state.currentIndex];
    return baseQ ? { q: getQuestion(baseQ), revealed: state.revealed } : null;
  }
  if (state.mode === 'quiz' && state.quizSession && !state.quizSession.done) {
    const baseQ = state.quizSession.questions[state.quizSession.current];
    if (!baseQ) return null;
    const q = getQuestion(baseQ);
    const answered = state.quizSession.answers[q.id];
    return { q, revealed: !!answered };
  }
  return null;
}

function speakCard(q, { revealed } = {}) {
  if (!speechSupported()) return;
  // Toggle off if tapping while speaking the same card
  if (speech.speakingForQ === q.id) { stopSpeaking(); return; }
  stopSpeaking();
  if (!speech.voice) speech.voice = pickBestVoice();

  const LETTERS = 'ABCDEFGHIJ';
  const options = shuffleOptionsForCard(q.options || [], q.id);
  const parts = [q.question];
  if (options.length) {
    parts.push(
      options.map((o, i) => `Option ${LETTERS[i] || i + 1}: ${o}`).join('. ')
    );
  }
  if (revealed) {
    if (q.correct_short) parts.push(`Correct answer: ${q.correct_short}.`);
    if (Array.isArray(q.correct_picks) && q.correct_picks.length) {
      parts.push(`Correct answers: ${q.correct_picks.join(', ')}.`);
    }
    if (q.explanation) {
      parts.push(q.explanation.replace(/^OBJ \d+\.\d+:\s*/i, '').trim());
    }
  }
  const text = parts.join('. ');
  const utter = new SpeechSynthesisUtterance(text);
  if (speech.voice) {
    utter.voice = speech.voice;
    utter.lang = speech.voice.lang;
  }
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.onend = () => {
    if (speech.speakingForQ === q.id) stopSpeaking();
  };
  utter.onerror = () => stopSpeaking();
  speech.speakingForQ = q.id;
  window.speechSynthesis.speak(utter);
  syncListenButton(true);
  acquireWakeLock();
}

// Wire up the persistent top-bar Listen button (works in study + quiz modes,
// stays available in focus mode since it's in the header, not the card).
function installListenButton() {
  const btn = document.getElementById('listen-btn');
  if (!btn) return;
  if (!speechSupported()) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const cur = currentSpeakableCard();
    if (!cur) return;
    speakCard(cur.q, { revealed: cur.revealed });
  });
}

//─── FOCUS MODE ──────────────────────────────────────────────
function toggleFocus() {
  state.focus = !state.focus;
  document.documentElement.toggleAttribute('data-focus', state.focus);
  haptic(5);
  const btn = $('#focus-btn');
  if (btn) {
    // 🎯 stays put; the engaged state is shown via accent fill (aria-pressed),
    // matching the Listen button — clearer than the old 🔒/🔓 swap, which
    // read as "security lock" and collided with the PIN-lock feature.
    btn.setAttribute('aria-pressed', state.focus ? 'true' : 'false');
    btn.setAttribute('aria-label', state.focus ? 'Exit focus mode' : 'Enter focus mode');
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
    lsSet('theme', theme);
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
      // Realistic progress export for 313 cards is ~100 KB. Anything
      // over 10 MB is either malicious or a different file type — skip
      // the JSON.parse hang and report up front.
      const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
      if (file.size > MAX_IMPORT_BYTES) throw new Error(`File too large (${(file.size/1024/1024).toFixed(1)} MB) — expected progress export under 10 MB`);
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
      // Same 10 MB cap as importProgress — defense against accidental
      // wrong-file imports and against pathological / DoS payloads.
      const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
      if (file.size > MAX_IMPORT_BYTES) throw new Error(`File too large (${(file.size/1024/1024).toFixed(1)} MB) — expected overrides export under 10 MB`);
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
  lsSet('supabase.url', url);
  lsSet('supabase.key', key);
  lsSet('supabase.syncKey', syncKey);
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
// single push/pull syncs all exams together.
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
  // Push through the progress_push RPC (SECURITY DEFINER) rather than
  // writing the table directly. The anon key is public, so direct
  // table writes let anyone overwrite any row; routing through the
  // function means a caller must supply the sync key to touch a row,
  // and the table itself is closed to the anon role. The function
  // stamps updated_at server-side.
  const body = JSON.stringify({
    p_sync_key: syncKey,
    p_data: { version: 2, progress: bundle.progress, overrides: bundle.overrides },
  });
  const res = await fetch(`${url}/rest/v1/rpc/progress_push`, {
    method: 'POST',
    headers: cloudHeaders(key),
    body,
  });
  if (!res.ok) throw new Error(`Push ${res.status}: ${(await res.text()).slice(0, 200)}`);
  lsSet('supabase.lastSync', new Date().toISOString());
}

function normalizeCloudData(data) {
  // v2: { progress: {examId: {id: {...}}}, overrides: {examId: {...}} }
  return { progress: data?.progress || {}, overrides: data?.overrides || {} };
}

async function cloudPull({ merge = true } = {}) {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  // Pull through the progress_pull RPC (SECURITY DEFINER). It returns
  // only the row whose sync_key matches, so the anon key can't be used
  // to read the whole table / harvest other people's keys.
  const res = await fetch(`${url}/rest/v1/rpc/progress_pull`, {
    method: 'POST',
    headers: cloudHeaders(key),
    body: JSON.stringify({ p_sync_key: syncKey }),
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
  lsSet('supabase.lastSync', new Date().toISOString());
}

//─── KEYBOARD SHORTCUTS ──────────────────────────────────────
function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Let the user type in inputs/textareas
    if (e.target.matches('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Bail when ANY modal overlay is open. Without this, `f` / space /
    // 1-4 / arrows etc. fire underneath the dialog and silently mutate
    // study state (toggle Focus mode, rate the next card, advance, etc.).
    // Each dialog already handles its own Escape; the per-dialog Escape
    // listener runs first because it's installed later in DOM order.
    if (document.querySelector(
      '#welcome-overlay, #help-overlay, #feedback-overlay, ' +
      '#pin-overlay, #lock-overlay, #img-zoom-overlay, #pdf-viewer-overlay, ' +
      '#outcome-overlay'
    )) return;

    const key = e.key.toLowerCase();

    // Global shortcuts
    if (key === 't') { e.preventDefault(); cycleTheme(); return; }
    if (key === 'f') { e.preventDefault(); toggleFocus(); return; }
    if (key === 'escape' && state.focus) { e.preventDefault(); toggleFocus(); return; }

    // Study navigation
    if (state.mode === 'study') {
      if (key === 'arrowright' || key === 'k' || key === 'n') { e.preventDefault(); nextQuestion(); return; }
      if (key === 'arrowleft'  || key === 'j' || key === 'p') { e.preventDefault(); prevQuestion(); return; }
      if (key === ' ' || key === 'enter' || key === 'r') {
        e.preventDefault();
        if (!state.revealed) {
          // Mirror the disabled-button gate from the click handler: don't
          // reveal until the user has either picked or committed via IDK.
          // For no-options qtypes, hasOptions is false and we reveal freely.
          const qs0 = filteredQuestions();
          const cur = qs0[state.currentIndex];
          const hasOptions = cur && Array.isArray(cur.options) && cur.options.length > 0;
          const ma = cur && isMultipleAnswer(cur);
          // Match the renderStudy gate: multi-answer requires N picks.
          const needCount = ma
            ? (Array.isArray(cur?.correct_picks) ? cur.correct_picks.length : 2)
            : 1;
          const pickedCount = ma
            ? (state.selectedOptions || []).length
            : (state.selectedOption ? 1 : 0);
          const picked = pickedCount >= needCount;
          if (hasOptions && !picked && !state.committed) {
            // Re-render to focus the IDK button so the user sees the gate.
            // Quick toast as feedback for keyboard users who can't see why
            // Space appeared to do nothing.
            const msg = ma
              ? `Pick ${needCount} answers (${pickedCount}/${needCount}) or tap "I don't know" first.`
              : 'Pick an answer or tap "I don\'t know" first.';
            toast(msg, 'info', 2200);
            $('#idk-btn')?.focus();
            return;
          }
          state.revealed = true;
          state._revealedAt = Date.now();
          renderStudy();
        } else {
          // No 800ms guard for keyboard — keyboard has no ghost-click problem,
          // and the previous check silently swallowed deliberate "Space to
          // reveal, then Space to rate Good" patterns.
          const qs = filteredQuestions();
          const cur = qs[state.currentIndex];
          if (cur) { recordRating(cur.id, 'good'); nextQuestion(); }
        }
        return;
      }
      if (state.revealed && ['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const rate = ['again', 'hard', 'good', 'easy'][Number(key) - 1];
        const qs = filteredQuestions();
        const cur = qs[state.currentIndex];
        if (cur) { recordRating(cur.id, rate); nextQuestion(); }
        return;
      }
    }
    // Quiz: space/enter advances when an answer is showing; no other shortcuts
    if (state.mode === 'quiz') {
      const session = state.quizSession;
      if ((key === ' ' || key === 'enter') && session && !session.done) {
        const answered = session.answers[session.questions[session.current]?.id];
        if (answered) { e.preventDefault(); advanceQuiz(); }
        return;
      }
    }
  });
}

//─── IMAGE ZOOM (PBQ figures) ────────────────────────────────
// Click any question image to open it in a fullscreen overlay. Tap or
// press Escape to close. Delegated handler so it works for cards that
// haven't been rendered yet at install time.
//─── REFERENCE PDF (personal study aid) ──────────────────────
// User uploads their own legally-acquired textbook PDF once via Settings.
// Stored entirely in IndexedDB on this device — never sent to a server,
// never bundled with the app. Each question can have a `pageRef` override
// pointing to the relevant page; "Open page" launches an in-app PDF.js
// viewer. Cleared with a single click in Settings.
const PDF_KEY = (exam) => `book.${exam}`;
let _pdfjsModule = null;
async function loadPdfJs() {
  if (_pdfjsModule) return _pdfjsModule;
  // Fixed pinned version, ESM build. The first load lands in the SW
  // cache so subsequent loads are offline.
  const url = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
  const workerUrl = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
  const mod = await import(/* @vite-ignore */ url);
  mod.GlobalWorkerOptions.workerSrc = workerUrl;
  _pdfjsModule = mod;
  return mod;
}

async function getReferenceBook(exam = state.exam) {
  return idbGet(RSTORE, PDF_KEY(exam));
}
async function setReferenceBook(exam, record) {
  return idbPut(RSTORE, PDF_KEY(exam), record);
}
async function clearReferenceBook(exam = state.exam) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(RSTORE, 'readwrite');
    tx.objectStore(RSTORE).delete(PDF_KEY(exam));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// Triggered by the file input. Stores raw bytes + parses page count.
async function uploadReferenceBook(file) {
  if (!file || !file.type.includes('pdf')) {
    toast('Please pick a PDF file.', 'error');
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    toast('That PDF is over 200 MB — try a smaller one.', 'error');
    return;
  }
  toast('Loading PDF…', 'info', 2000);
  const buf = await file.arrayBuffer();
  let pageCount = null;
  try {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    pageCount = doc.numPages;
  } catch (e) {
    toast('Could not read that PDF: ' + (e.message || 'unknown error'), 'error');
    return;
  }
  await setReferenceBook(state.exam, {
    name: file.name,
    size: file.size,
    uploadedAt: Date.now(),
    pageCount,
    blob: buf,
  });
  toast(`Reference book loaded — ${pageCount} pages.`, 'success');
  if (state.mode === 'stats') renderStats();
}

// Modal viewer: renders one page of the PDF onto a canvas. Prev/Next
// navigate; Escape or tap-outside closes.
async function openReferenceViewer(initialPage = 1) {
  const rec = await getReferenceBook();
  if (!rec) {
    toast('No reference book loaded yet — upload one in Stats → Reference book.', 'info');
    return;
  }
  if (document.getElementById('pdf-viewer-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'pdf-viewer-overlay';
  overlay.className = 'pdf-viewer-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Reference book viewer');
  overlay.innerHTML = `
    <div class="pdf-viewer-frame">
      <div class="pdf-viewer-toolbar">
        <button type="button" class="pdf-nav" data-pdf-nav="prev" aria-label="Previous page">←</button>
        <span class="pdf-pageinfo" aria-live="polite">page <strong class="pdf-cur">…</strong> / ${rec.pageCount}</span>
        <input type="number" class="pdf-jump" min="1" max="${rec.pageCount}" value="${initialPage}" aria-label="Jump to page">
        <button type="button" class="pdf-nav" data-pdf-nav="next" aria-label="Next page">→</button>
        <button type="button" class="pdf-viewer-close" aria-label="Close viewer">✕</button>
      </div>
      <div class="pdf-viewer-canvas-wrap">
        <canvas class="pdf-viewer-canvas" aria-label="Reference page"></canvas>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('.pdf-viewer-canvas');
  const curEl = overlay.querySelector('.pdf-cur');
  const jumpEl = overlay.querySelector('.pdf-jump');

  let current = Math.min(Math.max(1, initialPage | 0), rec.pageCount);
  let pdfDoc;
  try {
    const pdfjs = await loadPdfJs();
    pdfDoc = await pdfjs.getDocument({ data: rec.blob.slice(0) }).promise;
  } catch (e) {
    toast('Could not open PDF: ' + (e.message || 'unknown'), 'error');
    overlay.remove();
    return;
  }

  const renderPage = async (n) => {
    current = Math.min(Math.max(1, n), pdfDoc.numPages);
    curEl.textContent = current;
    jumpEl.value = current;
    const page = await pdfDoc.getPage(current);
    // Scale to fit the viewer width, with a sensible cap for huge displays.
    const wrap = overlay.querySelector('.pdf-viewer-canvas-wrap');
    const targetW = Math.min(wrap.clientWidth - 16, 1100);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetW / baseViewport.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  };

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
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') renderPage(current - 1);
    else if (e.key === 'ArrowRight') renderPage(current + 1);
  };
  overlay.querySelector('.pdf-viewer-close').addEventListener('click', close);
  overlay.querySelector('[data-pdf-nav="prev"]').addEventListener('click', () => renderPage(current - 1));
  overlay.querySelector('[data-pdf-nav="next"]').addEventListener('click', () => renderPage(current + 1));
  jumpEl.addEventListener('change', (e) => renderPage(parseInt(e.target.value, 10) || 1));
  // Click outside the frame closes (matches image-zoom behavior)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  await renderPage(current);
}

// Build a per-page text index for the loaded book so each question can be
// matched against its likely page. Cached on the IDB record so it only
// runs once per upload. Big books take a few seconds.
async function indexReferenceBook(progressCb = () => {}) {
  const rec = await getReferenceBook();
  if (!rec) { toast('Upload a PDF first.', 'error'); return null; }
  if (rec.pageText) return rec.pageText;
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: rec.blob.slice(0) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const text = await p.getTextContent();
    pages.push(text.items.map(it => it.str).join(' ').toLowerCase());
    progressCb(i, doc.numPages);
  }
  rec.pageText = pages;
  await setReferenceBook(state.exam, rec);
  return pages;
}

// For one question, find the page with the highest density of matches
// for the correct answer + key terms from the question text.
function suggestPageForQuestion(q, pageText) {
  if (!Array.isArray(pageText) || pageText.length === 0) return null;
  // Term set: correct_short + correct_picks + content words from the question.
  // Skip stop-words and short tokens.
  const STOP = new Set(['the','a','an','of','in','on','for','with','to','from','at','by','and','or','is','are','was','were','be','been','this','that','these','those','it','its','as','if','than','then','which','what','when','where','why','how','you','your','their','they','have','has','had','can','could','should','would','will','do','does','did','not','no','yes','any','all','some','one','two','three','four','five','more','most','least','best','worst','use','using','used','about','into','onto','also','only','very','just','than','they','via','per','not','vs','vs.','than'].concat(['comptia']));
  const tokens = (s) => (s || '').toLowerCase()
    .replace(/[^a-z0-9.\-+\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t));
  const ans = [q.correct_short, ...(q.correct_picks || [])].filter(Boolean).map(s => s.toLowerCase());
  const qTokens = tokens(q.question);
  // Heavily weight the answer terms; question terms are supporting context.
  const scored = pageText.map((text, idx) => {
    let score = 0;
    for (const a of ans) {
      if (!a) continue;
      // exact phrase match is gold
      const phraseHits = text.split(a).length - 1;
      score += phraseHits * 8;
    }
    for (const t of qTokens) {
      if (text.includes(t)) score += 1;
    }
    return { page: idx + 1, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Require a non-trivial score so we don't suggest a random page for
  // questions that don't actually appear in the textbook.
  if (scored[0].score < 3) return null;
  return scored[0].page;
}

// Returns the manual or auto-suggested pageRef for a question.
function pageRefFor(qid) {
  return state.overrides[qid]?.pageRef || null;
}
function setPageRefFor(qid, page) {
  if (!state.overrides[qid]) state.overrides[qid] = {};
  if (page) state.overrides[qid].pageRef = page;
  else delete state.overrides[qid].pageRef;
  saveOverrides();
}

// Settings panel block: file picker + status + actions. The actual
// upload state is async (lives in IDB) so we render a placeholder and
// hydrate it after fetch.
function renderReferenceBookHTML() {
  return `
    <h3 class="stats-h">Reference book</h3>
    <p class="stats-sub">Optional — upload your own reference PDF (e.g. an A+ study book) and the app can link individual cards to specific pages. The PDF stays in this browser, never uploaded to a server.</p>
    <div class="settings-panel">
      <div class="settings-row">
        <span id="ref-status">Checking…</span>
        <span class="settings-actions">
          <input type="file" id="ref-upload" accept="application/pdf,.pdf" hidden>
          <button class="small-btn" id="ref-pick">📖 Upload PDF</button>
          <button class="small-btn" id="ref-index" hidden>Index for auto-suggest</button>
          <button class="small-btn" id="ref-clear" hidden>Clear</button>
        </span>
      </div>
      <div class="settings-row" id="ref-suggest-row" hidden>
        <span class="settings-meta">Auto-suggest can match each question to its likely page in your PDF. Indexing extracts the text once and caches it.</span>
      </div>
    </div>
  `;
}

// Called after Stats renders to populate the async parts.
async function hydrateReferenceBookPanel() {
  const status = document.getElementById('ref-status');
  if (!status) return;
  const rec = await getReferenceBook();
  const pickBtn = document.getElementById('ref-pick');
  const upload = document.getElementById('ref-upload');
  const clearBtn = document.getElementById('ref-clear');
  const indexBtn = document.getElementById('ref-index');
  const suggestRow = document.getElementById('ref-suggest-row');

  if (rec) {
    const sizeMB = (rec.size / 1024 / 1024).toFixed(1);
    const indexed = rec.pageText ? ' · indexed' : '';
    status.innerHTML = `<strong>${escapeHtml(rec.name)}</strong> · ${rec.pageCount} pages · ${sizeMB} MB${indexed}`;
    pickBtn.textContent = '📖 Replace';
    clearBtn.hidden = false;
    indexBtn.hidden = false;
    indexBtn.textContent = rec.pageText ? 'Re-index' : 'Index for auto-suggest';
    suggestRow.hidden = false;
  } else {
    status.textContent = 'No PDF loaded';
  }

  pickBtn.onclick = () => upload.click();
  upload.onchange = (e) => {
    const f = e.target.files?.[0];
    if (f) uploadReferenceBook(f);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Remove the reference PDF from this device?')) return;
    await clearReferenceBook();
    toast('Reference book removed.', 'success');
    renderStats();
  };
  indexBtn.onclick = async () => {
    indexBtn.disabled = true;
    indexBtn.textContent = 'Indexing 0%';
    await indexReferenceBook((cur, total) => {
      indexBtn.textContent = `Indexing ${Math.round((cur / total) * 100)}%`;
    });
    toast('Indexed — auto-suggest is live.', 'success');
    indexBtn.disabled = false;
    renderStats();
  };
}

function installImageZoom() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.q-image-zoom');
    if (!btn) return;
    e.preventDefault();
    const img = btn.querySelector('img');
    if (!img) return;
    openImageZoom(img.src, img.alt);
  });
}
function openImageZoom(src, alt) {
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

//─── SCREEN WAKE LOCK ────────────────────────────────────────
// Keeps the screen on during study/quiz/read-aloud. Browsers auto-release
// the wake lock when the tab goes hidden, so we re-acquire on visibility
// change. No-op on browsers without the API (Safari < 16.4, etc.).
const wake = { lock: null, wanted: false };
async function acquireWakeLock() {
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
function releaseWakeLock() {
  wake.wanted = false;
  if (wake.lock) wake.lock.release().catch(() => {});
  wake.lock = null;
}
function installWakeLock() {
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

//─── INPUT MODE DETECTION ────────────────────────────────────
// Mark <html> with .is-touch the first time we see a touch event so CSS
// can hide keyboard-hint chips on touch-only devices. We don't toggle it
// back to mouse — a pure-mouse user never fires touchstart, and a hybrid
// device (iPad with keyboard, Surface) already gets touch-first treatment
// which is the safer default.
function installInputModeDetection() {
  const onTouch = () => {
    document.documentElement.classList.add('is-touch');
    window.removeEventListener('touchstart', onTouch);
  };
  window.addEventListener('touchstart', onTouch, { passive: true, once: true });
}

// Multi-tab warning. Each tab carries its own in-memory state.progress;
// the last write to IDB wins. A user with two tabs open rating cards in
// both will silently lose ratings from whichever tab persisted earlier.
// Detect siblings via BroadcastChannel + warn once. Doesn't fix the
// conflict (would need a CRDT or version vector), but at least the user
// knows to close the other tab before studying.
function installMultiTabGuard() {
  if (typeof BroadcastChannel !== 'function') return;
  let ch;
  try { ch = new BroadcastChannel('aplus-study'); } catch { return; }
  let warned = false;
  ch.onmessage = (e) => {
    if (e.data === 'hello' && !warned) {
      warned = true;
      ch.postMessage('here');
      toast('App is open in another tab. Progress saved here may overwrite — close other tabs before studying.', 'warn', 7000);
    } else if (e.data === 'here' && !warned) {
      warned = true;
      toast('App is open in another tab. Progress saved here may overwrite — close other tabs before studying.', 'warn', 7000);
    }
  };
  // Announce our presence. Existing tabs will respond with 'here'.
  ch.postMessage('hello');
}

//─── SWIPE (swipe left to advance in Study/Quiz) ─────────────
function installSwipe() {
  const main = $('#main');
  let sx = 0, sy = 0, tracking = false, pid = null;
  main.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'study' && state.mode !== 'quiz') return;
    // Don't start a swipe on answer options or other interactive elements.
    // .q-options covers the whole radiogroup so a tap+drift on any option
    // won't accidentally trigger a swipe-to-advance.
    if (e.target.closest('button, input, a, canvas, .filter-bar, .scratchpad-wrap, .q-options')) return;
    sx = e.clientX; sy = e.clientY;
    tracking = true;
    pid = e.pointerId;
  });
  main.addEventListener('pointerup', (e) => {
    if (!tracking || e.pointerId !== pid) return;
    tracking = false;
    // If the gesture ENDED on an interactive element, treat it as a click —
    // not a swipe. Without this, a touch that starts on the card body and
    // drifts to land on Reveal/Skip/an option fires BOTH the click handler
    // (revealing the answer) AND the swipe handler (advancing the card),
    // which from the user's perspective looks like "Reveal skipped the card".
    if (e.target.closest('button, input, a, canvas, .filter-bar, .scratchpad-wrap, .q-options')) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    // Ghost-tap guard (5-layer stack, layer 2): a swipe that lands within
    // 800ms of a reveal/answer-record is almost always the tail of the same
    // gesture that revealed the card, not a deliberate skip. The rate-btn and
    // quiz Next click handlers already carry this guard; the swipe pointerup
    // was the one navigation path missing it — which is the "it advanced on
    // its own" / "Reveal skipped the card" report. Bail before navigating.
    if (Date.now() - (state._revealedAt || 0) < 800) return;
    // Require a cleaner horizontal gesture (100px, less diagonal tolerance).
    // Left swipe = next; right swipe = prev (Study only — Quiz answers are
    // recorded and going back would un-record without un-grading).
    if (Math.abs(dx) > 100 && Math.abs(dx) > Math.abs(dy) * 2) {
      if (dx < 0) {
        haptic(15);
        if (state.mode === 'study') nextQuestion();
        else if (state.mode === 'quiz' && state.quizSession && !state.quizSession.done) advanceQuiz();
      } else if (dx > 0 && state.mode === 'study') {
        haptic(15);
        prevQuestion();
      }
    }
  });
  main.addEventListener('pointercancel', () => { tracking = false; });
}

// After innerHTML swaps the DOM under our feet, the previously-focused
// element is gone and focus silently resets to <body>. For keyboard / SR
// users that means every reveal/rate/advance dumps them back to the top
// of the document. This restores focus to the most sensible new target:
// the primary action button if visible, otherwise the main landmark.
function restoreFocusAfterRender(prefer = '#reveal-btn, #quiz-next-btn, .rate-btn, .quiz-size-btn[data-size]:not([disabled])') {
  if (document.activeElement && document.activeElement !== document.body) return;
  const target = document.querySelector(prefer) || document.getElementById('main');
  target?.focus?.({ preventScroll: true });
}

//─── DIALOG A11Y HELPERS ─────────────────────────────────────
// trapFocus: cycles Tab/Shift+Tab inside `overlay`, returns a cleanup
// function that detaches the listener. Used by every modal so keyboard
// users can't tab into the (visually dimmed) background content.
function trapFocus(overlay) {
  const focusablesFor = () => [...overlay.querySelectorAll(
    'button, [href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.disabled && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed'));
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    if (!overlay.isConnected) return;
    const f = focusablesFor();
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
// setAppInert: marks the main app shell as inert + aria-hidden while a
// modal is open, so screen readers don't read background content and Tab
// can't walk into it. Mirrors what `<dialog>` would do natively.
function setAppInert(inert) {
  const app = document.getElementById('app');
  if (!app) return;
  if (inert) { app.setAttribute('inert', ''); app.setAttribute('aria-hidden', 'true'); }
  else       { app.removeAttribute('inert');   app.removeAttribute('aria-hidden'); }
}
// Single global aria-live region for assertive announcements (reveal /
// grade outcomes, ratings). Created lazily so we don't touch the DOM
// until something needs to be spoken.
function announce(msg, assertive = false) {
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
    setAppInert(true);
    const releaseTrap = trapFocus(overlay);
    setTimeout(() => input.focus(), 50);

    const setError = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    };

    // Cleanup wrapper used by every resolve path so the app shell is
    // un-inerted and the focus-trap listener is removed.
    const finish = (value) => {
      releaseTrap();
      setAppInert(false);
      overlay.remove();
      resolve(value);
    };
    $('#lock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value;
      if (!pin) { setError('Enter your PIN.'); return; }
      const setup = getPinSetup();
      if (!setup) { finish(null); return; }
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
        finish(key);
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
      finish(null);
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

// Reusable custom-styled PIN dialog used by setup / change / remove flows.
// Each field has a label + numeric password input. Resolves to a map of the
// entered values (e.g. { pin, confirm }) when the user submits, or null if
// cancelled. Validation (length, match) happens in the caller — the dialog
// can render an inline error string via the `error` callback signature for
// per-field complaints. Replaces native window.prompt() chains so the flow
// matches the rest of the app's modal styling and isn't blocked by iOS
// PWA prompt quirks.
function pinDialog({ title, intro, fields, submit: submitLabel = 'Set', destructive = false }) {
  return new Promise((resolve) => {
    const id = (k) => `pind-${k}`;
    const fieldRows = fields.map(f => `
      <label class="pind-field">
        <span class="pind-label">${escapeHtml(f.label)}</span>
        <input id="${id(f.key)}" type="password" inputmode="numeric"
               autocomplete="off" autocorrect="off" autocapitalize="off"
               spellcheck="false" enterkeyhint="${f === fields[fields.length - 1] ? 'go' : 'next'}"
               aria-label="${escapeHtml(f.label)}" placeholder="${escapeHtml(f.placeholder || '')}">
      </label>
    `).join('');
    const html = `
      <div id="pin-overlay" role="dialog" aria-modal="true" aria-labelledby="pind-title">
        <div class="pind-card">
          <button class="welcome-close" id="pind-close" aria-label="Cancel">✕</button>
          <h2 id="pind-title" class="pind-title">${escapeHtml(title)}</h2>
          ${intro ? `<p class="pind-intro">${escapeHtml(intro)}</p>` : ''}
          <form id="pind-form">
            ${fieldRows}
            <div class="pind-error" id="pind-error" role="alert" hidden></div>
            <div class="pind-actions">
              <button type="button" class="action" id="pind-cancel">Cancel</button>
              <button type="submit" class="action ${destructive ? 'bad' : 'primary'}" id="pind-submit">${escapeHtml(submitLabel)}</button>
            </div>
          </form>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const overlay = $('#pin-overlay');
    const firstInput = overlay.querySelector('input');
    const previouslyFocused = document.activeElement;
    setAppInert(true);
    const releaseTrap = trapFocus(overlay);
    setTimeout(() => firstInput?.focus(), 50);

    const setError = (msg) => {
      const e = $('#pind-error');
      e.textContent = msg || '';
      e.hidden = !msg;
    };
    const finish = (value) => {
      releaseTrap();
      setAppInert(false);
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      // Return focus to the trigger so keyboard/SR users land back where they were.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      resolve(value);
    };
    const cancel = () => finish(null);
    const onKey = (e) => {
      if ($('#pin-overlay') !== overlay) return;
      if (e.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    $('#pind-close').addEventListener('click', cancel);
    $('#pind-cancel').addEventListener('click', cancel);
    $('#pind-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) values[f.key] = ($(`#${id(f.key)}`).value || '');
      finish(values);
    });
    // Inline next-field navigation: pressing Enter on a non-last input
    // jumps to the next, rather than submitting.
    const inputs = [...overlay.querySelectorAll('input')];
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && i < inputs.length - 1) {
          e.preventDefault();
          inputs[i + 1].focus();
        }
      });
    });
  });
}

async function pinSetupFlow() {
  const v = await pinDialog({
    title: 'Set a PIN',
    intro: 'Encrypts your progress, edits, and drawings on this device. ' +
           'Losing the PIN means losing local data unless you\'ve pushed to Supabase.',
    fields: [
      { key: 'pin',     label: 'New PIN (4+ characters)',  placeholder: '••••' },
      { key: 'confirm', label: 'Re-enter to confirm',      placeholder: '••••' },
    ],
    submit: 'Set PIN',
  });
  if (!v) return;
  if (v.pin.length < 4) { toast('PIN must be at least 4 characters.', 'error'); return; }
  if (v.confirm !== v.pin) { toast('PINs didn\'t match. PIN not set.', 'error'); return; }

  toast('Encrypting local data…', 'info', 4000);
  const salt = randomSaltB64();
  const key = await deriveKey(v.pin, salt);
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
  const v = await pinDialog({
    title: 'Change PIN',
    intro: 'Re-encrypts all local data under the new PIN.',
    fields: [
      { key: 'current', label: 'Current PIN',               placeholder: '••••' },
      { key: 'next',    label: 'New PIN (4+ characters)',   placeholder: '••••' },
      { key: 'confirm', label: 'Re-enter new PIN',          placeholder: '••••' },
    ],
    submit: 'Change PIN',
  });
  if (!v) return;
  const setup = getPinSetup();
  const testKey = await deriveKey(v.current, setup.salt, setup.iterations);
  if (!(await verifyPin(testKey, setup.verification))) {
    toast('Current PIN is wrong.', 'error'); return;
  }
  if (v.next.length < 4) { toast('New PIN must be at least 4 characters.', 'error'); return; }
  if (v.confirm !== v.next) { toast('New PINs didn\'t match. PIN unchanged.', 'error'); return; }

  toast('Re-encrypting local data…', 'info', 4000);
  const salt = randomSaltB64();
  const newKey = await deriveKey(v.next, salt);
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
// Pick today's 3 concrete tasks based on current state. Deterministic so
// reopening the welcome doesn't reshuffle — takes the sting out of decision
// load when energy is low.
function buildTodaysPlan() {
  const due = dueCount();
  const weak = weakestCount();
  const fixes = Object.keys(state.conceptFixes);
  const daysLeft = daysUntilExam(state.exam);
  const crunch = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;
  const seen = state.questions.filter(q => state.progress[q.id]?.seen > 0).length;
  const isFreshUser = seen === 0;

  const tasks = [];

  // Primary: what will hurt the most if skipped today?
  // Within 3 days of the exam, override everything with a cram-mode push:
  // due-queue scheduling can't catch up that late and the user benefits
  // most from a single full-deck loop with everything they got wrong
  // cycled back until cleared.
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 3) {
    tasks.push({
      id: 'cram', icon: '🔥', title: 'Cram mode — last-resort review',
      sub: `Exam in ${daysLeft === 0 ? '<24 hours' : daysLeft + ' day' + (daysLeft === 1 ? '' : 's')}. Walks every card once, looping anything you rate Again/Hard. Heads-up: massed practice helps short-term recall but spacing remembers longer — only run cram when spacing isn't possible anymore.`,
      primary: true,
    });
  } else if (isFreshUser) {
    // First-time user: skip the scary "313 cards due" framing. Lead with
    // a calm "take your first card" CTA that introduces the flow.
    tasks.push({
      id: 'start', icon: '🚀', title: 'Start studying',
      sub: 'Your first card. Read → Reveal → rate how it felt. The app schedules reviews from there.',
      primary: true,
    });
  } else if (due > 0) {
    tasks.push({
      id: 'due', icon: '📚', title: 'Clear your due queue',
      sub: `${due} card${due === 1 ? '' : 's'} due right now. Spaced repetition works when you show up.`,
      primary: true,
    });
  } else if (crunch) {
    tasks.push({
      id: 'rapid', icon: '⚡', title: 'Rapid fire 60s',
      sub: `Exam is ${daysLeft === 0 ? 'today' : daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' away'}. Sprint — rate as many as you can.`,
      primary: true,
    });
  } else {
    tasks.push({
      id: 'micro', icon: '🎯', title: 'Just 5 cards',
      sub: `Nothing due yet. A small micro-session. One-and-done ≤ 5 min.`,
      primary: true,
    });
  }

  // Secondary: the drill if there's something to drill
  if (isFreshUser && fixes.length > 0) {
    tasks.push({
      id: 'reading', icon: '📖', title: 'Read first — concept sheets',
      sub: `${fixes.length} short fix sheets per objective. Skim before flashcards if you'd rather read first.`,
    });
  } else if (weak > 0) {
    tasks.push({
      id: 'weakest', icon: '🎯', title: `Drill your weakest ${weak}`,
      sub: 'Cards you\'ve missed most. 10-minute focused run.',
    });
  } else if (crunch && due === 0) {
    tasks.push({
      id: 'session15', icon: '⏱', title: '15-min focus session',
      sub: 'Time-boxed. Countdown in header. End early anytime.',
    });
  } else {
    tasks.push({
      id: 'session15', icon: '⏱', title: '15-min focus session',
      sub: 'Time-boxed study. End early anytime without guilt.',
    });
  }

  // Tertiary: an off-ramp that still moves you forward
  if (isFreshUser) {
    tasks.push({
      id: 'micro', icon: '🎯', title: 'Or — just 5 cards',
      sub: 'Smaller commitment. Five cards, done in a few minutes.',
    });
  } else if (fixes.length > 0) {
    tasks.push({
      id: 'reading', icon: '📖', title: 'Read one concept sheet',
      sub: 'No flashcards. Just the fix notes per objective.',
    });
  } else {
    tasks.push({
      id: 'stats', icon: '📊', title: 'See my progress',
      sub: 'Mastery by objective, streak, accessibility settings.',
    });
  }
  return tasks;
}

function showWelcome() {
  const streak = getStreak();
  const seen = state.questions.filter(q => state.progress[q.id]?.seen > 0).length;
  const returningUser = seen > 0;
  const daysLeft = daysUntilExam(state.exam);
  const examLabel = examDef(state.exam).label.replace(/\s*\(.*\)$/, '');

  const hour = new Date().getHours();
  const tod = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const greeting = returningUser
    ? `${tod}${streak.count > 0 ? ` — 🔥 ${streak.count}-day streak` : ''}.`
    : `Welcome — A+ Core 2 study app.`;

  // For brand-new users: a single short orientation line under the title so
  // the dialog reads "what is this, what do I do" rather than dropping them
  // straight into task choices.
  const introHtml = !returningUser
    ? `<p class="welcome-intro">Spaced-repetition flashcards for the CompTIA A+ Core 2 (220-1202) exam. Pick how you want to start — you can change anytime.</p>`
    : '';

  // Countdown line: the most emotionally charged part of the screen.
  // If no date is set, expose a real button that opens Stats — much more
  // discoverable than the old "Stats → Active exam" text instruction.
  let countdownHtml = '';
  if (daysLeft !== null) {
    const urgency = daysLeft < 0 ? 'hud-past' : daysLeft <= 7 ? 'hud-urgent' : daysLeft <= 30 ? 'hud-soon' : '';
    let text;
    if (daysLeft < 0) text = `${examLabel} was ${-daysLeft}d ago`;
    else if (daysLeft === 0) text = `${examLabel} is TODAY`;
    else text = `${daysLeft} day${daysLeft === 1 ? '' : 's'} to ${examLabel}`;
    countdownHtml = `<p class="welcome-countdown ${urgency}">⏳ ${text}</p>`;
  } else if (!returningUser) {
    countdownHtml = `<button type="button" class="welcome-countdown welcome-countdown-cta" data-welcome="set-exam-date">📅 Set your exam date →</button>`;
  }

  const tasks = buildTodaysPlan();
  // De-dupe the "More options" list — don't repeat actions that are already
  // in the primary 3 tasks; that's where the old dialog felt cluttered.
  const primaryIds = new Set(tasks.map(t => t.id));
  const moreOptions = [
    { id: 'due',       label: '📚 All due cards' },
    { id: 'weakest',   label: `🎯 Weakest ${weakestCount()}` },
    { id: 'micro',     label: '🎯 Just 5 cards' },
    { id: 'rapid',     label: '⚡ Rapid fire 60s' },
    { id: 'session15', label: '⏱ 15-min session' },
    { id: 'reading',   label: '📖 Concept sheets' },
    { id: 'stats',     label: '📊 Progress' },
  ].filter(o => !primaryIds.has(o.id));

  const html = `
    <div id="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div class="welcome-card">
        <button class="welcome-close" id="welcome-close" aria-label="Close">✕</button>
        <h2 id="welcome-title">${greeting}</h2>
        ${introHtml}
        ${countdownHtml}

        <h3>${returningUser ? "Today's plan" : 'Pick a starting point'}</h3>
        <div class="welcome-actions">
          ${tasks.map(t => `
            <button class="welcome-btn${t.primary ? ' primary' : ''}" data-welcome="${t.id}">
              <span class="wbtn-title">${t.icon} ${escapeHtml(t.title)}</span>
              <span class="wbtn-sub">${escapeHtml(t.sub)}</span>
            </button>
          `).join('')}
        </div>

        ${moreOptions.length > 0 ? `
        <details class="welcome-help">
          <summary>More options</summary>
          <div class="welcome-actions welcome-more">
            ${moreOptions.map(o => `<button class="welcome-btn" data-welcome="${o.id}">${o.label}</button>`).join('')}
          </div>
        </details>
        ` : ''}

        <label class="welcome-dismiss">
          <input type="checkbox" id="welcome-dismiss-permanent">
          Don't show this on every load
        </label>
        <p class="welcome-help-link">
          New here, or need to install / sync between devices?
          <a href="#" id="welcome-open-help">Open setup &amp; help →</a>
        </p>
        <p class="welcome-credit">
          Built by <strong>Amanda Kondrat'yev</strong> · open-source (MIT) ·
          <a href="https://github.com/manderwall/aplusstudyapp" target="_blank" rel="noopener noreferrer">GitHub</a>
        </p>
      </div>
    </div>
  `;
  // Re-opening from the header Help button should replace, not stack
  $('#welcome-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);

  const overlay = $('#welcome-overlay');
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const onKeydown = (e) => {
    if ($('#welcome-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(null); return; }
  };
  const close = (action) => {
    const dismissPerm = $('#welcome-dismiss-permanent')?.checked;
    if (dismissPerm) lsSet('welcomeDismissed', '1');
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    // Restore focus to the trigger so keyboard users aren't dumped at <body>
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    // 'start' is the fresh-user calm-onboarding action — deliberately NOT in
    // studyActions so we don't auto-enter Focus Mode (which would hide the
    // tab bar a beginner is still learning to use).
    const studyActions = new Set(['due', 'weakest', 'micro', 'session15', 'rapid', 'cram']);
    if (action === 'start')          { setMode('study'); }
    else if (action === 'due')            { state.filter.due = true; setMode('study'); }
    else if (action === 'weakest')   { state.filter.weakest = true; setMode('study'); }
    else if (action === 'micro')     { startSession({ targetCards: 5 }); setMode('study'); }
    else if (action === 'session15') { startSession({ minutes: 15 }); setMode('study'); }
    else if (action === 'rapid')     { startSession({ minutes: 1, rapid: true }); setMode('study'); }
    else if (action === 'cram')      { startCram(); }
    else if (action === 'reading')   { setMode('reading'); }
    else if (action === 'stats')     { setMode('stats'); }
    else if (action === 'set-exam-date') { setMode('stats'); }
    // For Study-focused actions, auto-enter Focus Mode: hides tab bar, filter
    // bar, HUD, and card meta so it's just the card. Exit with F or the 🎯 button.
    if (studyActions.has(action) && !state.focus) toggleFocus();
    // First-run: name the header icons once the welcome is out of the way
    // (skipped automatically if Focus Mode just hid the chrome).
    maybeShowIconLegend();
  };

  $('#welcome-close').addEventListener('click', () => close(null));
  $$('[data-welcome]').forEach(btn =>
    btn.addEventListener('click', () => close(btn.dataset.welcome))
  );
  // "Setup & help" footer link inside the welcome dialog — opens the help
  // overlay without losing the welcome (closed first so they stack
  // cleanly; user can reopen welcome from Help if they want).
  $('#welcome-open-help')?.addEventListener('click', (e) => {
    e.preventDefault();
    close(null);
    showHelp();
  });
  document.addEventListener('keydown', onKeydown);
  // Focus the primary action so keyboard + screen-reader users land in the
  // dialog immediately instead of at <body>.
  setTimeout(() => {
    const primary = overlay.querySelector('.welcome-btn.primary') ||
                    overlay.querySelector('[data-welcome]') ||
                    overlay.querySelector('button');
    primary?.focus();
  }, 0);
}

//─── FIRST-RUN ICON LEGEND (coachmark) ───────────────────────
// A one-time, non-modal popover that names the header icons so the bare
// emoji aren't a guessing game. Shown once (localStorage-gated) after the
// welcome dialog is dismissed. Lightweight by design — it doesn't trap
// focus or inert the app; dismiss with the button, Escape, or any header
// button click.
function maybeShowIconLegend() {
  if (localStorage.getItem('iconLegendSeen')) return;
  if (location.search.includes('skipWelcome')) return;   // keep tests clean
  if (state.focus) return;                               // chrome is hidden
  if ($('#welcome-overlay') || $('#icon-legend')) return;
  const cloudSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 16.5a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.5 8a3.5 3.5 0 0 1 .5 6.95"/><path d="M9.7 13.2 12 10.9l2.3 2.3"/><path d="M12 10.9v6.4"/></svg>';
  const html = `
    <div id="icon-legend" role="dialog" aria-label="What the buttons at the top do">
      <div class="legend-arrow" aria-hidden="true"></div>
      <p class="legend-title">The buttons up here ↑</p>
      <ul class="legend-list">
        <li><span class="legend-ic">❓</span> Help &amp; setup guides</li>
        <li><span class="legend-ic">${cloudSvg}</span> Sync &amp; back up across devices</li>
        <li><span class="legend-ic">🎯</span> Focus mode — hide everything but the card</li>
        <li><span class="legend-ic">🌓</span> Light / dark theme</li>
      </ul>
      <p class="legend-note">🔈 A “read aloud” button also appears while you study.</p>
      <button type="button" class="welcome-btn primary legend-dismiss" id="legend-dismiss">Got it</button>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  const el = $('#icon-legend');
  const dismiss = () => {
    lsSet('iconLegendSeen', '1');
    document.removeEventListener('keydown', onKey);
    el.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  $('#legend-dismiss').addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  setTimeout(() => $('#legend-dismiss')?.focus(), 0);
}

//─── HELP & SETUP DIALOG ─────────────────────────────────────
// Distinct from the welcome dialog (which is a per-launch task picker).
// This is a how-to overlay: install to home screen, clear cache when an
// update doesn't show up, optional Supabase sync, optional PIN lock,
// keyboard shortcuts, troubleshooting. Triggered by the header ❓ button.
function showHelp() {
  const liveUrl = 'https://aplusstudyapp.pages.dev';
  const html = `
    <div id="help-overlay" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="welcome-card help-card">
        <button class="welcome-close" id="help-close" aria-label="Close help">✕</button>
        <h2 id="help-title">Help &amp; setup</h2>
        <p class="welcome-intro">Quick walkthroughs for everything you might need. Tap a section to expand.</p>

        <details class="help-section" open>
          <summary>📱 Install to home screen (iPad / iPhone / Android)</summary>
          <div class="help-body">
            <p><strong>iPad / iPhone (Safari only — Chrome on iOS can't install PWAs):</strong></p>
            <ol>
              <li>Open <code>${liveUrl}</code> in Safari.</li>
              <li>Tap the <strong>Share</strong> button (square with up arrow).</li>
              <li>Scroll down → <strong>Add to Home Screen</strong> → Add.</li>
              <li>Open from the home-screen icon. Works fully offline once loaded.</li>
            </ol>
            <p><strong>Android (Chrome):</strong></p>
            <ol>
              <li>Open <code>${liveUrl}</code> in Chrome.</li>
              <li>Tap the <strong>⋮</strong> menu → <strong>Install app</strong> (or "Add to Home Screen").</li>
            </ol>
            <p><strong>Desktop (Chrome / Edge):</strong> click the install icon in the address bar.</p>
          </div>
        </details>

        <details class="help-section">
          <summary>🔄 Update doesn't show up? Clear the cache</summary>
          <div class="help-body">
            <p>Service workers cache the app for offline use, so updates sometimes take a refresh to land.</p>
            <p><strong>iPad / iPhone (installed to home screen):</strong></p>
            <ol>
              <li>Long-press the A+ Study icon → <strong>Delete app</strong>.</li>
              <li>Reopen <code>${liveUrl}</code> in Safari → Share → <strong>Add to Home Screen</strong> again.</li>
            </ol>
            <p><strong>iPad / iPhone (Safari, not installed):</strong> Settings → Safari → Advanced → Website Data → find the site → <strong>Remove</strong>.</p>
            <p><strong>Android:</strong> long-press the icon → <strong>App info</strong> → Storage &amp; cache → <strong>Clear cache</strong>.</p>
            <p><strong>Desktop:</strong> hard-refresh with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (Windows / Linux) or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (Mac).</p>
          </div>
        </details>

        <details class="help-section">
          <summary>📅 Set your exam date</summary>
          <div class="help-body">
            <p>Setting an exam date enables the countdown in the header + a "cram mode" the week of the exam.</p>
            <ol>
              <li>Tap <strong>Stats</strong> tab (bottom right).</li>
              <li>Under <strong>Active exam</strong>, find <em>Core 2 (220-1202) exam date</em>.</li>
              <li>Tap the date picker → pick your test day.</li>
            </ol>
          </div>
        </details>

        <details class="help-section">
          <summary>☁️ Sync &amp; backup between devices (optional)</summary>
          <div class="help-body">
            <p>If you study on more than one device — or just want a backup — optional cloud sync keeps your progress together. It's free and skippable if you only use one device.</p>
            <p>Setup now lives behind the <strong>☁️ button at the top of the screen</strong>, with a copy-paste setup script and step-by-step instructions.</p>
            <button type="button" class="action primary" id="help-open-sync">☁️ Open Sync &amp; backup</button>
          </div>
        </details>

        <details class="help-section">
          <summary>🔒 PIN lock (optional — encrypts your data)</summary>
          <div class="help-body">
            <p>Adds a passcode that encrypts your progress, edits, and scratchpad drawings at rest. Useful on shared devices.</p>
            <ol>
              <li>Open <strong>Stats → App lock (encrypted at rest)</strong> → <strong>Set PIN</strong>.</li>
              <li>Pick a PIN of 4+ characters, re-enter to confirm.</li>
              <li>Every launch asks for the PIN. The PIN itself is never stored — only a verification blob.</li>
            </ol>
            <p><strong>Forgot the PIN?</strong> The lock screen offers <em>Wipe local data</em> (you can re-pull from Supabase on another device if you set sync up).</p>
          </div>
        </details>

        <details class="help-section">
          <summary>⌨️ Keyboard shortcuts (desktop)</summary>
          <div class="help-body">
            <table class="help-kbd-table">
              <tr><td><kbd>Space</kbd> / <kbd>Enter</kbd> / <kbd>R</kbd></td><td>Reveal answer (Study) or skip (Quiz)</td></tr>
              <tr><td><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd></td><td>Rate Again / Hard / Good / Easy (Study, after reveal)</td></tr>
              <tr><td><kbd>→</kbd> / <kbd>K</kbd> / <kbd>N</kbd></td><td>Next question</td></tr>
              <tr><td><kbd>←</kbd> / <kbd>J</kbd> / <kbd>P</kbd></td><td>Previous question</td></tr>
              <tr><td><kbd>T</kbd></td><td>Cycle theme (auto / light / dark)</td></tr>
              <tr><td><kbd>F</kbd></td><td>Toggle Focus Mode (hides chrome); <kbd>Esc</kbd> also exits</td></tr>
            </table>
          </div>
        </details>

        <details class="help-section">
          <summary>🆘 Stuck? Lost progress? Found a bug?</summary>
          <div class="help-body">
            <ul>
              <li><strong>Page won't load:</strong> check connection, then clear the cache (section above).</li>
              <li><strong>Cards seem to skip:</strong> reinstall the home-screen icon — you may be on an old service-worker cache.</li>
              <li><strong>Lost your progress after wipe:</strong> if you set up sync, tap the <strong>☁️ button → ⬇ Pull</strong> on this device.</li>
              <li>
                <strong>Send feedback or report a bug:</strong>
                <button type="button" class="action primary feedback-cta" id="help-feedback-btn">📨 Send feedback</button>
                <span class="help-aux">(pre-fills the screen you're on + device info so you don't have to type it out)</span>
              </li>
            </ul>
          </div>
        </details>

        <div class="help-footer">
          <button type="button" class="welcome-btn primary" id="help-open-welcome">
            <span class="wbtn-title">← Back to "Pick a starting point"</span>
          </button>
          <p class="help-credit">
            <strong>A+ Study</strong> — created by Amanda Kondrat'yev.
            <a href="https://github.com/manderwall/aplusstudyapp" target="_blank" rel="noopener noreferrer">Source on GitHub</a> ·
            <a href="https://github.com/manderwall/aplusstudyapp/issues" target="_blank" rel="noopener noreferrer">Report an issue</a>
          </p>
          <p class="help-disclaimer">
            Unofficial, independent study aid — <strong>not affiliated with,
            authorized, or endorsed by CompTIA</strong>. “CompTIA” and “A+” are
            trademarks of CompTIA, used here only to describe the exam this app
            helps you study for. All questions are original, written to the
            publicly available exam objectives; no actual exam content is
            reproduced. A free, open-source personal project (MIT-licensed).
          </p>
        </div>
      </div>
    </div>
  `;
  $('#help-overlay')?.remove();
  $('#welcome-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = $('#help-overlay');
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const close = () => {
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
  const onKeydown = (e) => {
    if ($('#help-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(); return; }
  };
  $('#help-close').addEventListener('click', close);
  $('#help-open-welcome').addEventListener('click', () => {
    close();
    showWelcome();
  });
  $('#help-feedback-btn').addEventListener('click', () => {
    close();
    showFeedback();
  });
  $('#help-open-sync')?.addEventListener('click', () => {
    close();
    showSync();
  });
  document.addEventListener('keydown', onKeydown);
  setTimeout(() => {
    overlay.querySelector('summary')?.focus();
  }, 0);
}

//─── SYNC & BACKUP DIALOG (☁️ header icon) ────────────────────
// One-time, copy-paste-able Supabase setup that matches what the app
// actually calls (the progress_push / progress_pull RPCs from the
// security-hardening PR — NOT the old direct-table policies). Lives
// behind its own header icon so cross-device backup is discoverable
// instead of buried at the bottom of Stats. Reuses the help-overlay
// scaffolding + the standard setAppInert + trapFocus a11y pattern.

// The exact SQL a brand-new project needs: the table (closed to anon)
// plus the two SECURITY DEFINER functions the app talks to. Kept here
// as the single source of truth shown in-app; mirrors
// docs/supabase-sync-hardening.sql (which only patches an existing
// table). $$ is a Postgres body delimiter, safe inside a JS template.
const SUPABASE_SETUP_SQL = `-- A+ Study cloud sync — run once in Supabase:
-- Project → SQL Editor → New query → paste → Run.

create table if not exists public.progress (
  sync_key   text primary key,
  data       jsonb not null,
  updated_at timestamptz default now()
);
alter table public.progress enable row level security;
-- No anon policies on purpose: the table is reachable ONLY through the
-- two functions below, and each one requires your sync key.

create or replace function public.progress_pull(p_sync_key text)
returns table (data jsonb, updated_at timestamptz)
language sql security definer set search_path = public as $$
  select p.data, p.updated_at
  from public.progress p
  where p.sync_key = p_sync_key;
$$;

create or replace function public.progress_push(p_sync_key text, p_data jsonb)
returns void
language sql security definer set search_path = public as $$
  insert into public.progress (sync_key, data, updated_at)
  values (p_sync_key, p_data, now())
  on conflict (sync_key) do update
    set data = excluded.data, updated_at = excluded.updated_at;
$$;

grant execute on function public.progress_pull(text)        to anon;
grant execute on function public.progress_push(text, jsonb) to anon;`;

function syncStatusLine() {
  const { url, key, syncKey } = getCloudCfg();
  const configured = !!(url && key && syncKey);
  const last = localStorage.getItem('supabase.lastSync');
  if (!configured) {
    return { configured, text: 'Not set up yet — this device saves locally only.' };
  }
  return {
    configured,
    text: last
      ? `Connected. Last sync: ${new Date(last).toLocaleString()}`
      : 'Connected — not synced yet. Tap ⬆ Push to back up.',
  };
}

// Toggle the "backup is on" dot on the header sync button. Cheap enough
// to call on init + after any config change.
function updateSyncBadge() {
  const btn = $('#sync-btn');
  if (!btn) return;
  const { configured } = syncStatusLine();
  btn.classList.toggle('is-configured', configured);
  btn.title = configured
    ? 'Sync & backup — on (tap to manage)'
    : 'Sync & backup (save across devices)';
}

function showSync() {
  const cfg = getCloudCfg();
  const status = syncStatusLine();
  const html = `
    <div id="sync-overlay" role="dialog" aria-modal="true" aria-labelledby="sync-title">
      <div class="welcome-card help-card">
        <button class="welcome-close" id="sync-close" aria-label="Close sync">✕</button>
        <h2 id="sync-title">☁️ Sync &amp; backup</h2>
        <p class="welcome-intro">Your progress is always saved on <strong>this</strong> device automatically. Cloud sync is optional — turn it on to back up your progress and study across more than one device (e.g. iPad + phone).</p>

        <div class="sync-status ${status.configured ? 'is-on' : 'is-off'}" id="sync-status-banner" role="status">
          <span class="sync-status-dot" aria-hidden="true"></span>
          <span id="sync-status-text">${escapeHtml(status.text)}</span>
        </div>

        <details class="help-section">
          <summary>🤔 Do I even need this?</summary>
          <div class="help-body">
            <p><strong>Only use one device?</strong> You can skip all of this — your progress is already safe on this device and works offline.</p>
            <p><strong>Want a backup, or study on two devices?</strong> Set up the free Supabase backend once (below), then connect each device with the same sync key.</p>
          </div>
        </details>

        <details class="help-section" ${status.configured ? '' : 'open'}>
          <summary>1️⃣ Set up the backend (one time, ~5 min)</summary>
          <div class="help-body">
            <ol>
              <li>Make a free project at <strong>supabase.com</strong> (no card needed).</li>
              <li>Open the project → <strong>SQL Editor</strong> → <strong>New query</strong>.</li>
              <li>Paste the script below and click <strong>Run</strong>. (Sets up the storage table + the two secure functions this app uses.)
                <button type="button" class="copy-sql-btn small-btn" id="sync-copy-sql">📋 Copy the SQL</button>
                <pre id="sync-sql">${escapeHtml(SUPABASE_SETUP_SQL)}</pre>
              </li>
              <li>Open <strong>Project Settings → API</strong> and copy two things: the <em>Project URL</em> and the <em>anon / public key</em>.</li>
            </ol>
          </div>
        </details>

        <details class="help-section" ${status.configured ? 'open' : ''}>
          <summary>2️⃣ Connect this device</summary>
          <div class="help-body">
            <div class="settings-stack sync-form">
              <label class="settings-vrow">
                <span class="settings-vlabel">Project URL</span>
                <input id="cloud-url" type="url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cfg.url)}">
              </label>
              <label class="settings-vrow">
                <span class="settings-vlabel">Anon / public key</span>
                <input id="cloud-key" type="password" placeholder="eyJ…" value="${escapeHtml(cfg.key)}">
              </label>
              <label class="settings-vrow">
                <span class="settings-vlabel">Sync key — pick any long random string, use the <em>same</em> one on every device (e.g. <code>my-aplus-7Kp2qX</code>)</span>
                <input id="cloud-sync" type="text" placeholder="your-sync-key" value="${escapeHtml(cfg.syncKey)}">
              </label>
              <p class="settings-meta">Your sync key is the only thing protecting your data — use something long and unguessable, and keep it private.</p>
              <div class="sync-actions">
                <button class="small-btn" id="cloud-save">💾 Save</button>
                <button class="small-btn" id="cloud-push">⬆ Push (back up this device)</button>
                <button class="small-btn" id="cloud-pull">⬇ Pull (load onto this device)</button>
              </div>
              <label class="settings-row sync-autosync">
                <span>Auto-sync after each save (every 5s)</span>
                <input type="checkbox" id="sync-autosync" ${pref('autosync')==='on'?'checked':''}>
              </label>
              <p class="settings-meta" id="cloud-status">${escapeHtml(status.text)}</p>
            </div>
          </div>
        </details>

        <details class="help-section">
          <summary>🆘 Sync isn't working?</summary>
          <div class="help-body">
            <ul>
              <li><strong>Push/Pull fails:</strong> re-check the Project URL and anon key (Settings → API). Make sure you ran the full SQL script above.</li>
              <li><strong>"No row found for sync key":</strong> you haven't pushed from any device yet — tap <strong>⬆ Push</strong> on the device that has your progress first.</li>
              <li><strong>Two devices disagree:</strong> Push from the one that's most up-to-date, then Pull on the other.</li>
              <li><strong>First device, fresh install:</strong> Pull <em>replaces</em> local progress with the cloud copy — only Pull onto a device you're okay overwriting.</li>
            </ul>
          </div>
        </details>
      </div>
    </div>
  `;
  $('#sync-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = $('#sync-overlay');
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const close = () => {
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
  };
  const onKeydown = (e) => {
    if ($('#sync-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(); return; }
  };
  $('#sync-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  const readInputs = () => saveCloudCfg(
    $('#cloud-url').value.trim(),
    $('#cloud-key').value.trim(),
    $('#cloud-sync').value.trim(),
  );
  const refreshBanner = () => {
    const s = syncStatusLine();
    const banner = $('#sync-status-banner');
    if (banner) {
      banner.classList.toggle('is-on', s.configured);
      banner.classList.toggle('is-off', !s.configured);
      $('#sync-status-text').textContent = s.text;
    }
    updateSyncBadge();
  };

  $('#sync-copy-sql').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
      btn.textContent = '✓ Copied!';
    } catch {
      window.prompt('Copy this SQL, then run it in the Supabase SQL editor:', SUPABASE_SETUP_SQL);
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  });
  $('#cloud-save').addEventListener('click', () => {
    readInputs();
    setCloudStatus('Configuration saved.');
    refreshBanner();
  });
  $('#cloud-push').addEventListener('click', async () => {
    setCloudStatus('Pushing…');
    try {
      readInputs();
      await cloudPush();
      setCloudStatus(`Pushed ${new Date().toLocaleTimeString()}`);
    } catch (e) { setCloudStatus(`Push failed: ${e.message}`, true); }
    refreshBanner();
  });
  $('#cloud-pull').addEventListener('click', async () => {
    if (!confirm('Pull will overwrite local progress with the cloud copy. Continue?')) return;
    setCloudStatus('Pulling…');
    try {
      readInputs();
      await cloudPull();
      setCloudStatus(`Pulled ${new Date().toLocaleTimeString()}`);
      if (state.mode === 'stats') renderStats();
    } catch (e) { setCloudStatus(`Pull failed: ${e.message}`, true); }
    refreshBanner();
  });
  $('#sync-autosync').addEventListener('change', (e) => {
    setPref('autosync', e.target.checked ? 'on' : 'off');
  });
  setTimeout(() => { $('#sync-close')?.focus(); }, 0);
}

//─── FEEDBACK / BUG-REPORT DIALOG ─────────────────────────────
// Opens an in-app form that pre-fills the screen the user is on + device
// info, so a classmate doesn't have to type "I was on Quiz card #7,
// iPhone 15 Pro, Safari, app version v73" by hand.
//
// Contact form: if FEEDBACK_FORM_KEY is set, the report is POSTed to the
// Web3Forms relay, which emails it straight to Amanda's inbox — no GitHub
// login required and her address never appears in this source. When the key
// is blank it falls back to opening a prefilled GitHub issue, so the button
// is never dead. Copy-to-clipboard is always available as a last resort.
const FEEDBACK_ISSUES_URL = 'https://github.com/manderwall/aplusstudyapp/issues/new';
// Web3Forms access key — a PUBLIC, submit-only token (safe to commit; it
// can only post to this one form, can't read anything). It maps to the
// owner's email ON Web3Forms, so the address itself stays out of the repo.
// Get a free key in ~1 min at https://web3forms.com (enter your email; they
// email you the key) and paste it here. Blank = GitHub-issue fallback.
const FEEDBACK_FORM_KEY = '';
const FEEDBACK_FORM_ENDPOINT = 'https://api.web3forms.com/submit';
function contactFormReady() {
  return typeof FEEDBACK_FORM_KEY === 'string' && FEEDBACK_FORM_KEY.length >= 16;
}
// POST the report to the Web3Forms relay. Resolves true on a confirmed
// delivery, false otherwise (network error, CSP block, relay rejection).
async function sendFeedbackToInbox(body) {
  try {
    const res = await fetch(FEEDBACK_FORM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_key: FEEDBACK_FORM_KEY,
        subject: 'A+ Study — feedback / bug report',
        from_name: 'A+ Study app',
        message: body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success !== false;
  } catch {
    return false;
  }
}
// Open a prefilled GitHub issue (the no-key fallback). Overflows to
// copy-to-clipboard + a blank issue form when the report is too long.
function openFeedbackIssue(body) {
  const base = `${FEEDBACK_ISSUES_URL}?title=${encodeURIComponent('Bug report / feedback')}`;
  const url = `${base}&body=${encodeURIComponent(body)}`;
  if (url.length > 6000) {
    navigator.clipboard?.writeText(body);
    toast('Report copied — paste it into the GitHub issue that just opened.', 'info', 6000);
    window.open(base, '_blank', 'noopener');
    return;
  }
  try {
    const w = window.open(url, '_blank', 'noopener');
    if (!w) location.href = url;
  } catch { location.href = url; }
}
async function getCacheVersion() {
  // The SW writes a constant `aplus-study-v<N>`; reading it out of the
  // active SW lets us tag reports with the version the user is actually
  // running, not what main pushed two minutes ago.
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (!reg) return 'unknown';
    const keys = await caches.keys();
    return keys.find(k => k.startsWith('aplus-study-')) || 'unknown';
  } catch { return 'unknown'; }
}
async function buildDiagnostics() {
  const ua = navigator.userAgent;
  const cache = await getCacheVersion();
  const seenCards = state.questions.filter(q => state.progress[q.id]?.seen > 0).length;
  const totalCards = state.questions.length;
  const cardId = state._currentQ?.id || '(no current card)';
  return [
    `Mode: ${state.mode}`,
    `Card: ${cardId}`,
    `Progress: ${seenCards} / ${totalCards} cards rated`,
    `Active filter: ${JSON.stringify(state.filter)}`,
    `Theme: ${pref('theme') || 'auto'}`,
    `App cache: ${cache}`,
    `Viewport: ${window.innerWidth} × ${window.innerHeight}`,
    `Device: ${ua}`,
    `When: ${new Date().toISOString()}`,
  ].join('\n');
}
async function showFeedback() {
  const diagnostics = await buildDiagnostics();
  const html = `
    <div id="feedback-overlay" role="dialog" aria-modal="true" aria-labelledby="fbk-title">
      <div class="welcome-card pind-card feedback-card">
        <button class="welcome-close" id="fbk-close" aria-label="Cancel">✕</button>
        <h2 id="fbk-title" class="pind-title">📨 Report a bug or send feedback</h2>
        <p class="pind-intro">Tell me what happened. The form pre-fills the screen you're on and your device info so you don't have to type it out.</p>
        <label class="fbk-field">
          <span class="pind-label">What were you doing? What went wrong?</span>
          <textarea id="fbk-msg" rows="5" placeholder="Example: I tapped Quiz, picked B, and the next question loaded with no options visible."></textarea>
        </label>
        <label class="fbk-include">
          <input type="checkbox" id="fbk-include-diag" checked>
          <span>Include diagnostics — current screen, app version, browser. Helps me debug.</span>
        </label>
        <details class="fbk-diag-preview">
          <summary>Show what's included</summary>
          <pre id="fbk-diag-preview-pre"></pre>
        </details>
        <div id="fbk-error" class="pind-error" role="alert" hidden></div>
        <div class="pind-actions">
          <button type="button" class="action" id="fbk-copy">Copy report</button>
          <button type="button" class="action primary" id="fbk-send">${contactFormReady() ? 'Send to Amanda →' : 'Open a GitHub issue →'}</button>
        </div>
      </div>
    </div>`;
  $('#feedback-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  const overlay = $('#feedback-overlay');
  $('#fbk-diag-preview-pre').textContent = diagnostics;
  const previouslyFocused = document.activeElement;
  setAppInert(true);
  const releaseTrap = trapFocus(overlay);
  const close = () => {
    releaseTrap();
    setAppInert(false);
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
  };
  const onKeydown = (e) => {
    if ($('#feedback-overlay') !== overlay) return;
    if (e.key === 'Escape') { close(); }
  };
  document.addEventListener('keydown', onKeydown);
  $('#fbk-close').addEventListener('click', close);

  const buildReport = () => {
    const msg = ($('#fbk-msg').value || '').trim();
    const includeDiag = $('#fbk-include-diag').checked;
    const parts = [];
    if (msg) parts.push(msg);
    else parts.push('(no description provided)');
    if (includeDiag) {
      parts.push('');
      parts.push('---');
      parts.push('Diagnostics:');
      parts.push(diagnostics);
    }
    return parts.join('\n');
  };

  $('#fbk-send').addEventListener('click', async () => {
    const body = buildReport();
    const errEl = $('#fbk-error');
    errEl.hidden = true;
    // Preferred path: relay straight to the owner's inbox via Web3Forms.
    if (contactFormReady()) {
      const btn = $('#fbk-send');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Sending…';
      const ok = await sendFeedbackToInbox(body);
      if (ok) { toast('Sent — thank you! 💛', 'info', 4000); close(); return; }
      // Delivery failed (offline / blocked): keep the report safe + explain.
      btn.disabled = false; btn.textContent = orig;
      navigator.clipboard?.writeText(body).catch(() => {});
      errEl.hidden = false;
      errEl.textContent = "Couldn't send just now — your report is copied to the clipboard. Check your connection and try again, or use Copy report.";
      return;
    }
    // No key configured yet → prefilled GitHub issue (still works).
    openFeedbackIssue(body);
    setTimeout(close, 200);
  });

  $('#fbk-copy').addEventListener('click', async () => {
    const body = buildReport();
    try {
      await navigator.clipboard.writeText(body);
      const btn = $('#fbk-copy');
      const orig = btn.textContent;
      btn.textContent = 'Copied ✓';
      btn.classList.add('share-copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('share-copied'); }, 1800);
    } catch {
      // Clipboard blocked — show the text so user can long-press select it
      const errEl = $('#fbk-error');
      errEl.hidden = false;
      errEl.textContent = `Couldn't copy automatically. Select and copy this, then paste it into a GitHub issue: ${body.slice(0, 200)}…`;
    }
  });

  setTimeout(() => $('#fbk-msg')?.focus(), 50);
}

// One-shot defaults for exam dates so users don't have to open Stats just to
// see their countdown. The sentinel under `exam.defaulted` tracks which exam
// IDs we've already applied a default to — clearing the date afterwards
// sticks, because we never re-apply once an ID is in that set.
function applyDefaultExamDates() {
  const DEFAULTS = {};  // No defaults — set per-exam from Stats
  let defaulted;
  try { defaulted = new Set(JSON.parse(localStorage.getItem('exam.defaulted') || '[]')); }
  catch { defaulted = new Set(); }
  let changed = false;
  for (const [id, iso] of Object.entries(DEFAULTS)) {
    if (defaulted.has(id)) continue;
    if (!getExamDate(id)) { setExamDate(id, iso); changed = true; }
    defaulted.add(id);
  }
  if (changed || defaulted.size) {
    lsSet('exam.defaulted', JSON.stringify([...defaulted]));
  }
}

// One-shot cleanup: when Core 1 was scrubbed, the orphaned progress /
// overrides / drawings rows for examId="core1" stay in IndexedDB on each
// device until something deletes them. Quiet, idempotent, runs at most
// once per device (the `core1.purged` localStorage flag guards repeats).
async function purgeCore1Leftovers() {
  if (localStorage.getItem('core1.purged') === '1') return;
  try {
    const stores = ['progress', 'overrides', 'drawings', 'reference'];
    const db = await openDB();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(stores.filter(s => db.objectStoreNames.contains(s)), 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s)) continue;
        try { tx.objectStore(s).delete('core1'); } catch {}
      }
    });
    lsSet('core1.purged', '1');
  } catch { /* best-effort; never block init */ }
}

async function init() {
  // Prefs / theme / shuffle all load before any render so first paint is correct
  applyPrefs();
  applyDefaultExamDates();
  purgeCore1Leftovers();  // fire-and-forget; init shouldn't wait on it
  // Active exam is persisted separately so the PIN gate can still unlock the
  // right encrypted progress blob on first load.
  const savedExam = localStorage.getItem('exam');
  if (EXAM_IDS.includes(savedExam)) state.exam = savedExam;
  setTheme(localStorage.getItem('theme') || 'auto');
  const savedOrder = localStorage.getItem('order');
  if (savedOrder === 'smart' || savedOrder === 'random' || savedOrder === 'sequential') {
    state.order = savedOrder;
  } else if (localStorage.getItem('shuffle') === 'true') {
    // Migrate prior Boolean shuffle flag → Random order
    state.order = 'random';
    lsSet('order', 'random');
    localStorage.removeItem('shuffle');
  }
  if (pref('sound') !== 'off') setSound(pref('sound'));  // ambient noise restores (needs gesture on some browsers)
  if (pref('shake') === 'on') enableShake().catch(() => {});

  $('#theme-btn')?.addEventListener('click', cycleTheme);
  $('#focus-btn')?.addEventListener('click', toggleFocus);
  $('#help-btn')?.addEventListener('click', showHelp);
  $('#sync-btn')?.addEventListener('click', showSync);
  updateSyncBadge();

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
  // Critical-path installers — keyboard + swipe handle the first frame's
  // input. Render the Study tab synchronously so the first card paints
  // ASAP (~300ms saved on throttled mobile vs running everything inline).
  installSwipe();
  installKeyboard();
  setMode('study');

  // Show welcome on first visit (or every load until user ticks "don't show again").
  // Skippable via ?skipWelcome=1 for tests.
  if (!localStorage.getItem('welcomeDismissed') && !location.search.includes('skipWelcome')) {
    showWelcome();
  } else {
    // Returning user (welcome suppressed): still offer the one-time icon
    // legend so the header changes are explained at least once.
    maybeShowIconLegend();
  }

  // Deferred installers — none of these block first interaction.
  // ListenButton + ImageZoom + WakeLock + InputModeDetection fire on
  // events the user can't trigger in the first ~100ms anyway. Scheduling
  // via requestIdleCallback (falling back to setTimeout) yields the main
  // thread so the first card paints before this runs.
  // Defer past first paint without waiting for arbitrary "idle". The
  // previous requestIdleCallback path could defer 100s of ms on slow
  // devices — opening a race where the user taps Listen/an image
  // before the handler is wired. setTimeout(0) yields one frame
  // (paint cycle completes) but the deferred installers run before
  // any plausible user input can land.
  const deferIdle = (fn) => setTimeout(fn, 0);
  deferIdle(() => {
    installListenButton();
    installInputModeDetection();
    installWakeLock();
    installImageZoom();
    installMultiTabGuard();
  });

  // Register service worker for offline + watch for new versions. Deferred
  // (idle) because SW install + update-check + the offerReload pathway are
  // not first-paint-critical and noticeably stretch the JS work before the
  // first card paints on slow CPUs.
  if ('serviceWorker' in navigator) deferIdle(() => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offerReload = (sw) => {
        toast('A new version is ready. Tap to reload.', 'info', 8000, () => {
          sw.postMessage('SKIP_WAITING');
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offerReload(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            offerReload(incoming);
          }
        });
      });
      let _refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_refreshing) return;
        _refreshing = true;
        location.reload();
      });
      // Probe for updates immediately and again whenever the tab returns
      // to the foreground — catches updates the user wouldn't otherwise
      // see until a full restart.
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(err => console.warn('SW failed:', err));
  });
}

init();

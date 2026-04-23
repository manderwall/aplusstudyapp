// A+ Study — single-file PWA logic
// Modules: State, DB, Study, Quiz, Reading, Stats, ScratchPad, Router

//─── GLOBAL STATE ────────────────────────────────────────────
const state = {
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

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_INTERVAL_DAYS = 30;  // cap so exam-prep doesn't schedule cards past the exam

function defaultProgress() {
  return { status: 'new', seen: 0, correct: 0, lastSeen: 0, ease: 2.5, interval: 0, due: 0 };
}

function migrateProgress(p) {
  if (p.ease === undefined) p.ease = 2.5;
  if (p.interval === undefined) p.interval = 0;
  if (p.due === undefined) p.due = 0;
  return p;
}

function schedule(p, rate) {
  const now = Date.now();
  if (rate === 'again') {
    p.ease = Math.max(1.3, p.ease - 0.2);
    p.interval = 0;
    p.due = now + MIN;
    p.status = 'learning';
  } else if (rate === 'hard') {
    p.ease = Math.max(1.3, p.ease - 0.15);
    if (p.interval === 0) { p.due = now + 10 * MIN; }
    else {
      p.interval = Math.min(MAX_INTERVAL_DAYS, p.interval * 1.2);
      p.due = now + p.interval * DAY;
    }
    p.status = 'learning';
  } else if (rate === 'good') {
    if (p.interval === 0) p.interval = 1;
    else p.interval = Math.min(MAX_INTERVAL_DAYS, p.interval * p.ease);
    p.due = now + p.interval * DAY;
    p.status = p.status === 'new' ? 'learning' : 'good';
  } else if (rate === 'easy') {
    p.ease = p.ease + 0.15;
    if (p.interval === 0) p.interval = 3;
    else p.interval = Math.min(MAX_INTERVAL_DAYS, p.interval * p.ease * 1.3);
    p.due = now + p.interval * DAY;
    p.status = 'good';
  }
}

function isDue(q) {
  return (state.progress[q.id].due || 0) <= Date.now();
}

function haptic(pattern = 10) {
  if (pref('haptics') === 'off') return;
  if (navigator.vibrate) navigator.vibrate(pattern);
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
    alert(msg);
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
    <g class="mascot-sparkles"><path d="M14 28 L16 34 L22 36 L16 38 L14 44 L12 38 L6 36 L12 34 Z"/><path d="M100 18 L101 22 L105 23 L101 24 L100 28 L99 24 L95 23 L99 22 Z"/><path d="M104 90 L106 96 L112 98 L106 100 L104 106 L102 100 L96 98 L102 96 Z"/></g>
    <g class="mascot-body"><ellipse cx="60" cy="72" rx="32" ry="26"/><circle cx="36" cy="62" r="16"/><circle cx="84" cy="62" r="16"/><circle cx="60" cy="50" r="20"/></g>
    <ellipse class="mascot-eye" cx="50" cy="62" rx="4" ry="5"/><ellipse class="mascot-eye" cx="70" cy="62" rx="4" ry="5"/>
    <circle class="mascot-shine" cx="51" cy="59" r="1.5"/><circle class="mascot-shine" cx="71" cy="59" r="1.5"/>
    <ellipse class="mascot-blush" cx="43" cy="72" rx="4.5" ry="2.2"/><ellipse class="mascot-blush" cx="77" cy="72" rx="4.5" ry="2.2"/>
    <path class="mascot-smile" d="M54 74 Q60 79 66 74" fill="none"/>
  </svg>`,

  celebrate: `<svg class="mascot celebrate" viewBox="0 0 120 120" aria-hidden="true">
    <g class="mascot-sparkles">
      <path d="M14 28 L16 34 L22 36 L16 38 L14 44 L12 38 L6 36 L12 34 Z"/>
      <path d="M100 18 L101 22 L105 23 L101 24 L100 28 L99 24 L95 23 L99 22 Z"/>
      <path d="M104 90 L106 96 L112 98 L106 100 L104 106 L102 100 L96 98 L102 96 Z"/>
      <path d="M20 92 L21 96 L25 97 L21 98 L20 102 L19 98 L15 97 L19 96 Z"/>
    </g>
    <g class="mascot-body"><ellipse cx="60" cy="72" rx="32" ry="26"/><circle cx="36" cy="62" r="16"/><circle cx="84" cy="62" r="16"/><circle cx="60" cy="50" r="20"/></g>
    <path class="mascot-eye-happy" d="M46 62 Q50 57 54 62" fill="none"/>
    <path class="mascot-eye-happy" d="M66 62 Q70 57 74 62" fill="none"/>
    <ellipse class="mascot-blush" cx="43" cy="72" rx="4.5" ry="2.2"/><ellipse class="mascot-blush" cx="77" cy="72" rx="4.5" ry="2.2"/>
    <path class="mascot-smile" d="M52 74 Q60 82 68 74" fill="none"/>
    <!-- party confetti floating up -->
    <rect x="28" y="14" width="3" height="6" fill="#ffd700" transform="rotate(15 29 17)"/>
    <rect x="88" y="14" width="3" height="6" fill="#ff80ab" transform="rotate(-15 89 17)"/>
    <circle cx="58" cy="12" r="2" fill="#80d8ff"/>
  </svg>`,

  sleep: `<svg class="mascot" viewBox="0 0 120 120" aria-hidden="true">
    <text x="88" y="22" class="mascot-z">z</text><text x="96" y="34" class="mascot-z" font-size="10">z</text><text x="102" y="42" class="mascot-z" font-size="7">z</text>
    <g class="mascot-body"><ellipse cx="60" cy="72" rx="32" ry="26"/><circle cx="36" cy="62" r="16"/><circle cx="84" cy="62" r="16"/><circle cx="60" cy="50" r="20"/></g>
    <path class="mascot-eye-closed" d="M46 62 Q50 66 54 62" fill="none"/>
    <path class="mascot-eye-closed" d="M66 62 Q70 66 74 62" fill="none"/>
    <ellipse class="mascot-blush" cx="43" cy="72" rx="4.5" ry="2.2"/><ellipse class="mascot-blush" cx="77" cy="72" rx="4.5" ry="2.2"/>
    <path class="mascot-smile" d="M55 74 Q60 76 65 74" fill="none"/>
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

async function loadProgress() {
  try { return (await idbGet(STORE, 'all')) || {}; } catch { return {}; }
}
async function saveProgress() {
  try { await idbPut(STORE, 'all', state.progress); }
  catch (e) { console.warn('Save progress failed', e); }
}
async function clearProgress() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    state.progress = {};
  } catch (e) { console.warn('Clear failed', e); }
}

async function loadOverrides() {
  try { return (await idbGet(OSTORE, 'all')) || {}; } catch { return {}; }
}
async function saveOverrides() {
  try { await idbPut(OSTORE, 'all', state.overrides); }
  catch (e) { console.warn('Save overrides failed', e); }
}

//─── DATA LOAD ───────────────────────────────────────────────
async function loadData() {
  const [questionsRes, fixesRes] = await Promise.all([
    fetch('data/questions.json'),
    fetch('data/concept-fixes.json'),
  ]);
  state.questions = await questionsRes.json();
  state.conceptFixes = await fixesRes.json();
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
  const qs = filteredQuestions();
  if (qs.length === 0) {
    const msg = state.filter.due
      ? ['✨ All caught up!', 'No cards due right now — come back later, or tap Due again to turn it off and study anything.', 'celebrate']
      : state.filter.search
      ? ['Hmm, nothing matches', `Nothing for "${escape(state.filter.search)}". Try a different word or clear the search.`, 'sleep']
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
      <div class="card-question">${escape(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">You picked (wrong)${Array.isArray(q.wrong_picks) && q.wrong_picks.length > 1 ? ` — ${q.wrong_picks.length} different ways` : ''}</div>
          ${Array.isArray(q.wrong_picks) && q.wrong_picks.length > 1
            ? `<ul class="wrong-picks">${q.wrong_picks.map(w => `<li>${escape(w)}</li>`).join('')}</ul>`
            : `<p>${escape(q.wrong_pick)}</p>`}
        </div>
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
  $$('.q-options li.q-option').forEach(li => li.addEventListener('click', () => {
    if (state.revealed) return;
    state.selectedOption = li.dataset.option;
    haptic(5);
    rerender();
  }));
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
  const qs = filteredQuestions();
  if (qs.length === 0) {
    const msg = state.filter.due
      ? ['✨ All caught up!', 'Nothing due for Quiz — tap Due to turn it off and pick anything.', 'celebrate']
      : state.filter.search
      ? ['Hmm, nothing matches', `No match for "${escape(state.filter.search)}" — try another word.`, 'sleep']
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
      <div class="card-question">${escape(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">Common wrong pick${Array.isArray(q.wrong_picks) && q.wrong_picks.length > 1 ? `s (${q.wrong_picks.length})` : ''}</div>
          ${Array.isArray(q.wrong_picks) && q.wrong_picks.length > 1
            ? `<ul class="wrong-picks">${q.wrong_picks.map(w => `<li>${escape(w)}</li>`).join('')}</ul>`
            : `<p>${escape(q.wrong_pick)}</p>`}
        </div>
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

  const html = objs.map(obj => {
    const fix = state.conceptFixes[obj];
    return `
      <div class="obj-section">
        <h2>OBJ ${obj} — ${escape(fix.title)}</h2>
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
          <span>Text size</span>
          <span class="seg-control" data-pref="size">
            <button data-val="small" class="${pref('size')==='small'?'active':''}">S</button>
            <button data-val="medium" class="${pref('size')==='medium'?'active':''}">M</button>
            <button data-val="large" class="${pref('size')==='large'?'active':''}">L</button>
            <button data-val="xlarge" class="${pref('size')==='xlarge'?'active':''}">XL</button>
          </span>
        </div>
        <div class="settings-row">
          <span>Font</span>
          <span class="seg-control" data-pref="font">
            <button data-val="system" class="${pref('font')==='system'?'active':''}">System</button>
            <button data-val="atkinson" class="${pref('font')==='atkinson'?'active':''}">Atkinson</button>
            <button data-val="opendyslexic" class="${pref('font')==='opendyslexic'?'active':''}">OpenDyslexic</button>
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
          <span>Focus sound</span>
          <span class="seg-control" data-pref="sound">
            <button data-val="off" class="${pref('sound')==='off'?'active':''}">Off</button>
            <button data-val="white" class="${pref('sound')==='white'?'active':''}">White</button>
            <button data-val="pink" class="${pref('sound')==='pink'?'active':''}">Pink</button>
            <button data-val="brown" class="${pref('sound')==='brown'?'active':''}">Brown</button>
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

      <h3 class="stats-h">Cloud sync (Supabase)</h3>
      <div class="settings-panel">
        <div class="settings-stack">
          <label class="settings-vrow">
            <span class="settings-vlabel">Project URL</span>
            <input id="cloud-url" type="url" placeholder="https://xxxx.supabase.co" value="${escape(getCloudCfg().url)}">
          </label>
          <label class="settings-vrow">
            <span class="settings-vlabel">Anon key</span>
            <input id="cloud-key" type="password" placeholder="eyJ…" value="${escape(getCloudCfg().key)}">
          </label>
          <label class="settings-vrow">
            <span class="settings-vlabel">Sync key (any string you pick — same on every device)</span>
            <input id="cloud-sync" type="text" placeholder="amanda-aplus" value="${escape(getCloudCfg().syncKey)}">
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

      <button class="reset-btn" id="reset-btn">Reset all progress</button>
    </div>
  `;
  $('#reset-btn').addEventListener('click', async () => {
    if (confirm('Reset all study progress? This cannot be undone.')) {
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
  $$('.seg-control').forEach(group => {
    const key = group.dataset.pref;
    group.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      setPref(key, btn.dataset.val);
      if (key === 'sound') setSound(btn.dataset.val);
      renderStats();
    }));
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
    <div class="search-row">
      <input id="search-input" type="search" placeholder="Search question text…" value="${escape(state.filter.search)}" autocomplete="off">
      ${state.filter.search ? '<button id="search-clear" class="small-btn" aria-label="Clear search">✕</button>' : ''}
    </div>
    <div class="filter-bar">
      <button class="due-chip ${state.filter.due ? 'active' : ''}" data-filter="due">
        ${state.filter.due ? '✓ ' : ''}Due (${dueCount()})
      </button>
      <button class="${state.filter.obj === null ? 'active' : ''}" data-filter="all">All (${state.questions.length})</button>
      ${objs.map(o => `
        <button class="${state.filter.obj === o ? 'active' : ''}" data-filter="${o}">
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
          <img class="scratchpad-underlay" src="${escape(src)}" alt="Annotate">
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

// Drawings persist per question in IndexedDB.
async function loadDrawing(qid) {
  try { return (await idbGet('drawings', qid)) || null; } catch { return null; }
}
async function saveDrawing(qid, dataUrl) {
  try { await idbPut('drawings', qid, dataUrl); } catch (e) { console.warn('Save drawing failed', e); }
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
      `<img src="${escape(src)}" alt="Question figure" loading="lazy">`
    ).join('')}</div>`;
  }
  // PBQ with no image → make it clear it's missing
  if (q.qtype === 'PBQ') {
    return `<div class="q-image-missing">
      <strong>⚠️ Image not available.</strong>
      This PBQ references a figure from the original pretest. Drop a PNG/JPG at
      <code>images/${escape(q.id)}.png</code> and add <code>"image": "images/${escape(q.id)}.png"</code>
      to this question in <code>data/questions.json</code> to show it here.
      The explanation below still describes what was being asked.
    </div>`;
  }
  return '';
}

function renderOptionsHTML(q) {
  if (!Array.isArray(q.options) || q.options.length === 0) return '';
  const picked = state.selectedOption;
  const correct = q.correct_short;
  const isCorrect = (opt) => {
    if (!correct) return false;
    const a = opt.toLowerCase().trim().replace(/\s+/g, ' ');
    const b = correct.toLowerCase().trim().replace(/\s+/g, ' ');
    return a === b;
  };
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
  return `
    <ol class="q-options" type="A">
      ${q.options.map(opt =>
        `<li class="${cls(opt)}" data-option="${escape(opt)}">${escape(opt)}</li>`
      ).join('')}
    </ol>`;
}

//─── IN-APP QUESTION EDITOR ──────────────────────────────────
function renderEditFormHTML(q) {
  const optsText = (q.options || []).join('\n');
  const imgVal = q.image || (q.images && q.images[0]) || '';
  return `
    <div class="card edit-card">
      <h3 class="edit-title">Edit question <span class="edit-id">${escape(q.id)}</span></h3>
      <p class="edit-question">${escape(q.question)}</p>

      <label class="edit-field">
        <span class="edit-label">Multiple-choice options (one per line)</span>
        <textarea id="edit-options" rows="6" placeholder="Cable modem&#10;DSL&#10;ONT&#10;SDN">${escape(optsText)}</textarea>
        <span class="edit-hint">Tip: enter the four answer choices. Order doesn't matter — the app doesn't grade clicks.</span>
      </label>

      <label class="edit-field">
        <span class="edit-label">Image URL (PBQs)</span>
        <input id="edit-image" type="text" value="${escape(imgVal)}" placeholder="images/${escape(q.id)}.png or https://…">
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
function escape(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format a raw explanation blob into a scannable layout:
// - Strip redundant "OBJ X.X:" prefix (already shown as a tag)
// - Break into paragraphs (every 2 sentences) so it's not a wall of text
// - Pull "For the exam..." into its own callout at the bottom
// - Give the first paragraph a lead style so the answer stands out
function formatExplanation(text) {
  if (!text) return '';
  text = text.replace(/^OBJ \d+\.\d+:\s*/i, '').trim();

  let tip = '';
  const tipIdx = text.search(/For the exam[,:]?/i);
  if (tipIdx !== -1) {
    tip = text.slice(tipIdx).replace(/^For the exam[,:]?\s*/i, '').trim();
    text = text.slice(0, tipIdx).trim();
  }

  const mdBold = (s) => escape(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Split only at a space between a sentence-ending punctuation mark and the
  // next sentence's capital letter. Avoids breaking numbers like "2.4 GHz" or
  // "802.11g" — those decimals aren't followed by a capital letter.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);

  let body;
  if (sentences.length < 3) {
    body = `<p class="expl-lead">${mdBold(text)}</p>`;
  } else {
    const paras = [];
    for (let i = 0; i < sentences.length; i += 2) {
      paras.push(sentences.slice(i, i + 2).join(' ').trim());
    }
    body = paras.map((p, i) =>
      `<p class="${i === 0 ? 'expl-lead' : 'expl-para'}">${mdBold(p)}</p>`
    ).join('');
  }

  if (tip) {
    body += `<div class="expl-tip"><strong>💡 For the exam</strong><p>${mdBold(tip)}</p></div>`;
  }
  return body;
}

function emptyHTML(title, sub, mood = 'sleep') {
  return `<div class="empty-state">
    <div class="empty-mascot">${MASCOT(mood)}</div>
    <h3>${title}</h3>
    <p>${sub}</p>
  </div>`;
}

//─── ROUTING ─────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  state.currentIndex = 0;
  state.revealed = false;
  state.editing = false;
  state.selectedOption = null;
  state.history = [];
  state._shuffleCache = null;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
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
  if (btn) btn.textContent = state.focus ? '🔓' : '🔒';
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
      alert('Progress imported.');
    } catch (e) {
      alert('Import failed: ' + e.message);
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
      alert('Overrides imported.');
    } catch (e) {
      alert('Import failed: ' + e.message);
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

async function cloudPush() {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const body = JSON.stringify({
    sync_key: syncKey,
    data: { progress: state.progress, overrides: state.overrides, version: 1 },
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

async function cloudPull({ merge = true } = {}) {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const res = await fetch(`${url}/rest/v1/progress?sync_key=eq.${encodeURIComponent(syncKey)}&select=data,updated_at`, {
    headers: cloudHeaders(key),
  });
  if (!res.ok) throw new Error(`Pull ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`No row found for sync key "${syncKey}"`);
  const data = rows[0].data || {};
  const cloudProgress = data.progress || {};
  const cloudOverrides = data.overrides || {};

  if (merge) {
    // Per-card last-write-wins: keep whichever side has a newer updated_at
    for (const [id, cloudP] of Object.entries(cloudProgress)) {
      const localP = state.progress[id];
      if (!localP) { state.progress[id] = cloudP; continue; }
      const cTime = cloudP.updated_at || cloudP.lastSeen || 0;
      const lTime = localP.updated_at || localP.lastSeen || 0;
      if (cTime > lTime) state.progress[id] = cloudP;
    }
    // Overrides: prefer whichever has more fields (naive — rare to edit same card in two places concurrently)
    for (const [id, cloudO] of Object.entries(cloudOverrides)) {
      const localO = state.overrides[id];
      if (!localO || Object.keys(cloudO).length > Object.keys(localO).length) {
        state.overrides[id] = cloudO;
      }
    }
  } else {
    state.progress = cloudProgress;
    state.overrides = cloudOverrides;
  }

  // Re-apply defaults/migrations for any card the cloud didn't cover
  for (const q of state.questions) {
    if (!state.progress[q.id]) state.progress[q.id] = defaultProgress();
    else migrateProgress(state.progress[q.id]);
  }
  await saveProgress();
  await saveOverrides();
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
        } else {
          // When revealed: space/enter advances with a neutral "good" rating
          const qs = filteredQuestions();
          if (qs.length > 0) {
            const q = qs[state.currentIndex];
            if (state.mode === 'study') {
              recordRating(q.id, 'good');
              nextQuestion();
            } else {
              const p = state.progress[q.id];
              p.seen++; p.lastSeen = Date.now(); p.updated_at = p.lastSeen; p.correct++;
              schedule(p, 'good');
              haptic(10); saveProgress(); onCardRated(q.id);
              nextQuizQuestion();
            }
          }
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
    <div id="welcome-overlay">
      <div class="welcome-card">
        <button class="welcome-close" id="welcome-close" aria-label="Close">✕</button>
        <div class="welcome-mascot">${MASCOT(returningUser && streak.count > 0 ? 'celebrate' : 'wave')}</div>
        <h2>${greeting}</h2>
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
  document.body.insertAdjacentHTML('beforeend', html);

  const overlay = $('#welcome-overlay');
  const close = (action) => {
    const dismissPerm = $('#welcome-dismiss-permanent')?.checked;
    if (dismissPerm) localStorage.setItem('welcomeDismissed', '1');
    overlay.remove();
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
  // Esc closes
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && $('#welcome-overlay')) {
      close(null);
      document.removeEventListener('keydown', escClose);
    }
  });
}

async function init() {
  // Prefs / theme / shuffle all load before any render so first paint is correct
  applyPrefs();
  setTheme(localStorage.getItem('theme') || 'auto');
  state.shuffle = localStorage.getItem('shuffle') === 'true';
  if (pref('sound') !== 'off') setSound(pref('sound'));  // ambient noise restores (needs gesture on some browsers)
  if (pref('shake') === 'on') enableShake().catch(() => {});

  $('#theme-btn')?.addEventListener('click', cycleTheme);
  $('#focus-btn')?.addEventListener('click', toggleFocus);
  $('#help-btn')?.addEventListener('click', showWelcome);

  try {
    await loadData();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><h3>Couldn't load data</h3><p>${escape(e.message)}</p></div>`;
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

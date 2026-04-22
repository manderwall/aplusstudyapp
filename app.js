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
  editing: false,  // when true, render the edit form instead of the question card
  history: [],     // stack of previous currentIndex values for Prev nav
  shuffle: false,
  _shuffleCache: null,  // { key, list }
  progress: {},    // { questionId: { status, seen, correct, lastSeen, ease, interval, due } }
  overrides: {},   // { questionId: { options?, image?, images? } } — user-added content
};

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
  if (navigator.vibrate) navigator.vibrate(pattern);
}

//─── INDEXEDDB (progress + overrides persistence) ────────────
const DB_NAME = 'aplus-study';
const DB_VERSION = 2;
const STORE = 'progress';
const OSTORE = 'overrides';   // per-question edits: { [qid]: {options?, image?, images?} }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(OSTORE)) db.createObjectStore(OSTORE);
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

function updateHUD() {
  const qs = filteredQuestions();
  const total = qs.length;
  const idx = state.currentIndex + 1;
  const parts = total > 0 ? [`${Math.min(idx, total)} / ${total}`] : [`0 / 0`];
  if (!state.filter.due) parts.push(`${dueCount()} due`);
  $('#progress-hud').textContent = parts.join(' · ');
}

//─── MODE: STUDY (flashcards with self-rating) ──────────────
function renderStudy() {
  $('#mode-title').textContent = 'Study';
  const qs = filteredQuestions();
  if (qs.length === 0) {
    $('#main').innerHTML = emptyHTML('No questions', 'Pick an objective below or clear the filter.');
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
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        <span class="tag">P${q.pretest} Q${q.qnum}</span>
        ${prog.seen > 0 ? `<span class="tag">Seen ${prog.seen}×</span>` : ''}
        ${edited ? '<span class="tag edited">✏️ Edited</span>' : ''}
        <button class="tag tag-btn" id="edit-btn" title="Add/edit options and image">✏️ Edit</button>
      </div>
      <div class="card-question">${escape(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">You picked (wrong)</div>
          <p>${escape(q.wrong_pick)}</p>
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
    ${renderScratchpadHTML()}
  `;
  renderFilterBar();
  updateHUD();
  attachStudyEvents(q);
  attachScratchpadEvents();
  $('#edit-btn')?.addEventListener('click', () => { state.editing = true; renderStudy(); });
}

function attachStudyEvents(q) {
  const reveal = $('#reveal-btn');
  if (reveal) reveal.addEventListener('click', () => { state.revealed = true; renderStudy(); });
  const skip = $('#skip-btn');
  if (skip) skip.addEventListener('click', () => { nextQuestion(); });
  const prev = $('#prev-btn');
  if (prev) prev.addEventListener('click', () => { prevQuestion(); });
  $$('[data-rate]').forEach(btn => btn.addEventListener('click', () => {
    const rate = btn.dataset.rate;
    recordRating(q.id, rate);
    nextQuestion();
  }));
}

function recordRating(qid, rate) {
  const p = state.progress[qid];
  p.seen++;
  p.lastSeen = Date.now();
  if (rate === 'good' || rate === 'easy') p.correct++;
  schedule(p, rate);
  haptic(10);
  saveProgress();
}

function nextQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  if (qs.length === 0) { renderStudy(); return; }
  state.history.push(state.currentIndex);
  if (state.history.length > 50) state.history.shift();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  renderStudy();
}

function prevQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
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
    $('#main').innerHTML = emptyHTML('No questions', 'Pick an objective or clear the filter.');
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
  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        ${accuracy !== null ? `<span class="tag">${accuracy}% (${prog.correct}/${prog.seen})</span>` : ''}
        ${edited ? '<span class="tag edited">✏️ Edited</span>' : ''}
        <button class="tag tag-btn" id="edit-btn" title="Add/edit options and image">✏️ Edit</button>
      </div>
      <div class="card-question">${escape(q.question)}</div>
      ${renderImageHTML(q)}
      ${renderOptionsHTML(q)}
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">Common wrong pick</div>
          <p>${escape(q.wrong_pick)}</p>
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
    ${renderScratchpadHTML()}
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
  $$('[data-qa]').forEach(btn => btn.addEventListener('click', () => {
    const right = btn.dataset.qa === 'right';
    const p = state.progress[q.id];
    p.seen++;
    p.lastSeen = Date.now();
    if (right) p.correct++;
    schedule(p, right ? 'good' : 'again');
    haptic(10);
    saveProgress();
    nextQuizQuestion();
  }));
  attachScratchpadEvents();
}

function nextQuizQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
  if (qs.length === 0) { renderQuiz(); return; }
  state.history.push(state.currentIndex);
  if (state.history.length > 50) state.history.shift();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  renderQuiz();
}

function prevQuizQuestion() {
  const qs = filteredQuestions();
  state.revealed = false;
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

  $('#main').innerHTML = `
    <div class="stats-wrap">
      <div class="stats-row">
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

      <h3 class="stats-h">Mastery by Objective</h3>
      <div class="obj-bar-list">
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
      state.history = [];
      state._shuffleCache = null;
      if (state.mode === 'study') renderStudy();
      else if (state.mode === 'quiz') renderQuiz();
    });
  }
}

//─── SCRATCH PAD (Apple Pencil) ──────────────────────────────
function renderScratchpadHTML() {
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

function attachScratchpadEvents() {
  const canvas = $('#scratchpad');
  if (!canvas) return;
  // Resize canvas to actual pixel size for sharp lines
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
  };
  resize();

  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--text');

  let drawing = false;
  let lastX = 0, lastY = 0;
  let mode = 'pen';

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
  });

  function getXY(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (e) => {
    // Ignore touch if a pen is in use nearby; allow pen OR finger
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getXY(e);
    lastX = x; lastY = y;
    // Pressure from Apple Pencil
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

  const stop = () => { drawing = false; };
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
  return `
    <ol class="q-options" type="A">
      ${q.options.map(opt => `<li>${escape(opt)}</li>`).join('')}
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

function emptyHTML(title, sub) {
  return `<div class="empty-state">
    <div class="icon">📭</div>
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
  state.history = [];
  state._shuffleCache = null;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  if (mode === 'study') renderStudy();
  else if (mode === 'quiz') renderQuiz();
  else if (mode === 'reading') renderReading();
  else if (mode === 'stats') renderStats();
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

async function cloudPull() {
  const { url, key, syncKey } = getCloudCfg();
  if (!url || !key || !syncKey) throw new Error('Set Supabase URL, anon key, and sync key first');
  const res = await fetch(`${url}/rest/v1/progress?sync_key=eq.${encodeURIComponent(syncKey)}&select=data,updated_at`, {
    headers: cloudHeaders(key),
  });
  if (!res.ok) throw new Error(`Pull ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`No row found for sync key "${syncKey}"`);
  const data = rows[0].data || {};
  if (data.progress) state.progress = data.progress;
  if (data.overrides) state.overrides = data.overrides;
  // Re-apply migrations so missing fields don't break the UI
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

    // Global: theme toggle
    if (key === 't') { e.preventDefault(); cycleTheme(); return; }

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
              p.seen++; p.lastSeen = Date.now(); p.correct++;
              schedule(p, 'good');
              haptic(10); saveProgress();
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
async function init() {
  // Theme + shuffle prefs load before any render so first paint is correct
  setTheme(localStorage.getItem('theme') || 'auto');
  state.shuffle = localStorage.getItem('shuffle') === 'true';

  $('#theme-btn')?.addEventListener('click', cycleTheme);

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

  // Register service worker for offline
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed:', err));
  }
}

init();

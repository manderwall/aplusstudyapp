// A+ Study — single-file PWA logic
// Modules: State, DB, Study, Quiz, Reading, Stats, ScratchPad, Router

//─── GLOBAL STATE ────────────────────────────────────────────
const state = {
  questions: [],
  conceptFixes: {},
  mode: 'study',
  filter: { obj: null },
  currentIndex: 0,
  revealed: false,
  reviewSet: [],   // question IDs in the current review session
  progress: {},    // { questionId: { status: 'new'|'learning'|'good', seen: N, correct: N, lastSeen: ts } }
};

//─── INDEXEDDB (progress persistence) ────────────────────────
const DB_NAME = 'aplus-study';
const DB_VERSION = 1;
const STORE = 'progress';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadProgress() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('all');
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => resolve({});
    });
  } catch { return {}; }
}

async function saveProgress() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(state.progress, 'all');
  } catch (e) { console.warn('Save failed', e); }
}

async function clearProgress() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    state.progress = {};
  } catch (e) { console.warn('Clear failed', e); }
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
  // Initialize progress for any new question
  for (const q of state.questions) {
    if (!state.progress[q.id]) {
      state.progress[q.id] = { status: 'new', seen: 0, correct: 0, lastSeen: 0 };
    }
  }
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

function filteredQuestions() {
  let qs = state.questions.slice();
  if (state.filter.obj) qs = qs.filter(q => q.obj === state.filter.obj);
  return qs;
}

function updateHUD() {
  const qs = filteredQuestions();
  const total = qs.length;
  const idx = state.currentIndex + 1;
  $('#progress-hud').textContent = `${Math.min(idx, total)} / ${total}`;
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
  const q = qs[state.currentIndex];
  const prog = state.progress[q.id];

  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        <span class="tag">P${q.pretest} Q${q.qnum}</span>
        ${prog.seen > 0 ? `<span class="tag">Seen ${prog.seen}×</span>` : ''}
      </div>
      <div class="card-question">${escape(q.question)}</div>
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">You picked (wrong)</div>
          <p>${escape(q.wrong_pick)}</p>
        </div>
        <div class="card-section right">
          <div class="label">Correct answer & explanation</div>
          <p>${formatExplanation(q.explanation)}</p>
        </div>
        <div class="btn-row">
          <button class="action bad" data-rate="again">Again</button>
          <button class="action warn" data-rate="hard">Hard</button>
          <button class="action good" data-rate="good">Good</button>
          <button class="action primary" data-rate="easy">Easy</button>
        </div>
      ` : `
        <div class="btn-row">
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
}

function attachStudyEvents(q) {
  const reveal = $('#reveal-btn');
  if (reveal) reveal.addEventListener('click', () => { state.revealed = true; renderStudy(); });
  const skip = $('#skip-btn');
  if (skip) skip.addEventListener('click', () => { nextQuestion(); });
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
  if (rate === 'easy') p.status = 'good';
  else if (rate === 'good') p.status = p.status === 'new' ? 'learning' : 'good';
  else if (rate === 'hard') p.status = 'learning';
  else if (rate === 'again') p.status = 'learning';
  saveProgress();
}

function nextQuestion() {
  const qs = filteredQuestions();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  state.revealed = false;
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
  const q = qs[state.currentIndex];
  const prog = state.progress[q.id];
  const accuracy = prog.seen > 0 ? Math.round((prog.correct / prog.seen) * 100) : null;

  $('#main').innerHTML = `
    ${filterBarHTML()}
    <div class="card">
      <div class="card-meta">
        <span class="tag obj">OBJ ${q.obj}</span>
        ${q.qtype === 'PBQ' ? '<span class="tag pbq">PBQ</span>' : `<span class="tag">${q.qtype}</span>`}
        ${accuracy !== null ? `<span class="tag">${accuracy}% (${prog.correct}/${prog.seen})</span>` : ''}
      </div>
      <div class="card-question">${escape(q.question)}</div>
      ${state.revealed ? `
        <div class="card-section wrong">
          <div class="label">Common wrong pick</div>
          <p>${escape(q.wrong_pick)}</p>
        </div>
        <div class="card-section right">
          <div class="label">Correct answer & explanation</div>
          <p>${formatExplanation(q.explanation)}</p>
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
  $$('[data-qa]').forEach(btn => btn.addEventListener('click', () => {
    const right = btn.dataset.qa === 'right';
    const p = state.progress[q.id];
    p.seen++;
    p.lastSeen = Date.now();
    if (right) p.correct++;
    if (right) p.status = p.status === 'new' ? 'learning' : 'good';
    saveProgress();
    nextQuizQuestion();
  }));
  attachScratchpadEvents();
}

function nextQuizQuestion() {
  const qs = filteredQuestions();
  state.currentIndex = (state.currentIndex + 1) % qs.length;
  state.revealed = false;
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

      <h3 style="margin: 20px 0 12px; font-size: 16px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px;">Mastery by Objective</h3>
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

      <button class="reset-btn" id="reset-btn">Reset all progress</button>
    </div>
  `;
  $('#reset-btn').addEventListener('click', async () => {
    if (confirm('Reset all study progress? This cannot be undone.')) {
      await clearProgress();
      for (const q of state.questions) {
        state.progress[q.id] = { status: 'new', seen: 0, correct: 0, lastSeen: 0 };
      }
      renderStats();
    }
  });
}

//─── FILTER BAR (shared by Study + Quiz) ─────────────────────
function filterBarHTML() {
  const objs = uniqueObjs();
  const counts = {};
  for (const o of objs) counts[o] = state.questions.filter(q => q.obj === o).length;
  return `
    <div class="filter-bar">
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
    state.filter.obj = f === 'all' ? null : f;
    state.currentIndex = 0;
    state.revealed = false;
    if (state.mode === 'study') renderStudy();
    else if (state.mode === 'quiz') renderQuiz();
  }));
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

//─── HELPERS ─────────────────────────────────────────────────
function escape(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatExplanation(text) {
  if (!text) return '';
  // Let **bold** and simple markdown through
  let html = escape(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
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
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  if (mode === 'study') renderStudy();
  else if (mode === 'quiz') renderQuiz();
  else if (mode === 'reading') renderReading();
  else if (mode === 'stats') renderStats();
}

//─── INIT ────────────────────────────────────────────────────
async function init() {
  try {
    await loadData();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><h3>Couldn't load data</h3><p>${escape(e.message)}</p></div>`;
    return;
  }
  $$('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
  setMode('study');

  // Register service worker for offline
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed:', err));
  }
}

init();

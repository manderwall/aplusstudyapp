// storage.mjs — the persistence layer: IndexedDB primitives, at-rest
// encryption glue, and the per-exam load/save helpers for progress,
// overrides, and the exam-outcome log. Imports only core (state, toast) and
// crypto; everything above it (features, render) imports from here, so the
// dependency arrow points one way and there's no cycle back into app.js.

import { state, toast } from './core.mjs';
import { encryptJSON, decryptJSON, isEncryptedBlob } from './crypto.mjs';

export const DB_NAME = 'aplus-study';
export const DB_VERSION = 5;
export const STORE = 'progress';
export const OSTORE = 'overrides';   // per-question edits: { [qid]: {options?, image?, images?} }
export const DSTORE = 'drawings';    // per-question scratchpad canvas PNGs (base64 dataURL)
export const RSTORE = 'reference';   // user's reference book PDF (per-exam): { blob, name, size, pageCount, uploadedAt, pageText? }
export const ESTORE = 'examEvents';  // outcome-loop log: { [examEventId]: ExamEvent }. PR #67. See ExamEvent shape comment near loadExamEvents().

export function openDB() {
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

export function idbGet(store, key) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  }));
}

export function idbPut(store, key, value) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

export function idbDelete(store, key) {
  return openDB().then(db => new Promise(resolve => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

//─── AT-REST ENCRYPTION GLUE ─────────────────────────────────
// The derived key is held in memory only (state._cryptoKey) for the current
// session; closing the app drops it and requires re-unlock.
export async function maybeEncrypt(obj) {
  return state._cryptoKey ? encryptJSON(state._cryptoKey, obj) : obj;
}
export async function maybeDecrypt(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (!isEncryptedBlob(raw)) return raw;
  if (!state._cryptoKey) throw new Error('locked');
  return decryptJSON(state._cryptoKey, raw);
}

// Per-exam keys so each exam's progress lives in its own slot.
export async function loadProgress(examId = state.exam) {
  try {
    const raw = await idbGet(STORE, examId);
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
// One-time-per-session warning so the user knows their FSRS progress
// stopped persisting (IDB blocked, quota exhausted, etc.) instead of
// silently studying with ratings that won't survive a tab close.
let _idbFailToasted = false;
export async function saveProgress(examId = state.exam) {
  try { await idbPut(STORE, examId, await maybeEncrypt(state.progress)); }
  catch (e) {
    console.warn('Save progress failed', e);
    if (!_idbFailToasted) {
      _idbFailToasted = true;
      try { toast('Couldn\'t save progress to device storage. Ratings may not persist after closing.', 'error', 6000); } catch {}
    }
  }
}
export async function clearProgress(examId = state.exam) {
  try {
    await idbDelete(STORE, examId);
    state.progress = {};
  } catch (e) { console.warn('Clear failed', e); }
}

export async function loadOverrides(examId = state.exam) {
  try {
    const raw = await idbGet(OSTORE, examId);
    return (await maybeDecrypt(raw, {})) || {};
  } catch (e) { if (e.message === 'locked') throw e; return {}; }
}
export async function saveOverrides(examId = state.exam) {
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
export async function loadExamEvents(examId = state.exam) {
  try {
    const raw = await idbGet(ESTORE, examId);
    return (await maybeDecrypt(raw, [])) || [];
  } catch (e) { if (e.message === 'locked') throw e; return []; }
}
export async function saveExamEvents(events, examId = state.exam) {
  try { await idbPut(ESTORE, examId, await maybeEncrypt(events)); }
  catch (e) { console.warn('Save exam events failed', e); }
}

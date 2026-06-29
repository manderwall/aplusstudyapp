// Pure helpers shared by app.js and tests/. Keep this module side-effect-free
// so the test runner can import it directly without a DOM.

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;
export const MAX_INTERVAL_DAYS = 30;  // default cap when no exam date is set

// ─── FSRS-4 spaced-repetition scheduler ─────────────────────────────────
// FSRS = Free Spaced Repetition Scheduler. Replaces the hand-tuned SM-2
// math that was here previously. Why the swap:
//   - SM-2's `ease` factor decays on Again/Hard and never recovers
//     fully — a noisy week of mis-rates depresses a known card for the
//     rest of its life ("ease hell").
//   - SM-2 treats every Good the same regardless of how mature the card
//     is. FSRS uses a two-dimensional (Difficulty, Stability) memory
//     model where the next interval scales with the card's CURRENT
//     stability + how confident the user was, giving longer steps for
//     well-known cards and not punishing fresh-card slips.
//   - FSRS is the algorithm Anki adopted as the default scheduler in
//     2024 after benchmarking against millions of real reviews.
//
// We use FSRS-4 (17 default weights) — the most-tested public variant.
// FSRS-5 adds 2 more weights for short-term scheduling; minor accuracy
// gain not worth the extra complexity for an exam-prep horizon (<1-3 mo).
//
// Per-card state:
//   p.D   - difficulty in [1, 10] (10 = hardest)
//   p.S   - stability in days (memory half-life at retention=0.9)
//   p.lastReviewedAt - epoch ms of the last review (for retrievability)
//
// Backward-compat fields kept on every progress row so existing UI
// reading p.interval / p.due / p.ease still works:
//   p.interval - next interval in days (derived from S + target retention)
//   p.due      - epoch ms when card becomes due (derived)
//   p.ease     - SM-2 ease, derived from D for code paths that still read it
//
// Existing rows missing FSRS state are migrated lazily by initFsrsFromLegacy.

// FSRS-4 default weights (anki-bench tuned, public domain).
export const FSRS_W = [
  0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14,
  0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61,
];
// Target retention used when solving for the next interval. The caller
// (recordRating in app.js) can override this per-rate based on how
// close the exam is — see EXAM_RETENTION_SCHEDULE in app.js.
export const FSRS_TARGET_RETENTION = 0.9;
// Forgetting curve: R(t) = (1 + t/(9·S))^DECAY.
//
// This is canonical FSRS-4: with DECAY = -1, the interval where R hits
// 0.9 is exactly S (stability days). Prior to PR #65 this was an
// accidental hybrid (-0.5 exponent / 9S denominator) that produced
// ~2.11·S intervals — effective retention ~0.81, not the 0.9 the
// constant implied. Fixed per the deep-research synthesis (Cepeda 2008
// ratio rule + FSRS community consensus for short-horizon exam prep).
const FSRS_DECAY = -1;

// Helpers
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const gradeToG = (rate) => ({ again: 1, hard: 2, good: 3, easy: 4 }[rate] || 3);

// Forgetting curve: probability of recall after `days` since last review.
export function fsrsRetrievability(days, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + days / (9 * stability), FSRS_DECAY);
}

// Days until retention drops to the target.
// Derivation: R(t) = (1 + t/(9S))^DECAY → t = 9S · (R^(1/DECAY) - 1).
// With DECAY = -1 and r = 0.9: t = 9S · (1/0.9 - 1) = S exactly.
// With DECAY = -1 and r = 0.95: t ≈ S · 0.474 (~halves the interval).
// With DECAY = -1 and r = 0.97: t ≈ S · 0.278.
export function fsrsNextIntervalDays(stability, retention = FSRS_TARGET_RETENTION) {
  if (stability <= 0) return 0;
  const i = 9 * stability * (Math.pow(retention, 1 / FSRS_DECAY) - 1);
  return Math.max(1, i);
}

function initDifficulty(G) {
  // D₀(G) = w[4] - exp(w[5] · (G-1)) + 1
  return clamp(FSRS_W[4] - Math.exp(FSRS_W[5] * (G - 1)) + 1, 1, 10);
}
function initStability(G) {
  // S₀(G) = w[G-1]
  return Math.max(0.1, FSRS_W[G - 1]);
}
function nextDifficulty(D, G) {
  // ΔD = -w[6]·(G-3); blend toward D₀(4) (the "easy" anchor) by w[7]
  const dPrime = D - FSRS_W[6] * (G - 3);
  return clamp(FSRS_W[7] * initDifficulty(4) + (1 - FSRS_W[7]) * dPrime, 1, 10);
}
function nextStabilityOnSuccess(D, S, R, G) {
  // S' = S · (e^w[8] · (11-D) · S^(-w[9]) · (e^(w[10]·(1-R)) - 1) · hardPenalty · easyBonus + 1)
  const hardPenalty = G === 2 ? FSRS_W[15] : 1;
  const easyBonus   = G === 4 ? FSRS_W[16] : 1;
  const factor = Math.exp(FSRS_W[8]) *
                 (11 - D) *
                 Math.pow(S, -FSRS_W[9]) *
                 (Math.exp(FSRS_W[10] * (1 - R)) - 1) *
                 hardPenalty * easyBonus;
  return Math.max(0.1, S * (factor + 1));
}
function nextStabilityOnLapse(D, S, R) {
  // S' = w[11] · D^(-w[12]) · ((S+1)^w[13] - 1) · e^(w[14]·(1-R))
  return Math.max(0.1, FSRS_W[11] *
    Math.pow(D, -FSRS_W[12]) *
    (Math.pow(S + 1, FSRS_W[13]) - 1) *
    Math.exp(FSRS_W[14] * (1 - R)));
}

// One-shot migration from SM-2 (ease, interval) → FSRS (D, S). Called
// lazily the first time a legacy row hits the scheduler so saved
// progress isn't lost. The mapping is approximate by design: FSRS
// re-learns the card's true difficulty over the next ~3 reviews.
//
// Defensive: sanitizes pathological inputs (NaN, Infinity, negatives)
// because real-user IDB-loaded rows can have weird values from old
// app versions, partial Supabase syncs, or corrupted localStorage
// imports. Clamps the derived S to a reasonable upper bound so a
// massive legacy interval (e.g. interval = 365 from a card that was
// last reviewed before the 30-day cap existed) doesn't produce a
// 700-day next-review estimate.
const MIGRATION_S_CAP = 90;  // days. Larger than MAX_INTERVAL_DAYS so
// users with an explicit exam date set well into the future still get
// meaningful spacing on imported mature cards.
function initFsrsFromLegacy(p) {
  if (Number.isFinite(p.S) && Number.isFinite(p.D)) return;  // already FSRS
  // Sanitize legacy fields. Number() coerces strings (from JSON round-trips)
  // and NaN-checks catch corrupted values. Falls back to defaults when invalid.
  let ease = Number(p.ease);
  if (!Number.isFinite(ease) || ease <= 0) ease = 2.5;
  let interval = Number(p.interval);
  if (!Number.isFinite(interval) || interval < 0) interval = 0;
  if (interval > 0) {
    // Card has been seen at least once. Use interval as a stability proxy
    // (since SM-2 intervals ≈ FSRS S at r=0.9 reasonably well), and map
    // ease into the [1,10] difficulty band.
    p.S = clamp(Math.max(0.5, interval), 0.5, MIGRATION_S_CAP);
    // ease 1.3 → D 10 (hardest); ease 3.0 → D 1 (easiest). Linear-ish.
    p.D = clamp(10 - (ease - 1.3) * 9 / 1.7, 1, 10);
  } else {
    // Brand-new card: leave S/D unset so the first rating uses init values.
    p.S = undefined;
    p.D = undefined;
  }
}

export function defaultProgress() {
  return {
    status: 'new', seen: 0, correct: 0, lastSeen: 0, due: 0,
    // FSRS fields — undefined until first rating
    S: undefined, D: undefined, lastReviewedAt: 0,
    // Legacy SM-2 fields kept for backward-compat reads
    ease: 2.5, interval: 0,
  };
}

export function migrateProgress(p) {
  if (p.ease === undefined) p.ease = 2.5;
  if (p.interval === undefined) p.interval = 0;
  if (p.due === undefined) p.due = 0;
  if (p.lastReviewedAt === undefined) p.lastReviewedAt = p.lastSeen || 0;
  // Lazy FSRS init — runs once per row, idempotent for already-migrated rows.
  initFsrsFromLegacy(p);
  return p;
}

export function schedule(p, rate, now = Date.now(), capDays = MAX_INTERVAL_DAYS, targetRetention = FSRS_TARGET_RETENTION) {
  // Coerce + sanitize `now`. A non-finite or string-typed `now` (which
  // can happen if the caller pulled a timestamp from a corrupted sync
  // payload or a future refactor passes state.now through) would otherwise
  // propagate into p.due as NaN/Infinity/string-concatenation — breaking
  // every downstream due/sort check. Default to wall-clock.
  let _now = Number(now);
  if (!Number.isFinite(_now) || _now <= 0) _now = Date.now();
  now = _now;
  // Effective interval cap. Floored at 1 so cards always come back at
  // least once, even with an exam tomorrow.
  const cap = Math.max(1, capDays || MAX_INTERVAL_DAYS);
  const G = gradeToG(rate);

  // First rating for this card: initialize FSRS state from G alone.
  if (!Number.isFinite(p.S) || !Number.isFinite(p.D)) {
    initFsrsFromLegacy(p);
  }
  if (!Number.isFinite(p.S)) {
    p.S = initStability(G);
    p.D = initDifficulty(G);
  } else {
    const elapsedDays = p.lastReviewedAt > 0 ? Math.max(0, (now - p.lastReviewedAt) / DAY) : 0;
    const R = fsrsRetrievability(elapsedDays, p.S);
    if (G === 1) {
      // Lapse: stability collapses (but is preserved across the floor).
      p.S = nextStabilityOnLapse(p.D, p.S, R);
    } else {
      p.S = nextStabilityOnSuccess(p.D, p.S, R, G);
    }
    p.D = nextDifficulty(p.D, G);
  }
  // Post-update sanity: cap S, clamp D. Belt-and-suspenders against any
  // FSRS formula producing NaN/Infinity from pathological inputs (e.g.
  // R=0 + extreme D), and against runaway stability when the user
  // chains many Easies on a card the migration over-estimated.
  if (!Number.isFinite(p.S) || p.S <= 0) p.S = initStability(G);
  if (!Number.isFinite(p.D)) p.D = initDifficulty(G);
  p.S = Math.min(p.S, MIGRATION_S_CAP * 4);  // 360-day stability ceiling
  p.D = clamp(p.D, 1, 10);

  // Map the new stability into a due time.
  if (G === 1) {
    // Lapsed: 1-minute relearning step regardless of stability.
    p.due = now + MIN;
    p.status = 'learning';
    p.interval = 0;
  } else if (p.S < 1) {
    // Card is still being learned — schedule in minutes, not days.
    const subDayDays = Math.max(MIN / DAY, p.S);
    p.due = now + subDayDays * DAY;
    p.interval = Math.round(subDayDays * 10) / 10;
    p.status = p.status === 'new' ? 'learning' : p.status;
  } else {
    const intervalDays = Math.min(cap, fsrsNextIntervalDays(p.S, targetRetention));
    p.due = now + intervalDays * DAY;
    p.interval = Math.round(intervalDays * 10) / 10;
    p.status = p.status === 'new' ? 'learning' : (G >= 3 ? 'good' : 'learning');
  }
  p.lastReviewedAt = now;
  // p.ease is the only legacy field updateLegacyFields still has to set.
  p.ease = clamp(10 - p.D, 1.3, 3.0);
  return p;
}

export function escapeHtml(s) {
  if (s == null || s === '' || s === false) return '';
  // Coerce non-string inputs (numbers, booleans, BigInt, accidental objects)
  // before .replace. Without this, e.g. a content PR shipping
  // `options: ["a", 42, "b"]` would crash the renderer with "s.replace is
  // not a function" instead of just stringifying 42 to "42". Data validator
  // should catch malformed files; this is defense in depth.
  const str = typeof s === 'string' ? s : String(s);
  // Escape quotes too — otherwise an option like 9.6" x 9.6" injected into
  // data-option="..." terminates the attribute early and the click handler
  // reads back a truncated value, breaking option matching.
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function normalizeOption(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

//─── URL SAFETY ──────────────────────────────────────────────
// Pure predicates that gate where the app will load remote content from —
// defense in depth against a content PR smuggling an http:// tracking pixel
// or a javascript: "learn more" link. Kept here (pure, no DOM) so any module
// that renders question content can import them and they stay unit-testable.
export function isSafeLearnMoreUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return false;
  try { return /^https?:$/i.test(new URL(u).protocol); }
  catch { return false; }
}
export function isSafeImageSrc(u) {
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

// Return a stable shuffled copy of options for a given question ID.
// Using the ID as a seed means the order is always the same for the same
// card (so Prev → card looks the same as the first visit), but differs
// between cards so the correct answer isn't always in the same slot.
export function shuffleOptionsForCard(options, qid) {
  if (!Array.isArray(options) || options.length < 2) return options;
  // Hash the string ID into a 32-bit integer seed
  let h = 0x811c9dc5;
  for (let i = 0; i < qid.length; i++) {
    h ^= qid.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  const rng = rngFromSeed(h);
  const out = options.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Deterministic mulberry32 PRNG so a given seed produces the same card order
// within a session (stable Prev/Next) but a different order next session.
export function rngFromSeed(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Smart SRS ordering: due cards first (most overdue first), then new cards,
// then young/learning cards not yet due. Randomized within each tier so the
// user doesn't memorize card position. `mode` = 'smart' | 'random' | 'sequential'.
export function orderDeck(qs, progressById, { mode = 'smart', seed = 1, now = Date.now() } = {}) {
  if (mode === 'sequential') return qs.slice();
  const rng = rngFromSeed(seed);
  if (mode === 'random') return shuffleInPlace(qs.slice(), rng);

  const due = [];
  const fresh = [];
  const young = [];
  for (const q of qs) {
    const p = progressById[q.id] || {};
    const seen = p.seen || 0;
    const dueAt = p.due || 0;
    if (seen === 0) fresh.push(q);
    else if (dueAt <= now) due.push({ q, dueAt });
    else young.push({ q, dueAt });
  }
  // Overdue-first: smaller due timestamp = more overdue. Random tiebreak.
  due.sort((a, b) => (a.dueAt - b.dueAt) || (rng() - 0.5));
  young.sort((a, b) => (a.dueAt - b.dueAt) || (rng() - 0.5));
  shuffleInPlace(fresh, rng);
  return [...due.map(x => x.q), ...fresh, ...young.map(x => x.q)];
}

// Human-readable label for what tapping each rating button will do.
// Used in the rating UI so the learner knows "Good = 1 day" etc.
export function nextIntervalLabel(p, rate, now = Date.now(), capDays, targetRetention) {
  const sim = { ...p };
  if (sim.ease === undefined) sim.ease = 2.5;
  if (sim.interval === undefined) sim.interval = 0;
  schedule(sim, rate, now, capDays, targetRetention);
  const ms = sim.due - now;
  if (ms < 60 * 1000) return '<1 min';
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)} min`;
  const days = ms / DAY;
  if (days < 1) return `${Math.round(ms / (60 * MIN))} hr`;
  if (days < 1.5) return '1 day';
  // Whole days render without a trailing ".0"; fractional < 10 keep one decimal.
  if (days >= 10) return `${Math.round(days)} days`;
  const rounded = Math.round(days * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} days` : `${rounded.toFixed(1)} days`;
}

// Default rating recommendation based on how the learner did on the MC.
// right → good, wrong → again, no pick (just revealed) → hard.
export function recommendedRating({ picked, correct }) {
  if (!picked) return 'hard';
  return normalizeOption(picked) === normalizeOption(correct) ? 'good' : 'again';
}

export function formatExplanation(text) {
  if (!text) return '';
  text = text.replace(/^OBJ \d+\.\d+:\s*/i, '').trim();

  let tip = '';
  const tipIdx = text.search(/For the exam[,:]?/i);
  if (tipIdx !== -1) {
    tip = text.slice(tipIdx).replace(/^For the exam[,:]?\s*/i, '').trim();
    text = text.slice(0, tipIdx).trim();
  }

  const mdBold = (s) => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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

// Break a long question into paragraphs every 2 sentences so it's scannable
// rather than a wall of text. Short questions (≤2 sentences) are left as a
// single block so they don't get unnecessary padding.
export function formatQuestion(text) {
  if (!text) return '';
  const t = text.trim();
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  if (sentences.length <= 2) {
    return `<p class="q-para">${escapeHtml(t)}</p>`;
  }
  const paras = [];
  for (let i = 0; i < sentences.length; i += 2) {
    paras.push(sentences.slice(i, i + 2).join(' ').trim());
  }
  return paras.map(p => `<p class="q-para">${escapeHtml(p)}</p>`).join('');
}

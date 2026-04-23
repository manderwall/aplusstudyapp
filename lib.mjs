// Pure helpers shared by app.js and tests/. Keep this module side-effect-free
// so the test runner can import it directly without a DOM.

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * 60 * 1000;
export const MAX_INTERVAL_DAYS = 30;  // cap so exam-prep doesn't schedule cards past the exam

export function defaultProgress() {
  return { status: 'new', seen: 0, correct: 0, lastSeen: 0, ease: 2.5, interval: 0, due: 0 };
}

export function migrateProgress(p) {
  if (p.ease === undefined) p.ease = 2.5;
  if (p.interval === undefined) p.interval = 0;
  if (p.due === undefined) p.due = 0;
  return p;
}

export function schedule(p, rate, now = Date.now()) {
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
  return p;
}

export function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function normalizeOption(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
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

// Format a raw explanation blob into a scannable layout:
// - Strip redundant "OBJ X.X:" prefix (already shown as a tag)
// - Break into paragraphs (every 2 sentences) so it's not a wall of text
// - Pull "For the exam..." into its own callout at the bottom
// - Give the first paragraph a lead style so the answer stands out
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
export function nextIntervalLabel(p, rate, now = Date.now()) {
  const sim = { ...p };
  if (sim.ease === undefined) sim.ease = 2.5;
  if (sim.interval === undefined) sim.interval = 0;
  schedule(sim, rate, now);
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

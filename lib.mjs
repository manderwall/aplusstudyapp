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

// Format a raw explanation blob into a scannable layout:
// - Strip redundant "OBJ X.X:" prefix (already shown as a tag)
// - Break into paragraphs (every 2 sentences) so it's not a wall of text
// - Pull "For the exam..." into its own callout at the bottom
// - Give the first paragraph a lead style so the answer stands out
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

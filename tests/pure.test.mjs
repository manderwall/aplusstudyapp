// Unit tests for lib.mjs pure functions. Run: `node --test tests/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN, DAY, MAX_INTERVAL_DAYS,
  defaultProgress, migrateProgress, schedule,
  escapeHtml, normalizeOption, formatExplanation, formatQuestion,
  orderDeck, nextIntervalLabel, recommendedRating,
  shuffleOptionsForCard,
  FSRS_W, FSRS_TARGET_RETENTION, fsrsRetrievability, fsrsNextIntervalDays,
} from '../lib.mjs';

const NOW = 1_700_000_000_000;  // fixed for deterministic assertions

test('defaultProgress returns a fresh card state', () => {
  const p = defaultProgress();
  assert.equal(p.status, 'new');
  assert.equal(p.seen, 0);
  assert.equal(p.ease, 2.5);
  assert.equal(p.interval, 0);
  assert.equal(p.due, 0);
});

test('migrateProgress fills SRS fields on old saves', () => {
  const old = { status: 'learning', seen: 3, correct: 2, lastSeen: 123 };
  migrateProgress(old);
  assert.equal(old.ease, 2.5);
  assert.equal(old.interval, 0);
  assert.equal(old.due, 0);
  // Existing fields untouched
  assert.equal(old.seen, 3);
  assert.equal(old.status, 'learning');
});

test('migrateProgress is idempotent', () => {
  const p = defaultProgress();
  const snapshot = { ...p };
  migrateProgress(p);
  assert.deepEqual(p, snapshot);
});

// ─── FSRS scheduler tests ───────────────────────────────────────────────
// Tests below validate the FSRS-4 behavior the schedule() function now
// implements. They focus on invariants (monotonicity, bounds, recovery)
// rather than pinning exact numbers — the algorithm's exact outputs
// depend on the public weight vector and are correct by reference, not
// by hand-derived assertion.

test('schedule again: short relearn window + difficulty rises', () => {
  const p = defaultProgress();
  schedule(p, 'good', NOW);             // first review establishes S, D
  const dBefore = p.D;
  schedule(p, 'again', NOW + DAY);      // 1 day later, user forgets
  assert.equal(p.due, NOW + DAY + MIN, '1-min relearn step on lapse');
  assert.equal(p.status, 'learning', 'lapsed card drops back to learning');
  assert.ok(p.D > dBefore, `difficulty should rise on lapse (was ${dBefore.toFixed(2)}, now ${p.D.toFixed(2)})`);
  assert.ok(p.S > 0, 'stability stays positive (FSRS preserves a floor)');
});

test('schedule good: fresh card → ~1 day, status transitions to learning', () => {
  const p = defaultProgress();
  schedule(p, 'good', NOW);
  // FSRS-4 initial stability for G=3 (Good) is w[2] = 2.4 days, then capped
  // by the interval cap. Just assert it's in the learning-window ballpark.
  assert.ok(p.interval >= 1 && p.interval <= MAX_INTERVAL_DAYS, `interval ${p.interval} out of [1, ${MAX_INTERVAL_DAYS}]`);
  assert.ok(p.due > NOW, 'due is in the future');
  assert.equal(p.status, 'learning', 'new card transitions to learning on first Good');
  assert.ok(p.S > 0, 'FSRS stability initialized');
  assert.ok(p.D >= 1 && p.D <= 10, 'FSRS difficulty in [1, 10]');
});

test('schedule good: stability grows monotonically over a Good streak', () => {
  const p = defaultProgress();
  schedule(p, 'good', NOW);
  const s1 = p.S;
  schedule(p, 'good', NOW + p.interval * DAY);
  const s2 = p.S;
  schedule(p, 'good', NOW + 2 * p.interval * DAY);
  const s3 = p.S;
  assert.ok(s2 > s1, `stability should grow: s1=${s1.toFixed(2)}, s2=${s2.toFixed(2)}`);
  assert.ok(s3 > s2, `and keep growing: s2=${s2.toFixed(2)}, s3=${s3.toFixed(2)}`);
});

test('schedule easy gives a longer next interval than good', () => {
  const pGood = defaultProgress();
  const pEasy = defaultProgress();
  schedule(pGood, 'good', NOW);
  schedule(pEasy, 'easy', NOW);
  assert.ok(pEasy.interval > pGood.interval,
    `easy interval ${pEasy.interval}d should exceed good interval ${pGood.interval}d`);
  // On a fresh card, FSRS-4's initDifficulty for both G=3 and G=4 with the
  // default weights clamps to D=1, so the post-clamp values can match.
  // The interval-vs-interval comparison above is what users actually feel.
});

test('schedule honors the exam-runway capDays argument', () => {
  const p = defaultProgress();
  // Build up a card with high stability via many Goods
  schedule(p, 'easy', NOW);
  schedule(p, 'good', NOW + p.interval * DAY);
  schedule(p, 'good', NOW + 2 * p.interval * DAY);
  // Now schedule with a 5-day cap — even a high-stability card should not exceed.
  schedule(p, 'good', NOW + 30 * DAY, 5);
  assert.ok(p.interval <= 5, `interval ${p.interval} exceeded the 5-day cap`);
});

test('schedule hard: fresh card → small initial step', () => {
  const p = defaultProgress();
  schedule(p, 'hard', NOW);
  // FSRS-4 init stability for G=2 is w[1] = 0.6 days → due in <1 day
  // (specifically minutes via the in-day learning step).
  assert.ok(p.due > NOW, 'due in the future');
  assert.equal(p.status, 'learning');
  assert.ok(p.D >= 1 && p.D <= 10);
});

// ─── FSRS-specific math invariants ──────────────────────────────────────

test('fsrsRetrievability decreases over time', () => {
  const S = 5;
  assert.equal(fsrsRetrievability(0, S), 1, 'R(0) = 1');
  assert.ok(fsrsRetrievability(2, S) > fsrsRetrievability(10, S));
  assert.ok(fsrsRetrievability(10, S) > fsrsRetrievability(30, S));
  assert.equal(fsrsRetrievability(-1, 0), 0, 'zero stability → zero retrievability');
});

test('fsrsNextIntervalDays scales linearly with stability', () => {
  const i1 = fsrsNextIntervalDays(1);
  const i5 = fsrsNextIntervalDays(5);
  const i10 = fsrsNextIntervalDays(10);
  assert.ok(i5 > i1 && i10 > i5);
  // 5×S input gives ≈5×I out (within floating-point rounding).
  assert.ok(Math.abs(i5 / i1 - 5) < 0.01, `i5/i1 should be ~5, got ${(i5/i1).toFixed(2)}`);
});

test('FSRS_W is the 17-element FSRS-4 default vector', () => {
  assert.equal(FSRS_W.length, 17, 'FSRS-4 expects 17 weights');
  assert.equal(FSRS_TARGET_RETENTION, 0.9, 'default desired retention');
});

// ─── Legacy SM-2 → FSRS migration ───────────────────────────────────────

test('migrateProgress initializes FSRS state from legacy ease+interval', () => {
  const legacy = { status: 'good', seen: 5, correct: 4, lastSeen: NOW, ease: 2.5, interval: 10, due: NOW + 10 * DAY };
  migrateProgress(legacy);
  assert.ok(legacy.S !== undefined, 'S initialized');
  assert.ok(legacy.D !== undefined, 'D initialized');
  assert.ok(legacy.S >= 10, `S should be at least the prior interval (got ${legacy.S})`);
  // ease 2.5 should map to mid-range difficulty (not extreme).
  assert.ok(legacy.D > 2 && legacy.D < 8, `D should be mid-range (got ${legacy.D.toFixed(2)})`);
});

test('migrateProgress on a brand-new card leaves FSRS state undefined', () => {
  const fresh = { status: 'new', seen: 0, correct: 0, lastSeen: 0, ease: 2.5, interval: 0, due: 0 };
  migrateProgress(fresh);
  assert.equal(fresh.S, undefined, 'S undefined until first rating');
  assert.equal(fresh.D, undefined, 'D undefined until first rating');
});

test('schedule on a migrated legacy card uses its imported S/D', () => {
  const p = { status: 'good', seen: 5, correct: 4, lastSeen: NOW, ease: 2.0, interval: 7, due: NOW + 7 * DAY };
  migrateProgress(p);
  const sBefore = p.S;
  // Rate good after the prior due time → stability should grow
  schedule(p, 'good', NOW + 7 * DAY);
  assert.ok(p.S > sBefore, `S grew: ${sBefore.toFixed(2)} → ${p.S.toFixed(2)}`);
});

test('escapeHtml escapes the angle brackets and ampersand', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('x>y && a<b'), 'x&gt;y &amp;&amp; a&lt;b');
});

test('escapeHtml escapes quotes so data-option="..." attributes survive', () => {
  // Without quote escaping, an option like 9.6" x 9.6" would terminate the
  // attribute early and the click handler would read back only "9.6",
  // silently breaking grading on every question with a quote in its options.
  assert.equal(escapeHtml('9.6" x 9.6"'), '9.6&quot; x 9.6&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml('"a" & \'b\''), '&quot;a&quot; &amp; &#39;b&#39;');
});

test('normalizeOption lowercases + collapses whitespace', () => {
  assert.equal(normalizeOption('  Cable Modem  '), 'cable modem');
  assert.equal(normalizeOption('Gigabit   NIC'), 'gigabit nic');
  assert.equal(normalizeOption(null), '');
});

test('formatExplanation strips the OBJ prefix', () => {
  const out = formatExplanation('OBJ 3.5: A sample short explanation.');
  assert.ok(!out.includes('OBJ 3.5'));
  assert.ok(out.includes('A sample short explanation.'));
});

test('formatExplanation lifts "For the exam…" into a callout', () => {
  const out = formatExplanation('OBJ 2.3: Foo is important. Bar also matters. For the exam, remember X.');
  assert.ok(out.includes('expl-tip'));
  assert.ok(out.includes('remember X'));
  assert.ok(!out.match(/expl-para[^<]*For the exam/));
});

test('formatExplanation does not split on "2.4 GHz"-style numbers', () => {
  // The split regex should only break on .!? followed by a space and capital letter.
  // Here "2.4 GHz" has a space + capital after the decimal — the old naive
  // split-on-period would have cut it; the current regex must not.
  const out = formatExplanation('OBJ 2.3: 2.4 GHz is slower than 5 GHz. It has 3 non-overlapping channels. Wi-Fi 4 and above support it.');
  assert.ok(out.includes('2.4 GHz'));  // kept intact
  assert.ok(out.includes('5 GHz'));
  assert.ok(out.includes('expl-lead'));
  assert.ok(out.includes('expl-para'));  // 3 sentences → paragraphed
});

test('formatExplanation bolds **markdown**', () => {
  const out = formatExplanation('OBJ 1.1: This is **bold** text.');
  assert.ok(out.includes('<strong>bold</strong>'));
});

test('formatExplanation short input uses lead only (no paragraphing)', () => {
  const out = formatExplanation('OBJ 1.1: One short sentence here.');
  assert.ok(out.includes('expl-lead'));
  assert.ok(!out.includes('expl-para'));
});

test('formatExplanation empty input returns empty', () => {
  assert.equal(formatExplanation(''), '');
  assert.equal(formatExplanation(null), '');
});

//─── orderDeck ──────────────────────────────────────────────────────────

test('orderDeck sequential: preserves input order', () => {
  const qs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const out = orderDeck(qs, {}, { mode: 'sequential', seed: 1 });
  assert.deepEqual(out.map(x => x.id), ['a', 'b', 'c', 'd']);
});

test('orderDeck smart: due cards first, then new, then young', () => {
  const qs = [
    { id: 'new1' }, { id: 'due1' }, { id: 'young1' }, { id: 'new2' }, { id: 'due2' },
  ];
  const prog = {
    due1:   { seen: 1, due: NOW - 10 * DAY },  // due, most overdue
    due2:   { seen: 1, due: NOW - 1 * DAY },   // due
    young1: { seen: 1, due: NOW + 5 * DAY },   // not due yet
    // new1, new2: unseen → new
  };
  const out = orderDeck(qs, prog, { mode: 'smart', seed: 42, now: NOW });
  const ids = out.map(x => x.id);
  // due1 is most overdue so it comes first in the due tier
  assert.equal(ids[0], 'due1');
  assert.equal(ids[1], 'due2');
  // tier 2: the new cards (in some order), tier 3: the young
  assert.ok(ids.indexOf('new1') < ids.indexOf('young1'));
  assert.ok(ids.indexOf('new2') < ids.indexOf('young1'));
});

test('orderDeck smart: stable for same seed, different for different seed', () => {
  const qs = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}` }));
  const a = orderDeck(qs, {}, { mode: 'smart', seed: 7, now: NOW }).map(x => x.id);
  const b = orderDeck(qs, {}, { mode: 'smart', seed: 7, now: NOW }).map(x => x.id);
  const c = orderDeck(qs, {}, { mode: 'smart', seed: 999, now: NOW }).map(x => x.id);
  assert.deepEqual(a, b);  // same seed = same order
  assert.notDeepEqual(a, c);  // different seed = different order
});

test('orderDeck random: returns all input items (no loss/duplication)', () => {
  const qs = Array.from({ length: 20 }, (_, i) => ({ id: `q${i}` }));
  const out = orderDeck(qs, {}, { mode: 'random', seed: 123 });
  assert.equal(out.length, 20);
  assert.deepEqual(new Set(out.map(x => x.id)), new Set(qs.map(x => x.id)));
});

//─── nextIntervalLabel ──────────────────────────────────────────────────

test('nextIntervalLabel: fresh card produces sensible labels', () => {
  // FSRS produces algorithm-specific values; assert label shape + ordering
  // instead of pinning exact numbers. Again should be tiny; easy > good.
  const p = defaultProgress();
  const again = nextIntervalLabel(p, 'again', NOW);
  const good = nextIntervalLabel(p, 'good', NOW);
  const easy = nextIntervalLabel(p, 'easy', NOW);
  assert.ok(/min|hr/.test(again), `again label "${again}" should be sub-day`);
  assert.ok(/day|days/.test(good) || /hr/.test(good), `good label "${good}" should be hours-to-days`);
  assert.ok(/day/.test(easy), `easy label "${easy}" should be in days`);
});

test('nextIntervalLabel: does not mutate the input progress', () => {
  const p = defaultProgress();
  const snap = { ...p };
  nextIntervalLabel(p, 'easy', NOW);
  assert.deepEqual(p, snap);
});

//─── recommendedRating ──────────────────────────────────────────────────

test('recommendedRating: matches correct answer → good', () => {
  assert.equal(recommendedRating({ picked: 'Cable modem', correct: 'Cable modem' }), 'good');
  assert.equal(recommendedRating({ picked: '  cable MODEM  ', correct: 'Cable modem' }), 'good');
});

test('recommendedRating: wrong pick → again', () => {
  assert.equal(recommendedRating({ picked: 'DSL', correct: 'Cable modem' }), 'again');
});

test('recommendedRating: no pick → hard', () => {
  assert.equal(recommendedRating({ picked: null, correct: 'Cable modem' }), 'hard');
  assert.equal(recommendedRating({ picked: '', correct: 'Cable modem' }), 'hard');
});

//─── shuffleOptionsForCard ──────────────────────────────────────────────

test('shuffleOptionsForCard: preserves all options, no loss or duplication', () => {
  const opts = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const out = shuffleOptionsForCard(opts, 'p1q3');
  assert.equal(out.length, 4);
  assert.deepEqual(new Set(out), new Set(opts));
});

test('shuffleOptionsForCard: stable — same qid always produces same order', () => {
  const opts = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const a = shuffleOptionsForCard(opts, 'p1q3');
  const b = shuffleOptionsForCard(opts, 'p1q3');
  assert.deepEqual(a, b);
});

test('shuffleOptionsForCard: different qids produce different orders (for this set)', () => {
  const opts = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const a = shuffleOptionsForCard(opts, 'p1q3');
  const b = shuffleOptionsForCard(opts, 'p1q7');
  // While not guaranteed for all inputs, a 4-item shuffle has 23 other orderings
  assert.notDeepEqual(a, b);
});

test('shuffleOptionsForCard: does not mutate the original array', () => {
  const opts = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const original = opts.slice();
  shuffleOptionsForCard(opts, 'p1q3');
  assert.deepEqual(opts, original);
});

//─── formatQuestion ──────────────────────────────────────────────────────

test('formatQuestion: short question stays a single paragraph', () => {
  const out = formatQuestion('What is DNS? It maps names to IPs.');
  assert.equal(out.match(/<p class="q-para">/g).length, 1);
  assert.ok(out.includes('What is DNS?'));
});

test('formatQuestion: long question splits into multiple paragraphs', () => {
  const text = 'First sentence. Second sentence here. Third one follows. Fourth ends the thought.';
  const out = formatQuestion(text);
  const paras = out.match(/<p class="q-para">/g) || [];
  assert.ok(paras.length >= 2, `expected ≥2 paragraphs, got ${paras.length}`);
});

test('formatQuestion: escapes HTML in the input', () => {
  const out = formatQuestion('<script>alert(1)</script>');
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<script>'));
});

test('formatQuestion: empty input → empty output', () => {
  assert.equal(formatQuestion(''), '');
  assert.equal(formatQuestion(null), '');
});

// ─── FSRS migration hardening tests (PR after #45) ──────────────────────
// Real-shape SM-2 progress rows from accumulated app use + pathological
// inputs that can land in IDB from old app versions, partial Supabase
// syncs, or corrupted exports.

test("migrateProgress + schedule on a fresh-card SM-2 row", () => {
  // Shape exactly matches the pre-FSRS defaultProgress()
  const fresh = { status: "new", seen: 0, correct: 0, lastSeen: 0, ease: 2.5, interval: 0, due: 0 };
  migrateProgress(fresh);
  assert.equal(fresh.S, undefined, "fresh card stays uninitialized");
  schedule(fresh, "good", NOW);
  assert.ok(Number.isFinite(fresh.S) && fresh.S > 0, "first rate inits S");
  assert.ok(fresh.due > NOW, "due in future");
});

test("migrateProgress + schedule on a learning-card SM-2 row", () => {
  const learning = { status: "learning", seen: 3, correct: 2, lastSeen: NOW - 2 * DAY, ease: 2.35, interval: 1, due: NOW - DAY };
  migrateProgress(learning);
  assert.ok(learning.S >= 1 && learning.S <= 5, `learning S sensible (got ${learning.S})`);
  schedule(learning, "good", NOW);
  const interval = (learning.due - NOW) / DAY;
  assert.ok(interval > 1 && interval < 30, `next interval sensible (${interval.toFixed(1)} days)`);
});

test("migrateProgress + schedule on a well-learned SM-2 row", () => {
  // Card the user has rated Good many times — interval matured to 30 (the
  // old SM-2 cap), ease climbed to ~2.7
  const mature = { status: "good", seen: 12, correct: 12, lastSeen: NOW - 30 * DAY, ease: 2.7, interval: 30, due: NOW };
  migrateProgress(mature);
  assert.ok(mature.S >= 30 && mature.S <= 90, `mature S preserved + capped (got ${mature.S})`);
  assert.ok(mature.D < 5, `mature D low (got ${mature.D})`);
  schedule(mature, "good", NOW);
  assert.ok(mature.S > 30, "stability still grows from mature state");
});

test("migrateProgress + schedule on a lapsed SM-2 row", () => {
  // Card user has lapsed on several times — ease floored at 1.3, status learning
  const lapsed = { status: "learning", seen: 8, correct: 3, lastSeen: NOW - 6 * MIN, ease: 1.3, interval: 0, due: NOW + MIN };
  migrateProgress(lapsed);
  // interval==0 means brand-new init path, NOT the legacy mapping.
  // The first Hard rating should produce sensible relearning behavior.
  schedule(lapsed, "hard", NOW);
  assert.ok(lapsed.due > NOW, "lapsed-then-hard schedules in future");
  assert.equal(lapsed.status, "learning");
  assert.ok(Number.isFinite(lapsed.S) && lapsed.S > 0);
});

test("migration sanitizes pathological inputs", () => {
  const cases = [
    { ease: NaN, interval: 5, label: "NaN ease" },
    { ease: -1, interval: 5, label: "negative ease" },
    { ease: Infinity, interval: 5, label: "Infinity ease" },
    { ease: 2.5, interval: NaN, label: "NaN interval" },
    { ease: 2.5, interval: -10, label: "negative interval" },
    { ease: "2.5", interval: "5", label: "string-typed (JSON roundtrip)" },
    { ease: 2.5, interval: 9999, label: "absurd interval" },
  ];
  for (const c of cases) {
    const p = { status: "good", seen: 1, correct: 1, lastSeen: NOW, ease: c.ease, interval: c.interval, due: NOW };
    migrateProgress(p);
    // After migration, S/D must be finite numbers in valid ranges OR undefined
    if (p.S !== undefined) {
      assert.ok(Number.isFinite(p.S) && p.S > 0, `${c.label}: S finite > 0 (got ${p.S})`);
      assert.ok(p.S <= 90, `${c.label}: S capped at MIGRATION_S_CAP (got ${p.S})`);
    }
    if (p.D !== undefined) {
      assert.ok(Number.isFinite(p.D) && p.D >= 1 && p.D <= 10, `${c.label}: D in [1,10] (got ${p.D})`);
    }
    // Schedule must succeed without throwing or producing NaN
    schedule(p, "good", NOW);
    assert.ok(Number.isFinite(p.S), `${c.label}: post-schedule S finite`);
    assert.ok(Number.isFinite(p.D), `${c.label}: post-schedule D finite`);
    assert.ok(Number.isFinite(p.due) && p.due > 0, `${c.label}: post-schedule due valid`);
  }
});

test("schedule stays bounded across a 30-rating stress walk", () => {
  // Simulate a realistic 30-rating sequence: mostly Goods, a few Hards
  // and Agains, occasional Easy. Verify S never goes infinite or weird.
  const p = { status: "new", seen: 0, correct: 0, lastSeen: 0, ease: 2.5, interval: 0, due: 0 };
  migrateProgress(p);
  const ratings = ["good", "good", "good", "hard", "good", "good", "easy",
                   "good", "again", "hard", "good", "good", "good", "easy",
                   "good", "good", "again", "good", "good", "hard", "good",
                   "easy", "good", "good", "good", "good", "good", "good",
                   "easy", "good"];
  let t = NOW;
  for (const rate of ratings) {
    schedule(p, rate, t);
    assert.ok(Number.isFinite(p.S) && p.S > 0 && p.S <= 360, `S out of bounds after "${rate}": ${p.S}`);
    assert.ok(Number.isFinite(p.D) && p.D >= 1 && p.D <= 10, `D out of bounds after "${rate}": ${p.D}`);
    assert.ok(Number.isFinite(p.due) && p.due > t, `due not in future after "${rate}"`);
    // Advance simulated time to the new due date (perfect spaced repetition)
    t = p.due;
  }
});

test("interval cap shrinks correctly as exam-day approaches", () => {
  // User has a mature card at S ~ 30; exam day is 7 → cap should hit
  const p = { status: "good", seen: 10, correct: 10, lastSeen: NOW, ease: 2.7, interval: 30, due: NOW };
  migrateProgress(p);
  schedule(p, "good", NOW, 7);
  assert.ok(p.interval <= 7, `interval should respect 7-day cap (got ${p.interval})`);
  // Exam tomorrow → cap = 1
  schedule(p, "good", NOW, 1);
  assert.ok(p.interval <= 1, `interval should respect 1-day cap (got ${p.interval})`);
});


// ─── adversarial now sanitization (PR after #59) ─────────────────────
test('schedule sanitizes pathological now: Infinity/NaN/string/0/negative', () => {
  const cases = [Infinity, -Infinity, NaN, 0, -1, '1700000000000'];
  for (const bad of cases) {
    const p = defaultProgress();
    schedule(p, 'good', bad);
    assert.ok(Number.isFinite(p.S), `S finite for now=${bad}: got ${p.S}`);
    assert.ok(Number.isFinite(p.D), `D finite for now=${bad}: got ${p.D}`);
    assert.ok(Number.isFinite(p.due) && p.due > 0, `due finite + positive for now=${bad}: got ${p.due}`);
    assert.ok(typeof p.due === 'number', `due is number for now=${bad}: got ${typeof p.due}`);
  }
});

test('escapeHtml coerces non-string inputs defensively', () => {
  // A content PR shipping options: ["a", 42, "b"] would crash the renderer
  // with "s.replace is not a function" without this defense.
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(true), 'true');
  assert.equal(escapeHtml(BigInt(42)), '42');
  assert.equal(escapeHtml([1, 2]), '1,2');
  assert.equal(escapeHtml({ a: 1 }), '[object Object]');
  // Still safe on null/undefined/empty/false (returns empty string)
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(false), '');
});

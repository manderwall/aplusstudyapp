// Unit tests for lib.mjs pure functions. Run: `node --test tests/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN, DAY, MAX_INTERVAL_DAYS,
  defaultProgress, migrateProgress, schedule,
  escapeHtml, normalizeOption, formatExplanation,
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

test('schedule again: 1-minute relearn + ease drops', () => {
  const p = defaultProgress();
  p.ease = 2.5; p.interval = 10;
  schedule(p, 'again', NOW);
  assert.equal(p.interval, 0);
  assert.equal(p.due, NOW + MIN);
  assert.equal(p.status, 'learning');
  assert.ok(Math.abs(p.ease - 2.3) < 1e-9);
});

test('schedule again: ease floors at 1.3', () => {
  const p = defaultProgress();
  p.ease = 1.3;
  schedule(p, 'again', NOW);
  assert.equal(p.ease, 1.3);
});

test('schedule good: fresh card → 1-day interval', () => {
  const p = defaultProgress();
  schedule(p, 'good', NOW);
  assert.equal(p.interval, 1);
  assert.equal(p.due, NOW + DAY);
  assert.equal(p.status, 'learning');  // new → learning on first "good"
});

test('schedule good: learning card graduates to good', () => {
  const p = defaultProgress();
  p.status = 'learning'; p.interval = 1; p.ease = 2.5;
  schedule(p, 'good', NOW);
  assert.equal(p.interval, 2.5);
  assert.equal(p.status, 'good');
});

test('schedule easy: interval caps at MAX_INTERVAL_DAYS', () => {
  const p = defaultProgress();
  p.interval = 20; p.ease = 3.0;
  schedule(p, 'easy', NOW);
  assert.ok(p.interval <= MAX_INTERVAL_DAYS);
  assert.equal(p.due, NOW + p.interval * DAY);
});

test('schedule hard: learning fresh → 10-minute retry', () => {
  const p = defaultProgress();
  schedule(p, 'hard', NOW);
  assert.equal(p.due, NOW + 10 * MIN);
  assert.equal(p.status, 'learning');
});

test('escapeHtml escapes the angle brackets and ampersand', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('x>y && a<b'), 'x&gt;y &amp;&amp; a&lt;b');
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

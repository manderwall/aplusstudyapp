#!/usr/bin/env node
// Dedupe data/questions.json: merge repeated questions into a single card.
// Canonical entry keeps the lowest (pretest, qnum), records all sources and
// any unique wrong_picks, and uses the longest explanation.

import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync('data/questions.json', 'utf8'));
const groups = new Map();  // normalized question text → array of entries

for (const q of src) {
  const key = (q.question || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(q);
}

function chooseCanonical(group) {
  return group.slice().sort((a, b) => a.pretest - b.pretest || a.qnum - b.qnum)[0];
}

function mergeObj(group) {
  // Majority vote, ties broken by canonical's obj
  const counts = {};
  for (const q of group) counts[q.obj] = (counts[q.obj] || 0) + 1;
  const max = Math.max(...Object.values(counts));
  const winners = Object.entries(counts).filter(([_, c]) => c === max).map(([o]) => o);
  return winners.includes(chooseCanonical(group).obj) ? chooseCanonical(group).obj : winners[0];
}

const merged = [];
let dupCount = 0;
for (const [_, group] of groups) {
  const canon = chooseCanonical(group);
  if (group.length === 1) {
    // Still add sources array for consistency so the UI can always render it
    merged.push({ ...canon, sources: [{ pretest: canon.pretest, qnum: canon.qnum }] });
    continue;
  }
  dupCount += group.length - 1;

  // Sources: sorted by pretest then qnum
  const sources = group
    .map(q => ({ pretest: q.pretest, qnum: q.qnum }))
    .sort((a, b) => a.pretest - b.pretest || a.qnum - b.qnum);

  // Unique wrong picks
  const wrongPicks = [...new Set(group.map(q => q.wrong_pick).filter(Boolean))];

  // Longest non-empty explanation wins
  const explanation = group
    .map(q => q.explanation || '')
    .sort((a, b) => b.length - a.length)[0];

  merged.push({
    id: canon.id,
    pretest: canon.pretest,
    qnum: canon.qnum,
    obj: mergeObj(group),
    qtype: canon.qtype,
    question: canon.question,
    wrong_pick: wrongPicks[0] || '',
    wrong_picks: wrongPicks,   // new field when >1
    correct_short: canon.correct_short || '',
    explanation,
    sources,
  });
}

// Sort output the same way as canonical: by pretest, then qnum, for stable diffs
merged.sort((a, b) => a.pretest - b.pretest || a.qnum - b.qnum);

writeFileSync('data/questions.json', JSON.stringify(merged, null, 2));
console.log(`Before: ${src.length}  After: ${merged.length}  Removed duplicates: ${dupCount}`);
console.log(`Cards appearing on 2+ pretests: ${merged.filter(q => q.sources.length > 1).length}`);
const maxRepeats = Math.max(...merged.map(q => q.sources.length));
console.log(`Most-repeated card: ${maxRepeats}× (${merged.find(q => q.sources.length === maxRepeats).id})`);

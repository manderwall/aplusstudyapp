#!/usr/bin/env node
// Extracts question + options + correct answer + image page from a pretest PDF OCR output.
// Inputs: /tmp/pretest{N}-ocr/p-NN.txt (62 pages, one OCR file per page)
// Matches extracted questions against data/questions.json by question-text fuzzy compare
// and fills q.options + q.correct_short + q.image for matched entries.
//
// Usage: node scripts/extract-pretest.mjs <pretestNum> <ocrDir> <pagesDir>

import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';

const [,, pretestNum, ocrDir, pagesDir] = process.argv;
if (!pretestNum || !ocrDir || !pagesDir) {
  console.error('Usage: extract-pretest.mjs <pretestNum> <ocrDir> <pagesDir>');
  process.exit(2);
}

// ─── Load + concatenate OCR with page boundaries ─────────────
const pageFiles = readdirSync(ocrDir).filter(f => f.endsWith('.txt')).sort();
const pages = pageFiles.map(f => ({
  num: Number(basename(f, '.txt').replace(/^p-/, '')),
  text: readFileSync(`${ocrDir}/${f}`, 'utf8'),
}));

// Build a flat array of (page, line) with running global line index
const lines = [];
for (const p of pages) {
  for (const line of p.text.split('\n')) {
    lines.push({ page: p.num, text: line });
  }
}

// ─── Parse each question block ───────────────────────────────
// A question starts at a line matching `/^\s*(\d+\s*)?[\[\]\d]*\s*(\d+)\s*\/\s*1\s*point/i` roughly,
// but more reliably by the presence of the TYPE label like "Multiple Choice" / "Multiple Answer" /
// "Performance-Based Question" near a fraction token.
const QTYPE_RE = /(\d+)\s*\/\s*1\s*point\s+(Multiple\s+Choice|Multiple\s+Answer|Performance-Based\s+Question)/i;

const questions = [];
let current = null;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const m = l.text.match(QTYPE_RE);
  if (m) {
    if (current) questions.push(current);
    current = {
      num: Number(m[1]),
      type: m[2].replace(/\s+/g, ' '),
      startPage: l.page,
      endPage: l.page,
      body: [],
    };
    continue;
  }
  if (current) {
    current.body.push({ page: l.page, text: l.text });
    current.endPage = l.page;
  }
}
if (current) questions.push(current);

// Drop any "question 0" false positives + anything after question ~95
const valid = questions.filter(q => q.num >= 1 && q.num <= 95);
console.log(`Parsed ${valid.length} question blocks from pretest ${pretestNum}`);

// ─── For each question, extract question text, options, correct ───
// Option detection: a line that starts (after trim) with any non-word token then either `O`, `©`,
// `CO`, or nothing, followed by space and content. The CORRECT option has "extra letters" before
// the circle (OCR of the green check), e.g. "Was ©", "Va ©", "Wag ©", "Rie ©", "V ©", "Vv ©".
const OPTION_START = /^\s*([A-Za-z]{0,5})\s*([O©¢]|CO|CE|Ce)\s+(.+?)\s*$/;
const CORRECT_MARKERS = /^(Was|Wag|Va|Vv|V|Rie|Ra|Ri|WY|YW|We)$/i;  // OCR of the green ✓

function parseBlock(q) {
  // Stop at "Feedback" / "General Feedback" (explanation section)
  let stopIdx = q.body.findIndex(l => /^\s*(Feedback|General Feedback)\b/i.test(l.text));
  if (stopIdx === -1) stopIdx = q.body.length;
  const active = q.body.slice(0, stopIdx);

  // Find first option line
  let firstOptIdx = -1;
  for (let i = 0; i < active.length; i++) {
    if (OPTION_START.test(active[i].text)) { firstOptIdx = i; break; }
  }
  if (firstOptIdx === -1) return null;

  // Question text = everything before first option (joined, whitespace-normalized)
  const qtext = active.slice(0, firstOptIdx)
    .map(l => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Options + correctness
  const options = [];
  let correctIdx = -1;
  for (let i = firstOptIdx; i < active.length; i++) {
    const m = active[i].text.match(OPTION_START);
    if (!m) continue;
    const [, prefix, , rest] = m;
    const isCorrect = CORRECT_MARKERS.test(prefix);
    if (isCorrect) correctIdx = options.length;
    options.push(rest.trim());
  }

  return { qtext, options, correctIdx, page: q.startPage };
}

const parsed = valid.map(q => ({
  ...q,
  ...parseBlock(q),
}));

const good = parsed.filter(p => p.qtext && p.options && p.options.length >= 2);
console.log(`Extracted ${good.length} questions with ≥2 options`);
const withCorrect = good.filter(p => p.correctIdx >= 0);
console.log(`Of those, ${withCorrect.length} have a detected correct answer`);

// ─── Match to data/questions.json and fill in ────────────────
const dataPath = 'data/questions.json';
const qs = JSON.parse(readFileSync(dataPath, 'utf8'));

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function similarity(a, b) {
  // Simple Jaccard on word 4-grams
  const grams = (s) => {
    const words = s.split(' ');
    const set = new Set();
    for (let i = 0; i <= words.length - 4; i++) set.add(words.slice(i, i+4).join(' '));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

let matched = 0;
const unmatched = [];
for (const p of good) {
  const nqtext = norm(p.qtext);
  // Only match against questions whose sources include this pretest
  const candidates = qs.filter(q =>
    (q.sources || []).some(s => s.pretest === Number(pretestNum))
  );
  let best = null, bestScore = 0;
  for (const q of candidates) {
    const s = similarity(norm(q.question), nqtext);
    if (s > bestScore) { bestScore = s; best = q; }
  }
  // Threshold: ≥ 0.3 Jaccard on 4-grams (conservative; OCR has noise)
  if (best && bestScore >= 0.3) {
    best.options = p.options;
    if (p.correctIdx >= 0) best.correct_short = p.options[p.correctIdx];
    if (best.qtype === 'PBQ' || /Performance/i.test(valid.find(v => v.num === p.num)?.type || '')) {
      const pngName = `pretest${pretestNum}_q${p.num}.png`;
      const src = `${pagesDir}/p-${String(p.page).padStart(2, '0')}.png`;
      if (existsSync(src)) {
        if (!existsSync('images')) mkdirSync('images');
        copyFileSync(src, `images/${pngName}`);
        best.image = `images/${pngName}`;
      }
    }
    matched++;
  } else {
    unmatched.push({ num: p.num, page: p.page, score: bestScore.toFixed(2), q: p.qtext.slice(0, 70) });
  }
}

writeFileSync(dataPath, JSON.stringify(qs, null, 2));
console.log(`\nMatched + populated: ${matched}`);
console.log(`Unmatched (no card in data/questions.json or score too low): ${unmatched.length}`);
if (unmatched.length > 0) {
  console.log('Unmatched samples:');
  for (const u of unmatched.slice(0, 8)) console.log(`  [p${pretestNum}q${u.num}] score=${u.score} "${u.q}..."`);
}

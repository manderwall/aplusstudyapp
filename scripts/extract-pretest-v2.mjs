#!/usr/bin/env node
// Extract questions + options + correct answer + PBQ images from a pretest PDF.
// The Safari-exported PDFs have a clean text layer, so pdftotext gives us exact
// text — no OCR needed. The correct answer is NOT in the text layer (the green
// check is visual only), so we infer it from the explanation.
//
// Usage: node scripts/extract-pretest-v2.mjs <pretestNum> <pdfPath>

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';

const [,, pretestNum, pdfPath] = process.argv;
if (!pretestNum || !pdfPath) {
  console.error('Usage: extract-pretest-v2.mjs <pretestNum> <pdfPath>');
  process.exit(2);
}

// ─── Extract text per page ────────────────────────────────────
const pageCount = Number(
  execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf8' })
    .match(/^Pages:\s+(\d+)/m)[1]
);

const pages = [];
for (let i = 1; i <= pageCount; i++) {
  const text = execSync(`pdftotext -f ${i} -l ${i} "${pdfPath}" -`, { encoding: 'utf8' });
  pages.push({ num: i, text });
}

// Concatenate all lines with (page, line) provenance
const lines = [];
for (const p of pages) {
  for (const line of p.text.split('\n')) lines.push({ page: p.num, text: line });
}

// ─── Parse into question blocks ──────────────────────────────
const QTYPE_RE = /^(\d+)\s*\/\s*1\s*point\s+(Multiple Choice|Multiple Answer|Performance-Based Question)/;

const blocks = [];
let current = null;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].text.match(QTYPE_RE);
  if (m) {
    if (current) blocks.push(current);
    current = { type: m[2], body: [], startPage: lines[i].page };
    continue;
  }
  if (current) current.body.push(lines[i]);
}
if (current) blocks.push(current);

console.log(`Parsed ${blocks.length} question blocks from pretest ${pretestNum}`);

// ─── Split each block into question + options ────────────────
function parseBlock(b) {
  // Drop trailing Feedback section
  const fbIdx = b.body.findIndex(l => /^Feedback\s*$/.test(l.text));
  const active = fbIdx === -1 ? b.body : b.body.slice(0, fbIdx);

  // Find a blank line that separates question from options. If none, use last
  // line ending in '?' or ':' as the question end.
  const nonBlank = active.map((l, i) => ({ ...l, i })).filter(l => l.text.trim());
  if (nonBlank.length < 2) return null;

  // Heuristic: question ends at a line ending in '?', '.', or ':' — options
  // follow. If question has no '?', it's a PBQ ("select all that apply") — still
  // works since the boundary is the first option that's a short factual phrase.

  // Find lines ending with sentence-terminators: these are potential question-end markers
  let qEndLocalIdx = -1;
  for (let j = 0; j < nonBlank.length; j++) {
    const t = nonBlank[j].text.trim();
    if (/[?:.]$/.test(t) && j > 0) { qEndLocalIdx = j; break; }
  }
  if (qEndLocalIdx === -1) qEndLocalIdx = 0;

  const qLines = nonBlank.slice(0, qEndLocalIdx + 1).map(l => l.text.trim());
  const optLines = nonBlank.slice(qEndLocalIdx + 1).map(l => l.text.trim());

  return {
    qtext: qLines.join(' ').replace(/\s+/g, ' ').trim(),
    options: optLines.filter(o =>
      o &&
      o.length < 200 &&
      !/^<|General Feedback|For support|^\(This is/.test(o) &&
      // Exclude lines that are clearly instructions/notes (parentheticals that continue)
      !/^(This is|drag-and-drop|motherboard\.)/.test(o.trim())
    ),
    page: b.startPage,
    type: b.type,
  };
}

const parsed = blocks.map(parseBlock).filter(Boolean);
const good = parsed.filter(p => p.qtext && p.options && p.options.length >= 2 && p.options.length <= 10);
console.log(`Extracted ${good.length} questions with 2–10 options`);

// ─── Match to data/questions.json ────────────────────────────
const dataPath = 'data/questions.json';
const qs = JSON.parse(readFileSync(dataPath, 'utf8'));

function norm(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function wordSet(s) {
  return new Set(s.split(' ').filter(w => w.length >= 4));
}

function similarity(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Given an explanation, find which option best matches the stated correct answer
function guessCorrect(explanation, options) {
  if (!explanation || options.length === 0) return -1;
  // Strip OBJ prefix
  const e = explanation.replace(/^OBJ \d+\.\d+:\s*/i, '');
  // First sentence often names the correct answer; rank by options that best match
  const firstSentence = e.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ').toLowerCase();
  let bestIdx = -1, bestScore = 0;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i].toLowerCase();
    // Score: does the first sentence mention this option text?
    let score = 0;
    if (firstSentence.includes(opt)) score += 10;
    // Penalty if it's "not X" or "X is not" — careful with negations
    const notPattern = new RegExp(`(not\\s+)${opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(does not|is not|are not)`, 'i');
    if (notPattern.test(e)) score -= 5;
    // Word-overlap fallback
    const optWords = opt.split(/\s+/).filter(w => w.length >= 4);
    for (const w of optWords) if (firstSentence.includes(w)) score += 1;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= 2 ? bestIdx : -1;
}

let matched = 0, populatedCorrect = 0;
const matchLog = [];
for (const p of good) {
  const nq = norm(p.qtext);
  let best = null, bestScore = 0;
  for (const q of qs) {
    const s = similarity(norm(q.question), nq);
    if (s > bestScore) { bestScore = s; best = q; }
  }
  if (best && bestScore >= 0.35) {
    best.options = p.options;
    const cidx = guessCorrect(best.explanation, p.options);
    if (cidx >= 0) {
      best.correct_short = p.options[cidx];
      populatedCorrect++;
    }
    // PBQ image: save the page render
    if (best.qtype === 'PBQ' || /Performance/.test(p.type)) {
      const imagesDir = 'images';
      if (!existsSync(imagesDir)) mkdirSync(imagesDir);
      const pngName = `pretest${pretestNum}_p${String(p.page).padStart(2, '0')}.png`;
      const outPath = `${imagesDir}/${pngName}`;
      if (!existsSync(outPath)) {
        try {
          execSync(`pdftoppm -png -r 120 -f ${p.page} -l ${p.page} "${pdfPath}" ${imagesDir}/tmp_${pretestNum}_${p.page} 2>/dev/null`);
          const tmpName = `${imagesDir}/tmp_${pretestNum}_${p.page}-${String(p.page).padStart(2, '0')}.png`;
          const tmpAlt = `${imagesDir}/tmp_${pretestNum}_${p.page}-1.png`;
          if (existsSync(tmpName)) execSync(`mv "${tmpName}" "${outPath}"`);
          else if (existsSync(tmpAlt)) execSync(`mv "${tmpAlt}" "${outPath}"`);
        } catch {}
      }
      if (existsSync(outPath)) best.image = outPath;
    }
    matched++;
    matchLog.push(`✓ ${bestScore.toFixed(2)} [${best.id}] ${best.qtype === 'PBQ' ? '📸' : ''} ${cidx >= 0 ? '✔' : '✗'} ${p.qtext.slice(0, 55)}`);
  }
}

writeFileSync(dataPath, JSON.stringify(qs, null, 2));
console.log(`\nMatched: ${matched} (of ${good.length} extracted)`);
console.log(`With correct-answer detected: ${populatedCorrect}`);
for (const m of matchLog.slice(0, 30)) console.log('  ' + m);
if (matchLog.length > 30) console.log(`  ... and ${matchLog.length - 30} more`);

#!/usr/bin/env node
// Data-integrity checks for data/questions.json. Fails (exit 1) on any issue
// so CI can gate PRs. Run locally: `node scripts/validate-questions.mjs`.

import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'data/questions.json';
const qs = JSON.parse(readFileSync(path, 'utf8'));
const errors = [];
const warnings = [];

const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const seenIds = new Set();

for (const q of qs) {
  const id = q.id || '<no-id>';
  const required = ['id', 'obj', 'qtype', 'question', 'explanation'];
  for (const k of required) {
    if (!q[k]) errors.push(`${id}: missing required field "${k}"`);
  }
  if (seenIds.has(id)) errors.push(`${id}: duplicate id`);
  seenIds.add(id);

  if (!Array.isArray(q.sources) || q.sources.length === 0) {
    warnings.push(`${id}: no sources[] (expected after dedupe)`);
  }

  if (q.options !== undefined) {
    if (!Array.isArray(q.options)) {
      errors.push(`${id}: options must be an array`);
    } else if (q.options.length < 2) {
      errors.push(`${id}: options has <2 entries (n=${q.options.length})`);
    } else {
      const nopts = q.options.map(norm);

      // correct_short must appear in options (if present)
      const cs = norm(q.correct_short);
      if (cs && !nopts.includes(cs)) {
        errors.push(`${id}: correct_short "${q.correct_short}" not in options`);
      }

      // correct_picks entries must appear in options
      if (Array.isArray(q.correct_picks)) {
        for (const cp of q.correct_picks) {
          if (!nopts.includes(norm(cp))) {
            errors.push(`${id}: correct_picks entry "${cp}" not in options`);
          }
        }
      }

      // No option should be a substring of the question (extraction-fragment check)
      const qNorm = norm(q.question);
      for (const opt of q.options) {
        const o = norm(opt);
        if (o.length > 20 && qNorm.includes(o)) {
          errors.push(`${id}: option looks like a question-text fragment: ${JSON.stringify(opt)}`);
        }
      }

      // Options shouldn't be exact duplicates
      const dupes = new Set();
      const seen = new Set();
      for (const o of nopts) {
        if (seen.has(o)) dupes.add(o);
        seen.add(o);
      }
      if (dupes.size) errors.push(`${id}: duplicate options: ${[...dupes].join(' | ')}`);
    }
  }

  if (q.qtype === 'PBQ' && !(q.image || (Array.isArray(q.images) && q.images.length))) {
    warnings.push(`${id}: PBQ without image (user sees the "image not available" banner)`);
  }

  if (q.qtype === 'Multiple Answer' && !Array.isArray(q.correct_picks)) {
    warnings.push(`${id}: Multiple Answer but no correct_picks[] — only one answer will highlight`);
  }

  // wrong_pick should be in options when both are present (or explicitly empty)
  if (q.options && q.wrong_pick) {
    const wp = norm(q.wrong_pick);
    const nopts = q.options.map(norm);
    if (!nopts.includes(wp)) {
      // Some cards (e.g. p1q36) deliberately wipe wrong_pick; only warn, don't error
      warnings.push(`${id}: wrong_pick "${q.wrong_pick}" not in options`);
    }
  }
}

// Report
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`\n${qs.length} questions checked · ${warnings.length} warnings · ${errors.length} errors`);

if (errors.length > 0) process.exit(1);

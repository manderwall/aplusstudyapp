#!/usr/bin/env node
// Data-integrity checks for question banks. Fails (exit 1) on any issue
// so CI can gate PRs. Also exported as a function so the test suite can
// gate `node --test` runs on data quality.
//
// Run locally:
//   node scripts/validate-questions.mjs                     # core1 by default
//   node scripts/validate-questions.mjs data/questions.json
//   node scripts/validate-questions.mjs --all               # all decks
//
// What it catches (every one of these has burned a real user — see git log):
//   - missing required fields (id, obj, qtype, question, explanation)
//   - duplicate ids
//   - correct_short / correct_picks values that aren't in options (unwinnable)
//   - duplicate options
//   - options that look like extraction artifacts (substring of question)
//   - PBQ qtype without an image bundle (renders the "image missing" banner)
//   - Multiple Answer qtype without correct_picks[] (only one option highlights)
//   - wrong_pick values that aren't in options
//   - question text references a picture/figure/diagram with no image attached
//   - the OBJ X.Y prefix in the explanation doesn't match the obj field
//   - question text missing terminal punctuation (looks truncated)
//   - "Select TWO/THREE/N" question stem doesn't match correct_picks length
//   - image path that points to a file that doesn't exist on disk
//   - HTML-style markup or weird chars that suggest a paste mistake

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Pattern that says "the question is referring to something visual that
// the user is supposed to look at". Tight enough to skip prose mentions
// of "image" / "graphic" used conceptually (e.g. "the image on the
// monitor" = refresh-rate question; "graphic designer" = job title).
const REQUIRES_IMAGE_RE = new RegExp(
  // "this <noun>" — direct deictic reference, almost always needs a visual
  '\\bthis\\s+(picture|image|figure|photo|diagram|exhibit)\\b' +
  // "in this picture / using the image / based on the figure / refer to the diagram"
  '|\\b(in|using|based\\s+on|refer\\s+to)\\s+the\\s+(picture|image|figure|photo|diagram|exhibit)\\b' +
  '|\\bin\\s+this\\s+(picture|image|figure|photo|diagram|exhibit)\\b' +
  // "the picture/image/figure (above|below|here|attached|provided|shown)"
  '|\\bthe\\s+(picture|image|figure|photo|diagram|exhibit)\\s+(above|below|here|attached|provided|shown)\\b' +
  // PBQ stems: "Using the image..."
  '|^\\s*using\\s+the\\s+(image|picture|figure|diagram|exhibit)\\b' +
  // Specific visual artifacts that clearly require an image
  '|\\bfloor\\s+plan\\b' +
  '|\\bnetwork\\s+diagram\\b' +
  // "labeled as X" — port-cluster-style PBQs
  '|\\blabel(?:l)?ed\\s+as\\s+[A-Z]\\b',
  'i'
);

export function validate(qs, options = {}) {
  const errors = [];
  const warnings = [];
  const dataDir = options.dataDir || resolve(REPO_ROOT, 'data');
  const seenIds = new Set();

  for (const q of qs) {
    const id = q.id || '<no-id>';

    // 1. Required fields
    for (const k of ['id', 'obj', 'qtype', 'question', 'explanation']) {
      if (!q[k]) errors.push(`${id}: missing required field "${k}"`);
    }
    if (seenIds.has(id)) errors.push(`${id}: duplicate id`);
    seenIds.add(id);

    if (!Array.isArray(q.sources) || q.sources.length === 0) {
      warnings.push(`${id}: no sources[] (expected after dedupe)`);
    }

    // 2. obj format must be N.M
    if (q.obj && !/^\d+\.\d+$/.test(q.obj)) {
      errors.push(`${id}: obj "${q.obj}" doesn't match the expected "N.M" format`);
    }

    // 3. OBJ X.Y prefix in explanation should match obj field — easy to
    //    flip while editing and silently mis-files the card.
    const objMatch = q.explanation?.match(/^OBJ\s+(\d+\.\d+)/i);
    if (objMatch && q.obj && objMatch[1] !== q.obj) {
      errors.push(`${id}: explanation says "OBJ ${objMatch[1]}" but obj field is "${q.obj}"`);
    }

    // 4. Question text quality
    if (q.question) {
      // Must end with terminal punctuation (so a truncated paste doesn't slip in)
      const trimmed = q.question.trim();
      if (!/[.?!](['")\]]?)$/.test(trimmed)) {
        errors.push(`${id}: question doesn't end with . ? or ! — possible truncation: "...${trimmed.slice(-30)}"`);
      }
      // Visual reference without an image
      const hasImg = q.image || (Array.isArray(q.images) && q.images.length);
      if (!hasImg && REQUIRES_IMAGE_RE.test(q.question)) {
        const snippet = q.question.match(REQUIRES_IMAGE_RE)?.[0];
        errors.push(`${id}: question references a visual ("${snippet}") but no image is bundled`);
      }
    }

    // 5. Options
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) {
        errors.push(`${id}: options must be an array`);
      } else if (q.options.length < 2) {
        errors.push(`${id}: options has <2 entries (n=${q.options.length})`);
      } else {
        const nopts = q.options.map(norm);

        // correct_short must appear in options (if present) — otherwise
        // unwinnable: every pick gets graded as wrong.
        const cs = norm(q.correct_short);
        if (cs && !nopts.includes(cs)) {
          errors.push(`${id}: correct_short "${q.correct_short}" not in options ${JSON.stringify(q.options)}`);
        }

        // correct_picks entries must appear in options
        if (Array.isArray(q.correct_picks)) {
          for (const cp of q.correct_picks) {
            if (!nopts.includes(norm(cp))) {
              errors.push(`${id}: correct_picks entry "${cp}" not in options`);
            }
          }
        }

        // Options can't be empty / whitespace
        for (const opt of q.options) {
          if (typeof opt !== 'string' || !opt.trim()) {
            errors.push(`${id}: empty / non-string option found`);
          }
        }

        // Extraction-fragment check: long options that are a verbatim
        // substring of the question text are almost always paste mistakes.
        const qNorm = norm(q.question);
        for (const opt of q.options) {
          const o = norm(opt);
          if (o.length > 20 && qNorm.includes(o)) {
            errors.push(`${id}: option looks like a question-text fragment: ${JSON.stringify(opt)}`);
          }
        }

        // Duplicate options
        const dupes = new Set(), seen = new Set();
        for (const o of nopts) {
          if (seen.has(o)) dupes.add(o);
          seen.add(o);
        }
        if (dupes.size) errors.push(`${id}: duplicate options: ${[...dupes].join(' | ')}`);

        // 6. correct_short and wrong_pick can't be the same
        if (q.correct_short && q.wrong_pick && norm(q.correct_short) === norm(q.wrong_pick)) {
          errors.push(`${id}: correct_short equals wrong_pick (${q.correct_short})`);
        }

        // 7. wrong_pick should be in options if present
        if (q.wrong_pick) {
          const wp = norm(q.wrong_pick);
          if (!nopts.includes(wp)) {
            warnings.push(`${id}: wrong_pick "${q.wrong_pick}" not in options`);
          }
        }
      }
    }

    // 8. PBQ without image
    const hasImg = q.image || (Array.isArray(q.images) && q.images.length);
    if (q.qtype === 'PBQ' && !hasImg) {
      errors.push(`${id}: PBQ qtype without image — render shows the "image not available" banner`);
    }

    // 9. Image file actually exists on disk
    const imgPaths = [q.image, ...(q.images || [])].filter(Boolean);
    for (const p of imgPaths) {
      const abs = p.startsWith('/') ? resolve(REPO_ROOT, p.slice(1)) : resolve(REPO_ROOT, p);
      if (!existsSync(abs)) {
        errors.push(`${id}: image path "${p}" doesn't exist on disk (looked at ${abs})`);
      }
    }

    // 10. Multiple Answer must have correct_picks
    if (q.qtype === 'Multiple Answer' && !(Array.isArray(q.correct_picks) && q.correct_picks.length > 1)) {
      errors.push(`${id}: Multiple Answer qtype needs correct_picks[] with ≥2 entries`);
    }

    // 11. "Select TWO" / "Select THREE" stem must match correct_picks count
    const selectN = q.question?.match(/select\s+(TWO|THREE|FOUR|2|3|4)\b/i);
    if (selectN) {
      const want = { TWO: 2, THREE: 3, FOUR: 4 }[selectN[1].toUpperCase()] || Number(selectN[1]);
      const have = Array.isArray(q.correct_picks) ? q.correct_picks.length : 0;
      if (have !== want) {
        errors.push(`${id}: question says "Select ${selectN[1]}" but correct_picks has ${have} entries`);
      }
      if (q.qtype !== 'Multiple Answer') {
        warnings.push(`${id}: question says "Select ${selectN[1]}" but qtype is "${q.qtype}", not "Multiple Answer"`);
      }
    }

    // 12. learnMore field, if present, must be a URL string or an array of
    //     {url, label} entries. Catches typos in JSON pasted from elsewhere.
    if (q.learnMore !== undefined) {
      const links = Array.isArray(q.learnMore) ? q.learnMore : [q.learnMore];
      for (const l of links) {
        const url = typeof l === 'string' ? l : l?.url;
        if (!url || typeof url !== 'string') {
          errors.push(`${id}: learnMore entry has no url field`);
          continue;
        }
        try { new URL(url); }
        catch { errors.push(`${id}: learnMore url is not a valid URL: ${JSON.stringify(url)}`); }
      }
    }

    // 13. pageRef in overrides isn't validated here — the user adds those at
    //     runtime against their own PDF; we'd need the PDF to know the
    //     valid page range. The app silently drops out-of-range refs.

    // 14. Stray HTML/markdown leaking from a paste
    for (const text of [q.question, ...(q.options || []), q.explanation, q.correct_short]) {
      if (typeof text !== 'string') continue;
      if (/<\/?[a-z][^>]*>/i.test(text)) {
        warnings.push(`${id}: HTML tag in plain text — escapeHtml will neutralize it but it likely shouldn't be there`);
        break;
      }
      if (text.includes('�')) {
        errors.push(`${id}: contains the U+FFFD replacement character (encoding bug)`);
        break;
      }
    }
  }

  return { errors, warnings, count: qs.length };
}

// CLI entry point
const isCli = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('validate-questions.mjs');
if (isCli) {
  const allFlag = process.argv.includes('--all');
  const paths = allFlag
    ? ['data/questions.json', 'data/core2/questions.json']
    : [process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'data/questions.json'];

  let totalErrors = 0;
  for (const relPath of paths) {
    const fullPath = resolve(REPO_ROOT, relPath);
    if (!existsSync(fullPath)) {
      console.log(`(skipping ${relPath} — does not exist)`);
      continue;
    }
    let qs;
    try {
      qs = JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (e) {
      console.error(`ERROR ${relPath}: invalid JSON — ${e.message}`);
      totalErrors++;
      continue;
    }
    if (!Array.isArray(qs)) {
      console.error(`ERROR ${relPath}: top-level must be a JSON array`);
      totalErrors++;
      continue;
    }
    const { errors, warnings, count } = validate(qs);
    console.log(`\n=== ${relPath} ===`);
    for (const w of warnings) console.log(`warn   ${w}`);
    for (const e of errors)   console.error(`ERROR  ${e}`);
    console.log(`${count} questions · ${warnings.length} warnings · ${errors.length} errors`);
    totalErrors += errors.length;
  }
  if (totalErrors > 0) process.exit(1);
}

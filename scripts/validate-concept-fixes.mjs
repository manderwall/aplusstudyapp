#!/usr/bin/env node
// Content gate for data/<exam>/concept-fixes.json. Reading sheets are
// the one path in the app where author-supplied HTML is rendered raw
// (renderConceptSheet uses innerHTML so the markup actually formats).
// The CSP added in PR #37 stops loaded <script> from executing, but
// defense-in-depth: block them at PR-merge time so a malicious or
// careless content PR can't poison the data file in the first place.
//
// What we block:
//   - <script> / <iframe> / <object> / <embed> / <frame> elements
//   - inline event handlers (onclick=, onerror=, onload=, on*=, etc.)
//   - javascript: URLs in href/src
//   - data: URLs that aren't images (data:text/html, etc.)
//   - srcdoc attribute
//
// Usage:
//   node scripts/validate-concept-fixes.mjs                 # validates all data/*/concept-fixes.json
//   node scripts/validate-concept-fixes.mjs path/to/file    # one file
//   import { validate } from 'scripts/validate-concept-fixes.mjs'  # programmatic

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);

// Regexes are intentionally permissive about whitespace + casing.
// The point is "would the browser interpret this as executable?", not
// "is this perfect HTML".
const DANGER_PATTERNS = [
  { re: /<\s*script\b[^>]*>/i,                            name: '<script> element' },
  { re: /<\s*iframe\b[^>]*>/i,                            name: '<iframe> element' },
  { re: /<\s*object\b[^>]*>/i,                            name: '<object> element' },
  { re: /<\s*embed\b[^>]*>/i,                             name: '<embed> element' },
  { re: /<\s*frame\b[^>]*>/i,                             name: '<frame> element' },
  { re: /<\s*meta\b[^>]*http-equiv[^>]*refresh/i,         name: '<meta http-equiv="refresh">' },
  { re: /\son[a-z]+\s*=\s*["'][^"']*["']/i,               name: 'inline event handler (on*=)' },
  { re: /\son[a-z]+\s*=\s*[^\s"'>]+/i,                    name: 'inline event handler (unquoted on*=)' },
  // javascript: and vbscript: URLs in href/src/action
  { re: /\b(?:href|src|action|formaction|data)\s*=\s*["']?\s*(?:javascript|vbscript|data):(?!image\/(?:png|jpe?g|gif|svg\+xml|webp);)/i,
                                                          name: 'javascript:/vbscript:/data: URL in attribute' },
  // srcdoc lets you embed a whole document
  { re: /\bsrcdoc\s*=/i,                                  name: 'srcdoc attribute (inline frame document)' },
];

export function validate(text, label = '<input>') {
  const findings = [];
  for (const { re, name } of DANGER_PATTERNS) {
    const m = text.match(re);
    if (m) {
      // Locate which content section the match landed in, for actionable errors.
      const idx = m.index;
      const before = text.slice(0, idx);
      const snippet = m[0].slice(0, 80);
      const lineNo = (before.match(/\n/g) || []).length + 1;
      findings.push({ name, line: lineNo, snippet, file: label });
    }
  }
  return findings;
}

function validateFile(path) {
  const raw = readFileSync(path, 'utf8');
  let json;
  try { json = JSON.parse(raw); }
  catch (e) { return [{ name: 'invalid JSON', line: 1, snippet: e.message, file: path }]; }
  // Sweep each section's content + every other string-valued field that
  // could end up rendered (titles use textContent so they're safe; the
  // `content` field is the only innerHTML path today, but check title
  // too in case future code paths change).
  const findings = [];
  for (const [key, section] of Object.entries(json || {})) {
    if (!section || typeof section !== 'object') continue;
    for (const field of ['content', 'title']) {
      const v = section[field];
      if (typeof v !== 'string') continue;
      findings.push(...validate(v, `${path}:${key}.${field}`));
    }
  }
  return findings;
}

function collectDefaultPaths() {
  const dataRoot = join(REPO_ROOT, 'data');
  if (!statSync(dataRoot).isDirectory()) return [];
  const out = [];
  for (const entry of readdirSync(dataRoot)) {
    const sub = join(dataRoot, entry);
    if (!statSync(sub).isDirectory()) continue;
    const file = join(sub, 'concept-fixes.json');
    try { if (statSync(file).isFile()) out.push(file); } catch {}
  }
  return out;
}

// CLI mode — only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const targets = args.length ? args : collectDefaultPaths();
  if (targets.length === 0) {
    console.error('No concept-fixes.json files found and no path given.');
    process.exit(1);
  }
  let totalFindings = 0;
  for (const path of targets) {
    const found = validateFile(path);
    if (found.length === 0) {
      console.log(`✓ ${path} — no executable content`);
    } else {
      totalFindings += found.length;
      console.error(`✗ ${path} — ${found.length} dangerous pattern(s):`);
      for (const f of found) {
        console.error(`  L${f.line} [${f.name}] in ${basename(f.file)}: ${f.snippet}`);
      }
    }
  }
  process.exit(totalFindings === 0 ? 0 : 1);
}

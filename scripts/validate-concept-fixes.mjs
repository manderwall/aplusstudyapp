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
  // Event handlers: HTML5 allows whitespace OR a self-closing slash between
  // the tag name and the attribute. `<svg/onload=alert(1)>` is valid markup.
  // [\s/] matches both. Earlier version only had \s and missed the /-variant.
  { re: /[\s/]on[a-z]+\s*=\s*["'][^"']*["']/i,            name: 'inline event handler (on*=)' },
  { re: /[\s/]on[a-z]+\s*=\s*[^\s"'>]+/i,                 name: 'inline event handler (unquoted on*=)' },
  // javascript: and vbscript: URLs in href/src/action.
  // \s* allows tab/newline between attr and value (`<a\thref="...">` works).
  { re: /\b(?:href|src|action|formaction|data)\s*=\s*["']?\s*(?:javascript|vbscript|data):(?!image\/(?:png|jpe?g|gif|svg\+xml|webp);)/i,
                                                          name: 'javascript:/vbscript:/data: URL in attribute' },
  // srcdoc lets you embed a whole document
  { re: /\bsrcdoc\s*=/i,                                  name: 'srcdoc attribute (inline frame document)' },
  // <style> blocks that embed a javascript: URL via CSS url(). Legacy IE
  // ran these as script; modern browsers don't. Defense in depth: never
  // ship CSS that LOOKS like it wants to run JS.
  { re: /<\s*style\b[\s\S]*?(?:javascript|vbscript):[\s\S]*?<\s*\/\s*style\s*>/i,
                                                          name: 'javascript: URL inside <style> block' },
];

// HTML entity-escape bypass: a content author can write
// `<a href="&#106;avascript:alert(1)">` and the browser will decode
// `&#106;` to `j` BEFORE applying any URL handler. The regex above sees
// "&#106;avascript:" which doesn't match "javascript:" literally. Fix:
// decode numeric entities (both decimal &#NN; and hex &#xNN;, with or
// without trailing semicolon since Firefox/Chrome accept missing ;) +
// the handful of named entities a real attacker would use, then re-run
// the regex on the decoded copy.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', tab: '\t', newline: '\n' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&#([0-9]+);?/g, (_, d) => {
      const n = parseInt(d, 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _;
    })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

export function validate(text, label = '<input>') {
  const findings = [];
  // Run the regex against the raw text AND the entity-decoded text so
  // `&#106;avascript:` and `javascript:` both get caught.
  const decoded = decodeEntities(text);
  const variants = decoded === text ? [text] : [text, decoded];
  for (const { re, name } of DANGER_PATTERNS) {
    for (const variant of variants) {
      const m = variant.match(re);
      if (!m) continue;
      // Locate in the ORIGINAL text where possible; if the match is only
      // in the decoded copy, fall back to the decoded position.
      const origIdx = text.indexOf(m[0]);
      const idx = origIdx >= 0 ? origIdx : m.index;
      const before = text.slice(0, idx);
      const snippet = m[0].slice(0, 80);
      const lineNo = (before.match(/\n/g) || []).length + 1;
      findings.push({ name, line: lineNo, snippet, file: label });
      break;  // one finding per pattern per content string
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

// Verifies the concept-fixes content validator catches the patterns
// it claims to catch + clears the actual shipped content.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/validate-concept-fixes.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('validator catches <script> elements', () => {
  assert.equal(validate('<p>Hi</p><script>alert(1)</script>').length, 1);
  assert.equal(validate('<SCRIPT >x</SCRIPT>').length, 1);
});

test('validator catches inline event handlers', () => {
  assert.equal(validate('<img src="x" onerror="alert(1)">').length, 1);
  assert.equal(validate('<a OnClick="x()">go</a>').length, 1);
  assert.equal(validate('<svg onload=alert(1)>').length, 1);
});

test('validator catches javascript: URLs', () => {
  assert.equal(validate('<a href="javascript:alert(1)">x</a>').length, 1);
  assert.equal(validate('<a href = "  JAVASCRIPT:alert(1)  ">x</a>').length, 1);
});

test('validator catches <iframe>/<object>/<embed>', () => {
  assert.equal(validate('<iframe src="evil"></iframe>').length, 1);
  assert.equal(validate('<object data="evil.swf"></object>').length, 1);
});

test('validator catches srcdoc + meta refresh', () => {
  // The iframe+srcdoc+inline-script string trips three rules (iframe, srcdoc,
  // script). Just assert all three are caught rather than pinning a count.
  const found = validate('<iframe srcdoc="<script>x</script>"></iframe>').map(f => f.name);
  assert.ok(found.some(n => n.includes('iframe')),  'should catch iframe');
  assert.ok(found.some(n => n.includes('srcdoc')),  'should catch srcdoc');
  assert.ok(found.some(n => n.includes('script')),  'should catch nested script');
  assert.equal(validate('<meta http-equiv="refresh" content="0;url=evil">').length, 1);
});

test('validator allows benign HTML (tables, code, em, strong, lists)', () => {
  const safe = `
    <table><tr><th>X</th></tr><tr><td><strong>Y</strong></td></tr></table>
    <p>Plain text with <em>emphasis</em> and <code>sfc /scannow</code>.</p>
    <ol><li>Step 1</li><li>Step 2</li></ol>
    <a href="https://example.org/docs">External link</a>
    <img src="https://example.org/diagram.png" alt="OK">
  `;
  assert.deepEqual(validate(safe), []);
});

// ── Adversarial corpus added in PR after #56 (response to "is there ──
// anything else though"). When I first wrote this validator I tested
// the obvious patterns I designed it for, which is exactly the failure
// mode the question was probing. Trying to BREAK the validator with
// real-world XSS bypasses surfaced 4 misses; each is now caught.
test('validator catches SVG self-closing event handler', () => {
  // <svg/onload=...> is valid HTML5 — the / between tag and attr
  // satisfies the "must have separator" requirement.
  assert.ok(validate('<svg/onload=alert(1)>').length > 0);
});
test('validator catches HTML-entity-escaped javascript: URLs', () => {
  // Browsers decode &#106; → "j" BEFORE running href, so "&#106;avascript:"
  // is a working XSS vector against a regex that only matches literal
  // "javascript:".
  assert.ok(validate('<a href="&#106;avascript:alert(1)">x</a>').length > 0);
  assert.ok(validate('<a href="javascript&#58;alert(1)">x</a>').length > 0);
  assert.ok(validate('<a href="&#x6A;avascript:alert(1)">x</a>').length > 0);  // hex entity
  assert.ok(validate('<a href="&#106avascript:alert(1)">x</a>').length > 0);   // no trailing ;
});
test('validator catches javascript: inside <style> blocks', () => {
  assert.ok(validate('<style>body{background:url("javascript:alert(1)")}</style>').length > 0);
});
test('validator catches tab/newline between tag and attr', () => {
  // \t and \n satisfy the attribute-separator requirement in HTML5.
  assert.ok(validate('<a\thref="javascript:alert(1)">x</a>').length > 0);
  assert.ok(validate('<img src=x\nonerror=alert(1)>').length > 0);
});

test('validator allows data:image URLs but blocks data:text/html', () => {
  assert.deepEqual(validate('<img src="data:image/png;base64,iVBOR...">'), []);
  assert.equal(validate('<a href="data:text/html,<script>x</script>">x</a>').length >= 1, true);
});

test('shipped concept-fixes.json files contain no dangerous patterns', () => {
  const dataRoot = join(REPO_ROOT, 'data');
  const exams = readdirSync(dataRoot).filter(e => {
    try { return statSync(join(dataRoot, e)).isDirectory(); } catch { return false; }
  });
  let checked = 0;
  for (const exam of exams) {
    const file = join(dataRoot, exam, 'concept-fixes.json');
    try { statSync(file); } catch { continue; }
    const text = readFileSync(file, 'utf8');
    const json = JSON.parse(text);
    for (const [key, section] of Object.entries(json || {})) {
      for (const field of ['content', 'title']) {
        const v = section?.[field];
        if (typeof v !== 'string') continue;
        const findings = validate(v, `${exam}/${key}.${field}`);
        assert.deepEqual(findings, [], `Unexpected danger in ${exam}/${key}.${field}: ${JSON.stringify(findings)}`);
      }
    }
    checked++;
  }
  assert.ok(checked > 0, 'Expected at least one concept-fixes file to validate');
});

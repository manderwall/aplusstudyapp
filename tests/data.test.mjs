// Data integrity tests — runs the full validator against every question
// bank shipped with the app. If you add Core 2 (or any new exam dataset)
// and a question has a missing image, wrong correct_short, or any of the
// other 12 categories of bug we've burned on before, this test fails BEFORE
// the bad data reaches users.
//
// Run as part of `node --test tests/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/validate-questions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Find every questions.json under data/ — top-level + each exam subdir.
function findQuestionFiles() {
  const dataDir = resolve(REPO_ROOT, 'data');
  const found = [];
  const top = resolve(dataDir, 'questions.json');
  if (existsSync(top)) found.push(top);
  for (const entry of readdirSync(dataDir)) {
    const sub = resolve(dataDir, entry);
    if (statSync(sub).isDirectory()) {
      const inner = resolve(sub, 'questions.json');
      if (existsSync(inner)) found.push(inner);
    }
  }
  return found;
}

const files = findQuestionFiles();

if (files.length === 0) {
  test('no question banks found', () => {
    assert.fail('Expected at least one data/**/questions.json');
  });
}

for (const file of files) {
  const rel = file.replace(REPO_ROOT + '/', '');

  test(`${rel}: parses as a JSON array`, () => {
    const text = readFileSync(file, 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(text); }, `${rel} is not valid JSON`);
    assert.ok(Array.isArray(parsed), `${rel} top-level must be an array`);
  });

  test(`${rel}: passes data validator`, () => {
    const qs = JSON.parse(readFileSync(file, 'utf8'));
    if (qs.length === 0) return;  // empty is fine — placeholder for future content
    const { errors, warnings } = validate(qs);
    if (errors.length) {
      // Echo errors to test output so they show up in the failure message.
      console.error(`\n${rel}: ${errors.length} validation error${errors.length === 1 ? '' : 's'}:`);
      for (const e of errors) console.error('  ' + e);
    }
    assert.equal(errors.length, 0, `${errors.length} validation errors in ${rel} (see above)`);
    // Warnings don't fail the test but log so they show up in CI output.
    if (warnings.length) {
      console.warn(`\n${rel}: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
      for (const w of warnings) console.warn('  ' + w);
    }
  });
}

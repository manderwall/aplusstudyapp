// Shared harness for the browser smoke suite. Spawns a throwaway static
// server on an OS-assigned ephemeral port (no more hardcoded 88xx ports
// colliding when tests run in parallel) and launches headless Chromium.
//
// Runtime deps stay zero — puppeteer is a devDependency only, imported
// lazily here so `npm test` (the fast unit suite) never touches it.
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HARNESS_DIR, '..', '..');
export const SHOT_DIR = join(HARNESS_DIR, '__shots__');

// Spawn `python3 -m http.server 0` (port 0 → kernel picks a free port),
// parse the assigned port from its startup line, and hand back a base
// URL + a stop() fn. Eliminates the port-collision flakiness the old
// /tmp/smoke scripts had.
export async function startServer() {
  // `-u` + PYTHONUNBUFFERED force Python to flush its "Serving HTTP on
  // ... port N" banner immediately. Without this, stdout/stderr to a
  // pipe (not a TTY) is block-buffered, so the banner can sit unflushed
  // and the port-parse below times out on slow CI runners even though
  // the server is up. (See CI flake on PR #69.)
  const proc = spawn('python3', ['-u', '-m', 'http.server', '0'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/port (\d+)/i);
      if (m) { proc.stdout.off('data', onData); proc.stderr.off('data', onData); resolve(Number(m[1])); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);  // python prints the serving line to stderr on some versions
    proc.on('error', reject);
    // Generous window: CI cold-starts (apt + chromium install just ran)
    // can delay the first scheduler tick well past a few seconds.
    setTimeout(() => reject(new Error('server did not start in 30s')), 30000);
  });
  // Give the listener a beat to actually accept connections.
  await wait(150);
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => { try { proc.kill('SIGTERM'); } catch {} },
  };
}

export async function launchBrowser() {
  const puppeteer = (await import('puppeteer')).default;
  return puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

export function shotDir() {
  mkdirSync(SHOT_DIR, { recursive: true });
  return SHOT_DIR;
}

// Tiny assertion + reporting helpers shared by the smoke modules. Each
// smoke module returns { pass, fail } counts; the runner aggregates.
export function makeReporter(label) {
  const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
  const RED = (s) => `\x1b[31m${s}\x1b[0m`;
  const DIM = (s) => `\x1b[36m${s}\x1b[0m`;
  let pass = 0, fail = 0;
  return {
    ok: (m) => { pass++; console.log(GREEN(`  ✓ ${m}`)); },
    ng: (m) => { fail++; console.log(RED(`  ✗ ${m}`)); },
    info: (m) => console.log(DIM(`  … ${m}`)),
    head: (m) => console.log(`\n## ${label}: ${m}`),
    result: () => ({ pass, fail }),
  };
}

// Collect console errors on a page, ignoring known-benign noise (the SW
// registration warning headless Chromium emits when it can't bind).
export function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('SW failed')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

# Browser smoke suite

Headless-Chromium tests that drive the **real app** (not just the pure
helpers in `tests/*.test.mjs`). These guard the behaviors that are only
observable in a browser: the require-answer-before-Reveal gate, keyboard
shortcuts bailing under modals, localStorage-quota resilience, responsive
layout, and cold-boot performance.

## Why these live here

For most of the audit cycle (PRs #37–#63) this verification lived in an
uncommitted `/tmp` scratch dir and evaporated when the container was
reclaimed — so every session rebuilt it from scratch. Committing it means
the next change inherits the safety net instead of re-deriving it, and CI
runs it automatically.

## Running

```bash
npm install            # one-time: pulls puppeteer (devDependency only —
                       # the shipped app still has zero runtime deps)
npm run smoke          # regression suite — pass/fail, gates CI
npm run smoke:perf     # cold-boot timings (informational)
npm run smoke:mobile   # 6-viewport responsive sweep + screenshots
```

Screenshots land in `tests/smoke/__shots__/` (gitignored).

## Files

- `_harness.mjs` — shared helpers. Spawns a static server on an
  OS-assigned ephemeral port (no port collisions), launches Chromium,
  reporter + console-error tracker. Resolves paths relative to repo root.
- `regression.mjs` — assertion suite, **exits non-zero on failure**, wired
  into the `smoke` CI job. This is the one that protects against
  regressions; add new behavioral guards here.
- `perf.mjs` — cold-boot probe under Moto-G4 / Fast-3G / 4× CPU throttle.
- `mobile.mjs` — responsive sweep; flags h-scroll, sub-24×24 targets,
  truncated tab labels.

## Adding a guard

When you fix a browser-observable bug, add an assertion to
`regression.mjs` so it can't silently come back. Keep each check a few
lines; the harness handles server + browser lifecycle.

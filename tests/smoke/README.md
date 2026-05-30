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
npm run smoke:cross-device  # 10-device matrix (iOS/Android/iPadOS/Mac/PC emulated UAs)
```

## What cross-device CAN and CANNOT do

`smoke:cross-device` drives the app through 10 emulated device profiles
(iPhone SE/12/14 Pro, iPhone landscape, Pixel 7, Galaxy Tab S8, iPad
Air/Mini, desktop Mac, desktop PC) with realistic viewport + DPR +
touch + user-agent for each.

It **catches**: layout breaks, h-scroll, sub-24×24 controls, broken
flows (study → reveal, mock-exam button, outcome dialog), uncaught
console errors. All ten profiles are currently clean.

It **does not catch**: Safari engine quirks (`inert` partial support,
pinch-zoom edge cases, ITP), Android virtual-keyboard reflow, real
iOS PWA install + home-screen-icon behavior. For those you need a
physical device. The script prints this caveat at the end of every
run so it's never forgotten.

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

## CI status

These run **locally**, not in CI yet. Two attempts to wire a `smoke`
job into GitHub Actions failed fast at puppeteer's Chromium launch
(likely a missing system lib on the `ubuntu-24.04` runner, or the
browser postinstall being skipped) — and the working environment
couldn't read Actions logs to confirm which. Rather than leave a
perpetually-red advisory check (which trains people to ignore red),
CI integration is a documented TODO in `.github/workflows/ci.yml`.
The local run is the source of truth until then.

## Adding a guard

When you fix a browser-observable bug, add an assertion to
`regression.mjs` so it can't silently come back. Keep each check a few
lines; the harness handles server + browser lifecycle.

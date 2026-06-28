# A+ Study app — orientation for future Claude sessions

This is a CompTIA A+ exam study PWA. Single-file JS modules, no build step.
Spaced-repetition flashcards + practice quizzes + reading sheets + stats.

## Where to find what

- **`docs/STARTER-KIT.md`** — distilled patterns for building similar apps.
  Read this first if you're being asked to build a new study/learning PWA.
- **`docs/DATA-FORMAT.md`** — schema + workflow for adding question packs.
  Read this before touching `data/**/*.json`.
- **`app.js`** — all UI + state + handlers. ~5000 lines, no framework.
- **`lib.mjs`** — pure helpers (FSRS-4 scheduling, formatting, shuffling).
  Side-effect-free; tested by `tests/pure.test.mjs`.
- **`scripts/validate-questions.mjs`** — content data validator. Exports
  `validate(items)` for tests + runs as CLI.
- **`scripts/validate-concept-fixes.mjs`** — defense-in-depth XSS gate
  for `data/<exam>/concept-fixes.json` (Reading-sheet HTML is rendered
  raw via innerHTML). Blocks `<script>`, `on*=` handlers,
  `javascript:` URLs, `srcdoc`, etc. CI runs it on every PR.
- **`_headers`** — Cloudflare Pages security headers. Includes a strict
  CSP that allowlists self + `cdn.jsdelivr.net` (pdf.js) +
  `*.supabase.co` (optional sync). Plus `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`.

## Conventions baked into this repo

### Touch / click safety stack
Every reveal-style state change uses 5 layers. Don't remove any of them:
1. CSS `pointer-events: none` for **800ms** via `.card-just-revealed`
2. JS timestamp guard (`state._revealedAt`). **As of PR #39 the guard
   is scoped to pointer events only**: it lives on the rate-btn click
   handler and the quiz Next button click handler. `nextQuestion`,
   `prevQuestion`, `advanceQuiz`, and keyboard handlers no longer
   carry the guard so keyboard rates fire immediately (the audit found
   the broad guard was silently swallowing Space-reveal → 3 = Good).
3. Swipe handler bails on **pointerup target** if it's a button (not just
   pointerdown)
4. Sticky positioning is scoped to `.btn-row.rate-row` ONLY. Do not
   broaden — generic `.btn-row` sticky causes options-overlap bugs.
5. "← Back" button + right-swipe for prev. History stack stores card
   IDs, not array indices.

### Reveal-gate (commit before reveal)
As of PR #42 the Reveal button is **disabled** until the user has
either picked an option or tapped the "🤷 I don't know — show me"
affordance. State: `state.committed` flag, reset on every nav site
that already resets `selectedOption`/`selectedOptions` (7 sites). The
gate is upstream of the touch-safety stack — don't move it. Keyboard
Space/Enter/R on a gated card toasts "Pick an answer or tap I don't
know first" and focuses the IDK button (no silent no-op).

### FSRS scheduler
`lib.mjs` ships FSRS-4 (Free Spaced Repetition Scheduler) — Anki
adopted it as default in 2024. Per-card state: `p.S` (stability,
days), `p.D` (difficulty, [1, 10]), `p.lastReviewedAt`. Legacy SM-2
fields (`p.ease`, `p.interval`) are still written as derived values
for backward-compat UI reads. `migrateProgress()` lazily inits S/D
from any legacy ease+interval. Rate buttons show FSRS-computed
intervals (typical first-Good ≈ 5 days, first-Easy ≈ 12 days).
`schedule(p, rate, now, capDays)` honors the exam-aware `capDays`
from `recordRating` so spacing contracts as the exam approaches.

### Dialog a11y pattern (PR #39)
Every modal (Welcome, Help, PIN, Feedback, Lock screen, Image zoom,
PDF viewer) uses the same pattern: `setAppInert(true)` on open +
`trapFocus(overlay)` for Tab cycling + focus restoration to the
trigger on close. Helpers in app.js. Don't open a new dialog without
both. `aria-live` announcer (`announce(msg, assertive)`) speaks
reveal/grade outcomes for SR users.

### Data conventions
- All questions are ORIGINAL, written from CompTIA's publicly published exam
  objectives — no real exam content or third-party question banks. Keep it that
  way (see `DISCLAIMER.md` / README "Legal" section).
- Question IDs are stable, source-tagged slugs: `c2q<N>` for Core 2 items,
  `c2-<topic>-<N>` for topic drills (e.g. `c2-acr-12-r`), `yt<N>` / `avw<N>`
  for other authored batches. A few legacy `p<n>q<n>` migration paths still
  exist in `app.js` for backward-compat but no shipped question uses them.
- `correct_short` (single-answer) MUST appear in `options` exactly,
  case-and-whitespace-insensitive. Otherwise the question is unwinnable.
- `correct_picks` (multi-answer) — each entry MUST appear in `options`.
- "Select TWO/THREE/N" question stems must match `correct_picks.length`.
- Explanation should start with `OBJ X.Y:` matching the `obj` field.
- PBQ qtype requires an `image` (or `images[]`).
- All checks above are gated by `tests/data.test.mjs`.

### State / storage
- IndexedDB stores: `progress`, `overrides`, `drawings`, `reference` (PDF).
  DB version 4. Bump on schema change.
- localStorage for prefs, streak, quiz history, exam dates, sync config.
- `state.overrides[qid]` merges with source data via `getQuestion(q)`.
  Never mutate the source data array.
- The reference-PDF feature stores user-uploaded PDFs per-exam in IDB.
  PDFs NEVER go in git — they're copyrighted personal-use material. See
  `.gitignore`.

### Don't commit copyrighted content
- `.gitignore` blocks `*.pdf`, `*.epub`, `*.docx`, etc.
- The repo's history was once polluted with practice exam PDFs and was
  scrubbed via `git filter-repo` + force-push. Don't reintroduce them.
- If a PDF must be referenced, use the in-app upload flow (Stats →
  Reference book) which puts it in IDB on the user's device only.

### Service worker
- Bump `CACHE` in `sw.js` on every release. Currently at `aplus-study-vNN`
  (v86 at time of writing; check `sw.js` for current).
- iOS PWAs are sticky; users may need to delete + reinstall the
  home-screen icon for major updates to take effect.
- As of PR #38 the SW caches **same-origin basic responses only**.
  Cross-origin opaque (pdf.js CDN) passes through to the browser
  cache without app-level persistence.
- As of PR #38 the app listens for an installed waiting SW and shows
  a tap-to-reload toast (`A new version is ready. Tap to reload.`).
  Pairs with the SW's `SKIP_WAITING` message handler.

### Branching
- Feature work: `claude/<short-name>-<random>` branches
- Always test + ask before pushing to `main`
- Never force-push without explicit user approval

## Test commands

```bash
# Unit + data tests (fast, no browser). 62 tests as of PR #45.
# Includes pure scheduler tests (FSRS invariants + SM-2 migration),
# escapeHtml, formatExplanation, orderDeck, content-fixes validator.
node --test tests/*.test.mjs
npm test                                # alias

# Syntax check (catches ES module parse errors)
npm run check

# Validate question data
node scripts/validate-questions.mjs data/core2/questions.json
# Or all exams: node scripts/validate-questions.mjs --all

# Concept-fixes XSS gate (runs in CI on every PR)
node scripts/validate-concept-fixes.mjs

# Browser smoke suite — committed under tests/smoke/ (was /tmp scratch
# until 2026-05-30). Drives the real app headless. puppeteer is a
# devDependency only; shipped app stays zero-runtime-deps.
npm install            # one-time: pulls puppeteer
npm run smoke          # regression assertions — pass/fail, gates CI
npm run smoke:perf     # cold-boot timings (informational)
npm run smoke:mobile   # 6-viewport responsive sweep + screenshots
```

When you fix a browser-observable bug, add an assertion to
`tests/smoke/regression.mjs` so it can't silently regress. The suite
runs LOCALLY only — wiring it into CI failed twice on puppeteer's
Chromium launch on the runner (couldn't read Actions logs to debug);
see the TODO in `.github/workflows/ci.yml`. Local `npm run smoke` is
the source of truth.

## When the user reports a "skip" bug they can't reproduce

The 5-layer click safety stack should make it impossible. If they're
still seeing it:
1. Suspect PWA cache first. Bump SW version, tell them to delete +
   reinstall the home-screen icon (iOS) or hard-refresh + clear site
   data (desktop / Android).
2. If it survives a clean install, look for a NEW path you haven't
   guarded — maybe a button you added without the timestamp check, or a
   layout change that re-introduced the sticky-overlap.

## More things worth knowing

- The `_revealedAt` timestamp is reused for both Study reveal and Quiz
  answer-recorded events. Don't introduce a separate timestamp.
- The deck-order cache in `filteredQuestions()` keys on filter state +
  a rolling **hash of the full id list**. PR #38 fixed a collision
  bug where the old "first 40 chars of joined IDs" key returned stale
  order when filter membership changed but length + leading IDs stayed
  identical. If you add a new filter, add it to the cache key string
  too.
- `concept-fixes.json` is **deferred from the cold path** (PR #46).
  `loadData()` awaits only `questions.json`; concept-fixes fetches in
  parallel via `state._conceptFixesPromise`. `renderReading()` awaits
  the promise if the user opens Reading before it's landed (shows a
  loading state + re-renders on resolve).
- The init() boot path defers non-critical installers
  (`installListenButton`, `installImageZoom`, `installWakeLock`,
  `installInputModeDetection`) **and** the SW registration via
  `requestIdleCallback` (PR #50). Critical path: tab clicks +
  `installSwipe` + `installKeyboard` + `setMode('study')` + (optional)
  `showWelcome`. Anything you add to init should default to the
  deferred path unless the user can plausibly invoke it in the first
  ~100 ms.
- `data/<exam>/concept-fixes.json` content is rendered raw via
  `innerHTML` (the markup IS the formatting). The CI gate
  (`scripts/validate-concept-fixes.mjs`) blocks `<script>` / `on*=` /
  `javascript:` / etc. before merge. The CSP in `_headers` is a
  second layer. Don't disable either.

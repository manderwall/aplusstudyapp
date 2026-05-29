# A+ Study app — orientation for future Claude sessions

This is a CompTIA A+ exam study PWA. Single-file JS modules, no build step.
Spaced-repetition flashcards + practice quizzes + reading sheets + stats.

## Where to find what

- **`docs/STARTER-KIT.md`** — distilled patterns for building similar apps.
  Read this first if you're being asked to build a new study/learning PWA.
- **`docs/DATA-FORMAT.md`** — schema + workflow for adding question packs.
  Read this before touching `data/**/*.json`.
- **`app.js`** — all UI + state + handlers. ~3500 lines, no framework.
- **`lib.mjs`** — pure helpers (SRS scheduling, formatting, shuffling).
  Side-effect-free; tested by `tests/pure.test.mjs`.
- **`scripts/validate-questions.mjs`** — content data validator. Exports
  `validate(items)` for tests + runs as CLI.

## Conventions baked into this repo

### Touch / click safety stack
Every reveal-style state change uses 5 layers. Don't remove any of them:
1. CSS `pointer-events: none` for **800ms** via `.card-just-revealed`
2. JS timestamp guard (`state._revealedAt`) inside `nextQuestion`,
   `prevQuestion`, rate handlers, keyboard space/enter, and the rate-row
   click handler
3. Swipe handler bails on **pointerup target** if it's a button (not just
   pointerdown)
4. Sticky positioning is scoped to `.btn-row.rate-row` ONLY. Do not
   broaden — generic `.btn-row` sticky causes options-overlap bugs.
5. "← Back" button + right-swipe for prev. History stack stores card
   IDs, not array indices.

### Data conventions
- Pretest-derived question IDs follow `p<pretest>q<num>` (e.g. `p1q36`).
  When a pretest re-uses a number with different content, append `_2`
  (e.g. `p3q18_2`). This is intentional, not a typo. NotebookLM-generated
  batches use `c2q<N>` instead.
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
- Bump `CACHE` in `sw.js` on every release. Currently at `aplus-study-vNN`.
- iOS PWAs are sticky; users may need to delete + reinstall the
  home-screen icon for major updates to take effect.

### Branching
- Feature work: `claude/<short-name>-<random>` branches
- Always test + ask before pushing to `main`
- Never force-push without explicit user approval

## Test commands

```bash
# Unit + data tests (fast, no browser)
node --test tests/*.test.mjs

# Validate just the data
node scripts/validate-questions.mjs --all

# Smoke tests (Puppeteer; requires `python3 -m http.server 8770`)
cd /tmp/smoke && node smoke.mjs        # full app walk
cd /tmp/smoke && node ghost3.mjs       # ghost-click protection
cd /tmp/smoke && node prev-id.mjs      # Prev navigation correctness
cd /tmp/smoke && node features.mjs     # readiness banner, drill, your-pick, desktop layout
```

## When the user reports a "skip" bug they can't reproduce

The 5-layer click safety stack should make it impossible. If they're
still seeing it:
1. Suspect PWA cache first. Bump SW version, tell them to delete +
   reinstall the home-screen icon (iOS) or hard-refresh + clear site
   data (desktop / Android).
2. If it survives a clean install, look for a NEW path you haven't
   guarded — maybe a button you added without the timestamp check, or a
   layout change that re-introduced the sticky-overlap.

## Two more things worth knowing

- The `_revealedAt` timestamp is reused for both Study reveal and Quiz
  answer-recorded events. Don't introduce a separate timestamp.
- The deck-order cache in `filteredQuestions()` keys on filter state +
  question IDs. If you add a new filter, add it to the cache key string
  too, or you'll get stale ordering.

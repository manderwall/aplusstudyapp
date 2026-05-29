# Building a study/quiz/learning app — patterns to lock in from day 0

Distilled from building this app and burning on real bugs. Each section is
something that took multiple iterations to get right — bake them in at
the start and you skip the burn.

> **Use this as a checklist when starting a new project.** Most items are
> 5–30 lines of code. The expensive part was figuring out *which* 5–30
> lines.

---

## Table of contents

1. [Day 0: project skeleton](#day-0-project-skeleton)
2. [Data validator (gate every commit)](#data-validator)
3. [Touch / click safety (the "skip" problem)](#touch--click-safety)
4. [State + storage architecture](#state--storage)
5. [PWA cross-platform basics](#pwa-basics)
6. [Accessibility primitives that actually take effect](#accessibility)
7. [Privacy + git hygiene](#privacy--git-hygiene)
8. [Test infrastructure](#tests)
9. [UX patterns that pay back](#ux-patterns)
10. [Common bug classes to validate against](#bug-classes)

---

## Day 0: project skeleton

```
/
├── .gitignore                 ← BEFORE first commit (see Privacy section)
├── index.html                 ← single-file PWA shell
├── app.js                     ← module-typed; all state + UI
├── lib.mjs                    ← pure helpers (test-safe, no DOM)
├── styles.css                 ← all styles, prefer custom-property theming
├── sw.js                      ← service worker (cache shell + content)
├── manifest.json              ← PWA install manifest
├── icons/                     ← 192 + 512 PNG required
├── data/                      ← content (gets validated)
├── images/                    ← bundled images referenced from data
├── scripts/
│   └── validate-questions.mjs ← run on every push
├── tests/
│   ├── pure.test.mjs          ← logic tests (node --test)
│   └── data.test.mjs          ← gates content quality
└── docs/
    └── DATA-FORMAT.md         ← schema + workflow for content uploads
```

Keep `lib.mjs` pure — no DOM, no global state. It becomes the test surface
for SRS scheduling, formatting, and shuffling. Everything else lives in
`app.js` until you have a reason to split.

Module type at the top of `app.js`:
```js
// app.js
import { schedule, formatExplanation, shuffleOptionsForCard } from './lib.mjs';
```

Loaded as a module:
```html
<script src="app.js" type="module"></script>
```

---

## Data validator

The single most important early investment. Catches a dozen classes of
content bugs the moment they land. Run it from `node --test` so it
gates merges automatically.

**Bug classes worth catching from day 1:**

| Check | Why it matters |
|---|---|
| Required fields present | Card can't render |
| Duplicate IDs | Progress data collides |
| Correct answer not in options | Question is **unwinnable** — every pick grades wrong. (This is the #1 silent bug.) |
| Question references "this picture" / "the figure" / "Using the image" / "labeled as X" / "floor plan" without bundled image | User sees broken question |
| Question text missing terminal punctuation | Almost always a paste truncation |
| OBJ tag in explanation doesn't match obj field | Card files under wrong objective |
| "Select TWO/THREE/N" stem doesn't match correct_picks length | User can't satisfy the picker |
| MA qtype without correct_picks of length ≥2 | Only one option highlights as correct |
| Image path doesn't exist on disk | Broken image |
| PBQ without image | Renders the "image not available" banner |
| Correct equals wrong-pick | Logic conflict |
| Empty / non-string options | Renders blank tappable rows |
| HTML tags or U+FFFD chars in plain text | Encoding bug or paste mistake |
| Long option that is a substring of the question | Extraction artifact |

Wire it in as a node test so it gates everything:

```js
// tests/data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/validate-questions.mjs';
import { readFileSync } from 'node:fs';

for (const file of findContentFiles()) {
  test(`${file}: passes data validator`, () => {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const { errors } = validate(data);
    assert.equal(errors.length, 0, errors.join('\n'));
  });
}
```

`scripts/validate-questions.mjs` exports a `validate(items)` function AND
runs as a CLI when invoked directly. Returns `{ errors, warnings, count }`.

---

## Touch / click safety

The "skip" problem: a user taps a button, the DOM re-renders, and a
stray click lands on a freshly-mounted button at the same position —
the card "skipped" without the user seeing the answer. We ate ~6
iterations on this. **Lock these in from the start:**

### Layer 1 — CSS pointer-events lock during state transition

```css
.card-just-revealed { pointer-events: none; }
```

Add the class when revealing (or any major state change) and remove
on a 800 ms `setTimeout`. **800 ms** specifically — covers iOS Safari's
lingering tap-delay even with `user-scalable=no`.

```js
// In your reveal handler:
state.revealed = true;
state._revealedAt = Date.now();
renderCard();

// In your render function:
const sinceReveal = Date.now() - (state._revealedAt || 0);
const cls = state.revealed && sinceReveal < 800 ? 'card card-just-revealed' : 'card';
// After render, remove the class on a timer:
const node = document.querySelector('.card-just-revealed');
if (node) setTimeout(() => node.classList.remove('card-just-revealed'), 800);
```

### Layer 2 — JS timestamp guard on every navigation function

```js
function nextQuestion() {
  if (Date.now() - (state._revealedAt || 0) < 800) return;  // ghost-click block
  // ...real logic
}
function prevQuestion() {
  if (Date.now() - (state._revealedAt || 0) < 800) return;
  // ...
}
```

Apply the same guard on **keyboard** shortcuts that advance the card
(space, enter, 1-4 rating keys). Don't rely on click handlers alone.

### Layer 3 — Swipe handler bails on interactive pointerup target

```js
main.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, input, a, .options')) return;  // bail on interactive
  sx = e.clientX; sy = e.clientY;
  tracking = true;
});
main.addEventListener('pointerup', (e) => {
  if (!tracking) return;
  tracking = false;
  // ⚠ ALSO bail on pointerup target — a touch that starts on card body
  // and ends on a button must not register as both a swipe AND a click.
  if (e.target.closest('button, input, a, .options')) return;
  const dx = e.clientX - sx, dy = e.clientY - sy;
  if (Math.abs(dx) > 100 && Math.abs(dx) > Math.abs(dy) * 2) {
    if (dx < 0) nextQuestion();
    else if (dx > 0) prevQuestion();
  }
});
```

100 px threshold + 2:1 horizontal:vertical ratio = no false swipes from
a normal tap.

### Layer 4 — Layout: never put two interactive rows at the same Y after a re-render

When you transition from "pre-answer" to "answered" UI, the new buttons
will appear roughly where the old ones were. Make sure their Y coords
don't overlap. **Watch out for `position: sticky`** — a sticky button
row will sit on top of options when content is tall and steal clicks.
Scope sticky to the specific row that needs it, never to all `.btn-row`.

### Layer 5 — Always provide an Undo affordance

After the card advances, the user might realize they tapped wrong.
Expose a "← Back" button on the next card AND honor right-swipe for
prev navigation. Store `state.history` as **card IDs**, not array
indices — the deck reorders mid-session and indices become stale.

```js
function nextQuestion() {
  if (qs[state.currentIndex]) state.history.push(qs[state.currentIndex].id);
  state.currentIndex = (state.currentIndex + 1) % qs.length;
}
function prevQuestion() {
  if (state.history.length > 0) {
    const prevId = state.history.pop();
    const idx = qs.findIndex(q => q.id === prevId);
    if (idx !== -1) state.currentIndex = idx;
    else state.currentIndex = (state.currentIndex - 1 + qs.length) % qs.length;
  }
}
```

---

## State + storage

### One state object, no framework

```js
const state = {
  mode: 'study',
  questions: [],
  progress: {},        // per-card SRS data (synced)
  overrides: {},       // per-card user edits (synced)
  filter: { obj: null, due: false, weakest: false, hard: false, search: '' },
  currentIndex: 0,
  revealed: false,
  history: [],         // card IDs, not indices
  _revealedAt: 0,      // timestamp guard
  // ...
};
```

Render functions take state and return HTML strings. `innerHTML =` for
the whole pane, then attach event handlers. No virtual DOM, no diffing
— just rebuild.

### Big things in IndexedDB, small things in localStorage

```js
const DB_NAME = 'app';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
      if (!db.objectStoreNames.contains('overrides')) db.createObjectStore('overrides');
      // Add stores; bump DB_VERSION when you add new ones in a release.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) { /* boilerplate */ }
async function idbPut(store, key, val) { /* boilerplate */ }
```

- localStorage: prefs (theme, font size, anxiety mode) — small, sync, fine
- IndexedDB: progress data, drawings, uploaded reference files
- Never put sensitive data in either without encryption at rest (PIN-derived
  AES-GCM key works well; key in memory only)

### Per-item user overrides merge with source data

```js
// Source data ships read-only. User edits live in overrides[id].
// getItem() merges them so the rest of the app doesn't care.
function getItem(item) {
  const o = state.overrides[item.id];
  return o ? { ...item, ...o } : item;
}
```

---

## PWA basics

### `index.html` head — covers iOS, Android, desktop

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">

<!-- Standard / Android Chrome / Edge / desktop -->
<meta name="mobile-web-app-capable" content="yes">
<meta name="application-name" content="My App">
<meta name="description" content="What it does, in one line">
<meta name="theme-color" content="#1a1a1a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="dark light">

<!-- iOS PWA install -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="My App">

<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<link rel="icon" type="image/png" href="icons/icon-192.png">
```

`user-scalable=no` is the simplest way to defeat iOS's 300 ms tap delay.

### `manifest.json` minimum

```json
{
  "name": "My App",
  "short_name": "MyApp",
  "start_url": "./?source=pwa",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#1a1a1a",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### Service worker pattern

```js
// sw.js
const CACHE = 'myapp-v1';   // bump on every release
const ASSETS = ['./', './index.html', './app.js', './styles.css', './lib.mjs', /* ... */];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy).catch(() => {}));
        return res;
      }).catch(() => cached)
    )
  );
});
```

**Bump `CACHE` on every release.** That triggers the activate handler to
delete old caches. iOS PWAs are sticky about service workers; expect
users to need to delete + reinstall the PWA on iOS to pick up major
changes.

---

## Accessibility

### CSS variables driven by `data-*` attributes on `<html>`

```js
// In app.js
function applyPrefs() {
  const html = document.documentElement;
  for (const k of ['theme', 'size', 'font', 'contrast', 'motion', 'anxiety']) {
    html.setAttribute(`data-${k}`, pref(k));
  }
}
```

```css
html[data-theme="dark"]  { --bg: #1a1a1a; --text: #f0f0f0; /* ... */ }
html[data-theme="light"] { --bg: #fff;    --text: #1a1a1a; /* ... */ }

html[data-contrast="high"] { --border: #fff; /* ... */ }
html[data-motion="reduced"] *, *::before, *::after {
  animation-duration: 0.001ms !important;
  transition-duration: 0.001ms !important;
}
```

### Font size that actually works

If your stylesheet uses `px` everywhere (most do), `html { font-size: ... }`
won't propagate. Use `zoom` on `body`:

```css
html[data-size="small"]  body { zoom: 0.9; }
html[data-size="medium"] body { zoom: 1; }
html[data-size="large"]  body { zoom: 1.15; }
html[data-size="xlarge"] body { zoom: 1.35; }
```

### Form controls don't inherit font-family

If you support dyslexia fonts:

```css
html[data-font="atkinson"] body { font-family: 'Atkinson Hyperlegible', system-ui, sans-serif; }
html[data-font="atkinson"] button,
html[data-font="atkinson"] input,
html[data-font="atkinson"] textarea,
html[data-font="atkinson"] select { font-family: inherit; }
```

### Touch detection — JS class beats `(any-pointer)` media queries

`(any-pointer: fine)` lies in headless tests, on iPad-as-Mac, and on
hybrid devices. Use a JS-set class:

```js
window.addEventListener('touchstart', () => {
  document.documentElement.classList.add('is-touch');
}, { once: true, passive: true });
```

```css
.kbd-hint { display: inline-block; }
html.is-touch .kbd-hint { display: none; }
```

### Keep a wake lock during long sessions

```js
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch {}  // permission denied; retry on next user gesture
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});
```

Acquire on entering "study" mode, release on leaving. iOS requires a user
gesture for the first acquisition.

---

## Privacy + git hygiene

### Day-0 `.gitignore`

```gitignore
# Personal study materials (NEVER commit — copyrighted)
*.pdf
*.epub
*.mobi
*.docx
*.xlsx
*.pptx

# Local secrets / environment
.env
.env.*
!.env.example
*.secret
*.key
secrets.json

# App's own export dumps (users download these for backup)
*-progress-*.json
*-overrides-*.json

# OS / editor junk
.DS_Store
Thumbs.db
*.swp
.vscode/
.idea/

# Build artifacts
node_modules/
dist/
build/
*.log
```

### Personal-use materials → upload to IndexedDB, never to git

Reference PDFs, textbooks, etc., should be uploaded once per device by
the user via a Settings panel. Stored in IndexedDB. Cross-device sync
of *page references* (small data) is fine; sync of the file itself is
not necessary and is a privacy/copyright minefield.

### If you mess up and commit copyrighted content

Untrack with `git rm --cached` + `.gitignore`. To actually scrub from
history, install `git-filter-repo` and:

```bash
git filter-repo --path-glob "*.pdf" --invert-paths --force
git push origin main --force        # ⚠ destructive; warn other clones
git push origin <feature> --force
```

This rewrites every commit hash since the offending blob landed. Anyone
with an existing clone has the bytes; only re-cloning from the rewritten
remote loses them. Public repos: GitHub may still serve orphaned objects
via direct commit URLs for a window of time.

---

## Tests

### Layer 1: pure logic (`tests/pure.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, defaultProgress } from '../lib.mjs';

test('schedule again: relearn + ease drops', () => {
  const p = defaultProgress();
  p.ease = 2.5; p.interval = 10;
  schedule(p, 'again', 1_700_000_000_000);
  assert.equal(p.interval, 0);
  assert.ok(Math.abs(p.ease - 2.3) < 1e-9);
});
```

Run with `node --test tests/`. Fast, no browser.

### Layer 2: data validator (`tests/data.test.mjs`)

Auto-discovers every `data/**/*.json` and runs the validator. Gates the
data quality at PR time.

### Layer 3: smoke / interaction (puppeteer)

Spin up a static server, walk the app, assert key UI states. Use
synthetic pointer events for touch/swipe testing — Puppeteer's
touchscreen API doesn't always fire equivalent pointer events:

```js
await page.evaluate(() => {
  const fire = (t, x, y) => target.dispatchEvent(new PointerEvent(t, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
    clientX: x, clientY: y, button: 0,
  }));
  fire('pointerdown', 100, 100);
  fire('pointermove', 200, 100);
  fire('pointerup', 300, 100);
});
```

### Layer 4: GitHub Actions

`.github/workflows/test.yml`:
```yaml
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node --test tests/
```

Catches data + logic regressions before they hit main. Bake in early.

---

## UX patterns that pay back

### Welcome dialog with daily-plan tasks

Boot the app into a welcome overlay on first visit (and optionally on
every load) showing 2-3 contextual actions: "you have N due", "your
weakest 10", "15-minute focus session". Drop the user straight into
study by tapping any task. Set a `welcomeDismissed` flag in
localStorage to suppress it after first.

### Top bar for cross-mode controls; bottom tab bar for major modes

- Top: theme toggle, focus toggle, help, listen (TTS), settings access
- Bottom: 4-5 tabs for major flows (Study, Quiz, Reading, Stats)

Keep the top bar visible everywhere — controls that should work in any
mode (read-aloud, focus, theme) belong there.

### Toast notifications, not `alert()`

```js
function toast(msg, kind = 'info', ms = 3500) {
  const host = document.getElementById('toast-host') || createHost();
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 200); }, ms);
}
```

`alert()` is awful for AuDHD users and blocks the main thread.

### Confetti for genuine wins

Reserve celebrations for actual milestones — clearing the due queue,
mastering an objective, finishing a quiz. If everything is a celebration,
nothing is.

### Progress HUD always visible

Top-right of the header. Shows: exam countdown, due count, current
session timer. Update on every state change with `updateHUD()`.

### Stats screen is your dashboard

Don't hide it. Per-objective mastery (tappable to drill), exam-readiness
banner, last-90-days heatmap, quiz history chart, settings, exam dates.

---

## Bug classes

Things to write a check for in your validator from day 1:

```
[content-quality]
□ correct answer not present in options
□ duplicate options after normalize (lowercase + collapse whitespace)
□ empty / non-string options
□ options that are substrings of the question text (extraction artifacts)
□ question text references "this picture" / "the figure" without an image
□ question missing terminal . ? or !
□ "Select TWO/THREE" stem doesn't match correct_picks count
□ MA qtype without correct_picks of length ≥2
□ stray HTML tags or U+FFFD chars in plain text
□ image path that doesn't exist on disk
□ correct_short equals wrong_pick

[metadata-quality]
□ required fields present (id, qtype, question, explanation)
□ no duplicate IDs
□ obj field matches "N.M" pattern
□ obj field matches "OBJ X.Y:" prefix in explanation

[runtime-quality — test in puppeteer]
□ tap on Reveal does NOT also advance the card
□ tap on rate button within 800 ms of reveal is blocked
□ keyboard double-press of space does NOT skip past reveal
□ Prev navigates by ID (deck reorders don't break it)
□ swipe-from-card-body to button does NOT both advance and click
□ font-size setting actually changes rendered size
□ font-family setting reaches form controls
```

---

## Final thoughts

The patterns that hurt the most to learn:

1. **`escapeHtml` MUST escape quotes**, not just `<`, `>`, `&`. `"` inside
   `data-attribute="..."` terminates the attribute and silently
   truncates the value. We had unwinnable questions for weeks because
   options like `9.6" x 9.6"` round-tripped as just `9.6` through the
   click handler.

2. **Sticky positioning is dangerous.** If you have a `.btn-row` that's
   sticky-bottom for one purpose, a new `.btn-row` you add later will
   inherit the sticky and overlap content. **Scope to a specific class**
   (`.rate-row`, not `.btn-row`).

3. **Index ≠ ID.** History stacks must hold IDs. Anything that survives
   a re-sort must be ID-based.

4. **800 ms is the magic number** for iOS tap-delay margin. 350 wasn't
   enough; 500 was tight; 800 covers slow devices without feeling
   sluggish.

5. **Validate from day 0.** Every check you write before content lands
   is one you don't have to write later under deadline pressure.

6. **Store user files locally, sync only metadata.** PDFs, textbooks,
   personal materials live in IndexedDB on each device. Page references,
   ratings, settings sync. The split is privacy-respecting AND
   bandwidth-light.

7. **`node --test` + a validator + a puppeteer smoke is enough**. You
   don't need a test framework. You don't need Jest. The native runner
   is fast and runs anywhere.

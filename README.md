# A+ Study — Personal iPad + iPhone Study App

A Progressive Web App (PWA) for Amanda. CompTIA A+ Core 1 (220-1201) study tool built from your 119 missed pretest questions. Installs to home screen on **iPad** (full Pencil support) **or iPhone** (thumb-friendly layout, swipe to advance).

## What's in it

- **Study mode** — flashcards with spaced repetition (again / hard / good / easy). Cards come back at increasing intervals based on how well you did; "again" brings it back in a minute, "easy" pushes it out days.
- **Quiz mode** — same questions but tracked as right/wrong for accuracy stats. Wrong answers are scheduled for quick review; right answers graduate out.
- **Reading mode** — your concept-fix sheets for 23 objectives (all 5 pretests' weak areas).
- **Stats mode** — mastery bars per OBJ, total accuracy, reset button.
- **Apple Pencil scratch pad** — beneath every question on iPad (shown at widths >600px), pressure-sensitive canvas for subnet math, diagrams, etc. Hidden on iPhone portrait to keep the card readable.
- **Filter by OBJ or "Due"** — scroll the filter bar to drill a specific objective, or toggle the green **Due (N)** chip to see only cards scheduled for review right now.
- **Swipe to advance** — swipe left on Study/Quiz cards to skip to the next question. Light haptic tap on supported devices.
- **Offline** — service worker caches everything. Once installed, works in airplane mode.
- **Progress persists** — IndexedDB stores ratings, ease, and next-due timestamps between sessions.

## Installing to home screen (iPad or iPhone)

### 1. Host the files somewhere HTTPS

PWAs need HTTPS for the service worker (offline mode) to work. Three easy options:

**Easiest — Netlify drop:**

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop) in Safari or any browser
2. Drag the entire `studyapp/` folder onto the page
3. You get a URL like `https://random-name-123.netlify.app` — instant HTTPS
4. Done. No account required for the initial drop, but sign up (free) to keep it long-term.

**Alternative — GitHub Pages (free, needs a GitHub account):**

1. Create a new public repo
2. Upload the contents of `studyapp/` to the root
3. Settings → Pages → Source: `main` branch, root folder
4. Wait ~1 min, you'll get `https://<username>.github.io/<repo>/`

**Local testing on your Mac only:**

```bash
cd studyapp
python3 -m http.server 8000
```

Then visit `http://localhost:8000` in Safari on your Mac. Note: Service worker won't fully register on `http://` — that's fine for local testing, but **install on iPad requires HTTPS** (Netlify/GitHub).

### 2. Install to home screen

Works the same way on iPad and iPhone:

1. Open the HTTPS URL in **Safari** (not Chrome — iOS restricts PWA install to Safari)
2. Tap the **Share** button (square with up arrow)
3. Scroll down, tap **"Add to Home Screen"**
4. Name it "A+ Study" (or whatever) → Add
5. App icon appears on home screen. Tap it — opens full-screen, no Safari UI.

Progress is stored per-device. If you install to both iPad and iPhone, they don't sync — each keeps its own study history (see "Cross-device sync" below for a fix).

### 3. First launch

- Wait a second for the service worker to register. Once it has, you can go fully offline.
- Go to the **Study** tab, pick an OBJ filter or work through all 119 questions.
- Tap **Reveal answer** → rate how you did → next question. Progress saves automatically.
- Come back later and tap the green **Due** chip to drill only cards scheduled for review.

## Data schema (for adding options + PBQ images)

Each question in `data/questions.json` is an object:

```jsonc
{
  "id": "p1q3",
  "pretest": 1,
  "qnum": 3,
  "obj": "2.5",
  "qtype": "Multiple Choice",     // or "Multiple Answer" or "PBQ"
  "question": "Which of...",
  "wrong_pick": "DSL",             // the option you picked on the pretest
  "correct_short": "",
  "explanation": "OBJ 2.5: ...",

  // Optional — add these to enhance a card:
  "options": ["Cable modem", "DSL", "ONT", "SDN"],   // shown above the Reveal button
  "image":   "images/p1q3.png",                       // single figure
  "images":  ["images/p1q3-a.png", "images/p1q3-b.png"]  // or multiple
}
```

- **`options`** — an array of strings. When present, they're rendered as a lettered list (A, B, C, D) above the Reveal button. Absent = the old behavior (think-then-reveal). The app doesn't score clicks on options; you still self-rate.
- **`image` / `images`** — paths relative to the project root. Drop PNG/JPG into an `images/` folder and reference it here. PBQs without an image show a yellow "image not available" banner so you can still read the explanation.

To backfill options and PBQ figures, you'll need to re-extract from the source pretest docs (the current `questions.json` was extracted from plaintext where options weren't captured). Add them question-by-question or re-run the extraction script with an updated parser.

## Vibe-coding additions

If you want to extend it with Claude Code, here's the structure:

```
studyapp/
├── index.html           # Three-tab shell
├── styles.css           # iPad-first dark/light auto
├── app.js               # All logic (~400 lines, ES modules)
├── manifest.json        # PWA install config
├── sw.js                # Service worker (offline cache)
├── data/
│   ├── questions.json   # 119 questions with OBJ, question, wrong pick, explanation
│   └── concept-fixes.json  # 23 OBJ fix sheets as HTML strings
└── icons/
    ├── icon-180.png     # Apple touch icon
    ├── icon-192.png     # Web manifest
    └── icon-512.png     # Web manifest (high-res)
```

### Ideas for extensions

- **Multiple-choice options + PBQ images:** the rendering is already wired up (see "Data schema" above). What's missing is the content — backfill it from your source pretests.
- **Import new pretests:** Drop a new `p6_content.txt` into the extractor Python script, regenerate `questions.json`.
- **Audio explanations:** Use the Web Speech API (`speechSynthesis`) to read out the correct answer when revealed.
- **Search:** Add a search box that filters on question text.
- **Export to Anki:** Convert `questions.json` → Anki `.apkg` via `genanki` Python library.
- **Drawing save:** Extend the scratchpad to save the canvas PNG per question to IndexedDB.
- **Cross-device sync:** Add Supabase free tier — write progress to a remote table, read on launch.
- **Tune the SRS:** defaults live in `schedule()` in `app.js` — cap is 30 days so exam-prep doesn't schedule past the exam. Change `MAX_INTERVAL_DAYS` if you want longer intervals after the test.

### Things to know about iOS PWAs

- Storage is sandboxed per-origin. If you re-deploy to a new URL, you lose progress. **Keep the same Netlify/GitHub Pages URL for a given exam cycle.**
- Safari may evict PWA storage if the app hasn't been opened in ~30 days and the device is low on space. Low risk for you this week.
- Push notifications require iOS 16.4+ AND the app must be installed to home screen first. Not wired up in this scaffold.
- No `localStorage`/`sessionStorage` quota issues — this app uses IndexedDB which has much higher limits (~500 MB).

## Known limitations

- **Multiple-choice options aren't in the default dataset.** The extraction grabbed question text, the wrong pick, and the explanation — not the four options. The app will render them if you add an `"options": [...]` array to any question (see "Data schema"); until then Study/Quiz are "think, then reveal."
- **PBQ images aren't in the default dataset.** Same reason — PBQs reference motherboard diagrams, router dashboards, etc. that weren't captured. The app shows a clear yellow banner for PBQs without images and tells you where to drop the file. 10 of 119 questions are PBQs.
- **No pretest-6 import flow in the UI.** When you take more pretests, run `extract-text pretest_N.docx` and re-run the extraction script — or ask Claude Code to do it.
- **Scratch pad drawings don't persist.** Per-question saving is a future feature.
- **No search.** If you need to find a specific question, use the OBJ filter.
- **No cross-device sync.** iPhone and iPad keep separate progress (each IndexedDB is origin+device scoped).

## The path I'd take this week

1. Deploy once (Netlify or GitHub Pages) → install to **both iPad and iPhone** so you can study anywhere.
2. Day 1–5 evenings (iPad w/ Pencil): use Study mode, filter to one OBJ at a time, aim for all 119 marked "good" by Day 6.
3. Day 1–5 micro-sessions (iPhone, waiting-in-line mode): toggle the **Due** chip, swipe through whatever's scheduled — usually 5–15 cards at a time.
4. Day 6: Quiz mode on all 119, accuracy target 85%+.
5. Day 7: Reading mode only, no new reps. Early bedtime.
6. Exam day.

Post-exam: this becomes your Core 2 (220-1202) scaffold — you'll already have the infrastructure. Just re-run the extraction against Core 2 pretests and replace `questions.json`.

# A+ Study — Personal iPad Study App

A Progressive Web App (PWA) for Amanda. CompTIA A+ Core 1 (220-1201) study tool built from your 119 missed pretest questions.

## What's in it

- **Study mode** — flashcards with self-rating (again / hard / good / easy). Tracks mastery per question.
- **Quiz mode** — same questions but tracked as right/wrong for accuracy stats.
- **Reading mode** — your concept-fix sheets for 23 objectives (all 5 pretests' weak areas).
- **Stats mode** — mastery bars per OBJ, total accuracy, reset button.
- **Apple Pencil scratch pad** — beneath every question, pressure-sensitive canvas for subnet math, diagrams, etc. Tap the Eraser toggle or Clear to reset.
- **Filter by OBJ** — scroll the filter bar in Study and Quiz modes to drill a specific objective.
- **Offline** — service worker caches everything. Once installed, works in airplane mode.
- **Progress persists** — IndexedDB stores ratings/accuracy between sessions.

## Installing on iPad (the whole point)

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

### 2. Install to iPad home screen

1. Open the HTTPS URL in **Safari on your iPad** (not Chrome — iOS restricts PWA install to Safari)
2. Tap the **Share** button (square with up arrow)
3. Scroll down, tap **"Add to Home Screen"**
4. Name it "A+ Study" (or whatever) → Add
5. App icon appears on home screen. Tap it — opens full-screen, no Safari UI.

### 3. First launch

- Wait a second for the service worker to register. Once it has, you can go fully offline.
- Go to the **Study** tab, pick an OBJ filter or work through all 119 questions.
- Tap **Reveal answer** → rate how you did → next question. Progress saves automatically.

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

- **Spaced repetition (SM-2 or FSRS):** Replace the simple `status: new/learning/good` in `state.progress[id]` with proper intervals. The `lastSeen` timestamp is already recorded.
- **Import new pretests:** Drop a new `p6_content.txt` into the extractor Python script, regenerate `questions.json`.
- **Audio explanations:** Use the Web Speech API (`speechSynthesis`) to read out the correct answer when revealed.
- **Daily review schedule:** Show only cards due today based on SM-2 intervals.
- **Export to Anki:** Convert `questions.json` → Anki `.apkg` via `genanki` Python library.
- **Drawing save:** Extend the scratchpad to save the canvas PNG per question to IndexedDB.
- **Cross-device sync:** Add Supabase free tier — write progress to a remote table, read on launch.

### Things to know about iOS PWAs

- Storage is sandboxed per-origin. If you re-deploy to a new URL, you lose progress. **Keep the same Netlify/GitHub Pages URL for a given exam cycle.**
- Safari may evict PWA storage if the app hasn't been opened in ~30 days and the device is low on space. Low risk for you this week.
- Push notifications require iOS 16.4+ AND the app must be installed to home screen first. Not wired up in this scaffold.
- No `localStorage`/`sessionStorage` quota issues — this app uses IndexedDB which has much higher limits (~500 MB).

## Known limitations of v1

- **Quiz mode doesn't show multiple-choice options** — you see only the question and the (one) wrong pick from your pretest history. You think of your answer, reveal, then self-rate. This is deliberate: generating realistic distractors from 4 options would require either re-parsing the original pretests OR picking random wrong answers from other questions (both add complexity).
- **No pretest-6 import flow in the UI.** When you take more pretests, run `extract-text pretest_N.docx` and re-run the extraction script I built — or ask Claude Code to do it.
- **Scratch pad drawings don't persist.** Per-question saving is a future feature.
- **No search.** If you need to find a specific question, use the OBJ filter.

## The path I'd take this week

1. Netlify-drop the folder today → install to iPad.
2. Day 1-5 evenings: use Study mode, filter to one OBJ at a time, aim for all 119 marked "good" by Day 6.
3. Day 6: Quiz mode on all 119, accuracy target 85%+.
4. Day 7: Reading mode only, no new reps. Early bedtime.
5. Exam day.

Post-exam: this becomes your Core 2 (220-1202) scaffold — you'll already have the infrastructure. Just re-run the extraction against Core 2 pretests and replace `questions.json`.

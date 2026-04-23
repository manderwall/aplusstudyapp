# A+ Study — Personal iPad + iPhone Study App

A Progressive Web App (PWA) for Amanda. CompTIA A+ Core 1 (220-1201) study tool built from your 119 missed pretest questions. Installs to home screen on **iPad** (full Pencil support) **or iPhone** (thumb-friendly layout, swipe to advance).

## What's in it

- **Study mode** — flashcards with spaced repetition (again / hard / good / easy). Cards come back at increasing intervals based on how well you did; "again" brings it back in a minute, "easy" pushes it out days.
- **Quiz mode** — same questions but tracked as right/wrong for accuracy stats. Wrong answers are scheduled for quick review; right answers graduate out.
- **Reading mode** — your concept-fix sheets for 23 objectives (all 5 pretests' weak areas).
- **Stats mode** — mastery bars per OBJ, accuracy, shuffle toggle, export/import progress, reset.
- **Readable explanations** — long CompTIA explanations are auto-split into a lead answer + supporting paragraphs, with any "For the exam..." tip pulled into its own callout. No more walls of text.
- **Apple Pencil scratch pad** — beneath every question on iPad (shown at widths >600px), pressure-sensitive canvas for subnet math, diagrams, etc. Hidden on iPhone portrait to keep the card readable.
- **Filter by OBJ, "Due", or search** — scroll the filter bar to drill a specific objective, toggle the green **Due (N)** chip to see only cards scheduled for review, or type in the search box to narrow by question/explanation text.
- **Shuffle** — optional random order, toggled from Stats. Persists across sessions.
- **Swipe / keyboard / prev** — swipe left on Study/Quiz cards to skip; use the **← Prev** button to go back; desktop keyboard shortcuts (see below).
- **Theme toggle** — 🌓 button in the header cycles Auto / Light / Dark, saved to your device.
- **Export / import progress** — download your progress as JSON from Stats, import it on another device or after a browser wipe.
- **Offline** — service worker caches everything. Once installed, works in airplane mode.
- **Progress persists** — IndexedDB stores ratings, ease, and next-due timestamps between sessions.

## Keyboard shortcuts (desktop study)

| Key | Action |
|---|---|
| `Space` / `Enter` / `R` | Reveal answer. If already revealed: Study mode advances with a "good" rating; Quiz mode just skips (explicit right/wrong tap is required to record a quiz result). |
| `1` / `2` / `3` / `4` | Rate: Again / Hard / Good / Easy (Study mode, after reveal) |
| `→` / `K` / `N` | Next question |
| `←` / `J` / `P` | Previous question |
| `T` | Cycle theme (auto / light / dark) |
| `F` | Toggle Focus Mode (hides chrome) — `Esc` also exits |

## AuDHD-friendly features

Built to be flexible, because sensory needs flip between *understimulated* (ADHD-side: needs visual engagement) and *overstimulated* (autism-side: needs calm, minimal UI). Everything here is togglable from **Stats → Accessibility**, **Stats → Focus session**, and the 🔒 / 🌓 header buttons.

- **Focus Mode** (🔒 button or `F`) — hides the tab bar, filter chips, search box, progress HUD, and card meta tags. Just the question. Great when scrolling chrome becomes noise.
- **Focus Sessions** (Stats → Focus session):
  - **Time-boxed** — 5 / 15 / 25 min with a visible ⏱ countdown in the header (time-blindness).
  - **Card-count micro-goals** — 1 / 3 / 5 / 10 cards. Session ends automatically when the count is hit. "One card" is a valid commitment; you can always do one.
  - End-of-session summary celebrates whatever you did. "End now" exits early without guilt.
- **Anxiety Mode** — hides accuracy %, progress counters, mastery bars, seen counts. Keeps streak + session timer. Turn on when numbers feel like judgement.
- **Focus sound** — built-in white / pink / brown noise generator via Web Audio (no downloads, no tracking). Pink is gentler than white; brown is "the one that sounds like a waterfall."
- **Shake to shuffle** — iPhone only. Toggle in Accessibility, grant motion permission when prompted, then shake the phone to flip shuffle on/off mid-study (with a haptic confirmation).
- **Text size** — S / M / L / XL. Scales the whole app.
- **Font** — System default, **Atkinson Hyperlegible** (open-source, designed for low vision, loaded from Google Fonts), or **OpenDyslexic** (weighted letter bottoms to resist letter-swapping).
- **High contrast** — pure-black background + brighter text/borders. Reduces visual clutter.
- **Reduce motion** — kills transitions and animations. The OS-level `prefers-reduced-motion` setting is also respected automatically.
- **Haptic feedback** — on by default (a tiny tap on every rate). Toggle off if vibrations are distracting.
- **Daily streak + Today counter** in Stats — dopamine-friendly "I did a thing" signal without a full leaderboard grind.
- **Scratch pad** — doubles as a drawing / fidget space on iPad while you think. Hidden on iPhone portrait to cut clutter.
- **Auto-sync** — if you've set up Supabase, flip "Auto-sync" on and every rated card quietly syncs 5s later. No "did I forget to push?" worry.

Design principles that shaped this:

1. **Everything is a toggle, nothing is a mandate.** Today you might want haptics + motion + high-contrast; tomorrow you might not. Preferences persist per device.
2. **Reduce decision load.** The "default next action" (Reveal, Skip, a rating button) is always visually primary, always in the same spot.
3. **Time is visible.** Session countdown + card progress + due count are all numeric — no guessing "how long have I been at this?"
4. **Low-stakes sessions.** You can start a 5-minute session. You can end it early. Rating one card counts as "showing up."

None of this is medical advice — it's just options that map to patterns in the neurodivergent design literature. Use what helps, ignore what doesn't.

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

## Adding multiple-choice options + PBQ images

Two ways to fill in the data the original extraction missed:

### Option A — In-app editor (no source files needed)

Every Study/Quiz card now has a small **✏️ Edit** button in its meta row. Tap it to open a form where you can:

- Paste the four MC options (one per line)
- Add an image URL (`images/p1q36.png`, or any HTTPS URL)

Saves are stored in IndexedDB as **overrides** — they don't touch `data/questions.json`. An "✏️ Edited" tag appears on cards you've edited so you can see your work. Stats → **Question edits → Export** dumps your overrides as JSON; **Import** loads them back. They sync via cloud too (see below).

This is the fastest path: open a card, type the four options from your pretest screenshot, save, move on.

### Option B — Edit `data/questions.json` directly (permanent, ships in the repo)

If you want the options/images committed for everyone (or you have many to add at once), edit `data/questions.json`. Each entry is an object:

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

In-app edits (Option A above) live in IndexedDB and are merged onto the base question at render time, so an in-app edit overrides the JSON for that question.

## Cloud sync (Supabase)

Optional. Lets iPad + iPhone share progress and edits without exporting JSON manually.

### One-time Supabase setup

1. Create a free Supabase project at https://supabase.com.
2. In the SQL editor, run:

```sql
create table if not exists progress (
  sync_key text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

-- Allow the anon key to read/write rows (anyone with the URL + sync_key can sync,
-- which is fine for a personal study app — keep your sync_key secret-ish).
alter table progress enable row level security;
create policy "anon read"  on progress for select using (true);
create policy "anon write" on progress for insert with check (true);
create policy "anon update" on progress for update using (true);
```

3. In **Settings → API**, copy:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon / public key** (the long `eyJ…` JWT)

### Configure on each device

1. Open the app → **Stats** → **Cloud sync (Supabase)**
2. Paste the URL, the anon key, and pick a **Sync key** — any string you want, must be the same on every device (e.g. `amanda-aplus-2026`).
3. Tap **Save**.

### Use it

- **⬆ Push** — write your local progress + question edits to the cloud, replacing whatever was there for your sync_key.
- **⬇ Pull** — overwrite local progress + edits with what's in the cloud.

Workflow: study on iPad → Push. Open iPhone → Pull. Study on iPhone → Push. Last write wins; there's no auto-merge.

### Privacy

Your sync_key is the only "auth" — anyone who knows your project URL, anon key, and sync_key can read/write your row. The anon key is meant to be embedded in clients, but it's still worth not committing it to a public repo and using a non-obvious sync_key.

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
- **Auto-sync:** the current Supabase integration is manual push/pull. Could call `cloudPush()` on every save (debounced) for true auto-sync.
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
- **Cross-device sync is manual.** iPhone and iPad keep separate progress unless you wire up Supabase (see "Cloud sync" below) and tap Push/Pull. Stats → Export/Import works as a no-backend alternative.

## The path I'd take this week

1. Deploy once (Netlify or GitHub Pages) → install to **both iPad and iPhone** so you can study anywhere.
2. Day 1–5 evenings (iPad w/ Pencil): use Study mode, filter to one OBJ at a time, aim for all 119 marked "good" by Day 6.
3. Day 1–5 micro-sessions (iPhone, waiting-in-line mode): toggle the **Due** chip, swipe through whatever's scheduled — usually 5–15 cards at a time.
4. Day 6: Quiz mode on all 119, accuracy target 85%+.
5. Day 7: Reading mode only, no new reps. Early bedtime.
6. Exam day.

Post-exam: this becomes your Core 2 (220-1202) scaffold — you'll already have the infrastructure. Just re-run the extraction against Core 2 pretests and replace `questions.json`.

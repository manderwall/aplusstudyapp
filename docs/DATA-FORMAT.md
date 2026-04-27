# Adding a question pack

This is the contract for any `data/**/questions.json` file. The validator
runs automatically as part of `node --test tests/`, and `node
scripts/validate-questions.mjs --all` runs it standalone. **A failing
validator blocks the deploy.**

## Where files live

```
data/
  questions.json            ← Core 1 (the active deck for this exam)
  concept-fixes.json        ← Reading-mode prose per objective
  core2/
    questions.json          ← optional Core 2 deck
    concept-fixes.json
  <future-exam>/
    questions.json
    concept-fixes.json
images/
  <any-png-or-jpg>          ← referenced by `image:` / `images:` fields
```

The app picks up any subfolder under `data/` automatically — no code
changes needed to add a new exam. To switch decks at runtime, the user
uses the Stats → "Active exam" toggle.

## Question schema (one entry in the top-level array)

```jsonc
{
  "id":           "p1q36",                    // REQUIRED. Unique. Convention: p<pretest>q<num>
  "pretest":      1,                          // optional metadata
  "qnum":         36,
  "obj":          "3.3",                      // REQUIRED. CompTIA objective number "N.M"
  "qtype":        "Multiple Choice",          // REQUIRED. "Multiple Choice" | "Multiple Answer" | "PBQ"
  "question":     "Which …?",                 // REQUIRED. MUST end with . ? or !
  "options":      ["A", "B", "C", "D"],       // REQUIRED for graded questions, ≥2 entries, no duplicates
  "correct_short":"B",                        // REQUIRED for Multiple Choice / PBQ. MUST be exactly one of the options.
  "correct_picks":["A", "C"],                 // REQUIRED for Multiple Answer. ≥2 entries, all in options.
  "wrong_pick":   "D",                        // optional. The pretest-miss the user originally picked.
  "wrong_picks":  ["A", "D"],                 // optional. Multiple miss history.
  "explanation":  "OBJ 3.3: …",               // REQUIRED. Should start with "OBJ <obj>:" matching the obj field.
  "image":        "images/p1q36_mobo.png",    // optional. REQUIRED for qtype=PBQ. Path must exist on disk.
  "images":       ["images/x.png"],           // optional alternative — array of paths
  "sources":      [{"pretest":1,"qnum":36}]   // optional dedupe trace
}
```

## What the validator catches

If you add a pack and any of these are wrong, the test suite fails and
you'll see a clear message like
`p4q55: question references a visual ("in this picture") but no image is bundled`:

| Problem | Why it matters |
|---|---|
| Missing `id`, `obj`, `qtype`, `question`, or `explanation` | The card can't render |
| Duplicate `id` across questions | Progress data collides |
| `obj` not in `N.M` form | Per-objective filtering breaks |
| Explanation `OBJ X.Y:` prefix doesn't match `obj` | Card files under wrong objective; user can't find it via filter |
| Question text doesn't end with `.`, `?`, or `!` | Almost always a paste truncation |
| Question references a visual ("this picture", "in the figure", "floor plan", "Using the image", `labeled as X`) but no `image` is bundled | User sees a broken question with no way to answer |
| `qtype: PBQ` but no `image` | Falls back to "image not available" banner |
| `correct_short` not present in `options` | Question is **unwinnable** — every pick grades as wrong (this was the [escapeHtml-quote bug](https://example.com) class) |
| Any `correct_picks` value not in `options` | Same — partial unwinnability for MA |
| `correct_short` equals `wrong_pick` | Logic conflict |
| `wrong_pick` not in `options` | Pretest-miss footnote points to a non-existent option |
| Duplicate `options` (after case-and-whitespace normalization) | Two of the four choices look the same |
| Empty / non-string option | Renders as a blank tappable row |
| Long option that's a substring of the question | Almost always an extraction artifact (the parser pulled a sentence into the options array) |
| `qtype: Multiple Answer` without `correct_picks[]` of length ≥2 | Only one option highlights as correct |
| Question stem says "Select TWO/THREE/N" but `correct_picks.length` doesn't match | The user can't satisfy the picker |
| `image` / `images[]` path that doesn't exist on disk | Broken image when the card renders |
| Stray HTML tags or `U+FFFD` replacement characters in any text field | Encoding bug or paste mistake |

## Workflow for a new pack

```bash
# 1. Drop your questions.json into data/<exam>/
# 2. Drop any referenced images into images/
# 3. Run validation
node scripts/validate-questions.mjs data/<exam>/questions.json

# 4. Run the test suite — does data validation as part of it
node --test tests/pure.test.mjs tests/crypto.test.mjs tests/data.test.mjs

# 5. Open the app and switch to the new exam in Stats → Active exam.
```

If the validator complains about a question text that LOOKS conceptual
("the image on the monitor changes per second" = refresh rate, not a
literal image), check whether the trigger phrase is actually a deictic
reference. If not, rewrite the question to be self-contained — usually
it's worth the rewrite anyway, because users who don't see the image
need to be able to answer.

## Adding `concept-fixes.json` content

Free-form HTML in `content`, free-form `title`. Two reserved keys for
priority sections (rendered above numeric OBJ entries in Reading):

```jsonc
{
  "mnemonics":      { "title": "...", "content": "<HTML>" },  // memory aids cheat sheet
  "troubleshooting":{ "title": "...", "content": "<HTML>" },  // CompTIA 6-step
  "1.1":            { "title": "Mobile Device Hardware", "content": "<HTML>" },
  "2.5":            { "title": "Networking Hardware",    "content": "<HTML>" },
  // ...
}
```

The app sorts numerically by `N.M`. Any non-numeric key besides the two
reserved ones will sort to the end — fine for "appendix"-style sheets.

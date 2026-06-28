# Portfolio framing

Ready-to-use copy for sharing this project (LinkedIn, résumé, GitHub). Lead with
the **engineering**; mention the certification as proof you know the domain. Keep
it **non-commercial** (no ads, paywall, or "buy me a coffee") — that, plus the
[disclaimer](DISCLAIMER.md), is what keeps the trademark use clearly fair.

> Tip: put a **screenshot of the app** (not a CompTIA logo) at the top of any
> post, and pin this repo on your GitHub profile.

---

## LinkedIn post

> 🎉 I'm officially **CompTIA A+ certified** (passed both Core 1 and Core 2)!
>
> Instead of *just* studying, I built the tool I studied with: **A+ Study**, an
> offline-first study PWA — and it turned into the engineering project I'm most
> proud of.
>
> A few things under the hood:
> • **Zero dependencies, no build step** — ~5k lines of vanilla ES-module
>   JavaScript. Clone and open `index.html`.
> • **FSRS-4 spaced repetition** — the scheduling algorithm Anki adopted as its
>   default, implemented from scratch and unit-tested.
> • **Real client-side encryption** — an optional PIN derives an AES-GCM-256 key
>   (PBKDF2, 310k iterations) and encrypts everything at rest. The PIN is never
>   stored.
> • **Offline-first PWA** — a service worker precaches the shell + question bank,
>   so it runs in airplane mode and installs to the home screen like a native app.
> • **Accessibility as a design driver** — focus traps, reduced-motion support,
>   dyslexia-friendly fonts, high-contrast mode, and an "anxiety mode" that hides
>   judgmental metrics. I built it neurodivergent-first because that's how *I*
>   needed to study.
>
> Open-source (MIT), with all original practice questions written to CompTIA's
> public exam objectives.
>
> 🔗 Live demo: https://aplusstudyapp.pages.dev
> 💻 Code: https://github.com/manderwall/aplusstudyapp
>
> #CompTIA #APlus #JavaScript #WebDevelopment #PWA #Accessibility #OpenSource

---

## Résumé / portfolio blurb

> **A+ Study** — Offline-first study PWA (vanilla JS, zero dependencies, no build
> step). Implemented the FSRS-4 spaced-repetition scheduler from scratch,
> client-side AES-GCM encryption via the Web Crypto API, and an accessibility-first
> UI. Unit + browser-smoke tested, CI-gated, deployed on Cloudflare Pages.
> Open-source (MIT).

---

## GitHub "About" one-liner

> Offline-first CompTIA A+ study PWA — vanilla JS, zero deps, FSRS spaced
> repetition, client-side encryption, accessibility-first. Unofficial/independent.

---

## Talking points (for interviews)

- **Why no framework?** Wanted full control of the render path and a zero-install,
  offline-capable artifact. Trade-off: hand-rolled state/DOM updates instead of a
  framework's reconciler.
- **The spaced-repetition scheduler.** FSRS-4 models each card's *stability* and
  *difficulty* and schedules the next review to hit a target retention. Pure,
  side-effect-free, and unit-tested (`lib.mjs`).
- **Touch-safety stack.** iPad "ghost taps" after revealing an answer would skip
  cards; fixed with a layered guard (pointer-events lockout, timestamp guards,
  swipe-target checks) documented so it doesn't regress.
- **Accessibility.** Treated as a design driver, not a checkbox — focus traps,
  ARIA live regions, reduced-motion, text scaling, dyslexia-friendly fonts.

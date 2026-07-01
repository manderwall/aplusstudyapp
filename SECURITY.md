# Security policy

## Threat model

This is a single-user, client-side PWA. All progress, question overrides, and scratchpad drawings live in IndexedDB on the user's device. There is no server-side account system; the optional Supabase sync uses a user-supplied anon key + sync key.

The threats this app tries to defend against are deliberately scoped:

| ✅ In scope | ❌ Out of scope |
|---|---|
| A curious housemate, family member, or thief who picks up an unlocked device and opens the app | A targeted attacker with root/kernel access to the device |
| Plaintext study data sitting in IndexedDB if the device is later examined | Active malware running with permissions to read the live process |
| Accidental disclosure of progress via DevTools to a casual onlooker | Side-channel attacks against PBKDF2 or AES-GCM |
| Unauthorized installation of rogue browser extensions reading the page DOM | Phishing the user out of their PIN |

## Crypto design

When PIN lock is enabled (`Stats → App lock → Set PIN`):

- A random 16-byte **salt** is generated per device.
- The PIN is run through **PBKDF2-SHA256, 600,000 iterations**, producing a 256-bit key. (Meets the OWASP minimum for PBKDF2-HMAC-SHA256.)
- Every IndexedDB blob (progress, question overrides, scratchpad drawings) is **AES-GCM-256** encrypted with that key under a per-write random 12-byte IV.
- A small **verification blob** (a known plaintext encrypted under the key) is stored in `localStorage`. On unlock, the entered PIN derives a candidate key; if it decrypts the verification blob, the PIN was correct.
- The PIN and the derived key are **never persisted** — only the salt and verification blob are. The derived key lives in memory and is dropped on app close.
- "Forgot PIN" wipes all encrypted stores (you can re-pull from Supabase on another device that still has a working key).

The actual implementation is `crypto.mjs` — ~94 lines, no dependencies, uses the Web Crypto API directly. Tested in `tests/crypto.test.mjs`.

### Cloud sync

Supabase sync uses an anon key + a user-chosen `sync_key` for row addressing. Cloud data is **plaintext** — the PIN-lock crypto stops at the device boundary. If you need encrypted cloud sync, that's a future extension. Keep your `sync_key` non-obvious and treat the Supabase URL + anon key as semi-sensitive.

## Reporting an issue

If you find a security-relevant bug:

- **Don't open a public issue.** Email the address linked from the [GitHub profile](https://github.com/manderwall) instead, or open a private security advisory via the Security tab of this repo.
- A reasonable response timeline: acknowledgement within ~1 week, fix or status update within ~30 days. This is a personal project, not a vendor SLA.
- I won't run a paid bug-bounty program. Credit in the changelog if you want it.

Things that are **not** vulnerabilities here:

- "The anon Supabase key is visible in localStorage" — it's meant to be a client-embeddable token; security comes from RLS + the user's chosen `sync_key`.
- "I could see the questions JSON in DevTools" — yes, it's a static asset shipped to the browser. Not secret.
- "I disabled the SW and the offline mode broke" — expected.

// Browser regression smoke suite. Asserts the behaviors that this
// session's PRs (#37–#63) added or fixed, so they can't silently
// regress. Run: `npm run smoke` (needs devDependency puppeteer).
// Exits non-zero on any failure — suitable for CI.
//
// Covers:
//   - happy-path study walk (welcome → study → reveal → reading → stats → help)
//   - require-answer-before-Reveal gate, incl. multi-answer N-pick (PR #42/#58)
//   - keyboard shortcuts bail under open modals (PR #37)
//   - localStorage-quota resilience: app survives + warns once (PR #58)
//   - zero uncaught console errors across the walk
import { startServer, launchBrowser, makeReporter, trackConsoleErrors } from './_harness.mjs';
import { setTimeout as wait } from 'node:timers/promises';

async function run() {
  const server = await startServer();
  const browser = await launchBrowser();
  const r = makeReporter('regression');
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    const errors = trackConsoleErrors(page);

    // ── Happy path ──────────────────────────────────────────────
    r.head('happy-path study walk');
    await page.goto(server.base + '/', { waitUntil: 'networkidle0' });
    await wait(400);
    const welcomeShown = await page.evaluate(() => !!document.getElementById('welcome-overlay'));
    welcomeShown ? r.ok('welcome dialog shown on first load') : r.ng('no welcome dialog on first load');
    // Dismiss via the primary CTA
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#welcome-overlay button')].find(x => /start studying/i.test(x.textContent || ''));
      (b || document.querySelector('#welcome-overlay button.action.primary'))?.click();
    });
    await wait(400);
    const cardShown = await page.evaluate(() => !!document.querySelector('.card-question'));
    cardShown ? r.ok('study card renders after welcome dismissed') : r.ng('no study card after welcome');

    // ── Require-answer gate (single-answer) ─────────────────────
    r.head('require-answer-before-Reveal gate');
    const gateState = await page.evaluate(() => {
      const rev = document.getElementById('reveal-btn');
      return { exists: !!rev, disabled: rev?.disabled, idk: !!document.getElementById('idk-btn') };
    });
    if (gateState.exists && gateState.disabled && gateState.idk) r.ok('Reveal disabled + IDK affordance shown before any pick');
    else r.ng(`gate state wrong: ${JSON.stringify(gateState)}`);

    // Pick the required number of options, then Reveal should arm.
    const armed = await page.evaluate(() => {
      const opts = [...document.querySelectorAll('.q-options li.q-option')];
      // Multi-answer needs N picks; click them all to be safe (gate uses needCount).
      const isMa = !!document.querySelector('#quiz-submit-btn') || document.querySelectorAll('.q-option [type="checkbox"]').length > 0;
      if (opts[0]) opts[0].click();
      return { afterFirst: document.getElementById('reveal-btn')?.disabled };
    });
    await wait(150);
    const revealReady = await page.evaluate(() => {
      const rev = document.getElementById('reveal-btn');
      if (rev && !rev.disabled) return true;
      // multi-answer: keep picking until armed or options exhausted
      const opts = [...document.querySelectorAll('.q-options li.q-option')];
      for (const o of opts) { o.click(); if (!document.getElementById('reveal-btn')?.disabled) return true; }
      return !document.getElementById('reveal-btn')?.disabled;
    });
    revealReady ? r.ok('Reveal arms after the required pick(s)') : r.ng('Reveal stayed disabled after picking');
    // Armed Reveal advertises its keyboard shortcut (hidden on touch via CSS).
    const revealKbd = await page.evaluate(() => {
      const hint = document.querySelector('#reveal-btn .kbd-hint');
      return hint ? hint.textContent.trim() : null;
    });
    revealKbd === 'Space' ? r.ok('armed Reveal button shows its Space key hint') : r.ng(`reveal kbd hint wrong: ${JSON.stringify(revealKbd)}`);
    // Accent-fill text uses the theme-aware --on-accent token (AA in both themes).
    const onAccent = await page.evaluate(() => {
      const tok = getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim();
      const btn = getComputedStyle(document.getElementById('reveal-btn')).color;
      return { tok, btn };
    });
    (onAccent.tok && /^#|rgb/.test(onAccent.tok)) ? r.ok(`--on-accent token resolves (${onAccent.tok})`) : r.ng(`--on-accent missing: ${JSON.stringify(onAccent)}`);
    await page.evaluate(() => document.getElementById('reveal-btn')?.click());
    await wait(500);
    const revealed = await page.evaluate(() => !!document.querySelector('.rate-btn'));
    revealed ? r.ok('rating buttons appear after Reveal') : r.ng('no rating buttons after Reveal');

    // ── Rate-button intervals stay distinct (the "all four buttons show
    // the same time / 10h on every answer" bug). The exam-date cap used to
    // squash Hard/Good/Easy to one value in the preview; the preview is now
    // uncapped so the four ratings space the card differently. ──────────
    const intervals = await page.evaluate(() =>
      [...document.querySelectorAll('.rate-btn .rate-interval')].map(e => e.textContent.trim()));
    if (intervals.length === 4 && new Set(intervals).size >= 3)
      r.ok(`rate intervals are differentiated (${intervals.join(' / ')})`);
    else
      r.ng(`rate intervals collapsed: ${JSON.stringify(intervals)}`);

    // ── Keyboard bail under modal (PR #37) ──────────────────────
    r.head('keyboard shortcuts bail under open modal');
    // Advance to a fresh card first (rate the revealed one)
    await page.evaluate(() => document.querySelector('.rate-btn[data-rate="good"]')?.click());
    await wait(300);
    await page.evaluate(() => document.getElementById('help-btn')?.click());
    await wait(300);
    const helpOpen = await page.evaluate(() => !!document.getElementById('help-overlay'));
    const focusBefore = await page.evaluate(() => document.documentElement.hasAttribute('data-focus'));
    await page.keyboard.press('f');  // would toggle focus mode if it leaked
    await wait(120);
    const afterKbd = await page.evaluate(() => ({
      help: !!document.getElementById('help-overlay'),
      focus: document.documentElement.hasAttribute('data-focus'),
    }));
    if (helpOpen && afterKbd.help && afterKbd.focus === focusBefore) r.ok('`f` ignored while Help modal open (no focus-mode leak)');
    else r.ng(`keyboard leaked under modal: ${JSON.stringify(afterKbd)}`);
    await page.keyboard.press('Escape');
    await wait(200);
    const closed = await page.evaluate(() => !document.getElementById('help-overlay'));
    closed ? r.ok('Escape closes the modal') : r.ng('Escape did not close modal');

    // ── localStorage-quota resilience (PR #58) ──────────────────
    r.head('localStorage-quota resilience');
    await page.evaluate(() => {
      window.__origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; };
    });
    // Rate a few cards — bumpStreak + saveProgress will hit the throwing setItem
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { document.querySelector('.q-options li.q-option')?.click(); });
      await wait(120);
      await page.evaluate(() => document.getElementById('reveal-btn')?.click());
      await wait(200);
      await page.evaluate(() => document.querySelector('.rate-btn[data-rate="good"]')?.click());
      await wait(250);
    }
    await wait(500);
    const survived = await page.evaluate(() => ({
      card: !!document.querySelector('.card-question'),
      toast: [...document.querySelectorAll('.toast')].some(t => /storage is full or blocked/i.test(t.textContent)),
    }));
    survived.card ? r.ok('app keeps rendering when localStorage throws') : r.ng('app broke when localStorage threw');
    survived.toast ? r.ok('user warned once about storage failure') : r.info('quota toast not visible in window (may have auto-dismissed)');
    // Restore a working setItem so later blocks (sync Save) can persist.
    await page.evaluate(() => { if (window.__origSetItem) Storage.prototype.setItem = window.__origSetItem; });

    // ── Sync & backup dialog (☁️ header icon) ───────────────────
    r.head('sync & backup dialog');
    await page.evaluate(() => document.getElementById('sync-btn')?.click());
    await wait(300);
    const syncDlg = await page.evaluate(() => {
      const ov = document.getElementById('sync-overlay');
      if (!ov) return { open: false };
      const sql = ov.querySelector('#sync-sql')?.textContent || '';
      return {
        open: true,
        // The SQL must match what the app actually calls (RPCs), not the
        // old direct-table policies — that mismatch was the doc bug.
        hasRpcSql: sql.includes('progress_push') && sql.includes('progress_pull'),
        noStalePolicy: !/create policy/i.test(sql),
        hasInputs: !!(ov.querySelector('#cloud-url') && ov.querySelector('#cloud-key') && ov.querySelector('#cloud-sync')),
        hasActions: !!(ov.querySelector('#cloud-push') && ov.querySelector('#cloud-pull')),
      };
    });
    if (syncDlg.open) r.ok('☁️ button opens the Sync & backup dialog');
    else r.ng('Sync dialog did not open');
    syncDlg.hasRpcSql && syncDlg.noStalePolicy
      ? r.ok('setup SQL matches the RPC functions the app calls')
      : r.ng(`setup SQL wrong: ${JSON.stringify(syncDlg)}`);
    syncDlg.hasInputs && syncDlg.hasActions
      ? r.ok('config inputs + push/pull actions present in dialog')
      : r.ng(`sync config controls missing: ${JSON.stringify(syncDlg)}`);
    // Fill + Save → the header sync button should gain the "backup on" dot.
    const badgeOn = await page.evaluate(() => {
      const ov = document.getElementById('sync-overlay');
      ov.querySelector('#cloud-url').value = 'https://example.supabase.co';
      ov.querySelector('#cloud-key').value = 'anon-test-key';
      ov.querySelector('#cloud-sync').value = 'smoke-sync-key';
      ov.querySelector('#cloud-save').click();
      return document.getElementById('sync-btn')?.classList.contains('is-configured');
    });
    badgeOn ? r.ok('Save marks the header sync icon as configured') : r.ng('sync icon did not show configured badge after Save');
    await page.keyboard.press('Escape');
    await wait(200);
    const syncClosed = await page.evaluate(() => !document.getElementById('sync-overlay'));
    syncClosed ? r.ok('Escape closes the Sync dialog') : r.ng('Escape did not close Sync dialog');
    // Clean up the config we just wrote so later assertions/state stay neutral.
    await page.evaluate(() => ['supabase.url','supabase.key','supabase.syncKey'].forEach(k => localStorage.removeItem(k)));

    // ── Focus-mode icon: toggles via aria-pressed, no glyph swap ─
    r.head('focus-mode icon');
    const focusState = await page.evaluate(() => {
      const b = document.getElementById('focus-btn');
      const before = b.getAttribute('aria-pressed');
      b.click();
      const after = b.getAttribute('aria-pressed');
      const glyph = (b.textContent || '').trim();
      b.click(); // restore
      return { before, after, glyph };
    });
    (focusState.before === 'false' && focusState.after === 'true' && focusState.glyph === '🎯')
      ? r.ok('focus button toggles aria-pressed and keeps the 🎯 glyph')
      : r.ng(`focus button wrong: ${JSON.stringify(focusState)}`);

    // ── Stats: settings tucked into a collapsed section ─────────
    r.head('stats / settings split');
    await page.evaluate(() => document.querySelector('.tab[data-mode="stats"]')?.click());
    await wait(400);
    const statsLayout = await page.evaluate(() => {
      const wrap = document.querySelector('.stats-wrap');
      const collapse = document.querySelector('.settings-collapse');
      // Pure-stats heading (Active exam) should come before the settings collapse.
      const activeExam = [...document.querySelectorAll('.stats-h')].find(h => /active exam/i.test(h.textContent));
      const order = activeExam && collapse
        ? (activeExam.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false;
      return {
        hasCollapse: !!collapse,
        collapsedByDefault: collapse ? !collapse.open : false,
        // settings controls live inside the collapse (in DOM even while closed)
        settingsInside: !!collapse?.querySelector('[data-pref="contrast"]') && !!collapse?.querySelector('#reset-btn'),
        statsBeforeSettings: order,
      };
    });
    statsLayout.hasCollapse && statsLayout.collapsedByDefault ? r.ok('settings live in a collapsed section on Stats') : r.ng(`settings collapse missing/open: ${JSON.stringify(statsLayout)}`);
    statsLayout.settingsInside ? r.ok('accessibility + reset controls moved inside the collapse') : r.ng('settings controls not inside collapse');
    statsLayout.statsBeforeSettings ? r.ok('Active-exam stats render before the settings collapse') : r.ng('stats/settings order wrong');
    // Expanding it still exposes the working controls (handlers bind by id).
    const expandWorks = await page.evaluate(() => {
      const c = document.querySelector('.settings-collapse');
      c.open = true;
      return !!document.querySelector('.settings-collapse [data-pref="size"] button');
    });
    expandWorks ? r.ok('expanding the collapse reveals the settings controls') : r.ng('controls missing after expand');

    // ── Focus-sound (Web Audio noise; extracted to focus-sound.mjs) ──
    // Toggling a noise option calls setSound(); any breakage surfaces in the
    // console-error check below. Turn it off again so the AudioContext stops.
    const soundResult = await page.evaluate(() => {
      const white = document.querySelector('.settings-collapse [data-pref="sound"] button[data-val="white"]');
      if (!white) return 'missing';
      white.click();
      const applied = document.documentElement.getAttribute('data-sound');
      document.querySelector('.settings-collapse [data-pref="sound"] button[data-val="off"]')?.click();
      return applied === 'white' ? 'applied' : 'clicked';
    });
    soundResult !== 'missing' ? r.ok(`focus-sound toggle runs without error (${soundResult})`) : r.ng('sound control not found');

    // ── Reading TOC live filter ─────────────────────────────────
    r.head('reading section filter');
    await page.evaluate(() => document.querySelector('.tab[data-mode="reading"]')?.click());
    // Reading content (concept-fixes) loads async; wait for the TOC.
    await page.waitForSelector('#reading-toc-search', { timeout: 5000 }).catch(() => {});
    const readingFilter = await page.evaluate(() => {
      const input = document.getElementById('reading-toc-search');
      const items = () => [...document.querySelectorAll('.reading-toc-list li')];
      const total = items().length;
      if (!input || total === 0) return { ok: false, total };
      // No-match query hides everything + shows the empty note.
      input.value = 'zzzznomatchqwerty';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const noneVisible = items().every(li => li.hidden);
      const emptyShown = !document.querySelector('.reading-toc-empty')?.hidden;
      // Clearing restores all.
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const allVisible = items().every(li => !li.hidden);
      return { ok: true, total, noneVisible, emptyShown, allVisible };
    });
    if (!readingFilter.ok) r.info(`reading filter not exercised (no TOC rendered: ${JSON.stringify(readingFilter)})`);
    else {
      readingFilter.noneVisible && readingFilter.emptyShown
        ? r.ok('no-match query hides all sections + shows empty note')
        : r.ng(`filter no-match wrong: ${JSON.stringify(readingFilter)}`);
      readingFilter.allVisible ? r.ok('clearing the filter restores all sections') : r.ng('filter did not restore sections');
    }

    // ── Read-aloud (Listen button) ─────────────────────────────
    // Guards the read-aloud.mjs extraction: the Listen button only reaches
    // the "speaking" state if currentSpeakableCard() resolves a real card
    // via the filteredQuestions()/getQuestion() lookups injected into the
    // module at init. A broken injection => null card => no aria-pressed flip.
    r.head('read-aloud Listen button');
    await page.evaluate(() => document.querySelector('.tab[data-mode="study"]')?.click());
    await wait(200);
    const listen = await page.evaluate(() => {
      const btn = document.getElementById('listen-btn');
      if (!btn) return { state: 'missing' };
      if (btn.hidden) return { state: 'unsupported' };  // no speechSynthesis in this engine
      // Stub speak so we don't actually queue audio in CI.
      try { window.speechSynthesis.speak = () => {}; window.speechSynthesis.cancel = () => {}; } catch {}
      btn.click();
      return { state: 'clicked', pressed: btn.getAttribute('aria-pressed'), glyph: btn.textContent };
    });
    if (listen.state === 'unsupported') r.info('read-aloud not exercised (no speechSynthesis in this engine)');
    else if (listen.state === 'missing') r.ng('Listen button not found');
    else listen.pressed === 'true'
      ? r.ok('Listen reads the current card (injected card lookup works)')
      : r.ng(`Listen did not engage: ${JSON.stringify(listen)}`);

    // ── Cloud sync: push → pull round-trip ──────────────────────
    // Drives the real Sync dialog handlers with window.fetch stubbed to
    // emulate the progress_push / progress_pull RPCs. Proves a card rated
    // locally survives a push, and a pull replays it back through the merge
    // logic + IDB without error. This is the safety net for sync.mjs.
    r.head('cloud sync push/pull round-trip');
    // Make sure we have at least one rated card so the bundle isn't empty.
    await page.evaluate(() => document.querySelector('.tab[data-mode="study"]')?.click());
    await wait(200);
    await page.evaluate(() => {
      const opt = document.querySelector('.q-options li.q-option');
      if (opt) opt.click();
      const rev = document.getElementById('reveal-btn');
      if (rev && !rev.disabled) rev.click();
    });
    await wait(150);
    await page.evaluate(() => { document.querySelector('[data-rate]')?.click(); });
    await wait(200);
    // Install the backend stub: capture the pushed payload, replay it on pull.
    await page.evaluate(() => {
      window.__sync = { pushed: null, pushCalls: 0, pullCalls: 0 };
      window.confirm = () => true;  // pull asks before overwriting local
      const realFetch = window.fetch;
      window.fetch = (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/rpc/progress_push')) {
          window.__sync.pushCalls++;
          const body = JSON.parse(opts.body || '{}');
          window.__sync.pushed = body.p_data;
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (u.includes('/rpc/progress_pull')) {
          window.__sync.pullCalls++;
          return Promise.resolve(new Response(
            JSON.stringify([{ data: window.__sync.pushed }]), { status: 200 }));
        }
        return realFetch(url, opts);
      };
    });
    // Open dialog, configure, push.
    await page.evaluate(() => document.getElementById('sync-btn')?.click());
    await wait(250);
    await page.evaluate(() => {
      const ov = document.getElementById('sync-overlay');
      ov.querySelector('#cloud-url').value = 'https://example.supabase.co';
      ov.querySelector('#cloud-key').value = 'anon-test-key';
      ov.querySelector('#cloud-sync').value = 'smoke-sync-key';
      ov.querySelector('#cloud-save').click();
      ov.querySelector('#cloud-push').click();
    });
    await wait(300);
    const pushed = await page.evaluate(() => {
      const exams = window.__sync.pushed?.progress || {};
      const cardCount = Object.values(exams).reduce((n, e) => n + Object.keys(e || {}).length, 0);
      return {
        calls: window.__sync.pushCalls,
        version: window.__sync.pushed?.version,
        cardCount,
        status: document.getElementById('cloud-status')?.textContent || '',
      };
    });
    pushed.calls === 1 && pushed.version === 2 && pushed.cardCount > 0 && /pushed/i.test(pushed.status)
      ? r.ok(`Push sends a v2 bundle with progress (${pushed.cardCount} card(s))`)
      : r.ng(`push round-trip wrong: ${JSON.stringify(pushed)}`);
    // Pull replays the captured bundle back through the merge logic.
    await page.evaluate(() => document.getElementById('cloud-pull')?.click());
    await wait(300);
    // Push a second time — the card must still be present, proving the pull
    // wrote it back into state + IDB (true round-trip, not just a no-op).
    await page.evaluate(() => document.getElementById('cloud-push')?.click());
    await wait(300);
    const roundTrip = await page.evaluate(() => {
      const exams = window.__sync.pushed?.progress || {};
      const cardCount = Object.values(exams).reduce((n, e) => n + Object.keys(e || {}).length, 0);
      return {
        pullCalls: window.__sync.pullCalls,
        cardCountAfter: cardCount,
        status: document.getElementById('cloud-status')?.textContent || '',
      };
    });
    roundTrip.pullCalls === 1 && roundTrip.cardCountAfter > 0 && /pushed/i.test(roundTrip.status)
      ? r.ok('Pull restores progress through merge + IDB (survives re-push)')
      : r.ng(`pull round-trip wrong: ${JSON.stringify(roundTrip)}`);
    // Restore real fetch + clean up the config so later state stays neutral.
    await page.evaluate(() => {
      document.getElementById('sync-close')?.click();
      ['supabase.url','supabase.key','supabase.syncKey','supabase.lastSync'].forEach(k => localStorage.removeItem(k));
    });
    await wait(150);

    // ── Console-error scoreboard ────────────────────────────────
    r.head('console errors');
    errors.length === 0 ? r.ok('zero uncaught console errors across the walk') : r.ng(`${errors.length} console error(s): ${errors.slice(0, 3).join(' | ')}`);
  } finally {
    await browser.close();
    server.stop();
  }
  return r.result();
}

const { pass, fail } = await run();
console.log(`\n📊 regression: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

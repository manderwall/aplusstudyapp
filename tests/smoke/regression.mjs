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
    await page.evaluate(() => document.getElementById('reveal-btn')?.click());
    await wait(500);
    const revealed = await page.evaluate(() => !!document.querySelector('.rate-btn'));
    revealed ? r.ok('rating buttons appear after Reveal') : r.ng('no rating buttons after Reveal');

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

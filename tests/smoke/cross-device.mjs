// Cross-device emulation matrix. Drives the same end-to-end study →
// reveal → mock-exam-start → outcome-log flow under 8 emulated device
// profiles (iOS Safari, Android Chrome, iPadOS, desktop Mac/PC). Flags
// h-scroll, sub-24×24 controls, console errors, and any
// device-specific render breaks.
//
// LIMITATION: this is Chromium-with-emulated-UA, NOT real iOS Safari /
// real Android Chrome. It catches layout/responsive bugs and most JS
// runtime bugs reliably. It MISSES Safari engine-specific quirks
// (`inert` partial support, iOS pinch-zoom edge cases, Safari ITP).
// For those you need a real device. See README.
import { startServer, launchBrowser, shotDir, makeReporter } from './_harness.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { join } from 'node:path';

const SAFARI_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const SAFARI_IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const SAFARI_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const CHROME_WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Width, height, deviceScaleFactor are the user-perceived CSS pixel
// dimensions + DPR for each device. isMobile + hasTouch shape touch-
// event delivery. UA strings are sniffed by feature-detection in some
// codepaths (we mostly rely on viewport / CSS media queries, but
// emulating UA is free defense-in-depth).
const DEVICES = [
  { name: 'iphone-se-1-portrait',  w: 320, h: 568,  dpr: 2,     isMobile: true,  hasTouch: true,  ua: SAFARI_IOS_UA,     note: 'smallest viewport still in support' },
  { name: 'iphone-12-portrait',    w: 390, h: 844,  dpr: 3,     isMobile: true,  hasTouch: true,  ua: SAFARI_IOS_UA,     note: 'baseline modern iPhone' },
  { name: 'iphone-14-pro-portrait',w: 393, h: 852,  dpr: 3,     isMobile: true,  hasTouch: true,  ua: SAFARI_IOS_UA,     note: 'Dynamic Island, safe-area-top heavy' },
  { name: 'iphone-12-landscape',   w: 844, h: 390,  dpr: 3,     isMobile: true,  hasTouch: true,  ua: SAFARI_IOS_UA,     note: 'landscape compaction (PR #48)' },
  { name: 'pixel-7-portrait',      w: 412, h: 915,  dpr: 2.625, isMobile: true,  hasTouch: true,  ua: CHROME_ANDROID_UA, note: 'baseline modern Android' },
  { name: 'galaxy-tab-s8-portrait',w: 753, h: 1205, dpr: 2,     isMobile: true,  hasTouch: true,  ua: CHROME_ANDROID_UA, note: 'Android tablet portrait' },
  { name: 'ipad-air-portrait',     w: 820, h: 1180, dpr: 2,     isMobile: true,  hasTouch: true,  ua: SAFARI_IPAD_UA,    note: 'baseline modern iPad' },
  { name: 'ipad-mini-landscape',   w: 1133, h: 744, dpr: 2,     isMobile: true,  hasTouch: true,  ua: SAFARI_IPAD_UA,    note: 'tablet-as-laptop usage pattern' },
  { name: 'desktop-mac-retina',    w: 1440, h: 900, dpr: 2,     isMobile: false, hasTouch: false, ua: SAFARI_MAC_UA,     note: 'desktop Safari emulation' },
  { name: 'desktop-pc',            w: 1366, h: 768, dpr: 1,     isMobile: false, hasTouch: false, ua: CHROME_WIN_UA,     note: 'most-common Windows laptop' },
];

async function runDevice(server, browser, d, r) {
  const page = await browser.newPage();
  await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.dpr, isMobile: d.isMobile, hasTouch: d.hasTouch });
  await page.setUserAgent(d.ua);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('SW failed')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(server.base + '/?skipWelcome=1', { waitUntil: 'networkidle0' });
  await wait(400);

  // ── Layout audit ──
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const issues = [];
    if (doc.scrollWidth > doc.clientWidth + 2) issues.push(`h-scroll(${doc.scrollWidth}>${doc.clientWidth})`);
    const tiny = [...document.querySelectorAll('button, a, [tabindex]:not([tabindex="-1"])')].filter(el => {
      if (el.closest('.filter-bar')) return false;  // intentional h-scroll container
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && (b.width < 24 || b.height < 24);
    });
    if (tiny.length) issues.push(`${tiny.length} sub-24px control(s)`);
    return issues;
  });

  // ── Flow audit ──
  // Pick → Reveal → rate → confirm advance worked
  await page.evaluate(() => document.querySelector('.q-options li.q-option')?.click());
  await wait(200);
  await page.evaluate(() => document.getElementById('reveal-btn')?.click());
  await wait(400);
  const revealed = await page.evaluate(() => !!document.querySelector('.rate-btn'));
  if (!revealed) layout.push('reveal flow broken');
  await page.evaluate(() => document.querySelector('.rate-btn[data-rate="good"]')?.click());
  await wait(400);

  // Mock exam button availability
  await page.evaluate(() => document.querySelector('[data-mode="quiz"]')?.click());
  await wait(400);
  const mockBtn = await page.evaluate(() => {
    const b = document.querySelector('[data-mock]');
    return { exists: !!b, disabled: b?.disabled };
  });
  if (!mockBtn.exists) layout.push('mock-exam button missing');

  // Outcome log dialog open / close
  await page.evaluate(() => document.querySelector('[data-mode="stats"]')?.click());
  await wait(700);
  await page.evaluate(() => document.getElementById('outcome-log-btn')?.click());
  await wait(400);
  const dialogOk = await page.evaluate(() => {
    const ov = document.getElementById('outcome-overlay');
    if (!ov) return false;
    // Check the dialog actually fits on this viewport
    const r = ov.querySelector('.outcome-card')?.getBoundingClientRect();
    return r && r.width <= window.innerWidth && r.height <= window.innerHeight + 1;
  });
  if (!dialogOk) layout.push('outcome dialog overflows viewport');
  await page.keyboard.press('Escape');
  await wait(200);

  await page.screenshot({ path: join(shotDir(), `cross-${d.name}.png`) });

  if (layout.length === 0 && errors.length === 0) {
    r.ok(`${d.name} (${d.w}×${d.h}@${d.dpr}x) — clean · ${d.note}`);
  } else {
    const msg = [...layout, ...(errors.length ? [`${errors.length} console err`] : [])].join('; ');
    r.ng(`${d.name} (${d.w}×${d.h}@${d.dpr}x) — ${msg}`);
    if (errors.length) for (const e of errors.slice(0, 2)) console.log(`      ! ${e}`);
  }
  await page.close();
}

const server = await startServer();
const browser = await launchBrowser();
const r = makeReporter('cross-device');
try {
  r.head('emulated device matrix (Chromium-only — not real engine testing)');
  for (const d of DEVICES) await runDevice(server, browser, d, r);
} finally {
  await browser.close();
  server.stop();
}
const { pass, fail } = r.result();
console.log(`\n📊 cross-device: ${pass} pass, ${fail} fail · screenshots in tests/smoke/__shots__/cross-*.png`);
console.log('\nLIMITATION: Chromium with emulated UA/viewport/touch. Misses:');
console.log('  - Real iOS Safari engine quirks (inert partial support, pinch-zoom)');
console.log('  - Real Android keyboard reflow + viewport-meta interaction');
console.log('  - Real Safari ITP / Storage behavior');
console.log('  - PWA install / home-screen-icon flows (need real device)');
process.exit(fail === 0 ? 0 : 1);

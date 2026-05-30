// Responsive sweep across 6 viewport configs. Flags horizontal page
// scroll, controls below the WCAG 2.5.8 (24×24) minimum, and clipped
// tab labels. Saves screenshots to tests/smoke/__shots__/ (gitignored).
// Informational, but exits non-zero if a real layout break is found.
// Run: `npm run smoke:mobile`.
import { startServer, launchBrowser, shotDir, makeReporter } from './_harness.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { join } from 'node:path';

const DEVICES = [
  { name: 'iphone-se-1-portrait',  w: 320, h: 568, dpr: 2 },
  { name: 'iphone-se-1-landscape', w: 568, h: 320, dpr: 2 },
  { name: 'iphone-12-portrait',    w: 390, h: 844, dpr: 3 },
  { name: 'iphone-12-landscape',   w: 844, h: 390, dpr: 3 },
  { name: 'ipad-portrait',         w: 768, h: 1024, dpr: 2 },
  { name: 'ipad-landscape',        w: 1024, h: 768, dpr: 2 },
];

const server = await startServer();
const browser = await launchBrowser();
const r = makeReporter('mobile');
const shots = shotDir();
try {
  for (const d of DEVICES) {
    const page = await browser.newPage();
    await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: d.dpr, isMobile: true });
    await page.goto(server.base + '/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('welcomeDismissed', '1'); });
    await page.reload({ waitUntil: 'networkidle0' });
    await wait(400);
    await page.evaluate(() => document.querySelector('.q-options li.q-option')?.click());
    await wait(150);
    const issues = await page.evaluate(() => {
      const out = [];
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 2) out.push(`horizontal scroll (${doc.scrollWidth}>${doc.clientWidth})`);
      const tiny = [...document.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])')].filter(el => {
        const b = el.getBoundingClientRect();
        // Skip the OBJ filter chips — they live in an intentional horizontal scroller.
        if (el.closest('.filter-bar')) return false;
        return b.width > 0 && b.height > 0 && (b.width < 24 || b.height < 24);
      });
      if (tiny.length) out.push(`${tiny.length} control(s) under 24×24 WCAG 2.5.8 min`);
      const truncated = [...document.querySelectorAll('.tab .tab-label')].filter(e => e.scrollWidth > e.clientWidth + 1);
      if (truncated.length) out.push(`${truncated.length} tab label(s) truncated`);
      return out;
    });
    await page.screenshot({ path: join(shots, `mobile-${d.name}.png`) });
    if (issues.length === 0) r.ok(`${d.name} (${d.w}×${d.h}) — clean`);
    else r.ng(`${d.name} (${d.w}×${d.h}) — ${issues.join('; ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}
const { pass, fail } = r.result();
console.log(`\n📊 mobile: ${pass} pass, ${fail} fail · screenshots in tests/smoke/__shots__/`);
process.exit(fail === 0 ? 0 : 1);

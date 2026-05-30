// Cold-boot performance probe (informational, not pass/fail). Emulates a
// mid-range Android (Moto-G4-class viewport, Fast-3G, 4× CPU throttle)
// and prints key timings + the transfer waterfall. Run: `npm run smoke:perf`.
import { startServer, launchBrowser } from './_harness.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_harness.mjs';

const server = await startServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 3, isMobile: true });
  const client = await page.target().createCDPSession();
  await client.send('Network.emulateNetworkConditions', {
    offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 150,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluateOnNewDocument(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations?.().then(r => r.forEach(x => x.unregister()));
    if (window.caches) caches.keys().then(k => k.forEach(n => caches.delete(n)));
  });
  const t0 = Date.now();
  await page.goto(server.base + '/', { waitUntil: 'networkidle0', timeout: 60000 });
  const networkidle = Date.now() - t0;
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const p = performance.getEntriesByType('paint');
    return {
      ttfb: Math.round(nav.responseStart - nav.requestStart),
      fcp: Math.round(p.find(x => x.name === 'first-contentful-paint')?.startTime || 0),
      dcl: Math.round(nav.domContentLoadedEventEnd),
      heap: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      resources: performance.getEntriesByType('resource').length,
    };
  });
  console.log('# Cold-boot perf (Moto-G4 / Fast-3G / 4× CPU)');
  console.log(`  TTFB                 ${m.ttfb} ms   (target <600)`);
  console.log(`  First Contentful Paint ${m.fcp} ms (target <1800)`);
  console.log(`  DOMContentLoaded     ${m.dcl} ms`);
  console.log(`  networkidle0         ${networkidle} ms`);
  console.log(`  JS heap              ${m.heap} MB   (target <50)`);
  console.log(`  Resources fetched    ${m.resources}`);
  console.log('\n# Source sizes (disk, uncompressed; gzip ~halves text)');
  for (const f of ['app.js', 'lib.mjs', 'styles.css', 'index.html', 'data/core2/questions.json', 'data/core2/concept-fixes.json']) {
    try { console.log(`  ${f.padEnd(34)} ${(statSync(join(REPO_ROOT, f)).size / 1024).toFixed(1)} KB`); } catch {}
  }
} finally {
  await browser.close();
  server.stop();
}

// samples/playwright-sample.js — drive the SAME archonum gateway with Playwright.
//
// The gateway speaks plain CDP over a WebSocket, so it isn't Puppeteer-specific.
// Playwright attaches to a running browser with `chromium.connectOverCDP(wsUrl)`.
// The only archonum-specific bits — authenticating and surviving the gateway's
// transient 502s — are folded into a single reusable SDK helper, `getCDPUrl()`:
//
//     const browser = await chromium.connectOverCDP(await client.getCDPUrl());
//
// One call: authenticate, retry through transient 502s, and hand Playwright a
// credentialed CDP endpoint. No @archonum/engine and no Puppeteer needed — this
// sample imports only @archonum/sdk (plus playwright itself).
//
//   ARCHONUM_TOKEN=… ARCHONUM_USERNAME=… node samples/playwright-sample.js
//   ARCHONUM_TOKEN=… ARCHONUM_USERNAME=… node samples/playwright-sample.js https://news.ycombinator.com/
//
// Note: the Runtime.enable leak-fix in @archonum/engine patches Puppeteer
// only; Playwright manages CDP its own way. The real-device fingerprint (the thing
// that actually matters for bot walls) comes from the remote browser, not the client.

import { ArchonumClient } from '@archonum/sdk';
import { chromium } from 'playwright';

if (!process.env.ARCHONUM_TOKEN && !process.env.ARCHONUM_PASSWORD && !process.env.ARCHONUM_CDP_PASSWORD) {
  console.error('✗ set ARCHONUM_TOKEN and ARCHONUM_USERNAME (see the comment at the top of this file)');
  process.exit(1);
}

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://news.ycombinator.com/';

const client = ArchonumClient.fromEnv({ log: (msg) => console.log(`  ${msg}`) });

// One call: authenticate, survive the gateway's transient 502s, and hand Playwright
// a credentialed CDP endpoint. No @archonum/engine and no Puppeteer needed.
const browser = await chromium.connectOverCDP(await client.getCDPUrl());
console.log(`✓ attached to remote browser: ${browser.version()}`);

try {
  // connectOverCDP attaches to the already-running browser: reuse its default context
  // and existing tab rather than spawning new ones.
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  console.log(`✓ loaded: ${await page.title()}`);

  // Standard Playwright APIs from here on.
  const headlines = await page
    .locator('.titleline > a, h1, h2 a')
    .evaluateAll((els) => els.slice(0, 5).map((el) => el.textContent.trim()).filter(Boolean));
  console.log('✓ top items on the page:');
  for (const h of headlines) console.log(`   • ${h}`);

  await page.screenshot({ path: 'playwright-sample.png' });
  console.log('✓ saved playwright-sample.png');
} finally {
  // Detach without closing — the shared remote device keeps running for the next user.
  await browser.close(); // for a CDP-attached browser this disconnects; it does not kill the remote
}

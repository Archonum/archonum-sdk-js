// samples/puppeteer-sample.js — drive the archonum gateway with Puppeteer.
//
// @archonum/engine wraps a patched puppeteer-core, so here we just use
// ArchonumEngine directly and then work with the RAW Puppeteer `page` it hands
// back — navigate, evaluate in the page, click, screenshot. Anything you can do
// with a normal Puppeteer Page works, because that's exactly what it is.
//
//   ARCHONUM_TOKEN=… ARCHONUM_USERNAME=… node samples/puppeteer-sample.js
//   ARCHONUM_TOKEN=… ARCHONUM_USERNAME=… node samples/puppeteer-sample.js https://news.ycombinator.com/
//
// Uses --env-file too:  node --env-file=.env samples/puppeteer-sample.js

import { ArchonumEngine } from '@archonum/engine';

if (!process.env.ARCHONUM_TOKEN && !process.env.ARCHONUM_PASSWORD && !process.env.ARCHONUM_CDP_PASSWORD) {
  console.error('✗ set ARCHONUM_TOKEN and ARCHONUM_USERNAME (see the comment at the top of this file)');
  process.exit(1);
}

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://news.ycombinator.com/';

const engine = ArchonumEngine.fromEnv({ log: (msg) => console.log(`  ${msg}`) });

// The retrying handshake gives back an ArchonumSession wrapping a real Puppeteer Browser.
const session = await engine.connect();
console.log(`✓ attached to remote browser: ${session.info.Browser}`);

try {
  // `page` is a genuine Puppeteer Page — the SDK just applied desktop emulation for us.
  const page = await session.newPage({ desktop: true });

  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  console.log(`✓ loaded: ${await page.title()}`);

  // Regular Puppeteer APIs work unchanged. Pull structured data out of the page.
  const headlines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.titleline > a, h1, h2 a'))
      .slice(0, 5)
      .map((el) => el.textContent.trim())
      .filter(Boolean),
  );
  console.log('✓ top items on the page:');
  for (const h of headlines) console.log(`   • ${h}`);

  // Screenshot via the SDK helper (viewport-clipped + retried), or page.screenshot() raw.
  await session.captureViewport(page, { path: 'puppeteer-sample.png' });
  console.log('✓ saved puppeteer-sample.png');
} finally {
  // disconnect(), never close() — the shared remote device keeps running.
  await session.disconnect();
}

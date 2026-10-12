#!/usr/bin/env node
// archonum — screenshot ANY website through a remote Chrome on the archonum CDP
// gateway. Pass the URL on the command line, no editing.
//
//   archonum                                 # default site
//   archonum https://www.canadagoose.com/    # any site someone calls out
//   archonum https://site.com out.png        # custom output filename
//   archonum --desktop https://taobao.com/   # force the desktop version

import { execFile } from 'node:child_process';
import { ArchonumEngine } from '@archonum/engine';

// --- Config -----------------------------------------------------------------

// Credentials come from the ARCHONUM_* environment variables (see
// ArchonumEngine.fromEnv / ArchonumClient.fromEnv) so nothing secret lives in
// the repo. A .env file in the current directory is loaded automatically as a
// fallback — real environment variables always win over it.
let engine: ArchonumEngine;
try {
  engine = ArchonumEngine.fromEnv({ log: (msg) => console.log(`  ${msg}`) });
} catch {
  console.error('✗ set ARCHONUM_API_TOKEN — export it, or put it in a .env file in the current directory');
  process.exit(1);
}

// The gateway browsers are real MOBILE devices. Some sites (e.g. taobao.com) serve a
// stripped mobile/app-gated experience to mobile UAs while showing the full site to
// desktop. `--desktop` presents as desktop by keeping the device's REAL UA/platform
// and only dropping the "Mobile" token + widening the viewport — an honest
// "request desktop site", not an OS spoof (spoofing Windows on a Linux/ARM device
// desyncs the fingerprint and trips walls like Cloudflare). Left OFF by default:
// mobile is the genuine fingerprint that gets past bot walls like Kasada.
const DESKTOP = process.argv.includes('--desktop');

// Positional args (URL, output name) — flags like --desktop are filtered out.
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const TARGET_URL = positional[0] || 'https://www.mscdirect.com';
const SCREENSHOT_PATH =
  positional[1] || `${new URL(TARGET_URL).hostname.replace(/^www\./, '')}.png`;

const OPEN_WHEN_DONE = process.platform === 'darwin' && process.env.NO_OPEN !== '1';

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`→ target: ${TARGET_URL}  (country=${engine.client.country || 'any'})`);
  if (DESKTOP) console.log('→ desktop mode (real device UA, de-mobilized + widened viewport)');
  console.log('→ loading...');

  const { status, title, textLength, clip, info } = await engine.capture(TARGET_URL, {
    path: SCREENSHOT_PATH,
    desktop: DESKTOP,
  });

  console.log(`✓ remote browser: ${info.Browser}`);
  console.log('✓ connected (Runtime.enable CDP-leak fix; real-device fingerprint, no spoofing)');
  console.log(`✓ loaded [HTTP ${status}]: ${title}`);

  // Judge by what actually RENDERED, not the initial HTTP status.
  if (textLength < 50) {
    console.warn(`⚠ almost no content rendered (${textLength} chars) — the screenshot may be blank.`);
  }

  console.log(`✓ saved ${SCREENSHOT_PATH} (${clip.width}x${clip.height})`);
  if (OPEN_WHEN_DONE) execFile('open', [SCREENSHOT_PATH], () => {});
}

main().catch((err: unknown) => {
  console.error(`\n✗ capture failed: ${(err as Error).message}`);
  process.exit(1);
});

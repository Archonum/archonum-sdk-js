# @archonum/engine

Drive a **real-device remote Chrome** on the archonum CDP gateway. Each session is a
genuine mobile device with a per-session exit country — it walks past bot walls
(Kasada, Cloudflare, Akamai) because there is nothing to fake, and this package's only
stealth job is to not announce the automation.

It folds in every gateway quirk you'd otherwise re-derive: the
`Runtime.enable` CDP-leak fix (applied just by importing), the retrying connection-info +
connect handshake, flaky-op retries, desktop emulation capped to the device's physical
screen, page reuse, viewport-clipped screenshots, and `disconnect()`-not-`close()` so
the shared remote browser keeps running.

Beyond screenshots it gives an agent the primitives to **drive** a page: a
ref-tagged accessibility snapshot to act on (text, not vision tokens), human-like
input cadence so behavioural walls don't flag superhuman timing, and honest
feedback on every action (did the click actually do anything? is the page blocked,
and by whom?).

It builds on `@archonum/sdk`, which handles authentication and the credentialed CDP
URL; this package owns everything above that: the CDP handshake, sessions, and the
one-shot helpers (`capture`, `read`, `compareFlow`).

```js
import { ArchonumEngine } from '@archonum/engine';

const engine = ArchonumEngine.fromEnv({ log: console.log });
```

## Install

```bash
pnpm add @archonum/engine
```

or

```bash
npm i @archonum/engine
```

## Quick start

```js
// One-shot screenshot: connect, load, settle, capture, disconnect.
const { status, title, textLength } = await engine.capture(
  'https://www.canadagoose.com/',
  { path: 'shot.png' },
);

// One-shot read — "fetch, but unblockable": rendered text after JS ran,
// optionally as seen from a specific country.
const { text, settled, blocked } = await engine.read('https://example.com/', {
  country: 'de',
  waitForText: 'Add to cart',   // gate extraction on real content, not a shell
});
```

`read()` waits until content actually rendered (`minTextLength` or `waitForText`)
and then for the text to hold still (`settleMs`). On timeout it still returns what
rendered, flagged `settled: false` — so "little text" and "not finished rendering"
stay distinguishable.

## Driving a session

For anything interactive, hold a session and act on snapshot refs:

```js
const session = await engine.connect();               // retrying handshake → ArchonumSession
const page = await session.newPage({ desktop: true }); // raw Puppeteer page
await page.goto('https://news.ycombinator.com/', { waitUntil: 'load' });

console.log(await session.snapshot(page));  // [e1] link "Hacker News" … [e42] textbox "Search"
await session.type(page, 'e42', 'archonum', { submit: true });
await session.waitForContent(page, { minTextLength: 500 });

const { text } = await session.pageText(page);         // read what you drove to
await session.captureViewport(page, { path: 'hn.png' });
await session.disconnect();  // closes only pages it opened; the shared browser lives on
```

- **`snapshot(page)`** — compact outline of interactive elements as `[eN] role "name"`.
  Pierces open shadow DOM and same-origin iframes (`[iframe]`-tagged); cross-origin
  frames are reported as `[frame]` markers instead of silence. **Refs are ephemeral**:
  they belong to the latest snapshot and go stale the moment the DOM changes — re-snapshot
  after any action that changed the page.
- **`click(page, ref, { force?, fallback? })`** — human-like path + timing. Throws,
  naming the overlay, if something covers the target (`force: true` skips the check).
  Returns what the click actually did: `{ effect: 'navigation' | 'dom-change' | 'none' }`;
  `fallback: true` retries `'none'` via focus + Enter for widgets that ignore synthetic mice.
- **`type(page, ref, text, { submit?, clear?, verify? })`** — per-key typing (typeahead
  widgets need real keystrokes). Reads the field back and throws if the text didn't land;
  `verify: false` for widgets that reformat input.
- **`select(page, ref, value)`** — match by visible label or value attribute; reports `effect`.
- **`press(page, key, { ref? })`** — `"Enter"`, `"Control+A"`, …; `ref` focuses first; reports `effect`.
- **`scroll(page, { direction?, ref? })`** — wheel-event scrolling, or center a ref in view.

## Is the page blocked?

```js
const info = await session.pageInfo(page, response);
// { url, status, title, textLength, blocked, challenge?, clearable? }
```

`blocked` flags challenge pages: a 429 or 403 outright, or a page that rendered
little text (under 200 characters) **and** whose DOM actually looks challenge-like.
Short text alone is not enough — `https://example.com/` renders 129 characters and
is reported `blocked: false`, because nothing in it resembles a wall. When blocked,
`challenge` names the wall (`cloudflare-turnstile`, `akamai`, `perimeterx`,
`datadome`, …) and `clearable` says whether waiting is worth it for a real device.
The decision itself is exported as `isBlocked(status, textLength, challenge)` if you
want to apply it to page state you gathered yourself.

`waitForContent(page, { minTextLength?, containsText?, timeoutMs?, stallMs? })`
polls until content appears, and returns `stalled: true` early when the page shows
zero progress (no DOM mutation, network request, or text change) — the signature of
a hard block: rotate identity instead of waiting out the timeout.

## Replayable flows & geo comparison

Snapshot refs can't cross sessions, so declarative flows target elements by
accessible name/role or CSS selector instead (resolved via `locate()`):

```js
const steps = [
  { action: 'click', target: 'Accept all', optional: true },  // cookie banner, if present
  { action: 'type', target: 'Search', text: 'parka', submit: true },
  { action: 'waitForContent', minTextLength: 500 },
];

// The same flow, replayed in parallel from several exit countries:
const results = await engine.compareFlow('https://shop.example/', {
  countries: ['ch', 'de', 'us'],
  steps,
  extract: '.price',      // one CSS-selected value per country
  screenshot: true,
});
```

Or run a flow inside a session you already hold: `session.runFlow(page, steps)`.

## Desktop mode

The gateway devices are real **mobile** Chrome. `newPage({ desktop: true })`
presents the honest "request desktop site" identity: it keeps the device's own UA,
platform, and client hints, only dropping the `Mobile` token — a spoofed OS is
exactly what modern walls (Cloudflare Turnstile) block. The viewport is capped to
the device's physical width so captures never tile.

## Configuration

```js
import { ArchonumEngine, ArchonumClient } from '@archonum/engine';

const engine = new ArchonumEngine(new ArchonumClient({ /* … */ }), {
  humanize: true,          // human-like input cadence; false = max speed
  protocolTimeout: 120000, // puppeteer protocol timeout for the remote connection
});
```

`ArchonumEngine.fromEnv(overrides?)` builds both the client and the engine from the
environment in one call — it takes `humanize`/`protocolTimeout` for itself and passes
the rest of `overrides` through to `ArchonumClient.fromEnv()`:

```js
const engine = ArchonumEngine.fromEnv({ log: console.log });
```

Credentials (`username`, `token`), gateway host, the platform API `baseUrl`, exit
country, connect retries, and `log` all live on `ArchonumClient` (defined in the
sibling package `@archonum/sdk`, re-exported here for convenience) — see
`ArchonumClientOptions` and the `ARCHONUM_*` environment variables it reads.

Country selection on the CDP gateway (what this package talks to) works via the
`country` query parameter, which `ArchonumClient` sets for you — the
`{username}-country_{CC}` username-suffix form documented for archonum's
HTTP/SOCKS5 proxy ports does not apply here.

## Session hygiene

The remote browser is a shared device: always `session.disconnect()`, never
`session.browser.close()`. Disconnect closes only the pages the session opened itself.

## `page.evaluate` runs in an isolated world

To keep the `Runtime.enable` CDP leak closed, this package runs page code in an
**isolated world** (`REBROWSER_PATCHES_RUNTIME_FIX_MODE=alwaysIsolated`, set on import).
The DOM and browser built-ins behave exactly as normal, but page-defined JavaScript is
not visible — so on the `page` this package hands you:

```js
await page.evaluate(() => document.title);        // ✅ fine — DOM
await page.evaluate(() => window.__NEXT_DATA__);  // ⚠️ undefined — page global
```

Read page state out of the DOM instead (or a `<script type="application/json">` tag).
If you genuinely need the main world, set `REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding`
before importing — it keeps main-world access and still avoids `Runtime.enable`, but page
scripts can then observe your calls. Two related consequences of isolation: child-frame
execution contexts hang (this package reads same-origin iframes via `contentDocument`
from the main frame instead), and web workers are unsupported in this mode.

See `patches/README.md` at the repo root for what the patch changes and why.

## Other engines

If you only need the credentialed CDP URL — to drive the remote browser with
Playwright or another CDP client instead of this package's Puppeteer-based
`ArchonumSession` — you don't need this whole package; the sibling package
`@archonum/sdk` (a dependency of this one, re-exported above for convenience) is all
that call requires:

```js
import { chromium } from 'playwright';
import { ArchonumClient } from '@archonum/engine'; // or '@archonum/sdk' if that's the only one you installed

const client = ArchonumClient.fromEnv();
const browser = await chromium.connectOverCDP(await client.getCDPUrl());
```

`@archonum/engine`'s stealth benefits (the CDP-leak fix, human-like
input, snapshot/locate) are Puppeteer-specific; the real-device fingerprint that
actually defeats bot walls comes from the remote browser regardless of which
client attaches to it.

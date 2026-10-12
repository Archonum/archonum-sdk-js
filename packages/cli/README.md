# @archonum/cli (`archonum`)

Screenshot **any website** through a remote Chrome on the archonum CDP gateway.
Pass a URL on the command line, get a screenshot that pops up.

## Setup

```bash
npx @archonum/cli <url>
```

Or install it:

```bash
pnpm add -g @archonum/cli
```

Either way it needs your archonum API token — the one secret that authenticates
every archonum surface, so there's nothing else to fetch. Export it in your shell:

```bash
export ARCHONUM_API_TOKEN=…
```

or put it in a `.env` file in the current directory (nothing else to configure —
`archonum` loads it automatically):

```bash
printf 'ARCHONUM_API_TOKEN=…\n' > .env
archonum https://www.canadagoose.com/
```

If `ARCHONUM_API_TOKEN` isn't set either way, `archonum` prints a one-line error
and exits — no stack trace.

## Screenshot a site

```bash
archonum https://www.canadagoose.com/   # any URL someone calls out
archonum                                # default site (mscdirect.com)
archonum https://site.com out.png       # custom output filename
archonum --desktop https://taobao.com/  # force the desktop version of a site
```

The image is saved as `<hostname>.png` and **auto-opens on macOS** (set `NO_OPEN=1` to skip).

### Mobile vs. desktop (`--desktop`)

The gateway browsers are real **mobile** devices, so most sites render their mobile
layout — which is usually what you want, and it's the genuine fingerprint that gets past
bot walls like Kasada. But some sites (e.g. **taobao.com**) serve a stripped, app-gated
mobile page while showing the full site to desktop browsers. Add `--desktop` to present
as desktop Chrome (keeps the device's real UA, only dropping the `Mobile` token, and
widens the viewport, auto-capped to the device's screen width so the capture doesn't
tile). Leave it off for everything else.

## Using `@archonum/engine`

`archonum` is a thin CLI over the sibling package `@archonum/engine`, which folds in
every gateway quirk. `@archonum/engine` builds on `@archonum/sdk`, the credential and
handshake layer. Both are separate packages in this monorepo if you want to script
against the gateway directly instead of going through the CLI.

## What it does

1. `GET /json/version` on the gateway (credentials + `country` as query params) →
   `webSocketDebuggerUrl`. The whole handshake retries on the gateway's transient 502s.
2. `puppeteer.connect()` **attaches** to the already-running remote browser — no local
   Chromium.
3. Navigates (`waitUntil: 'load'`), lets the page settle, and screenshots — clipped to
   the remote device's screen (the gateway browsers are real mobile devices).
4. Disconnects (never closes), so the shared remote browser keeps running.

## The only stealth that matters

The gateway browser is a **real device**, so there is nothing to fake. The single
requirement is to not announce the automation: `@archonum/engine` uses a
**locally patched Puppeteer** that avoids the detectable `Runtime.enable` CDP leak.
That alone is enough to screenshot even Kasada-protected sites like `canadagoose.com`.

We deliberately do **not** spoof `navigator.webdriver`, `plugins`, WebGL/GPU, or the UA —
measurement showed that tampering makes a legit real-device fingerprint look *worse*, not
better.

## Credentials

Gateway credentials come from the environment — nothing secret is hardcoded:

```bash
export ARCHONUM_API_TOKEN=…          # required
export ARCHONUM_GATEWAY=host:port    # optional
archonum https://www.canadagoose.com/
```

Or put them in a `.env` file in the current directory — `archonum` loads it for you,
falling back to it only for variables that aren't already set in the real environment.

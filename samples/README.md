# @archonum/samples

Runnable examples for `@archonum/sdk` and `@archonum/engine` — not part of any
published package. This is a **private** workspace package precisely so its
dependencies (Playwright, the MCP SDK, zod) never end up in the `dependencies`
of `@archonum/sdk`, `@archonum/engine`, or `@archonum/cli`. A consumer who
installs one of those packages gets none of this.

## Setup

From the repo root:

```bash
pnpm install
pnpm build          # samples import the packages' compiled dist/, so this is required
cp .env.example .env
# then fill in ARCHONUM_TOKEN and ARCHONUM_USERNAME
```

`fromEnv()` (used by every sample) loads `.env` from the current directory
automatically, so plain `node samples/whatever.js` works from the repo root.
`node --env-file=.env samples/whatever.js` also still works if you prefer to
be explicit, or are running from inside `samples/`.

## Samples

### `puppeteer-sample.js`

Demonstrates driving the archonum gateway with the raw Puppeteer `page` that
`@archonum/engine` hands back — navigate, evaluate in the page, click,
screenshot. Needs `@archonum/engine` (which wraps a patched `puppeteer-core`).

```bash
pnpm --filter @archonum/samples puppeteer
# or, from the repo root:
node samples/puppeteer-sample.js https://news.ycombinator.com/
```

### `playwright-sample.js`

Demonstrates that a Playwright user needs neither `@archonum/engine` nor
Puppeteer at all: `ArchonumClient.getCDPUrl()` from `@archonum/sdk` alone does
authentication and retry-through-502s, and Playwright's own
`chromium.connectOverCDP()` takes it from there. Needs only `@archonum/sdk`
(plus `playwright` itself).

```bash
pnpm --filter @archonum/samples playwright
# or, from the repo root:
node samples/playwright-sample.js https://news.ycombinator.com/
```

### `mcp-server.js`

Exposes the remote browser as MCP tools (`read`, `navigate`, `snapshot`,
`click`, `type`, `compare_countries`, and more) over stdio. Needs
`@archonum/engine`, `@modelcontextprotocol/sdk`, and `zod`.

```bash
pnpm --filter @archonum/samples mcp
# or, from the repo root:
node samples/mcp-server.js
```

Run bare, it just prints `✓ archonum MCP server ready on stdio` and waits —
that's healthy; an MCP client is expected to launch it, not a human.

## Playwright browser binaries

The workspace's `pnpm-workspace.yaml` denies build/install scripts
(`onlyBuiltDependencies: []`), so Playwright's own browser-binary download
never runs. That's intentional, not a gap: this sample attaches to the already-
running remote browser on the archonum gateway over CDP
(`chromium.connectOverCDP(...)`), so no local Chromium/Firefox/WebKit binaries
are needed at all.

## MCP wiring

`mcp-server.js` speaks JSON-RPC over stdio, so you don't run it by hand in
normal use — an MCP client launches it as a subprocess. It groups work into
named, per-country sessions (e.g. `open_session "it" country it`), each its own
connection + tab + exit IP, so a CH and an IT view never mix.

Attach it in Claude Code (use the **absolute** path to the file and to `.env`):

```bash
claude mcp add archonum -- node --env-file=/ABS/PATH/.env /ABS/PATH/samples/mcp-server.js
```

Or add it to an MCP client config (e.g. Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "archonum": {
      "command": "node",
      "args": ["--env-file=/ABS/PATH/.env", "/ABS/PATH/samples/mcp-server.js"]
    }
  }
}
```

A published `@archonum/mcp` package is planned, which is why the MCP server
lives here in samples for now rather than as its own installable package.

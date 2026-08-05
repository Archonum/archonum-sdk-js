# archonum

Drive a **real-device remote Chrome** on the archonum CDP gateway. Each session is a
genuine mobile device with a per-session exit country — it walks past bot walls
(Kasada, Cloudflare, Akamai) because there is nothing to fake, and the only stealth
job left is to not announce the automation.

This repo is a pnpm + TypeScript monorepo of three packages, plus a private
samples workspace.

## Packages

| Package | What it does |
|---|---|
| [`@archonum/sdk`](packages/sdk/README.md) | Authenticate against the gateway and get a credentialed CDP URL. Zero runtime dependencies. |
| [`@archonum/engine`](packages/engine/README.md) | Stealth browser automation on top of the SDK: sessions, accessibility snapshots, human-like input, bot-wall detection. |
| [`@archonum/cli`](packages/cli/README.md) | `npx @archonum/cli <url>` to screenshot any site from a terminal. |

**Status:** none of these are published to npm yet — `npx @archonum/cli` and
`pnpm add @archonum/sdk` (etc.) will work once they are, per the Releasing section
below. Until then, run the CLI from a built checkout:

```bash
pnpm build && node packages/cli/dist/cli.js <url>
```

## Getting access

Archonum is a hosted service: the packages in this repo are clients, and every one
of them needs a token before it can do anything.

1. **Create an account** — [app.archonum.com/register](https://app.archonum.com/register/).
   Plans are listed at [archonum.com/#pricing](https://archonum.com/#pricing), including
   an Enterprise tier.
2. **Get your API token** — from the API Key page after signing in. It's the only
   secret you need: it doubles as the CDP gateway's password, so there's nothing
   separate to fetch for that. Note your account username too.
3. **Put them in the environment** — see [Configuration](#configuration). Both
   `ARCHONUM_TOKEN` and `ARCHONUM_USERNAME` are required; there is no default
   username any more.

For access questions, Enterprise plans, or anything the dashboard doesn't cover,
email [hello@archonum.com](mailto:hello@archonum.com).

Without credentials every client fails the same clear way rather than hanging — the
CLI prints `✗ set ARCHONUM_TOKEN and ARCHONUM_USERNAME …` and exits 1, and
`ArchonumClient` throws `username and token are required`.

## Which one do I need?

- **Playwright, or your own CDP-speaking driver** → `@archonum/sdk`. It just gets you
  a credentialed CDP URL; attach with whatever client you like.
- **Puppeteer-level automation, or the one-shot `read()`/`capture()` helpers** →
  `@archonum/engine`. It builds on the SDK and owns the CDP handshake, sessions, and
  human-like interaction.
- **A terminal, nothing else** → `@archonum/cli`. A thin CLI over `@archonum/engine`.

## Layering

```
              samples/
            ┌─────┴─────┐
            v           v
cli  ──>  engine  ──>  sdk  ──>  gateway
```

`@archonum/cli` depends only on `@archonum/engine`, which depends only on
`@archonum/sdk`, which talks to the archonum gateway directly. `samples/` is a
private workspace package that exercises both `@archonum/sdk` and
`@archonum/engine` directly (plus Playwright and an MCP server) — it sits outside
the dependency chain, not underneath it.

## Development

```bash
pnpm install    # install workspace dependencies
pnpm build      # compile every package's src/ to dist/
pnpm test       # run each package's test suite
pnpm typecheck  # tsc --noEmit across every package
```

Each package's sources live under `packages/<name>/src`. `sdk` and `engine` have
tests in `packages/<name>/test`; `cli` has none, by design. `pnpm build` and
`pnpm typecheck` run recursively across `packages/*` (see the root
`package.json` scripts); `pretest` and `pretypecheck` run `pnpm build` first
automatically, so `pnpm test` and `pnpm typecheck` always see fresh `dist/`
output.

`samples/` ([README](samples/README.md)) is a **private** workspace package —
never published — holding runnable examples plus the MCP server. Its samples
import the packages' compiled `dist/` output directly, so **`pnpm build` is
required before running any sample**; a plain `pnpm install` alone isn't enough.

## Configuration

Every package that talks to the gateway reads the same `ARCHONUM_*` environment
variables (see the [`@archonum/sdk` README](packages/sdk/README.md) for full
detail, including per-call overrides):

| Variable | Default | |
|---|---|---|
| `ARCHONUM_TOKEN` | — | required; `ARCHONUM_PASSWORD` is accepted as a fallback (same secret, older name) |
| `ARCHONUM_USERNAME` | — | required; no default any more |
| `ARCHONUM_GATEWAY` | `gateway.archonum.com:10900` | |
| `ARCHONUM_BASE_URL` | `https://app.archonum.com` | the archonum platform REST API, used by `getHealth()`/`getCredits()` |

`ArchonumClient.fromEnv()` (and `ArchonumEngine.fromEnv()`, which forwards to it)
loads a `.env` file from the current working directory automatically, using
Node's built-in `process.loadEnvFile()` — there is no `dotenv` dependency. Real
environment variables always win over anything in `.env`; a missing or unreadable
`.env` is not an error. `node --env-file=.env …` remains available if you'd rather
be explicit about it.

```bash
cp .env.example .env   # then fill in ARCHONUM_TOKEN and ARCHONUM_USERNAME
```

## Migrating from the pre-split package

If you used the single pre-split `@archonum/sdk` package (never published to
npm), the split changes these APIs:

- `ArchonumClient.getVersion()` is now `getConnectionInfo()`.
- The new `ArchonumClient.getCDPUrl()` replaces the old `getVersion()` +
  `withCreds(info.webSocketDebuggerUrl)` chain:

  ```ts
  // before
  const info = await client.getVersion();
  const url = client.withCreds(info.webSocketDebuggerUrl);

  // after
  const url = await client.getCDPUrl();
  ```

- `connect()`, `capture()`, `read()`, `compareFlow()`, and `ArchonumSession`
  moved off `ArchonumClient` onto `ArchonumEngine` in the new `@archonum/engine`
  package.
- `humanize` and `protocolTimeout` moved from the client to the engine.
- `ArchonumClient.fromEnv()` now also loads a `.env` from the current
  directory; real environment variables still win.
- Screenshot buffers are now typed `Uint8Array`, not `Buffer`
  (`CaptureResult.buffer`, `ReadResult.screenshot`, `CompareResult.screenshot`,
  `OneShotCapture.buffer`). Code doing `buffer.toString('base64')` must become
  `Buffer.from(buffer).toString('base64')`.
- `ArchonumSession` no longer exposes a public `client` field.
- `ArchonumSession`'s constructor changed from `(browser, info, client)` to
  `(browser, info, { humanize })`.
- `ARCHONUM_PASSWORD` is now `ARCHONUM_TOKEN` (the old name is still accepted
  as a fallback). The `relayer` default for `ARCHONUM_USERNAME` is gone —
  username is required, same as the token.
- `ArchonumClient` gained `getHealth()` and `getCredits()`, hitting the
  archonum platform REST API (`baseUrl`, default `https://app.archonum.com`)
  rather than the CDP gateway.

## Releasing

Each package is versioned and published independently via
[changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset          # record an intent-to-release for the packages you changed
pnpm changeset version  # bump versions + changelogs from pending changesets
pnpm release            # build, then `changeset publish` to npm
```

## Roadmap

- A published `@archonum/mcp` package — the MCP server currently lives in
  `samples/` (see [samples/README.md](samples/README.md)) because it isn't
  packaged for standalone install yet.
- A hosted/remote MCP server speaking Streamable HTTP with OAuth 2.0, instead of
  the current stdio-only transport.
- Markdown output for `read()`, as an alternative to plain rendered text.

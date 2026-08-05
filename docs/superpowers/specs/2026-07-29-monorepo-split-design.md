# Monorepo split: @archonum/sdk + engine + cli

Date: 2026-07-29
Status: approved (pending user review of this doc)

## Context

External SDK review (2026-07-26) found the single-package repo mixes four responsibilities (gateway connection, browser automation, CLI, MCP server) and forces users to install dependencies they never use — e.g. a Playwright-only user pays for `rebrowser-puppeteer-core`, and `playwright`/`@modelcontextprotocol/sdk`/`zod` sit in `dependencies` while only samples use them. It also flagged API ergonomics: `getVersion()` misnamed, CDP URL retrieval requires chaining internals.

Decisions made with the user:

- pnpm monorepo with three published packages: `@archonum/sdk`, `@archonum/engine`, `@archonum/cli`.
- MCP server stays a sample (promoted to a package later; hosted MCP is roadmap, not this work).
- Publish to public npm as part of this work. License: MIT.
- Convert source to TypeScript.

## Repo layout

```
pnpm-workspace.yaml
package.json                 # root: private, workspace scripts, changesets
tsconfig.base.json           # strict, ESM, shared compiler options
docs/superpowers/specs/      # this doc
packages/
  sdk/                       # @archonum/sdk
    src/index.ts
    test/                    # node:test via tsx
    package.json  tsconfig.json
  engine/                    # @archonum/engine
    src/index.ts  src/session.ts
    package.json  tsconfig.json
  cli/                       # @archonum/cli
    src/cli.ts
    package.json  tsconfig.json
samples/                     # private workspace package, never published
  package.json               # deps: playwright, @modelcontextprotocol/sdk, zod, workspace:*
  README.md                  # prerequisites + how to run each sample
  playwright-sample.js
  puppeteer-sample.js
  mcp-server.js
```

Root `archonum.js`, `cli.js` are deleted (moved into packages). `.env.example`, `.env` handling stays at root; CLI docs keep the `node --env-file` tip.

## Package scopes (responsibility boundaries)

Rule of thumb: gateway feature (auth, regions, endpoints) → sdk. Page capability (actions, extraction, wall handling) → engine. Terminal UX → cli.

### @archonum/sdk — "talk to the gateway"

Owns credentials, gateway address, exit-country selection, and producing an authenticated CDP WebSocket URL. Zero runtime dependencies (native `fetch`). Never imports puppeteer/playwright.

Public API:

- `class ArchonumClient` — constructor options as today (gateway, username, password, country, connectRetries, log). `humanize` and `protocolTimeout` both move to the engine: `protocolTimeout` is a puppeteer option, so it does not belong to a package that never opens a browser connection.
- `ArchonumClient.fromEnv(overrides?)` — reads `ARCHONUM_*` env vars as today. New: unconditionally attempts `process.loadEnvFile()` (Node >= 20.12) wrapped in a silent catch, so a `.env` in the cwd is picked up. Unconditional is safe because Node never overwrites an already-set variable — real environment variables always win over the file. No dotenv dependency.
- `getCDPUrl({ country? })` — NEW: fetches connection info and returns the credentialed WebSocket URL, with the transient-502 retry (connectRetries/backoff) built in. The one-liner for Playwright users: `chromium.connectOverCDP(await client.getCDPUrl())`.
- `getConnectionInfo(country?)` — RENAME of `getVersion()` (returns `/json/version` payload = connection metadata, not a version). No alias kept; the package was never published.
- `withCreds(url, country?)` — stays public as the low-level escape hatch.
- `withRetry(fn, opts?)` — exported helper, unchanged.

### @archonum/engine — "drive the stealth browser"

Owns everything between authenticated URL and page. Dependencies: `@archonum/sdk`, `rebrowser-puppeteer-core`. The rebrowser leak-fix env default (`REBROWSER_PATCHES_RUNTIME_FIX_MODE ||= 'alwaysIsolated'`) moves to this package's module top.

Public API (composition over the sdk client, matching the reviewer's layer diagram):

- `class ArchonumEngine` — `new ArchonumEngine(client, { humanize?, protocolTimeout? })` and `ArchonumEngine.fromEnv(overrides?)` (builds the sdk client internally).
  - `connect({ country? })` → `ArchonumSession` — the puppeteer.connect handshake, retried as one unit with the version fetch (as today).
  - `capture(url, opts)`, `read(url, opts)`, `compareFlow(url, opts)` — one-shots move here verbatim from `ArchonumClient`.
- `class ArchonumSession` — moves verbatim: `newPage` + desktop emulation, `snapshot`/`locate`, `click`/`type`/`select`/`press`/`scroll` (humanize cadence, occlusion check, effect verification), `pageInfo` + challenge classification, `waitForContent` + stall detection, `captureViewport`, `pageText`, `runFlow`, `disconnect`.
- Re-exports `puppeteer` and `DESKTOP_UA` as today.

Does NOT parse argv, print to console, or know its caller is a CLI/MCP.

### @archonum/cli — "engine.capture() from a terminal"

Owns argv parsing, env validation error messages, console output, macOS `open`. Dependency: `@archonum/engine` only. `bin: { "archonum": "./dist/cli.js" }` (shebang line in source) → users run `npx @archonum/cli <url>`. Same flags/behavior as today's `cli.js`.

### samples (private, unpublished)

Workspace package holding `playwright`, `@modelcontextprotocol/sdk`, `zod` and `workspace:*` deps on sdk/engine — the published packages carry none of these. Samples stay plain runnable `.js` (they demonstrate the published JS API; no build step). `samples/README.md` documents prerequisites and run commands (review feedback item). `mcp-server.js` imports from `@archonum/engine` instead of `../archonum.js`.

## TypeScript + build

- Authored in TS, strict mode, ESM only (`"type": "module"`). Plain `tsc` per package emitting JS + `.d.ts` + sourcemaps into `dist/` — no bundler.
- `tsconfig.base.json` at root; per-package `tsconfig.json` extends it. NodeNext module resolution.
- Package manifests: `exports` map pointing at `dist/`, `files: ["dist"]`, `engines: { node: ">=20" }`, `license: "MIT"`, repository/homepage metadata, `publishConfig: { access: "public" }`.
- `rebrowser-puppeteer-core` ships its own types (puppeteer-core fork); imported types (`Browser`, `Page`) come from it as today's JSDoc did.

## Versioning + publishing

- Changesets; independent versions, all starting at `1.0.0`.
- Publish flow: `pnpm changeset` → `pnpm changeset version` → build → `pnpm changeset publish`. No CI in scope.
- LICENSE (MIT) file at root, referenced by each package.

## Testing

- `@archonum/sdk`: `node:test` run via `tsx` (devDep). Cover `withCreds` (country/creds appending), `fromEnv` precedence (env > .env fallback; overrides win), `getCDPUrl` retry behavior with mocked `fetch`.
- Engine/cli need the live gateway — manual smoke via CLI and samples; `samples/README.md` documents the commands.

## Out of scope (explicitly deferred)

- `@archonum/mcp` package and hosted MCP (Streamable HTTP + OAuth).
- Markdown output for `read()`.
- Generalized `connect(connectFn)` (YAGNI — `getCDPUrl()` covers non-puppeteer engines).
- Session-leak warning on exit.
- Replacing `rebrowser-puppeteer-core` (staleness risk noted; engine isolation contains it).
- CI/CD.

## Migration notes

- `ArchonumClient` loses `humanize` (engine concern) and the browser methods; engine gains them. Sample/CLI imports update accordingly.
- Git history: use `git mv` where possible so blame survives the split.
- Root README rewritten as monorepo overview linking per-package READMEs (each package needs one for npm).

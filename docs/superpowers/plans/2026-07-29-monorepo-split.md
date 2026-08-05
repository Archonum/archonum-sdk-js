# Archonum monorepo split (sdk / engine / cli) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single-package JS repo into a pnpm + TypeScript monorepo publishing three MIT-licensed packages — `@archonum/sdk` (gateway auth only), `@archonum/engine` (browser automation), `@archonum/cli` (terminal) — with samples as a private workspace package.

**Architecture:** `packages/sdk` has zero runtime dependencies and owns credentials, the gateway HTTP call, and producing a credentialed CDP WebSocket URL. `packages/engine` depends on sdk + `rebrowser-puppeteer-core` and owns the puppeteer handshake plus everything page-level (`ArchonumSession`, one-shots `capture`/`read`/`compareFlow`). `packages/cli` depends on engine only and owns argv/console. `samples/` is a private workspace package carrying `playwright`, `@modelcontextprotocol/sdk`, and `zod` so published packages carry none of them. Existing behavior is preserved verbatim during the port; the only semantic changes are the API renames listed in Global Constraints.

**Tech Stack:** pnpm 11 workspaces, TypeScript 7 (`tsc`, ESM/NodeNext, no bundler), `node:test` via `tsx`, Changesets, Node >= 20.

## Global Constraints

- Package scope is `@archonum/*`. Published packages: `@archonum/sdk`, `@archonum/engine`, `@archonum/cli`. `samples` is `private: true` and never published.
- License: **MIT**, one `LICENSE` file at repo root, `"license": "MIT"` in every package manifest.
- Every package: `"type": "module"`, `"engines": { "node": ">=20" }`, `"files": ["dist"]`, an `exports` map pointing into `dist/`, `"publishConfig": { "access": "public" }`, and `repository`/`homepage` metadata.
- All package sources are TypeScript under `src/`, compiled by plain `tsc` to `dist/` with `.d.ts` + sourcemaps. No bundler. Strict mode on.
- Samples stay plain runnable `.js` — no build step, no TypeScript.
- API renames (no back-compat aliases; the package was never published): `getVersion()` → `getConnectionInfo()`; new `getCDPUrl()`.
- `humanize` moves from the client to `ArchonumEngine`. `protocolTimeout` also moves to `ArchonumEngine` (it is a puppeteer option; this corrects the spec, which listed it under sdk). `connectRetries` and `log` stay on the sdk client.
- Dependency versions: `typescript@^7.0.2`, `tsx@^4.23.1`, `@changesets/cli@^2.31.1`, `@types/node@^26.1.2`, `rebrowser-puppeteer-core@^24.8.1`, `playwright@^1.62.0`, `@modelcontextprotocol/sdk@^1.30.0`, `zod@^4.4.3`.
- Cross-package deps use `workspace:^`.
- Preserve git history with `git mv` where a file moves.
- Never commit `.env`. `.gitignore` keeps `node_modules`, `*.png`, `.env`; add `dist`.
- `page.screenshot()` in puppeteer 24 is typed `Promise<Uint8Array>`. Use `Uint8Array` in engine types and `Buffer.from(bytes).toString('base64')` where base64 is needed.

---

## File Structure

```
pnpm-workspace.yaml               # workspace globs + build-script allowlist
package.json                      # root: private, scripts, shared devDeps
tsconfig.base.json                # strict ESM/NodeNext compiler options
LICENSE                           # MIT
.changeset/config.json
README.md                         # monorepo overview (rewritten)

packages/sdk/
  package.json  tsconfig.json  README.md
  src/index.ts                    # public surface re-exports
  src/client.ts                   # ArchonumClient
  src/env.ts                      # loadDotEnv, readEnvConfig
  src/retry.ts                    # sleep, withRetry
  src/types.ts                    # ConnectionInfo, RetryInfo/RetryOptions
  test/retry.test.ts  test/env.test.ts  test/client.test.ts

packages/engine/
  package.json  tsconfig.json  README.md
  src/index.ts                    # ArchonumEngine, ArchonumSession, puppeteer, DESKTOP_UA
  src/engine.ts                   # ArchonumEngine: connect/capture/read/compareFlow
  src/session.ts                  # ArchonumSession: pages, viewport, text, pageInfo, waits
  src/actions.ts                  # click/type/select/press/scroll (free functions)
  src/human.ts                    # Humanizer, humanClick, occluder, effectWatch
  src/dom-scan.ts                 # snapshotOutline, locateRef, resolveRef
  src/challenge.ts                # CHALLENGE_CLEARABLE, classifyChallenge
  src/mutation.ts                 # mutationCount
  src/flow.ts                     # FlowStep, runFlow
  src/page-state.ts               # per-page clip + created-by-us tracking (WeakMap/WeakSet)
  src/png.ts                      # pngSize
  src/util.ts                     # sleep
  src/types.ts                    # Clip, PageInfo, ContentWait, ReadResult, CompareResult
  src/dom-globals.d.ts            # Window.__archonumMut, Navigator.userAgentData
  test/png.test.ts  test/flow.test.ts

packages/cli/
  package.json  tsconfig.json  README.md   # README.md replaces root CLI.md
  src/cli.ts                      # shebang, argv, console, macOS open

samples/
  package.json                    # private; playwright, MCP SDK, zod, workspace:^ deps
  README.md                       # prerequisites + run commands
  puppeteer-sample.js  playwright-sample.js  mcp-server.js
```

---

### Task 1: Workspace scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`, `LICENSE`, `.changeset/config.json`
- Modify: `package.json` (replace contents), `.gitignore`
- Delete: `package-lock.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `tsconfig.base.json` (extended by every package tsconfig); root scripts `build`, `test`, `typecheck`, `clean`, `release`; shared devDeps `typescript`, `tsx`, `@types/node`, `@changesets/cli`.

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
  - 'samples'

# `tsx` pulls in esbuild, whose native-binary postinstall trips pnpm's build-script
# gate (ERR_PNPM_IGNORED_BUILDS) unless the decision is recorded here. Denying it is
# safe: esbuild resolves its platform binary through its optional dependency, and
# both `tsx` and `tsx --test` were verified working without the build step. Do not
# delete this block — installs fail without it.
allowBuilds:
  esbuild: false

# Nothing else needs a build script either: Playwright (a samples-only dependency,
# added in a later task) downloads browser binaries we never use, because we attach
# to the remote archonum gateway over CDP.
onlyBuiltDependencies: []
```

- [ ] **Step 2: Replace root `package.json`**

```json
{
  "name": "archonum-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.2.2",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r --filter \"./packages/*\" run build",
    "clean": "pnpm -r --filter \"./packages/*\" exec rm -rf dist",
    "pretypecheck": "pnpm build",
    "typecheck": "pnpm -r --filter \"./packages/*\" exec tsc --noEmit",
    "pretest": "pnpm build",
    "test": "pnpm -r --filter \"./packages/*\" run test",
    "release": "pnpm build && pnpm changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.31.1",
    "@types/node": "^26.1.2",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

`lib` includes `DOM` because every `page.evaluate` callback is type-checked as browser code (`document`, `navigator`, `MutationObserver`). `noUncheckedIndexedAccess` is deliberately off — it adds churn to ported code without catching real bugs here.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitOverride": true,
    "noEmitOnError": true
  }
}
```

The `"types": ["node"]` entry is required because `@types/node` is hoisted to the workspace root; packages under `packages/` need this explicit entry for `tsc` to see Node's ambient types such as `process` and the `NodeJS` namespace.

- [ ] **Step 4: Create `LICENSE` (MIT)**

Standard MIT text, `Copyright (c) 2026 Papers AG`.

- [ ] **Step 5: Create `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch",
  "ignore": ["samples"]
}
```

- [ ] **Step 6: Add `dist` to `.gitignore`, delete `package-lock.json`**

`.gitignore` becomes:

```
node_modules
dist
*.png
.env
```

```bash
git rm --cached package-lock.json && rm -f package-lock.json
```

- [ ] **Step 7: Install and verify**

Run: `pnpm install`
Expected: succeeds; creates `pnpm-lock.yaml`. `pnpm -r list --depth -1` lists only the root (no workspace packages exist yet).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: set up pnpm workspace, shared tsconfig, changesets, MIT license"
```

---

### Task 2: sdk package skeleton + retry module (TDD)

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/src/types.ts`, `packages/sdk/src/retry.ts`, `packages/sdk/test/retry.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1.
- Produces:
  - `sleep(ms: number): Promise<void>`
  - `withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>`
  - `interface RetryInfo { attempt: number; attempts: number; error: Error }`
  - `interface RetryOptions { attempts?: number; delayMs?: number; onRetry?: (info: RetryInfo) => void }`
  - `interface ConnectionInfo { Browser: string; 'Protocol-Version': string; 'User-Agent': string; 'V8-Version'?: string; 'WebKit-Version'?: string; webSocketDebuggerUrl: string }`

- [ ] **Step 1: Create `packages/sdk/package.json`**

```json
{
  "name": "@archonum/sdk",
  "version": "1.0.0",
  "description": "Authenticate against the archonum CDP gateway and get a credentialed CDP WebSocket URL. Zero dependencies.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/papers-ch/archonum-sdk-js.git", "directory": "packages/sdk" },
  "homepage": "https://github.com/papers-ch/archonum-sdk-js/tree/master/packages/sdk#readme",
  "keywords": ["archonum", "cdp", "chrome-devtools-protocol", "scraping", "proxy"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test test/*.test.ts"
  }
}
```

- [ ] **Step 2: Create `packages/sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing tests — `packages/sdk/test/retry.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

test('withRetry returns the first successful value without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries until the call succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`boom ${calls}`);
      return calls;
    },
    { attempts: 5, delayMs: 0 },
  );
  assert.equal(result, 3);
  assert.equal(calls, 3);
});

test('withRetry throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { attempts: 3, delayMs: 0 }),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('withRetry reports every failed attempt to onRetry', async () => {
  const seen: Array<{ attempt: number; attempts: number; message: string }> = [];
  await assert.rejects(
    () => withRetry(async () => { throw new Error('nope'); }, {
      attempts: 2,
      delayMs: 0,
      onRetry: ({ attempt, attempts, error }) => seen.push({ attempt, attempts, message: error.message }),
    }),
  );
  assert.deepEqual(seen, [
    { attempt: 1, attempts: 2, message: 'nope' },
    { attempt: 2, attempts: 2, message: 'nope' },
  ]);
});

test('withRetry normalises a non-Error rejection before reporting it', async () => {
  const seen: Error[] = [];
  await assert.rejects(
    () => withRetry(async () => { throw 'plain string failure'; }, {
      attempts: 2,
      delayMs: 0,
      onRetry: ({ error }) => seen.push(error),
    }),
    (err: unknown) => err instanceof Error && err.message === 'plain string failure',
  );
  assert.equal(seen.length, 2);
  assert.ok(seen.every((e) => e instanceof Error), 'onRetry always receives a real Error');
  assert.equal(seen[0].message, 'plain string failure');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @archonum/sdk test`
Expected: FAIL — cannot resolve `../src/retry.js`.

- [ ] **Step 5: Create `packages/sdk/src/types.ts`**

```ts
/** The gateway's `/json/version` payload — CDP connection metadata, not a version string. */
export interface ConnectionInfo {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version'?: string;
  'WebKit-Version'?: string;
  webSocketDebuggerUrl: string;
}

export interface RetryInfo {
  attempt: number;
  attempts: number;
  error: Error;
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  onRetry?: (info: RetryInfo) => void;
}
```

- [ ] **Step 6: Create `packages/sdk/src/retry.ts`**

```ts
import type { RetryOptions } from './types.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a flaky async op with a fixed delay between attempts. The shared gateway
 * occasionally 502s a request that succeeds moments later, so wrap the calls that
 * must not fail hard.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 2000, onRetry }: RetryOptions = {},
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      // Anything can be thrown in JS; RetryInfo promises an Error, so make it one.
      lastErr = err instanceof Error ? err : new Error(String(err));
      onRetry?.({ attempt: i, attempts, error: lastErr });
      if (i < attempts) await sleep(delayMs);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @archonum/sdk test`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): add retry helper and connection types"
```

---

### Task 3: sdk env loading (TDD)

**Files:**
- Create: `packages/sdk/src/env.ts`, `packages/sdk/test/env.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `loadDotEnv(): void` — best-effort `process.loadEnvFile()`; never throws, never overrides already-set vars (verified Node behavior).
  - `readEnvConfig(env?: NodeJS.ProcessEnv): { gateway?: string; username: string; password?: string; country: string }`

- [ ] **Step 1: Write the failing tests — `packages/sdk/test/env.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, readEnvConfig } from '../src/env.js';

test('readEnvConfig applies the documented defaults', () => {
  const cfg = readEnvConfig({ ARCHONUM_PASSWORD: 'pw' } as NodeJS.ProcessEnv);
  assert.equal(cfg.username, 'relayer');
  assert.equal(cfg.country, 'ch');
  assert.equal(cfg.password, 'pw');
  assert.equal(cfg.gateway, undefined);
});

test('readEnvConfig keeps an explicitly empty country (gateway chooses)', () => {
  const cfg = readEnvConfig({ ARCHONUM_COUNTRY: '' } as NodeJS.ProcessEnv);
  assert.equal(cfg.country, '');
});

test('readEnvConfig reads every ARCHONUM_ variable', () => {
  const cfg = readEnvConfig({
    ARCHONUM_GATEWAY: 'gw:1',
    ARCHONUM_USERNAME: 'user',
    ARCHONUM_PASSWORD: 'pw',
    ARCHONUM_COUNTRY: 'de',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg, { gateway: 'gw:1', username: 'user', password: 'pw', country: 'de' });
});

test('loadDotEnv loads a .env from the cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-env-'));
  writeFileSync(join(dir, '.env'), 'ARCHONUM_TEST_LOADED=yes\n');
  const cwd = process.cwd();
  delete process.env.ARCHONUM_TEST_LOADED;
  try {
    process.chdir(dir);
    loadDotEnv();
    assert.equal(process.env.ARCHONUM_TEST_LOADED, 'yes');
  } finally {
    process.chdir(cwd);
    delete process.env.ARCHONUM_TEST_LOADED;
  }
});

test('loadDotEnv is a silent no-op when no .env exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-noenv-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.doesNotThrow(() => loadDotEnv());
  } finally {
    process.chdir(cwd);
  }
});

test('loadDotEnv never overrides an already-set variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-prec-'));
  writeFileSync(join(dir, '.env'), 'ARCHONUM_TEST_PREC=from_dotenv\n');
  const cwd = process.cwd();
  process.env.ARCHONUM_TEST_PREC = 'from_shell';
  try {
    process.chdir(dir);
    loadDotEnv();
    assert.equal(process.env.ARCHONUM_TEST_PREC, 'from_shell');
  } finally {
    process.chdir(cwd);
    delete process.env.ARCHONUM_TEST_PREC;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @archonum/sdk test`
Expected: FAIL — cannot resolve `../src/env.js`.

- [ ] **Step 3: Create `packages/sdk/src/env.ts`**

```ts
export interface EnvConfig {
  gateway?: string;
  username: string;
  password?: string;
  country: string;
}

/**
 * Load a `.env` from the current working directory into `process.env`, if the
 * runtime supports it (Node >= 20.12). Deliberately best-effort: a missing or
 * unreadable file is not an error, and Node never overwrites variables that are
 * already set — so a real environment always wins over the file.
 */
export function loadDotEnv(): void {
  const load = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return;
  try {
    load.call(process);
  } catch {
    /* no .env in cwd, or unreadable — environment variables only */
  }
}

/** The ARCHONUM_* configuration, with the documented defaults applied. */
export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    gateway: env.ARCHONUM_GATEWAY || undefined,
    username: env.ARCHONUM_USERNAME || 'relayer',
    password: env.ARCHONUM_PASSWORD,
    // ?? not ||: an explicitly empty country means "let the gateway choose".
    country: env.ARCHONUM_COUNTRY ?? 'ch',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @archonum/sdk test`
Expected: PASS, 10 tests total (4 retry + 6 env).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): read ARCHONUM_* config with .env fallback"
```

---

### Task 4: sdk ArchonumClient (TDD)

**Files:**
- Create: `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`, `packages/sdk/test/client.test.ts`
- Reference: `archonum.js:1004-1120` (the JS original being ported)

**Interfaces:**
- Consumes: `sleep`/`withRetry` (Task 2), `loadDotEnv`/`readEnvConfig` (Task 3), `ConnectionInfo`/`RetryInfo` (Task 2).
- Produces:
  - `interface ArchonumClientOptions { gateway?: string; username?: string; password?: string; country?: string; connectRetries?: number; log?: (msg: string) => void }`
  - `class ArchonumClient` with readonly fields `gateway`, `username`, `password`, `country`, `connectRetries`, `log`, and methods:
    - `static fromEnv(overrides?: ArchonumClientOptions): ArchonumClient`
    - `withCreds(url: string, country?: string): string`
    - `getConnectionInfo(country?: string): Promise<ConnectionInfo>`
    - `getCDPUrl(opts?: { country?: string; attempts?: number; onRetry?: (info: RetryInfo) => void }): Promise<string>`
  - `packages/sdk/src/index.ts` re-exports `ArchonumClient`, `ArchonumClientOptions`, `withRetry`, `sleep`, `loadDotEnv`, `readEnvConfig`, and the types.

- [ ] **Step 1: Write the failing tests — `packages/sdk/test/client.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArchonumClient } from '../src/client.js';

const creds = { username: 'relayer', password: 's3cret' };

test('the constructor requires a username and password', () => {
  assert.throws(() => new ArchonumClient({ username: 'relayer' }), /username and password are required/);
  assert.throws(() => new ArchonumClient({ password: 'pw' }), /username and password are required/);
});

test('withCreds appends credentials and the client country', () => {
  const client = new ArchonumClient({ ...creds, country: 'ch' });
  const url = new URL(client.withCreds('ws://gw:10900/devtools/browser/abc'));
  assert.equal(url.searchParams.get('username'), 'relayer');
  assert.equal(url.searchParams.get('password'), 's3cret');
  assert.equal(url.searchParams.get('country'), 'ch');
  assert.equal(url.protocol, 'ws:');
});

test('withCreds omits country when it is empty, and honours a per-call override', () => {
  const client = new ArchonumClient({ ...creds, country: '' });
  assert.equal(new URL(client.withCreds('http://gw:10900/json/version')).searchParams.get('country'), null);
  assert.equal(new URL(client.withCreds('http://gw:10900/json/version', 'it')).searchParams.get('country'), 'it');
});

test('getConnectionInfo requests /json/version on the configured gateway and parses it', async () => {
  const seen: string[] = [];
  const client = new ArchonumClient({ ...creds, gateway: 'gw.test:10900', country: 'de', fetch: async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ Browser: 'Chrome/148', webSocketDebuggerUrl: 'ws://gw.test:10900/devtools/browser/xyz' }), { status: 200 });
  } });
  const info = await client.getConnectionInfo();
  assert.equal(info.Browser, 'Chrome/148');
  assert.equal(seen.length, 1);
  const requested = new URL(seen[0]);
  assert.equal(requested.origin + requested.pathname, 'http://gw.test:10900/json/version');
  assert.equal(requested.searchParams.get('country'), 'de');
  assert.equal(requested.searchParams.get('password'), 's3cret');
});

test('getConnectionInfo throws on a non-OK response and on a non-JSON body', async () => {
  const bad = new ArchonumClient({ ...creds, fetch: async () => new Response('<html>502</html>', { status: 502 }) });
  await assert.rejects(() => bad.getConnectionInfo(), /gateway HTTP 502/);

  const html = new ArchonumClient({ ...creds, fetch: async () => new Response('<html>hi</html>', { status: 200 }) });
  await assert.rejects(() => html.getConnectionInfo(), /non-JSON body/);
});

test('getCDPUrl retries a flaky gateway and returns the credentialed ws URL', async () => {
  let calls = 0;
  const logged: string[] = [];
  const client = new ArchonumClient({
    ...creds,
    country: 'ch',
    connectRetries: 4,
    retryDelayMs: 0,
    log: (msg) => logged.push(msg),
    fetch: async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 502 });
      return new Response(JSON.stringify({ Browser: 'Chrome/148', webSocketDebuggerUrl: 'ws://gw:10900/devtools/browser/abc' }), { status: 200 });
    },
  });
  const url = new URL(await client.getCDPUrl());
  assert.equal(calls, 3);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.searchParams.get('country'), 'ch');
  assert.equal(url.searchParams.get('username'), 'relayer');
  assert.equal(logged.length, 2, 'each failed attempt is logged');
});

test('getCDPUrl gives up after `attempts` and honours a country override', async () => {
  const client = new ArchonumClient({ ...creds, retryDelayMs: 0, fetch: async () => new Response('', { status: 502 }) });
  await assert.rejects(() => client.getCDPUrl({ attempts: 2 }), /gateway HTTP 502/);

  const ok = new ArchonumClient({ ...creds, country: 'ch', fetch: async (url) => {
    assert.equal(new URL(url).searchParams.get('country'), 'us');
    return new Response(JSON.stringify({ Browser: 'x', webSocketDebuggerUrl: 'ws://gw:1/devtools/browser/a' }), { status: 200 });
  } });
  assert.equal(new URL(await ok.getCDPUrl({ country: 'us' })).searchParams.get('country'), 'us');
});

test('fromEnv builds a client from ARCHONUM_* and lets overrides win', () => {
  const prev = { ...process.env };
  try {
    process.env.ARCHONUM_PASSWORD = 'env-pw';
    process.env.ARCHONUM_COUNTRY = 'it';
    const client = ArchonumClient.fromEnv({ country: 'us' });
    assert.equal(client.password, 'env-pw');
    assert.equal(client.username, 'relayer');
    assert.equal(client.country, 'us');
    assert.equal(client.gateway, 'gateway.archonum.com:10900');
  } finally {
    process.env = prev;
  }
});
```

Note the tests inject `fetch` and `retryDelayMs`, so the client's options must include both (see Step 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @archonum/sdk test`
Expected: FAIL — cannot resolve `../src/client.js`.

- [ ] **Step 3: Create `packages/sdk/src/client.ts`**

`fetch` and `retryDelayMs` are injectable so the gateway can be tested without a network; both default to production behavior and are documented as test seams.

```ts
import { loadDotEnv, readEnvConfig } from './env.js';
import { withRetry } from './retry.js';
import type { ConnectionInfo, RetryInfo } from './types.js';

export type FetchLike = (url: string) => Promise<Response>;

export interface ArchonumClientOptions {
  /** host:port of the gateway. Default: gateway.archonum.com:10900 */
  gateway?: string;
  username?: string;
  password?: string;
  /** ISO 3166-1 alpha-2 exit country; '' lets the gateway choose. */
  country?: string;
  /** Attempts for the gateway request in getCDPUrl(). Default: 5 */
  connectRetries?: number;
  /** Progress sink; defaults to a no-op. Pass console.log for chatter. */
  log?: (msg: string) => void;
  /** Delay between gateway retries. Default: 2000. Set 0 in tests. */
  retryDelayMs?: number;
  /** Injectable fetch — a test seam; defaults to global fetch. */
  fetch?: FetchLike;
}

export interface GetCDPUrlOptions {
  country?: string;
  attempts?: number;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Credentials + gateway policy for the archonum CDP gateway. It authenticates and
 * hands back a credentialed CDP WebSocket URL; attaching a browser to that URL is
 * the caller's job (or @archonum/engine's).
 */
export class ArchonumClient {
  readonly gateway: string;
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly connectRetries: number;
  readonly log: (msg: string) => void;
  readonly #retryDelayMs: number;
  readonly #fetch: FetchLike;

  constructor({
    gateway = 'gateway.archonum.com:10900',
    username,
    password,
    country = '',
    connectRetries = 5,
    log = () => {},
    retryDelayMs = 2000,
    fetch: fetchImpl,
  }: ArchonumClientOptions = {}) {
    if (!username || !password) throw new Error('ArchonumClient: username and password are required');
    this.gateway = gateway;
    this.username = username;
    this.password = password;
    this.country = country;
    this.connectRetries = connectRetries;
    this.log = log;
    this.#retryDelayMs = retryDelayMs;
    this.#fetch = fetchImpl ?? ((url) => fetch(url));
  }

  /**
   * Build a client from the ARCHONUM_* environment variables:
   *   ARCHONUM_PASSWORD   required
   *   ARCHONUM_USERNAME   default: relayer
   *   ARCHONUM_GATEWAY    default: gateway.archonum.com:10900
   *   ARCHONUM_COUNTRY    default: 'ch'; set '' to let the gateway choose
   * A `.env` in the current directory is loaded as a fallback — real environment
   * variables always win over it.
   */
  static fromEnv(overrides: ArchonumClientOptions = {}): ArchonumClient {
    loadDotEnv();
    return new this({ ...readEnvConfig(), ...overrides });
  }

  /**
   * Append gateway credentials (and country) to any URL — http or ws. Pass
   * `country` to override the client default for this one URL.
   *
   * The gateway authenticates via query-string params, so the password ends up in
   * the URL: keep credentialed URLs out of logs and anything persisted.
   */
  withCreds(url: string, country: string = this.country): string {
    const u = new URL(url);
    if (country) u.searchParams.set('country', country);
    u.searchParams.set('username', this.username);
    u.searchParams.set('password', this.password);
    return u.toString();
  }

  /**
   * Fetch and parse the gateway's `/json/version` payload — CDP connection
   * metadata (including `webSocketDebuggerUrl`). Tolerates the gateway's
   * occasional empty/HTML bodies by throwing a retryable error instead of
   * crashing on JSON.parse.
   */
  async getConnectionInfo(country: string = this.country): Promise<ConnectionInfo> {
    const res = await this.#fetch(this.withCreds(`http://${this.gateway}/json/version`, country));
    const text = await res.text();
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
    try {
      return JSON.parse(text) as ConnectionInfo;
    } catch {
      throw new Error('gateway returned a non-JSON body');
    }
  }

  /**
   * The credentialed CDP WebSocket URL, with the gateway's transient failures
   * retried. This is the one call most integrations need:
   *
   *   const browser = await chromium.connectOverCDP(await client.getCDPUrl());
   */
  async getCDPUrl({ country = this.country, attempts = this.connectRetries, onRetry }: GetCDPUrlOptions = {}): Promise<string> {
    const info = await withRetry(() => this.getConnectionInfo(country), {
      attempts,
      delayMs: this.#retryDelayMs,
      onRetry:
        onRetry ??
        (({ attempt, attempts: total, error }) =>
          this.log(`gateway attempt ${attempt}/${total} failed (${error.message}); retrying...`)),
    });
    return this.withCreds(info.webSocketDebuggerUrl, country);
  }
}
```

- [ ] **Step 4: Create `packages/sdk/src/index.ts`**

```ts
export { ArchonumClient } from './client.js';
export type { ArchonumClientOptions, GetCDPUrlOptions, FetchLike } from './client.js';
export { withRetry, sleep } from './retry.js';
export { loadDotEnv, readEnvConfig } from './env.js';
export type { EnvConfig } from './env.js';
export type { ConnectionInfo, RetryInfo, RetryOptions } from './types.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @archonum/sdk test`
Expected: PASS, 19 tests total.

- [ ] **Step 6: Build and check the emitted declarations**

Run: `pnpm --filter @archonum/sdk build && ls packages/sdk/dist`
Expected: `index.js`, `index.d.ts`, `client.js`, `client.d.ts`, `env.*`, `retry.*`, `types.d.ts`, plus `.map` files. No compiler errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk
git commit -m "feat(sdk): add ArchonumClient with getCDPUrl and getConnectionInfo"
```

---

### Task 5: sdk README

**Files:**
- Create: `packages/sdk/README.md`

**Interfaces:**
- Consumes: the Task 4 public API.
- Produces: npm-facing docs for the sdk package.

- [ ] **Step 1: Write `packages/sdk/README.md`**

Sections, in order:

1. **Title + one-paragraph pitch** — `@archonum/sdk` authenticates against the archonum CDP gateway and returns a credentialed CDP WebSocket URL. Zero dependencies. For browser automation on top of it, point at `@archonum/engine`.
2. **Install** — `pnpm add @archonum/sdk`.
3. **Quick start** — the Playwright one-liner:

```js
import { ArchonumClient } from '@archonum/sdk';
import { chromium } from 'playwright';

const client = ArchonumClient.fromEnv();
const browser = await chromium.connectOverCDP(await client.getCDPUrl());
```

4. **Configuration** — the constructor options table (gateway, username, password, country, connectRetries, log, retryDelayMs) and the `ARCHONUM_*` env table copied from the current root README lines 203-210, plus a note that `fromEnv()` also loads a `.env` from the cwd and that real env vars win.
5. **API** — `getCDPUrl(opts?)`, `getConnectionInfo(country?)`, `withCreds(url, country?)`, `withRetry(fn, opts?)`, each with a two-line description and signature.
6. **Security note** — carry over the root README's warning (lines 212-214): the gateway authenticates via query string, so keep credentialed URLs out of logs and persistence.
7. **Country selection** — `country: 'ch'` pins the exit country; `''` lets the gateway choose; `getCDPUrl({ country })` overrides per call.

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/README.md
git commit -m "docs(sdk): add package README"
```

---

### Task 6: engine scaffold + leaf modules

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/src/util.ts`, `packages/engine/src/png.ts`, `packages/engine/src/page-state.ts`, `packages/engine/src/mutation.ts`, `packages/engine/src/dom-globals.d.ts`, `packages/engine/src/types.ts`, `packages/engine/test/png.test.ts`
- Reference: `archonum.js:69-74` (pngSize), `archonum.js:363-376` (mutation counter), `archonum.js:124-140` (the `_archonumClip`/`_archonumCreated` monkeypatching this task replaces)

**Interfaces:**
- Consumes: `@archonum/sdk` types (not used yet by these leaves).
- Produces:
  - `sleep(ms: number): Promise<void>` (engine-local copy; the sdk's is not part of the engine's contract)
  - `pngSize(bytes: Uint8Array | undefined): { width: number; height: number } | null`
  - `setClip(page, clip)`, `getClip(page): Clip | undefined`, `markCreated(page)`, `wasCreated(page): boolean`
  - `mutationCount(page: Page): Promise<number | null>`
  - `interface Clip { x: number; y: number; width: number; height: number }`
  - `interface PageInfo { url: string; status: number; title: string; textLength: number; blocked: boolean; challenge?: ChallengeKind; clearable?: Clearable }`
  - `interface ContentWait extends PageInfo { settled: boolean; stalled: boolean; excerpt?: string; recommendation?: string }`
  - `interface CaptureResult { buffer: Uint8Array | undefined; clip: Clip; width?: number; height?: number }`
  - `interface PageTextResult { text: string; truncated: boolean; textLength: number }`
  - `interface ReadResult extends PageInfo { settled: boolean; stalled?: boolean; excerpt?: string; text: string; truncated: boolean; screenshot?: Uint8Array }`
  - `interface CompareResult extends PageInfo { country: string; excerpt: string; extracted?: string | null; screenshot?: Uint8Array }`
  - `type EffectResult = 'navigation' | 'dom-change' | 'none' | 'unknown'`

- [ ] **Step 1: Create `packages/engine/package.json`**

```json
{
  "name": "@archonum/engine",
  "version": "1.0.0",
  "description": "Browser automation on the archonum gateway: stealth remote Chrome sessions, accessibility snapshots, human-like input, bot-wall detection.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/papers-ch/archonum-sdk-js.git", "directory": "packages/engine" },
  "homepage": "https://github.com/papers-ch/archonum-sdk-js/tree/master/packages/engine#readme",
  "keywords": ["archonum", "puppeteer", "cdp", "browser-automation", "scraping", "stealth"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@archonum/sdk": "workspace:^",
    "rebrowser-puppeteer-core": "^24.8.1"
  }
}
```

- [ ] **Step 2: Create `packages/engine/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install the workspace link**

Run: `pnpm install`
Expected: `packages/engine/node_modules/@archonum/sdk` is a symlink to `packages/sdk`.

- [ ] **Step 4: Write the failing test — `packages/engine/test/png.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pngSize } from '../src/png.js';

/** Minimal PNG header: signature + IHDR length/type + width/height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('pngSize reads width and height from the IHDR chunk', () => {
  assert.deepEqual(pngSize(pngHeader(1280, 800)), { width: 1280, height: 800 });
});

test('pngSize returns null for input that is not a PNG', () => {
  assert.equal(pngSize(undefined), null);
  assert.equal(pngSize(new Uint8Array(10)), null, 'too short');
  assert.equal(pngSize(new Uint8Array(24)), null, 'missing PNG signature');
});

test('pngSize works on a Buffer view with a non-zero byteOffset', () => {
  const padded = Buffer.concat([Buffer.alloc(8), Buffer.from(pngHeader(640, 480))]);
  assert.deepEqual(pngSize(padded.subarray(8)), { width: 640, height: 480 });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @archonum/engine test`
Expected: FAIL — cannot resolve `../src/png.js`.

- [ ] **Step 6: Create `packages/engine/src/png.ts`**

```ts
/** Width/height from a PNG's IHDR — cheap detection of partial captures. */
export function pngSize(bytes: Uint8Array | undefined): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @archonum/engine test`
Expected: PASS, 3 tests.

- [ ] **Step 8: Create `packages/engine/src/util.ts`**

```ts
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
```

- [ ] **Step 9: Create `packages/engine/src/page-state.ts`**

This replaces the `page._archonumClip` / `page._archonumCreated` monkeypatching (`archonum.js:124-140`), which strict TypeScript rejects.

```ts
import type { Page } from 'rebrowser-puppeteer-core';
import type { Clip } from './types.js';

/** The screenshot clip we own for a page (desktop mode only). */
const clips = new WeakMap<Page, Clip>();
/** Pages this SDK opened itself — the only ones disconnect() may close. */
const created = new WeakSet<Page>();

export const setClip = (page: Page, clip: Clip): void => void clips.set(page, clip);
export const getClip = (page: Page): Clip | undefined => clips.get(page);
export const markCreated = (page: Page, wasOurs: boolean): void => {
  if (wasOurs) created.add(page);
  else created.delete(page);
};
export const wasCreated = (page: Page): boolean => created.has(page);
```

- [ ] **Step 10: Create `packages/engine/src/dom-globals.d.ts`**

Ambient augmentations for the two non-standard globals the in-page code touches.

```ts
interface NavigatorUABrand {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  brands?: NavigatorUABrand[];
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platformVersion?: string;
    architecture?: string;
    bitness?: string;
    model?: string;
    uaFullVersion?: string;
    fullVersionList?: NavigatorUABrand[];
  }>;
}

declare global {
  interface Navigator {
    userAgentData?: NavigatorUAData;
  }
  interface Window {
    /** Installed by mutationCount(): a page-wide DOM mutation counter. */
    __archonumMut?: { n: number };
  }
}

export {};
```

- [ ] **Step 11: Create `packages/engine/src/mutation.ts`**

Ported from `archonum.js:363-376`.

```ts
import type { Page } from 'rebrowser-puppeteer-core';

/**
 * Install (once per navigation context) a page-wide DOM-mutation counter and
 * return its current value, or null when the page can't be instrumented. Runs in
 * the isolated world, which still observes the real DOM. A count LOWER than one
 * read earlier means the context was replaced — i.e. a navigation happened.
 */
export async function mutationCount(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      if (!window.__archonumMut) {
        const state = { n: 0 };
        window.__archonumMut = state;
        new MutationObserver((records) => {
          state.n += records.length;
        }).observe(document.documentElement ?? document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
      return window.__archonumMut.n;
    })
    .catch(() => null);
}
```

- [ ] **Step 12: Create `packages/engine/src/types.ts`**

```ts
export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ChallengeKind =
  | 'cloudflare-js-challenge'
  | 'cloudflare-turnstile'
  | 'akamai'
  | 'perimeterx'
  | 'datadome'
  | 'generic-interstitial'
  | 'unknown-empty'
  | 'unknown';

/** How likely a challenge is to clear on its own for a real device just waiting. */
export type Clearable = 'likely' | 'maybe' | 'unlikely';

export interface PageInfo {
  url: string;
  status: number;
  title: string;
  textLength: number;
  blocked: boolean;
  challenge?: ChallengeKind;
  clearable?: Clearable;
}

export interface ContentWait extends PageInfo {
  settled: boolean;
  stalled: boolean;
  excerpt?: string;
  recommendation?: string;
}

export interface PageTextResult {
  text: string;
  truncated: boolean;
  textLength: number;
}

export interface CaptureResult {
  buffer: Uint8Array | undefined;
  clip: Clip;
  width?: number;
  height?: number;
}

export interface ReadResult extends PageInfo {
  settled: boolean;
  stalled?: boolean;
  excerpt?: string;
  text: string;
  truncated: boolean;
  screenshot?: Uint8Array;
}

export interface CompareResult extends PageInfo {
  country: string;
  excerpt: string;
  extracted?: string | null;
  screenshot?: Uint8Array;
}

export type EffectResult = 'navigation' | 'dom-change' | 'none' | 'unknown';
```

- [ ] **Step 13: Typecheck**

Run: `pnpm --filter @archonum/engine exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): scaffold package with png, page-state, mutation helpers"
```

---

### Task 7: engine challenge classification + DOM scan

**Files:**
- Create: `packages/engine/src/challenge.ts`, `packages/engine/src/dom-scan.ts`
- Reference: `archonum.js:56-67` + `archonum.js:324-354` (challenge), `archonum.js:446-640` (scan, locate, resolve)

**Interfaces:**
- Consumes: `ChallengeKind`, `Clearable` (Task 6).
- Produces:
  - `CHALLENGE_CLEARABLE: Record<ChallengeKind, Clearable>`
  - `classifyChallenge(page: Page): Promise<ChallengeKind>`
  - `snapshotOutline(page: Page, opts?: { maxNodes?: number }): Promise<string>`
  - `locateRef(page: Page, target: { name?: string; role?: string; selector?: string }): Promise<string | null>`
  - `resolveRef(page: Page, ref: string | number): Promise<ElementHandle<Element>>`

- [ ] **Step 1: Create `packages/engine/src/challenge.ts`**

Port `CHALLENGE_CLEARABLE` (`archonum.js:56-67`) and `#classifyChallenge` (`archonum.js:330-354`) verbatim — same selectors, same markers, same order (turnstile before generic JS challenge), same `.catch(() => 'unknown')`. Shape:

```ts
import type { Page } from 'rebrowser-puppeteer-core';
import type { ChallengeKind, Clearable } from './types.js';

export const CHALLENGE_CLEARABLE: Record<ChallengeKind, Clearable> = {
  'cloudflare-js-challenge': 'likely',
  'cloudflare-turnstile': 'maybe',
  akamai: 'maybe',
  perimeterx: 'unlikely',
  datadome: 'unlikely',
  'generic-interstitial': 'maybe',
  'unknown-empty': 'unlikely',
  unknown: 'maybe',
};

/**
 * Which bot-wall vendor/type is blocking the page, from main-frame DOM markers.
 * Only worth calling when a page looks blocked — the answer tells a caller
 * whether waiting is worth it (see CHALLENGE_CLEARABLE).
 */
export async function classifyChallenge(page: Page): Promise<ChallengeKind> {
  return page
    .evaluate((): ChallengeKind => {
      // ... body ported verbatim from archonum.js:332-352
    })
    .catch((): ChallengeKind => 'unknown');
}
```

TypeScript notes for the in-page body: annotate the callback return as `ChallengeKind` so each literal is checked, and keep the local `q()` selector helper with its try/catch.

- [ ] **Step 2: Create `packages/engine/src/dom-scan.ts`**

Port `#domScan` (`archonum.js:486-605`), `snapshot` (`archonum.js:462-464`), `locate` (`archonum.js:476-478`), and `#resolve` (`archonum.js:614-640`) as free functions. The single in-page walk stays single — `snapshotOutline` and `locateRef` both call one internal `scan(page, opts)` so role/name definitions never drift.

Behavior to preserve exactly: the `KEEP` role set; `roleFor` including the custom-element/tabindex fallback; `nameFor`'s attribute precedence (`aria-label`, `placeholder`, `alt`, `title`, then text for non-textboxes) and 120-char cap; `visible()` using the element's own `defaultView`; walking light DOM + open shadow roots + same-origin iframe documents from the main frame only (never entering a child frame's execution context — it hangs under the rebrowser isolated-world patch); `[frame]` marker lines for unreadable cross-origin iframes; clearing stale `data-archonum-ref` attributes before stamping; `maxNodes` cap; `(value: …)` suffix for non-empty textboxes; `[iframe]` suffix for elements from another document; and the `'(no interactive elements found)'` fallback line.

TypeScript notes:
- Signature of the internal scan, so both callers share one implementation:

```ts
interface ScanOptions {
  locate?: { name?: string; role?: string; selector?: string } | null;
  maxNodes?: number;
}

async function scan(page: Page, opts: ScanOptions): Promise<string | null> {
  return page.evaluate((options: ScanOptions): string | null => {
    // ... ported body
  }, opts);
}

export async function snapshotOutline(page: Page, { maxNodes = 400 }: { maxNodes?: number } = {}): Promise<string> {
  return (await scan(page, { maxNodes })) ?? '(no interactive elements found)';
}

export async function locateRef(page: Page, target: { name?: string; role?: string; selector?: string }): Promise<string | null> {
  return scan(page, { locate: target });
}
```

- Inside the in-page body, elements come back as `Element`; cast where DOM subtypes are needed: `(el as HTMLInputElement).value`, `(el as HTMLIFrameElement).contentDocument`, `(el as HTMLElement).innerText`, `(el as HTMLElement).onclick`.
- `collect(root)` takes `Document | ShadowRoot | Element`; keep the try/catch around `querySelectorAll`.
- `resolveRef` keeps the recursive `find()` walk and throws the same message on a miss: `` `no element for ref e${n} — re-run snapshot (refs go stale after the DOM changes)` ``. Signature:

```ts
export async function resolveRef(page: Page, ref: string | number): Promise<ElementHandle<Element>> {
  const n = Number(String(ref).replace(/^e/, ''));
  const handle = await page.evaluateHandle((wanted: number) => { /* ported find() */ }, n);
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await handle.dispose().catch(() => {});
    throw new Error(`no element for ref e${n} — re-run snapshot (refs go stale after the DOM changes)`);
  }
  return el;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @archonum/engine exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/challenge.ts packages/engine/src/dom-scan.ts
git commit -m "feat(engine): port challenge classification and DOM scanning"
```

---

### Task 8: engine humanized input + actions

**Files:**
- Create: `packages/engine/src/human.ts`, `packages/engine/src/actions.ts`
- Reference: `archonum.js:642-747` (rand/pause/humanClick/effectWatch/occluder), `archonum.js:749-925` (click/type/select/press/scroll)

**Interfaces:**
- Consumes: `resolveRef` (Task 7), `mutationCount` (Task 6), `sleep` (Task 6), `EffectResult` (Task 6).
- Produces:
  - `class Humanizer { constructor(enabled: boolean); readonly enabled: boolean; rand(min: number, max: number): number; pause(min: number, max: number): Promise<void> }`
  - `humanClick(page: Page, el: ElementHandle<Element>, human: Humanizer, opts?: { force?: boolean; onBeforePress?: () => Promise<void> | void }): Promise<void>`
  - `occluder(el: ElementHandle<Element>, point: { x: number; y: number }): Promise<string | null>`
  - `effectWatch(page: Page): Promise<{ arm: () => Promise<void>; result: (timeoutMs?: number) => Promise<EffectResult>; dispose: () => void }>`
  - `click(page, ref, human, opts?): Promise<{ effect: EffectResult; via: 'mouse' | 'enter' }>`
  - `type(page, ref, text, human, opts?): Promise<void>` — opts `{ submit?: boolean; clear?: boolean; verify?: boolean }`
  - `select(page, ref, value: string | string[]): Promise<{ effect: EffectResult }>`
  - `press(page, key: string, human, opts?: { ref?: string | number }): Promise<{ effect: EffectResult }>`
  - `scroll(page, human, opts?: { direction?: 'down' | 'up' | 'top' | 'bottom'; ref?: string | number }): Promise<void>`

- [ ] **Step 1: Create `packages/engine/src/human.ts`**

```ts
import type { ElementHandle, Page } from 'rebrowser-puppeteer-core';
import { mutationCount } from './mutation.js';
import { sleep } from './util.js';
import type { EffectResult } from './types.js';

/**
 * Human-like timing. Behavioural bot walls flag the superhuman cadence of raw CDP
 * input, so every interaction routes its pauses through here. `enabled: false`
 * turns them into no-ops for maximum speed.
 */
export class Humanizer {
  constructor(readonly enabled: boolean) {}

  /** Uniform random in [min, max). */
  rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  /** Think-time pause with a random duration — a no-op when disabled. */
  async pause(min: number, max: number): Promise<void> {
    if (this.enabled) await sleep(this.rand(min, max));
  }
}
```

Then port, verbatim in behavior:
- `occluder(el, point)` from `archonum.js:727-747` — including the iframe coordinate translation loop and the `<role "name">` description string.
- `humanClick(page, el, human, { force, onBeforePress })` from `archonum.js:660-688` — scrollIntoView, pause, `clickablePoint()` with the plain-`el.click()` fallback path, the occlusion refusal with the exact message `` `target is covered by ${blocker} — dismiss it first, then retry (force:true skips this check for false positives)` ``, jittered mouse move with `steps` (12-28 when humanized, else 1), hover pause, `onBeforePress` armed after the scroll, down/up with press duration, settle pause.
- `effectWatch(page)` from `archonum.js:701-724` — `framenavigated` listener, `arm()`, `result(timeoutMs = 1000)` with the navigation-first short-circuit and counter-reset-means-navigation rule, `dispose()`.

- [ ] **Step 2: Create `packages/engine/src/actions.ts`**

Port `click`, `type`, `select`, `press`, `scroll` from `archonum.js:764-925` as free functions taking `(page, …, human)` instead of using `this`. Preserve exactly:
- `click`: effect watch armed before the press; on `effect === 'none'` and `fallback`, focus + Enter retry setting `via: 'enter'`; `watch.dispose()` in `finally`.
- `type`: focus via `humanClick` (so an overlay still throws by name), `select()`-based clear, per-character typing with 45-165ms jitter and the 8% chance of a 200-500ms "thinking" beat, read-back verification with the exact multi-line error message from `archonum.js:817-821`, optional Enter submit.
- `select`: in-page label-or-value resolution, `el.select(...values)`, the `` `select: no <option> matched ${JSON.stringify(wanted)}` `` throw, `effect` from the watcher.
- `press`: modifier down/up ordering with pauses, `ref` focusing first.
- `scroll`: `ref` centers the element; `top`/`bottom` jump; `down`/`up` dispatch 3-6 jittered wheel ticks of 90% viewport height total.

TypeScript notes:
- `select`'s in-page callback: `el.evaluate((node, wanted: string[]) => { const sel = node as HTMLSelectElement; ... }, wanted)`.
- `type`'s read-back: `el.evaluate((node) => { const input = node as HTMLInputElement; return input.value ?? node.textContent ?? ''; })`.
- Function signatures (used by Task 9's session delegates):

```ts
export async function click(page: Page, ref: string | number, human: Humanizer, { force = false, fallback = false }: { force?: boolean; fallback?: boolean } = {}): Promise<{ effect: EffectResult; via: 'mouse' | 'enter' }>;
export async function type(page: Page, ref: string | number, text: string, human: Humanizer, { submit = false, clear = true, verify = true }: { submit?: boolean; clear?: boolean; verify?: boolean } = {}): Promise<void>;
export async function select(page: Page, ref: string | number, value: string | string[]): Promise<{ effect: EffectResult }>;
export async function press(page: Page, key: string, human: Humanizer, { ref }: { ref?: string | number } = {}): Promise<{ effect: EffectResult }>;
export async function scroll(page: Page, human: Humanizer, { direction = 'down', ref }: { direction?: 'down' | 'up' | 'top' | 'bottom'; ref?: string | number } = {}): Promise<void>;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @archonum/engine exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/human.ts packages/engine/src/actions.ts
git commit -m "feat(engine): port humanized input and page actions"
```

---

### Task 9: engine ArchonumSession

**Files:**
- Create: `packages/engine/src/session.ts`
- Reference: `archonum.js:99-1002` (the class being ported), `archonum.js:35-54` (rebrowser env default + `DESKTOP_UA`)

**Interfaces:**
- Consumes: `Humanizer` + `humanClick` (Task 8), `actions.*` (Task 8), `snapshotOutline`/`locateRef`/`resolveRef` (Task 7), `classifyChallenge`/`CHALLENGE_CLEARABLE` (Task 7), `pngSize`/page-state/`mutationCount`/`sleep` (Task 6), `ConnectionInfo` from `@archonum/sdk`.
- Produces:
  - `DESKTOP_UA: string`
  - `class ArchonumSession` — `constructor(browser: Browser, info: ConnectionInfo, opts?: { humanize?: boolean })`, public `browser`, `info`, `humanize`, and methods:
    - `newPage(opts?: { desktop?: boolean; userAgent?: string | null }): Promise<Page>`
    - `renderedTextLength(page): Promise<number>`
    - `pageText(page, opts?: { maxChars?: number }): Promise<PageTextResult>`
    - `captureViewport(page, opts?: { path?: string; retries?: number; onRetry?: (info: RetryInfo) => void }): Promise<CaptureResult>`
    - `pageInfo(page, response?: HTTPResponse | null): Promise<PageInfo>`
    - `waitForContent(page, opts?): Promise<ContentWait>`
    - `snapshot(page, opts?: { maxNodes?: number }): Promise<string>`
    - `locate(page, target): Promise<string | null>`
    - `click`/`type`/`select`/`press`/`scroll` — same signatures as today, delegating to `actions.*`
    - `runFlow(page, steps, opts?)` — delegates to Task 10's `runFlow`
    - `disconnect(): Promise<void>`

- [ ] **Step 1: Create `packages/engine/src/session.ts` — module head**

The rebrowser fix mode must be set before the library loads, so it stays a module-level side effect, moved from `archonum.js:35-42`:

```ts
// The rebrowser Runtime-leak fix mode MUST be chosen before the library is
// imported. 'alwaysIsolated' runs page.evaluate in an isolated world: leak-free
// and reliable on a reused tab. Setting it here means importing this package is
// enough — callers don't have to remember the env var.
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ||= 'alwaysIsolated';

const { default: puppeteer } = await import('rebrowser-puppeteer-core');
export { puppeteer };
```

Keep `DESKTOP_UA` and its explanatory comment from `archonum.js:46-54`.

Note: top-level `await import` is why the package is ESM-only; `module: NodeNext` supports it.

- [ ] **Step 2: Port the class body**

Method-by-method from `archonum.js`, behavior unchanged:
- `newPage` (`124-140`) — reuse `pages()[0]` when present else `browser.newPage()`, recording ownership via `markCreated(page, isNew)` and the desktop clip via `setClip(page, clip)`.
- `#applyDesktop` (`156-212`) — private method; explicit `userAgent` honoured verbatim; else read the real device identity (`navigator.userAgentData` + high-entropy hints) and present its desktop variant (drop the `Mobile` token, `mobile: false`, `model: ''`), falling back to `DESKTOP_UA` when the device exposes no UA; then the physical-width-capped 1280-wide viewport at a 1440:900 ratio. Cast the high-entropy result fields to `string` when building the metadata.
- `renderedTextLength` (`220-222`), `pageText` (`235-240`).
- `#ensureViewport` (`250-260`), `captureViewport` (`274-297`) — the `withRetry` wrapper (import from `@archonum/sdk`), the short-capture detection via `pngSize`, and the forced re-apply + single retry.
- `pageInfo` (`311-322`) — `blocked` heuristic (`status === 429 || status === 403 || textLength < 200`), then `classifyChallenge` + `CHALLENGE_CLEARABLE` lookup when blocked.
- `waitForContent` (`394-444`) — request counting via the `request` listener removed in `finally`, `containsText` excerpt finder with ±150 chars, mutation/network/text activity tracking, the early `stalled: true` return with the verbatim `recommendation` string, and `settled: met()` on exit.
- `snapshot`/`locate` — one-line delegates to `snapshotOutline`/`locateRef`.
- `click`/`type`/`select`/`press`/`scroll` — delegates passing `new Humanizer(this.humanize)`; build the humanizer once in the constructor (`this.#human`) rather than per call.
- `locate` — keep a `= {}` parameter default on the wrapper (`locateRef` in `dom-scan.ts` has none), so the public signature stays call-compatible with the original `locate(page, { name, role, selector } = {})`.
- `disconnect` (`996-1001`) — close only pages where `wasCreated(page)`, then `browser.disconnect()`.

`runFlow` is deliberately NOT part of this task: it needs `flow.ts`, which Task 10 creates. Task 10 adds both `flow.ts` and the thin `runFlow` delegate method on `ArchonumSession`. This keeps Task 9 independently buildable — a task that ends with a failing compile cannot be reviewed against a green baseline.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @archonum/engine build`
Expected: exit 0. Since `runFlow` is deferred to Task 10, there is no missing-import error to tolerate — any error here is a real one, so fix it before moving on.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/session.ts
git commit -m "feat(engine): port ArchonumSession"
```

---

### Task 10: engine flow, ArchonumEngine, index, README

**Files:**
- Create: `packages/engine/src/flow.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/index.ts`, `packages/engine/README.md`, `packages/engine/test/flow.test.ts`
- Reference: `archonum.js:927-990` (runFlow), `archonum.js:1092-1272` (connect/capture/compareFlow/read)

**Interfaces:**
- Consumes: `ArchonumSession`, `puppeteer`, `DESKTOP_UA` (Task 9); `actions.*` (Task 8); `locateRef` (Task 7); `ArchonumClient`, `ArchonumClientOptions`, `ConnectionInfo` from `@archonum/sdk`.
- Produces:
  - `interface FlowStep { action: 'goto' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'wait' | 'waitForContent'; target?: string; selector?: string; role?: string; url?: string; waitUntil?: PuppeteerLifeCycleEvent; text?: string; value?: string | string[]; key?: string; direction?: 'down' | 'up' | 'top' | 'bottom'; submit?: boolean; clear?: boolean; ms?: number; minTextLength?: number; timeoutMs?: number; optional?: boolean }`
  - `runFlow(page: Page, steps: FlowStep[], opts: { session: ArchonumSession; log?: (msg: string) => void }): Promise<void>`
  - the `ArchonumSession#runFlow(page, steps, { log? })` delegate method, added to `session.ts` in this task (Task 9 deliberately left it out so that task could build on its own)
  - `interface ArchonumEngineOptions { humanize?: boolean; protocolTimeout?: number }`
  - `class ArchonumEngine` — `constructor(client: ArchonumClient, opts?: ArchonumEngineOptions)`, `static fromEnv(overrides?: ArchonumClientOptions & ArchonumEngineOptions)`, `connect(opts?: { country?: string }): Promise<ArchonumSession>`, `capture(url, opts?)`, `read(url, opts?)`, `compareFlow(url, opts)`, and a `log` getter delegating to `client.log`.
  - `packages/engine/src/index.ts` re-exports `ArchonumEngine`, `ArchonumSession`, `runFlow`, `Humanizer`, `puppeteer`, `DESKTOP_UA`, `CHALLENGE_CLEARABLE`, and every type from `./types.js` + `FlowStep` + the option interfaces.

- [ ] **Step 1: Write the failing test — `packages/engine/test/flow.test.ts`**

`runFlow` is the one non-trivial engine logic that needs no live gateway: it dispatches on `step.action` against a session/page it is handed. Test it with fakes.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, type FlowStep } from '../src/flow.js';

/** Records every call so the dispatch can be asserted without a browser. */
function fakes(locate: (target: unknown) => string | null = () => 'e1') {
  const calls: string[] = [];
  const page = {
    goto: async (url: string, opts: { waitUntil?: string }) => { calls.push(`goto ${url} ${opts.waitUntil}`); return null; },
  };
  const session = {
    locate: async (_page: unknown, target: unknown) => { calls.push(`locate ${JSON.stringify(target)}`); return locate(target); },
    click: async (_page: unknown, ref: string) => { calls.push(`click ${ref}`); return { effect: 'dom-change', via: 'mouse' }; },
    type: async (_page: unknown, ref: string, text: string) => { calls.push(`type ${ref} ${text}`); },
    select: async (_page: unknown, ref: string, value: string) => { calls.push(`select ${ref} ${value}`); return { effect: 'dom-change' }; },
    press: async (_page: unknown, key: string) => { calls.push(`press ${key}`); return { effect: 'none' }; },
    scroll: async (_page: unknown, opts: { direction?: string }) => { calls.push(`scroll ${opts.direction}`); },
    waitForContent: async (_page: unknown, opts: { minTextLength?: number }) => { calls.push(`waitForContent ${opts.minTextLength}`); return {}; },
  };
  return { calls, page, session };
}

const run = (steps: FlowStep[], f = fakes(), log?: (msg: string) => void) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runFlow(f.page as any, steps, { session: f.session as any, ...(log ? { log } : {}) });

test('runFlow dispatches each step to the right session method', async () => {
  const f = fakes();
  await run([
    { action: 'goto', url: 'https://example.com/' },
    { action: 'type', target: 'Search', text: 'parka', submit: true },
    { action: 'click', target: 'Go' },
    { action: 'select', target: 'Size', value: 'M' },
    { action: 'press', key: 'Escape' },
    { action: 'scroll', direction: 'bottom' },
    { action: 'waitForContent', minTextLength: 500 },
  ], f);
  assert.deepEqual(f.calls, [
    'goto https://example.com/ load',
    'locate {"name":"Search"}',
    'type e1 parka',
    'locate {"name":"Go"}',
    'click e1',
    'locate {"name":"Size"}',
    'select e1 M',
    'press Escape',
    'scroll bottom',
    'waitForContent 500',
  ]);
});

test('runFlow skips an optional step whose target is missing, and logs it', async () => {
  const f = fakes(() => null);
  const logged: string[] = [];
  await run([{ action: 'click', target: 'Accept all', optional: true }], f, (msg) => logged.push(msg));
  assert.deepEqual(f.calls, ['locate {"name":"Accept all"}']);
  assert.match(logged.join('\n'), /skipped click \(not found\): Accept all/);
});

test('runFlow throws when a required target is missing', async () => {
  await assert.rejects(
    () => run([{ action: 'click', target: 'Buy now' }], fakes(() => null)),
    /could not locate "Buy now" for click/,
  );
});

test('runFlow rejects an unknown action', async () => {
  await assert.rejects(
    () => run([{ action: 'teleport' } as unknown as FlowStep], fakes()),
    /unknown step action "teleport"/,
  );
});

test('runFlow waits the requested time for a wait step', async () => {
  const started = process.hrtime.bigint();
  await run([{ action: 'wait', ms: 20 }], fakes());
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 >= 15);
});
```

`locate` is called with `{ name, role, selector }` where undefined keys are omitted — build that object with conditional spreads so `JSON.stringify` matches the assertions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @archonum/engine test`
Expected: FAIL — cannot resolve `../src/flow.js`.

- [ ] **Step 3: Create `packages/engine/src/flow.ts`**

Port `runFlow` from `archonum.js:947-990`, taking the session as an explicit dependency instead of `this`:

```ts
import type { Page, PuppeteerLifeCycleEvent } from 'rebrowser-puppeteer-core';
import type { ArchonumSession } from './session.js';
import { sleep } from './util.js';

export interface FlowStep { /* as in the Interfaces block above */ }

export interface RunFlowOptions {
  session: ArchonumSession;
  log?: (msg: string) => void;
}

/**
 * Replay a declarative flow on a page. Element-targeting steps address elements
 * the way locate() does (visible `target` name + optional `role`, or a CSS
 * `selector`) rather than a snapshot ref, so the SAME flow runs in any fresh
 * session. `optional: true` skips a targeting step whose element isn't found
 * (cookie banners, popups that only sometimes appear).
 */
export async function runFlow(page: Page, steps: FlowStep[] = [], { session, log = () => {} }: RunFlowOptions): Promise<void> {
  // switch on step.action exactly as archonum.js:951-989 does
}
```

Keep the documented step shapes in the doc comment (the list at `archonum.js:934-941`), the `optional` skip log line, and the two throw messages verbatim.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @archonum/engine test`
Expected: PASS, 8 tests (3 png + 5 flow).

- [ ] **Step 5: Create `packages/engine/src/engine.ts`**

```ts
import type { ArchonumClient, ArchonumClientOptions } from '@archonum/sdk';
import { ArchonumClient as Client } from '@archonum/sdk';
import { ArchonumSession, puppeteer } from './session.js';
import { sleep } from './util.js';
import type { CompareResult, ReadResult } from './types.js';
import type { FlowStep } from './flow.js';

export interface ArchonumEngineOptions {
  /** Human-like input cadence on the session's actions. Default: true. */
  humanize?: boolean;
  /** Puppeteer protocol timeout for the remote connection. Default: 120000. */
  protocolTimeout?: number;
}

/**
 * Browser automation over the archonum gateway. It uses @archonum/sdk for
 * authentication and owns everything above it: the CDP handshake, sessions, and
 * the one-shot helpers.
 */
export class ArchonumEngine {
  readonly client: ArchonumClient;
  readonly humanize: boolean;
  readonly protocolTimeout: number;

  constructor(client: ArchonumClient, { humanize = true, protocolTimeout = 120_000 }: ArchonumEngineOptions = {}) {
    this.client = client;
    this.humanize = humanize;
    this.protocolTimeout = protocolTimeout;
  }

  /** Build an engine (and its client) from the ARCHONUM_* environment. */
  static fromEnv({ humanize, protocolTimeout, ...clientOptions }: ArchonumClientOptions & ArchonumEngineOptions = {}): ArchonumEngine {
    return new ArchonumEngine(Client.fromEnv(clientOptions), { humanize, protocolTimeout });
  }

  get log(): (msg: string) => void {
    return this.client.log;
  }

  /**
   * Fetch the endpoint AND open the CDP connection as one unit, retrying the
   * whole handshake with exponential backoff — the shared gateway throws
   * transient 502s on both the version request and the WS upgrade.
   */
  async connect({ country = this.client.country }: { country?: string } = {}): Promise<ArchonumSession> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.client.connectRetries; attempt++) {
      try {
        const info = await this.client.getConnectionInfo(country);
        const browser = await puppeteer.connect({
          browserWSEndpoint: this.client.withCreds(info.webSocketDebuggerUrl, country),
          defaultViewport: null, // use the remote device's own screen size
          protocolTimeout: this.protocolTimeout,
        });
        return new ArchonumSession(browser, info, { humanize: this.humanize });
      } catch (err) {
        lastErr = err;
        if (attempt === this.client.connectRetries) break;
        const wait = Math.min(2 ** attempt, 8);
        this.log(`handshake attempt ${attempt} failed (${(err as Error).message}); retrying in ${wait}s...`);
        await sleep(wait * 1000);
      }
    }
    throw lastErr;
  }

  // capture(), read(), compareFlow() ported below
}
```

Then port the three one-shots from `ArchonumClient`, unchanged in behavior:
- `capture(url, { path?, desktop?, settleMs = 15000, navTimeout = 90000, waitUntil = 'load' })` from `archonum.js:1135-1155` → returns `{ buffer, clip, status, title, textLength, info }`.
- `compareFlow(url, { countries, steps = [], extract?, screenshot = false, desktop = true, excerptChars = 800 })` from `archonum.js:1177-1209` → `Promise<CompareResult[]>`, including the "status only when no steps ran" rule and the per-country log prefix.
- `read(url, opts)` from `archonum.js:1239-1272` → `Promise<ReadResult>`, including the settle loop, the `deadline` interaction, and the conditional `stalled`/`excerpt`/`screenshot` fields.

Note: `connect()` deliberately uses `getConnectionInfo()` + `withCreds()` rather than `getCDPUrl()`, because the session needs the `ConnectionInfo` payload (it surfaces the remote device as `session.info`) and the retry must wrap the WS upgrade too, not just the HTTP request.

- [ ] **Step 6: Create `packages/engine/src/index.ts`**

```ts
export { ArchonumEngine } from './engine.js';
export type { ArchonumEngineOptions } from './engine.js';
export { ArchonumSession, puppeteer, DESKTOP_UA } from './session.js';
export { Humanizer } from './human.js';
export { runFlow } from './flow.js';
export type { FlowStep, RunFlowOptions } from './flow.js';
export { CHALLENGE_CLEARABLE } from './challenge.js';
export type {
  Clip, ChallengeKind, Clearable, PageInfo, ContentWait, PageTextResult,
  CaptureResult, ReadResult, CompareResult, EffectResult,
} from './types.js';
```

- [ ] **Step 7: Build and verify the emitted API**

Run: `pnpm --filter @archonum/engine build && grep -c "export" packages/engine/dist/index.d.ts`
Expected: build succeeds; `dist/index.d.ts` exists with the exports above.

- [ ] **Step 8: Write `packages/engine/README.md`**

Adapt the current root README, which is already engine-shaped. Sections:

1. **Title + pitch** — real-device remote Chrome, per-session exit country, nothing to fake (root README lines 3-19), with a line stating it builds on `@archonum/sdk`.
2. **Install** — `pnpm add @archonum/engine`.
3. **Quick start** — `ArchonumEngine.fromEnv()` then `capture()` / `read()` (adapted from root README lines 82-95, with `client.` → `engine.`).
4. **Driving a session** — the `connect()` → `newPage()` → snapshot/type/waitForContent → `disconnect()` walkthrough plus the per-method bullets (root README lines 105-137).
5. **Is the page blocked?** — `pageInfo`/`waitForContent`, challenge kinds, `stalled` (root README lines 139-153).
6. **Replayable flows & geo comparison** — `compareFlow`/`runFlow` (root README lines 155-176).
7. **Desktop mode** — root README lines 178-184.
8. **Configuration** — `new ArchonumEngine(client, { humanize, protocolTimeout })` and a pointer to `@archonum/sdk` for credentials/env.
9. **Session hygiene** — always `disconnect()`, never `browser.close()` (root README lines 236-239).
10. **Other engines** — if you only need the credentialed CDP URL (Playwright etc.), use `@archonum/sdk` directly: `chromium.connectOverCDP(await client.getCDPUrl())`.

- [ ] **Step 9: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): add ArchonumEngine, declarative flows, and package docs"
```

---

### Task 11: cli package

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/cli.ts`, `packages/cli/README.md`
- Reference: `cli.js` (whole file), `CLI.md` (whole file)

**Interfaces:**
- Consumes: `ArchonumEngine.fromEnv()` and `engine.capture()` (Task 10).
- Produces: the `archonum` bin — `archonum [--desktop] [url] [outfile]`.

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@archonum/cli",
  "version": "1.0.0",
  "description": "Screenshot any website through a real-device remote Chrome on the archonum gateway.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "archonum": "./dist/cli.js" },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/papers-ch/archonum-sdk-js.git", "directory": "packages/cli" },
  "homepage": "https://github.com/papers-ch/archonum-sdk-js/tree/master/packages/cli#readme",
  "keywords": ["archonum", "cli", "screenshot", "scraping"],
  "scripts": {
    "build": "tsc -p tsconfig.json && chmod +x dist/cli.js"
  },
  "dependencies": {
    "@archonum/engine": "workspace:^"
  }
}
```

No `test` script: the CLI's only logic is argv parsing plus a live-gateway call. It is smoke-tested in Step 5.

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/cli/src/cli.ts`**

Port `cli.js` verbatim in behavior, with a shebang and `ArchonumClient` → `ArchonumEngine`:

```ts
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

const engine = ArchonumEngine.fromEnv({ log: (msg) => console.log(`  ${msg}`) });

if (!engine.client.password) {
  console.error('✗ set ARCHONUM_PASSWORD — export it, or put it in a .env file in the current directory');
  process.exit(1);
}
```

Behavior to keep from `cli.js`: `--desktop` flag detection and its explanatory comment (`cli.js:28-35`), positional args with flags filtered out, default URL `https://www.mscdirect.com`, output filename defaulting to `<hostname-without-www>.png`, macOS auto-open gated on `NO_OPEN !== '1'`, the same `console.log` progress lines, the `textLength < 50` warning, and the `main().catch()` handler printing `✗ capture failed: …` with `exit(1)`.

Two changes from the original:
- The credential check moves after client construction (above) because `ArchonumEngine.fromEnv()` now also loads `.env` itself — so the old "did you forget `--env-file`?" hint is replaced by the message shown above. `ArchonumClient` throws on a missing password, so wrap `fromEnv()` in try/catch and print that message instead of a stack trace.
- `client.capture(...)` becomes `engine.capture(...)`; `client.country` becomes `engine.client.country`.

- [ ] **Step 4: Build**

Run: `pnpm install && pnpm --filter @archonum/cli build`
Expected: compiles; `packages/cli/dist/cli.js` exists and is executable.

- [ ] **Step 5: Smoke-test against the live gateway**

First verify the no-credentials path (works without a password):

```bash
cd /tmp && ARCHONUM_PASSWORD= ARCHONUM_USERNAME= node "$OLDPWD/packages/cli/dist/cli.js" https://example.com/; echo "exit=$?"
```

Expected: prints the `✗ set ARCHONUM_PASSWORD …` message and `exit=1` — no stack trace. (Run from `/tmp` so a repo-root `.env` is not picked up.)

Then, if a real password is available, the live path:

```bash
ARCHONUM_PASSWORD=… node packages/cli/dist/cli.js https://example.com/ /tmp/archonum-smoke.png
```

Expected: prints `✓ remote browser: …`, `✓ loaded [HTTP 200]: Example Domain`, `✓ saved …`. If no credentials are available, report in the task report that the live path is unverified.

- [ ] **Step 6: Write `packages/cli/README.md`**

Port `CLI.md` with `node cli.js` → `archonum` (and an `npx @archonum/cli <url>` line), plus a Setup section covering `ARCHONUM_PASSWORD` via export or `.env`. Keep the mobile-vs-desktop explanation verbatim.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add @archonum/cli package with archonum bin"
```

---

### Task 12: samples workspace package

**Files:**
- Create: `samples/package.json`, `samples/README.md`
- Modify: `samples/puppeteer-sample.js`, `samples/playwright-sample.js`, `samples/mcp-server.js`
- Delete: `archonum.js`, `cli.js`, `CLI.md` (their content now lives in the packages)

**Interfaces:**
- Consumes: `@archonum/engine` (`ArchonumEngine`, `ArchonumSession`), `@archonum/sdk` (`ArchonumClient`).
- Produces: three runnable samples; no exported API.

- [ ] **Step 1: Create `samples/package.json`**

```json
{
  "name": "@archonum/samples",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "puppeteer": "node puppeteer-sample.js",
    "playwright": "node playwright-sample.js",
    "mcp": "node mcp-server.js"
  },
  "dependencies": {
    "@archonum/engine": "workspace:^",
    "@archonum/sdk": "workspace:^",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "playwright": "^1.62.0",
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 2: Update `samples/puppeteer-sample.js`**

Change `import { ArchonumClient } from '../archonum.js'` to `import { ArchonumEngine } from '@archonum/engine'`, `ArchonumClient.fromEnv(...)` to `ArchonumEngine.fromEnv(...)`, and `client.connect()` to `engine.connect()`. Everything else stays. Update the header comment's run commands to `node samples/puppeteer-sample.js` (unchanged) and drop the "SDK's native engine (archonum.js wraps …)" phrasing in favour of "@archonum/engine wraps rebrowser-puppeteer-core".

- [ ] **Step 3: Update `samples/playwright-sample.js`**

This sample is the reason `getCDPUrl()` exists — replace the whole `withRetry` + `getVersion` + `withCreds` block (`samples/playwright-sample.js:34-45`) with:

```js
import { ArchonumClient } from '@archonum/sdk';
import { chromium } from 'playwright';

const client = ArchonumClient.fromEnv({ log: (msg) => console.log(`  ${msg}`) });

// One call: authenticate, survive the gateway's transient 502s, and hand Playwright
// a credentialed CDP endpoint. No @archonum/engine and no Puppeteer needed.
const browser = await chromium.connectOverCDP(await client.getCDPUrl());
console.log(`✓ attached to remote browser: ${browser.version()}`);
```

Update the header comment to match (it currently documents the three-step chain) and note that this sample needs only `@archonum/sdk`. Keep the rest of the file, including the `browser.close()` comment explaining that it detaches rather than killing the remote.

- [ ] **Step 4: Update `samples/mcp-server.js`**

- `import { ArchonumClient } from '../archonum.js'` → `import { ArchonumEngine } from '@archonum/engine'`.
- `const client = ArchonumClient.fromEnv({ log: … })` → `const engine = ArchonumEngine.fromEnv({ log: … })`; replace every later `client.` with `engine.` (`client.connect` → `engine.connect`, `client.read` → `engine.read`, `client.compareFlow` → `engine.compareFlow`, `client.country` → `engine.client.country`).
- Base64 conversions must go through `Buffer.from(...)` now that screenshots are typed `Uint8Array`: `Buffer.from(r.screenshot).toString('base64')` in the `read` tool, the `screenshot` tool, and `compare_countries`.
- Everything else — session registry, serialization, tool descriptions, INSTRUCTIONS — stays as is.

- [ ] **Step 5: Delete the pre-split root sources**

```bash
git rm archonum.js cli.js CLI.md
```

- [ ] **Step 6: Write `samples/README.md`**

The prerequisites doc the review asked for:

1. **What these are** — runnable examples, not part of any published package; a private workspace package so its dependencies (Playwright, the MCP SDK, zod) never reach `@archonum/*` consumers.
2. **Setup** — `pnpm install` at the repo root, then `pnpm build` (the samples import the packages' `dist/`), then `cp .env.example .env` and fill `ARCHONUM_PASSWORD`.
3. **Per-sample section** — for each of the three: what it demonstrates, which package it needs, and the exact command (`pnpm --filter @archonum/samples puppeteer`, or `node samples/puppeteer-sample.js` from the root). State that `.env` is picked up automatically by `fromEnv()` and that `node --env-file=.env` still works.
4. **Playwright note** — the workspace disables install scripts, so Playwright's browser binaries are not downloaded; none are needed because the sample attaches to the remote gateway over CDP.
5. **MCP note** — carry over the root README's MCP section (lines 51-78): it speaks JSON-RPC over stdio, the `claude mcp add` command with absolute paths, the `claude_desktop_config.json` snippet, and the per-country session model. Point out that a published `@archonum/mcp` package is planned, which is why this lives in samples for now.

- [ ] **Step 7: Verify the samples resolve and run**

Run: `pnpm install && pnpm build && node --check samples/mcp-server.js && node --check samples/playwright-sample.js && node --check samples/puppeteer-sample.js`
Expected: all pass. Then, with credentials available, run `node samples/puppeteer-sample.js https://example.com/` and `node samples/playwright-sample.js https://example.com/` and confirm both attach and save a PNG. Also start `node samples/mcp-server.js`, confirm it prints `✓ archonum MCP server ready on stdio`, and stop it with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(samples): move samples to a private workspace package"
```

---

### Task 13: root README + repo docs

**Files:**
- Modify: `README.md` (rewrite), `.env.example` (update the load hint)

**Interfaces:**
- Consumes: the three package READMEs.
- Produces: repo-level orientation docs.

- [ ] **Step 1: Rewrite `README.md` as a monorepo overview**

Sections:

1. **Title + one-paragraph pitch** — what archonum is (real-device remote Chrome, per-session exit country) and that this repo is a pnpm monorepo of three packages.
2. **Packages table** — name, npm badge-free one-liner, and link to each package README:
   - `@archonum/sdk` — authenticate against the gateway, get a credentialed CDP URL. Zero dependencies.
   - `@archonum/engine` — stealth browser automation: sessions, snapshots, human-like input, bot-wall detection.
   - `@archonum/cli` — `npx @archonum/cli <url>` to screenshot any site.
3. **Which one do I need?** — three bullets: Playwright/own driver → sdk; Puppeteer-level automation and one-shot `read`/`capture` → engine; terminal → cli.
4. **Layering diagram** — a fenced ASCII block: `cli → engine → sdk → gateway`, with `samples/` hanging off engine and sdk.
5. **Development** — `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, where sources live, and that samples are a private workspace package (link `samples/README.md`).
6. **Configuration** — the `ARCHONUM_*` table (from the old README lines 203-210) plus the `.env` fallback, pointing at the sdk README for detail.
7. **Releasing** — `pnpm changeset`, `pnpm changeset version`, `pnpm release`.
8. **Roadmap** — the deferred items from the design doc: `@archonum/mcp` package, hosted MCP (Streamable HTTP + OAuth), Markdown output for `read()`.

- [ ] **Step 2: Update `.env.example`**

Change the header comment from `Load with: node --env-file=.env cli.js <url>` to note that `fromEnv()` picks up `.env` from the current directory automatically, with `node --env-file=.env …` still available. Keep the variables and their comments unchanged.

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: rewrite root README as a monorepo overview"
```

---

### Task 14: release preparation

**Files:**
- Edit: root `README.md`
- Verify: package tarball contents

**Interfaces:**
- Consumes: everything above.
- Produces: verified tarballs ready for a first `1.0.0` publish.

- [ ] **Step 1: No changeset for the initial release**

None of `@archonum/sdk`, `@archonum/engine`, or `@archonum/cli` has ever been
published (all three 404 on the npm registry) and every manifest is already at
`1.0.0`. A changeset's job is to record a version *bump* relative to a published
baseline; there is no baseline yet, so there is nothing to bump. Writing a
`major` changeset here would make `changeset version` bump all three packages to
`2.0.0` for their first-ever release, which is wrong and confusing forever after.

So: do not create a changeset for this release. The initial publish ships the
manifests as they stand, at `1.0.0`. Changesets starts being used for the *next*
change, after `1.0.0` is out.

The breaking changes relative to the pre-split, never-published repo are real
and worth recording, but they belong in repo documentation aimed at the (single)
prior user of the pre-split code, not in a consumer-facing changeset read by npm
users of a package that has no prior version. Record them instead in a
"Migrating from the pre-split package" section of the root `README.md`,
covering:

- `ArchonumClient.getVersion()` is now `getConnectionInfo()`.
- The new `ArchonumClient.getCDPUrl()` replaces the `getVersion()` +
  `withCreds(info.webSocketDebuggerUrl)` chain.
- `connect()`, `capture()`, `read()`, `compareFlow()`, and `ArchonumSession` moved
  from `ArchonumClient` to `ArchonumEngine` in `@archonum/engine`.
- `humanize` and `protocolTimeout` moved from the client to the engine.
- `ArchonumClient.fromEnv()` now also loads a `.env` from the current directory;
  real environment variables still win.

- [ ] **Step 2: Full verification pass**

Run: `pnpm install && pnpm typecheck && pnpm build && pnpm test`
Expected: no type errors, all three packages build, 18 sdk tests + 8 engine tests pass.

- [ ] **Step 3: Verify tarball contents**

Run: `pnpm --filter @archonum/sdk exec npm pack --dry-run && pnpm --filter @archonum/engine exec npm pack --dry-run && pnpm --filter @archonum/cli exec npm pack --dry-run`
Expected: each tarball contains only `dist/**`, `package.json`, `README.md`, and `LICENSE`. No `src/`, no `test/`, no `.env`. Confirm `@archonum/sdk`'s tarball declares no dependencies and `@archonum/engine`'s declares exactly `@archonum/sdk` + `rebrowser-puppeteer-core`.

If `LICENSE` is missing from a tarball, copy the root `LICENSE` into each package directory (npm only auto-includes a package-local one) and re-check.

- [ ] **Step 4: Verify the bin entry is publishable**

A real `npm i` of the cli tarball cannot work until `@archonum/engine` is on npm, so verify the packaging instead:

```bash
node -e "const p=require('./packages/cli/package.json'); console.log(p.bin)"
head -1 packages/cli/dist/cli.js
test -x packages/cli/dist/cli.js && echo "executable bit set"
```

Expected: `{ archonum: './dist/cli.js' }`, the first line is `#!/usr/bin/env node`, and the executable bit is set. The end-to-end run was already verified in Task 11 Step 5.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add pre-split migration notes to README"
```

- [ ] **Step 6: Report readiness (do not publish)**

Publishing is a separate, user-authorized action. Report: packages built and verified, migration notes added, and the exact commands the user runs to publish:

```bash
pnpm changeset version   # writes versions + CHANGELOGs
pnpm release             # builds, then changeset publish
```

Note that `npm login` with access to the `@archonum` scope is required, and that the scope must exist on npm first.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| pnpm workspace, three packages + private samples | 1, 2, 6, 11, 12 |
| MIT license, publish metadata, `exports`, `files`, engines | 1, 2, 6, 11, 14 |
| TypeScript, strict, `tsc` → `dist`, no bundler | 1, 2, 6, 11 |
| sdk: zero deps, `ArchonumClient`, `fromEnv` + `.env` fallback | 3, 4 |
| sdk: `getCDPUrl()`, `getConnectionInfo()` rename, `withCreds`, `withRetry` | 2, 4 |
| engine: `ArchonumEngine` (`connect`/`capture`/`read`/`compareFlow`) | 10 |
| engine: `ArchonumSession` ported verbatim, rebrowser env default | 6, 7, 8, 9 |
| engine: re-export `puppeteer`, `DESKTOP_UA` | 9, 10 |
| cli: thin, `bin` → `npx @archonum/cli` | 11 |
| samples: private package, own deps, README with prerequisites | 12 |
| `humanize` (and `protocolTimeout`) move to engine | 10 |
| Changesets, independent versions from 1.0.0 | 1, 14 |
| sdk unit tests (`withCreds`, `fromEnv` precedence, `getCDPUrl` retry with mocked fetch) | 3, 4 |
| Engine/cli verified by typecheck + build + manual smoke | 9, 10, 11, 12 |
| Root README rewrite, per-package READMEs, `git mv` history | 5, 10, 11, 13 |
| Deferred items documented as roadmap | 13 |

Two deliberate deviations from the spec, both recorded in Global Constraints: `protocolTimeout` moves to the engine (it is a puppeteer option, not a gateway one), and `fromEnv()` calls `loadDotEnv()` unconditionally rather than only when the password is missing — verified Node behavior is that `process.loadEnvFile()` never overrides an already-set variable, so precedence is identical and the code path is simpler. The spec file is updated to match in Task 0 below.

**Task 0 (do this first): sync the spec**

- [ ] Edit `docs/superpowers/specs/2026-07-29-monorepo-split-design.md`: move `protocolTimeout` from the sdk bullet to the engine bullet, and change the `fromEnv()` bullet to say `loadDotEnv()` runs unconditionally because Node never overrides existing variables. Commit with Task 1.

**Placeholder scan:** No TBDs. Ported-code tasks (7, 8, 9, 10) cite exact `archonum.js` line ranges and enumerate every behavior and TypeScript change rather than saying "port it"; new code is given in full.

**Type consistency:** `Clip`, `PageInfo`, `ContentWait`, `CaptureResult`, `PageTextResult`, `ReadResult`, `CompareResult`, `EffectResult`, `ChallengeKind`, `Clearable` are defined once in Task 6 and referenced by that name afterwards. `ConnectionInfo`, `RetryInfo`, `RetryOptions` come from Task 2's `sdk/src/types.ts`. `Humanizer` (Task 8) is consumed by Tasks 8-9. `snapshotOutline`/`locateRef`/`resolveRef` (Task 7) are consumed by Tasks 8-9. `runFlow`'s `RunFlowOptions.session` is `ArchonumSession`, matching Task 9's export.

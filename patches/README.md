# patches/

`puppeteer-core@<version>.patch` teaches stock `puppeteer-core` not to announce itself
over CDP. pnpm applies it automatically on install (registered under
`patchedDependencies` in `pnpm-workspace.yaml`), so nothing in the packages has to
opt in — `@archonum/engine` just imports `puppeteer-core` and gets the patched copy.

## What it changes

Puppeteer normally calls `Runtime.enable` on every frame to learn its execution-context
IDs. Enabling the Runtime domain is observable from inside the page: the browser starts
serializing objects passed to `console.*` and thrown exceptions for delivery to the
debugger, and that serialization invokes user-defined getters that would otherwise never
run. A page plants a getter on `error.stack`, calls `console.debug(err)`, and knows a
debugger is attached. This is the check behind most "is this Puppeteer?" scripts.

The patch removes the `Runtime.enable` call and resolves context IDs lazily instead,
via one of three modes selected by `REBROWSER_PATCHES_RUNTIME_FIX_MODE`:

- `addBinding` (upstream default) — recovers the **real main world** ID through a
  randomly-named `Runtime.addBinding` plus a custom DOM event dispatched from a
  throwaway isolated world.
- `alwaysIsolated` — **what `@archonum/engine` sets** (`packages/engine/src/session.ts`).
  Runs everything in an isolated world. Leak-free and reliable on a reused tab, at the
  cost of two things worth knowing: `page.evaluate` cannot see page-defined globals
  (DOM and built-ins are fine), and child-frame execution contexts hang, which is why
  `dom-scan.ts` reads same-origin iframes via `contentDocument` from the main frame.
- `enableDisable` — enables then immediately disables Runtime. Narrows the detection
  window rather than closing it.
- `0` — off; restores stock puppeteer behaviour. Useful when debugging, since
  `page.pause()` does not work with the fix enabled.

It also replaces the `pptr:evaluate` `sourceURL` (which leaks into `Error.stack`) with a
generic `app.js`, and renames the utility world from `__puppeteer_utility_world__<ver>`
to `util`. Both are overridable via `REBROWSER_PATCHES_SOURCE_URL` and
`REBROWSER_PATCHES_UTILITY_WORLD_NAME`.

## Provenance and licence

Derived from [`rebrowser-patches`](https://github.com/rebrowser/rebrowser-patches)
(MIT, © Rebrowser), applied to `puppeteer-core` (Apache-2.0, © Google). We previously
consumed this as the prebuilt `rebrowser-puppeteer-core` fork; that fork stopped at
`24.8.1` (May 2025) and is a major version behind upstream, so we carry the ~320-line
patch directly and track current `puppeteer-core` instead.

Deviations from upstream `rebrowser-patches`:

- The `Browser.ts` hunk adding a `_connection()` accessor is dropped — it is a
  convenience method, not a leak fix, and nothing here uses it.
- The `WebWorker` debug log no longer calls `client._target()._getTargetInfo()`;
  `CDPSession#_target()` no longer exists in puppeteer 25, so the original line would
  throw whenever `REBROWSER_PATCHES_DEBUG` was set.
- Paths are rebased onto puppeteer 25's single `lib/puppeteer/**` tree (it dropped the
  dual `lib/cjs` + `lib/esm` build).
- **`acquireContextId` fixes, marked `// archonum:` in the diff.** Upstream leaves the
  `alwaysIsolated` branch unguarded while wrapping `addBinding` in `try/catch`. Since the
  retry below only triggers on a falsy `contextId`, a thrown protocol error escaped
  `acquireContextId` entirely and the three-try retry never ran — in the one mode we
  actually use. We mirror the `addBinding` handling. We also wait `100ms * tryCount`
  before retrying; upstream retries back-to-back, which against a remote gateway just
  re-fires before the round-trip that would have succeeded. Neither costs anything on the
  happy path. Upstream reports of `acquireContextId failed` on live sites are issues #100
  and #116, both filed after the project went dormant.

## Upgrading puppeteer-core

The patch is pinned to an exact version on purpose — it edits compiled output, so a
version bump can invalidate it. To upgrade:

1. `pnpm --filter @archonum/engine add puppeteer-core@<new> --save-exact`
2. `pnpm patch puppeteer-core@<new>`, re-apply the hunks in the temp dir, then
   `pnpm patch-commit <dir>`. Expect a handful of context-drift rejects; the bulk of
   the change lives in `cdp/ExecutionContext.js` and has been stable across releases.
3. Delete the stale `patches/puppeteer-core@<old>.patch` and its
   `pnpm-workspace.yaml` entry.
4. Verify the fix still holds — the check that matters is that `Runtime.enable` never
   reaches the wire. Drive a browser through a logging WebSocket proxy and assert the
   method is absent, then assert it IS present with
   `REBROWSER_PATCHES_RUNTIME_FIX_MODE=0` so you know the assertion can fail.

# @archonum/sdk

Authenticates against the archonum CDP gateway and hands back a credentialed
CDP WebSocket URL, and queries the archonum platform API for service health and
your remaining credits. Zero runtime dependencies — it never imports Puppeteer,
Playwright, or any browser library. Browser automation on top of it lives in
the sibling package `@archonum/engine`.

## Getting credentials

Archonum is a hosted service, so this package needs credentials before it can do
anything. Create an account at
[app.archonum.com/register](https://app.archonum.com/register/) (plans, including an
Enterprise tier, are at [archonum.com/#pricing](https://archonum.com/#pricing)), sign
in, and take your API token from the API Key page. That one token is the only secret
you need — it doubles as the gateway password, so the same value goes on both
`ARCHONUM_TOKEN` and (implicitly) the CDP gateway's `password` query parameter. Your
username is just your account username. Set both as `ARCHONUM_TOKEN` and
`ARCHONUM_USERNAME` — see [Configuration](#configuration). For access questions or
Enterprise plans, email [hello@archonum.com](mailto:hello@archonum.com).

## Install

```bash
pnpm add @archonum/sdk
```

or

```bash
npm i @archonum/sdk
```

## Quick start

```js
import { ArchonumClient } from '@archonum/sdk';
import { chromium } from 'playwright';

const client = ArchonumClient.fromEnv();
const browser = await chromium.connectOverCDP(await client.getCDPUrl());
```

`playwright` is your own dependency here, not something `@archonum/sdk`
installs for you — any CDP-speaking client works the same way. `getCDPUrl()`
already retries the gateway's transient failures, so this one call is all
most integrations need.

## Configuration

```js
new ArchonumClient({
  gateway: 'gateway.archonum.com:10900', // host:port of the CDP gateway
  tls: true,             // https:// handshake + wss:// session; env ARCHONUM_GATEWAY_TLS=false turns it off
  baseUrl: 'https://app.archonum.com',   // the archonum platform REST API
  username: '…',         // required
  token: '…',            // required; also accepted as the gateway password
  country: '',           // ISO 3166-1 alpha-2 exit country; '' = gateway chooses
  connectRetries: 5,     // attempts for the gateway request in getCDPUrl()
  log: () => {},         // progress sink; pass console.log for chatter
  retryDelayMs: 2000,    // delay between gateway retries; set 0 in tests
});
```

`username` and `token` are both required: the constructor throws
`ArchonumClient: username and token are required` if either is missing.
Neither has a default in the constructor itself — `fromEnv()` below is what
resolves them from the environment. `password` is still accepted as a
deprecated alias for `token` (`client.password` also still returns it), kept
only because it is the literal query-string parameter name the gateway
expects. Note also that the constructor's own default for `country` is `''`
(let the gateway choose), and it is never read from the environment — pass
it explicitly (in the constructor, or as a `fromEnv()` override) if you want
one pinned.

`ArchonumClient.fromEnv(overrides?)` builds a client from the
`ARCHONUM_*` environment variables:

| Variable | Default | Notes |
|---|---|---|
| `ARCHONUM_TOKEN` | — | required; `ARCHONUM_PASSWORD` and `ARCHONUM_CDP_PASSWORD` are accepted as fallbacks (same secret, older names) |
| `ARCHONUM_USERNAME` | — | required; `ARCHONUM_CDP_USERNAME` is accepted as a fallback |
| `ARCHONUM_GATEWAY` | `gateway.archonum.com:10900` | or derive it from `ARCHONUM_CDP_BASE_URL` (a full URL) if that's what your `.env` already has |
| `ARCHONUM_BASE_URL` | `https://app.archonum.com` | |

`fromEnv()` also loads a `.env` file from the current working directory as a
fallback, using Node's built-in `process.loadEnvFile()` — no `dotenv`
dependency required. Real environment variables always win over the file; a
missing or unreadable `.env` is not an error.

## API

### `ArchonumClient.fromEnv(overrides?: ArchonumClientOptions): ArchonumClient`

Builds a client from the `ARCHONUM_*` environment variables (see
Configuration above), then applies `overrides` on top.

### `client.getCDPUrl(opts?: { country?, attempts?, onRetry? }): Promise<string>`

The credentialed CDP WebSocket URL, with the gateway's transient failures
retried. This is the one call most integrations need. `country` overrides
the client's default country for this call only; `attempts` defaults to the
client's `connectRetries`.

### `client.getConnectionInfo(country?: string): Promise<ConnectionInfo>`

Fetches and parses the gateway's `/json/version` payload — CDP connection
metadata, including `webSocketDebuggerUrl` — not a version string. Throws a
retryable error instead of crashing on JSON.parse if the gateway returns an
empty or non-JSON body.

### `client.withCreds(url: string, country?: string): string`

Appends gateway credentials (and country) to any URL, http or ws. `country`
defaults to the client's own; pass one to override it for this URL only.

### `client.getHealth(): Promise<ServiceHealth>`

Public liveness probe for the archonum platform (`GET /api/v1/health/`) — needs
no credentials. Returns `{ healthy: boolean }`.

### `client.getCredits(): Promise<CreditBalance>`

Remaining credits, in MB, for the authenticated account (`GET
/api/v1/credits/`), sent with `Authorization: Token <token>`. Returns
`{ username, credits }`. Neither this nor `getHealth()` retries: a 401 or 402
will never succeed on retry, and both are cheap calls to just make again.
Failures are mapped to actionable messages — an invalid/missing token, an
insufficient-credits message straight from the API, or `archonum API HTTP
<status>` for anything else.

### `withRetry(fn: () => Promise<T>, opts?: { attempts?, delayMs?, onRetry? }): Promise<T>`

Retries a flaky async op with a fixed delay between attempts. `attempts`
defaults to 3, `delayMs` to 2000. Exported standalone for wrapping your own
gateway calls; `getCDPUrl()` uses it internally.

### `sleep(ms: number): Promise<void>`

Resolves after `ms` milliseconds. A small standalone helper used internally
for the delay between retries; exported because callers wrapping their own
gateway calls tend to need it too.

### `loadDotEnv(): void`

Loads a `.env` file from the current working directory into `process.env`,
if the runtime supports it (Node's built-in `process.loadEnvFile()`, >= 20.12).
Best-effort: a missing or unreadable file is not an error, and it never
overrides a variable that's already set in the real environment.
`ArchonumClient.fromEnv()` calls this for you; exported for callers who want
the same `.env` fallback without going through `fromEnv()`.

### `readEnvConfig(env?: NodeJS.ProcessEnv): EnvConfig`

Reads the `ARCHONUM_*` variables (see Configuration above) off `env`
(defaults to `process.env`), resolving each field's fallback chain, but
applies no defaults itself — `gateway`/`baseUrl`/`username`/`token` are all
`undefined` when unset. `ArchonumClient.fromEnv()` uses this internally,
after calling `loadDotEnv()`, and applies the constructor's defaults on top.

### `gatewayHostFromUrl(value: string): string | undefined`

Extracts a bare `host:port` from either a full URL
(`http://stagegw.archonum.com:10900`) or an already-bare `host:port`; returns
`undefined` if `value` is neither. Used internally to derive `gateway` from
`ARCHONUM_CDP_BASE_URL`, which is a URL while `ARCHONUM_GATEWAY` (and
`ArchonumClientOptions.gateway`) is bare `host:port` — exported since getting
that mismatch wrong produces a confusing 401.

## Security note

The gateway authenticates via query-string parameters, so `withCreds()` puts
the token in the URL it returns (as the `password` parameter — that's the
literal name the gateway expects). Query strings can surface in access/proxy
logs and browser history — keep credentialed URLs out of anything you log or
persist.

## Country selection

`country: 'ch'` pins the exit country to Switzerland; `country: ''` lets the
gateway choose. The client-wide default is set in the constructor — it is
never read from the environment, so pass it explicitly as a `fromEnv()`
override if you want one pinned. `getCDPUrl({ country })` (as well as
`getConnectionInfo(country)` and `withCreds(url, country)`) overrides it for
a single call.

This `country` query parameter is what the CDP gateway port (10900, what this
SDK talks to) uses for exit-country selection, and it is verified to work.
The `{username}-country_{CC}` username-suffix form documented for archonum's
HTTP/SOCKS5 proxy ports (10080/10443) does **not** apply here — using it on
the CDP port silently returns a random country instead of erroring, so don't
carry that convention over.

import { loadDotEnv, readEnvConfig } from './env.js';
import { withRetry } from './retry.js';
import type { ConnectionInfo, CreditBalance, RetryInfo, ServiceHealth } from './types.js';

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface ArchonumClientOptions {
  /** host:port of the gateway. Default: gateway.archonum.com:10900 */
  gateway?: string;
  /** Talk to the gateway over TLS (https:// for /json/version, so the CDP
   * WebSocket it hands back is wss://). Default: true. Set false only for a
   * gateway without a certificate, e.g. one on a private network. */
  tls?: boolean;
  /** Base URL of the archonum platform REST API. Default: https://app.archonum.com */
  baseUrl?: string;
  username?: string;
  /** The archonum API token — also accepted as the gateway password. */
  token?: string;
  /** @deprecated Use `token` instead; kept as an alias for it. */
  password?: string;
  /** ISO 3166-1 alpha-2 exit country; '' lets the gateway choose. */
  country?: string;
  /** Attempts for the gateway request in getCDPUrl(), and the retry budget
   * ArchonumEngine#connect uses for its full handshake retry loop. Default: 5 */
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
 * Credentials + gateway policy for the archonum CDP gateway and platform REST
 * API. It authenticates and hands back a credentialed CDP WebSocket URL;
 * attaching a browser to that URL is the caller's job (or @archonum/engine's).
 */
export class ArchonumClient {
  readonly gateway: string;
  readonly tls: boolean;
  readonly baseUrl: string;
  readonly username: string;
  readonly token: string;
  readonly country: string;
  readonly connectRetries: number;
  readonly log: (msg: string) => void;
  readonly #retryDelayMs: number;
  readonly #fetch: FetchLike;

  constructor({
    gateway = 'gateway.archonum.com:10900',
    tls = true,
    baseUrl = 'https://app.archonum.com',
    username,
    token,
    password,
    country = '',
    connectRetries = 5,
    log = () => {},
    retryDelayMs = 2000,
    fetch: fetchImpl,
  }: ArchonumClientOptions = {}) {
    const secret = token ?? password;
    if (!username || !secret) throw new Error('ArchonumClient: username and token are required');
    this.gateway = gateway;
    this.tls = tls;
    this.baseUrl = baseUrl;
    this.username = username;
    this.token = secret;
    this.country = country;
    this.connectRetries = connectRetries;
    this.log = log;
    this.#retryDelayMs = retryDelayMs;
    this.#fetch = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** @deprecated Use `token` instead; retained because it is the same secret. */
  get password(): string {
    return this.token;
  }

  /**
   * Build a client from the ARCHONUM_* environment variables:
   *   ARCHONUM_TOKEN      required (ARCHONUM_PASSWORD, ARCHONUM_CDP_PASSWORD accepted as fallbacks)
   *   ARCHONUM_USERNAME   required (ARCHONUM_CDP_USERNAME accepted as a fallback)
   *   ARCHONUM_GATEWAY    default: gateway.archonum.com:10900 (or derived from ARCHONUM_CDP_BASE_URL)
   *   ARCHONUM_GATEWAY_TLS default: true; `false` or `0` talks plaintext to the gateway
   *   ARCHONUM_BASE_URL   default: https://app.archonum.com
   * A `.env` in the current directory is loaded as a fallback — real environment
   * variables always win over it. `country` is not read from the environment;
   * pass it via `overrides` if you need one.
   */
  static fromEnv(overrides: ArchonumClientOptions = {}): ArchonumClient {
    loadDotEnv();
    const { gateway, tls, baseUrl, username, token } = readEnvConfig();
    return new this({ gateway, tls, baseUrl, username, token, ...overrides });
  }

  /**
   * Append gateway credentials (and country) to any URL — http or ws. Pass
   * `country` to override the client default for this one URL.
   *
   * The gateway authenticates via query-string params, so the token ends up in
   * the URL: keep credentialed URLs out of logs and anything persisted.
   */
  withCreds(url: string, country: string = this.country): string {
    const u = new URL(url);
    if (country) u.searchParams.set('country', country);
    u.searchParams.set('username', this.username);
    u.searchParams.set('password', this.token);
    return u.toString();
  }

  /**
   * Fetch and parse the gateway's `/json/version` payload — CDP connection
   * metadata (including `webSocketDebuggerUrl`). Tolerates the gateway's
   * occasional empty/HTML bodies by throwing a retryable error instead of
   * crashing on JSON.parse.
   */
  async getConnectionInfo(country: string = this.country): Promise<ConnectionInfo> {
    // Over TLS the gateway answers with a wss:// webSocketDebuggerUrl, so the
    // credentialed WebSocket stays encrypted too.
    const res = await this.#fetch(this.withCreds(`${this.tls ? 'https' : 'http'}://${this.gateway}/json/version`, country));
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

  #apiUrl(path: string): string {
    return new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`).toString();
  }

  /**
   * Public liveness probe for the archonum platform. Needs no credentials.
   * Not retried: a failure here is either a real outage or a bad `baseUrl`,
   * and retrying wouldn't help with either.
   */
  async getHealth(): Promise<ServiceHealth> {
    const res = await this.#fetch(this.#apiUrl('api/v1/health/'));
    return this.#parseApiResponse<ServiceHealth>(res);
  }

  /**
   * Remaining credits, in MB, for the authenticated account. Not retried: a
   * 401/402 will never succeed on retry, and both are cheap to hit again once
   * fixed.
   */
  async getCredits(): Promise<CreditBalance> {
    const res = await this.#fetch(this.#apiUrl('api/v1/credits/'), {
      headers: { Authorization: `Token ${this.token}` },
    });
    return this.#parseApiResponse<CreditBalance>(res);
  }

  async #parseApiResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      if (res.status === 401) throw new Error('archonum API: invalid or missing token');
      if (res.status === 402) {
        const body = await res.json().catch(() => undefined) as { error?: string } | undefined;
        throw new Error(body?.error ? `archonum API: ${body.error}` : 'archonum API: payment required');
      }
      throw new Error(`archonum API HTTP ${res.status}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error('archonum API returned a non-JSON body');
    }
  }
}

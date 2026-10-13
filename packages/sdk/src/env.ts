export interface EnvConfig {
  gateway?: string;
  tls?: boolean;
  baseUrl?: string;
  username?: string;
  token?: string;
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

/**
 * Extract a bare `host:port` from either a full URL
 * (`http://stagegw.archonum.com:10900`) or an already-bare `host:port`. Returns
 * `undefined` if `value` is neither. Exists because `ARCHONUM_CDP_BASE_URL` is a
 * URL while `ARCHONUM_GATEWAY` (and `ArchonumClientOptions.gateway`) is bare
 * `host:port` — getting that mismatch wrong produces a confusing 401.
 *
 * A URL with no explicit port yields a portless host (`http://gw.example.com` →
 * `gw.example.com`), leaving the port to the caller's default. Real
 * `ARCHONUM_CDP_BASE_URL` values always carry `:10900`.
 */
export function gatewayHostFromUrl(value: string): string | undefined {
  try {
    // A bare `host:port` (e.g. `stagegw.archonum.com:10900`) parses without
    // throwing — `host:` is read as the scheme — but yields an empty `host`.
    // Only trust the parse when it actually produced one.
    const host = new URL(value).host;
    if (host) return host;
  } catch {
    /* not a full URL — fall through to the bare host:port check below */
  }
  // A bare `host:port` (no scheme). Require a numeric port and no slash, so an
  // unparseable string falls through to `undefined` instead of matching.
  if (/^[^\s/:]+:\d+$/.test(value)) return value;
  return undefined;
}

/** The ARCHONUM_* configuration, with fallbacks resolved but no defaults applied. */
export function readEnvConfig(env: Record<string, string | undefined> = process.env): EnvConfig {
  const gateway = env.ARCHONUM_GATEWAY || (env.ARCHONUM_CDP_BASE_URL ? gatewayHostFromUrl(env.ARCHONUM_CDP_BASE_URL) : undefined);
  // Unset leaves the client default (TLS on); only an explicit false/0 turns it off.
  const tlsEnv = env.ARCHONUM_GATEWAY_TLS?.trim().toLowerCase();
  return {
    gateway,
    tls: tlsEnv ? !['false', '0', 'no', 'off'].includes(tlsEnv) : undefined,
    baseUrl: env.ARCHONUM_BASE_URL || undefined,
    username: env.ARCHONUM_USERNAME || env.ARCHONUM_CDP_USERNAME || undefined,
    token:
      env.ARCHONUM_API_TOKEN || env.ARCHONUM_TOKEN || env.ARCHONUM_PASSWORD || env.ARCHONUM_CDP_PASSWORD || undefined,
  };
}

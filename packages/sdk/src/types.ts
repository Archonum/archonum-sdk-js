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

/** `GET /api/v1/health/` — public liveness probe. */
export interface ServiceHealth {
  healthy: boolean;
}

/** `GET /api/v1/credits/` — remaining balance, in MB. */
export interface CreditBalance {
  username: string;
  /** Remaining credits in MB. */
  credits: number;
}

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
  if (attempts < 1) throw new Error('withRetry: "attempts" must be at least 1');
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

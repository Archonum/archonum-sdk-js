import type { Page } from 'puppeteer-core';

// The counter has to live on `window` to survive between evaluate() calls, so the
// property name is generated once per process rather than hardcoded. Under the
// default 'alwaysIsolated' fix mode it lands on the isolated world's window and the
// page cannot see it at all — but callers who switch to 'addBinding' (see the engine
// README) get a real main-world global, and a fixed name like `__archonumMut` would
// then be a one-line signature identifying this SDK. Random + non-enumerable leaves
// nothing to match on.
const COUNTER_KEY = `_${Math.random().toString(36).slice(2, 12)}`;

/**
 * Install (once per navigation context) a page-wide DOM-mutation counter and
 * return its current value, or null when the page can't be instrumented. Runs in
 * the isolated world, which still observes the real DOM. A count LOWER than one
 * read earlier means the context was replaced — i.e. a navigation happened.
 */
export async function mutationCount(page: Page): Promise<number | null> {
  return page
    .evaluate((key: string) => {
      const w = window as unknown as Record<string, { n: number } | undefined>;
      if (!w[key]) {
        const state = { n: 0 };
        Object.defineProperty(window, key, { value: state, enumerable: false, configurable: true });
        new MutationObserver((records) => {
          state.n += records.length;
        }).observe(document.documentElement ?? document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
      return w[key]!.n;
    }, COUNTER_KEY)
    .catch(() => null);
}

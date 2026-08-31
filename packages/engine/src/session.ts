// The Runtime-leak fix mode MUST be chosen before the library is imported.
// 'alwaysIsolated' runs page.evaluate in an isolated world: leak-free and reliable
// on a reused tab. Setting it here means importing this package is enough — callers
// don't have to remember the env var.
//
// The fix itself lives in patches/puppeteer-core@<version>.patch at the repo root,
// applied to stock puppeteer-core by pnpm on install. See that file's header for
// what it changes and why we carry it ourselves.
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ||= 'alwaysIsolated';

const { default: puppeteer } = await import('puppeteer-core');
export { puppeteer };

import type { Browser, HTTPResponse, Page } from 'puppeteer-core';
import type { ConnectionInfo, RetryInfo } from '@archonum/sdk';
import { withRetry } from '@archonum/sdk';
import {
  click as clickAction,
  press as pressAction,
  scroll as scrollAction,
  select as selectAction,
  type as typeAction,
} from './actions.js';
import { CHALLENGE_CLEARABLE, classifyChallenge, isBlocked, SHORT_PAGE_TEXT } from './challenge.js';
import { locateRef, snapshotOutline } from './dom-scan.js';
import { Humanizer } from './human.js';
import { mutationCount } from './mutation.js';
import { pageMarkdown } from './markdown.js';
import { getClip, markCreated, setClip, wasCreated } from './page-state.js';
import { pngSize } from './png.js';
import type { CaptureResult, Clip, ContentWait, EffectResult, PageInfo, PageMarkdownResult, PageTextResult } from './types.js';
import { sleep } from './util.js';
import { runFlow, type FlowStep } from './flow.js';

// Desktop mode DERIVES its UA from the real device at runtime (see
// ArchonumSession#applyDesktop) rather than spoofing this string — a hardcoded
// Windows UA contradicts the device's real navigator.platform ("Linux aarch64")
// and client hints, which is exactly what modern bot walls (e.g. Cloudflare
// Turnstile) block. This constant remains only as the fallback when a
// caller passes no override AND the device exposes no UA to derive from, and as a
// documented escape hatch for callers who explicitly want to force it.
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * A connected remote browser plus the helpers you want around it.
 * Get one from `ArchonumEngine#connect`.
 */
export class ArchonumSession {
  readonly browser: Browser;
  readonly info: ConnectionInfo;
  readonly humanize: boolean;
  readonly #human: Humanizer;

  constructor(browser: Browser, info: ConnectionInfo, { humanize = true }: { humanize?: boolean } = {}) {
    this.browser = browser;
    this.info = info;
    this.humanize = humanize;
    this.#human = new Humanizer(this.humanize);
  }

  /**
   * Acquire a page: reuse the remote browser's existing tab when there is one
   * (the gateway browser is already running), otherwise open a fresh page.
   * Applies desktop emulation when requested.
   *
   * `userAgent` forces an explicit UA in desktop mode; leave null to derive a
   * consistent desktop identity from the real device (recommended — a spoofed
   * OS trips bot walls).
   */
  async newPage({ desktop = false, userAgent = null }: { desktop?: boolean; userAgent?: string | null } = {}): Promise<Page> {
    const existing = await this.browser.pages();
    let page: Page;
    let isNew: boolean;
    if (existing.length > 0) {
      page = existing[0];
      isNew = false;
    } else {
      page = await this.browser.newPage();
      isNew = true;
    }
    markCreated(page, isNew);

    // Remember the clip to use for screenshots on this page.
    if (desktop) {
      setClip(page, await this.#applyDesktop(page, userAgent));
    }
    return page;
  }

  /**
   * Present as desktop Chrome WITHOUT spoofing the OS. The gateway devices are
   * real MOBILE Chrome; the previous approach set a hardcoded Windows UA, which
   * desynced the UA string from the device's real navigator.platform
   * ("Linux aarch64") and its Sec-CH-UA client hints — and modern bot walls
   * (e.g. Cloudflare Turnstile) block that mismatch, leaving the
   * page stuck on "Verifying you are human". Instead we KEEP the device's own
   * UA, platform and brand hints and only drop the "Mobile" token / flip the
   * `mobile` client hint to false — the honest "request desktop site" identity a
   * real device sends, fully self-consistent. Then widen the viewport (capped to
   * the device's PHYSICAL width so the capture surface never tiles). An explicit
   * `userAgent` is honoured verbatim as an escape hatch.
   */
  async #applyDesktop(page: Page, userAgent: string | null = null): Promise<Clip> {
    if (userAgent) {
      await page.setUserAgent(userAgent);
    } else {
      // Read the real device identity, then present its desktop variant so UA,
      // navigator.platform and the Sec-CH-UA hints all stay consistent.
      const real = await page.evaluate(async () => {
        const d = navigator.userAgentData;
        let high: {
          platformVersion?: string;
          architecture?: string;
          model?: string;
          fullVersionList?: { brand: string; version: string }[];
        } = {};
        if (d && d.getHighEntropyValues) {
          try {
            high = await d.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList']);
          } catch {
            /* high-entropy hints unavailable — fall back to low-entropy */
          }
        }
        return {
          ua: navigator.userAgent,
          brands: d ? d.brands : null,
          platform: d ? d.platform : '',
          platformVersion: high.platformVersion || '',
          architecture: high.architecture || '',
          fullVersionList: high.fullVersionList || null,
        };
      });
      if (real.ua) {
        // Drop the "Mobile" token (…Chrome/148 Mobile Safari → …Chrome/148 Safari).
        const desktopUA = real.ua.replace(/\sMobile(?=\sSafari)/i, '');
        const metadata =
          real.brands && real.brands.length
            ? {
                brands: real.brands,
                fullVersionList: real.fullVersionList || undefined,
                platform: real.platform || 'Linux',
                platformVersion: real.platformVersion || '',
                architecture: real.architecture || '',
                model: '', // desktop Chrome reports no device model
                mobile: false,
              }
            : undefined;
        await page.setUserAgent(desktopUA, metadata);
      } else {
        // Device exposed no UA to derive from — fall back to the static desktop UA.
        await page.setUserAgent(DESKTOP_UA);
      }
    }
    const phys = await page.evaluate(() =>
      Math.round((screen.width || 1280) * (window.devicePixelRatio || 1)),
    );
    const width = Math.min(1280, phys);
    const height = Math.round((width * 900) / 1440);
    await page.setViewport({
      width,
      height,
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,
    });
    return { x: 0, y: 0, width, height };
  }

  /**
   * How much text actually rendered — a better "did it work" signal than the
   * initial HTTP status, since bot walls (Kasada) 429 the first document and
   * then clear the challenge before real content loads.
   */
  async renderedTextLength(page: Page): Promise<number> {
    return page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0));
  }

  /**
   * The current page's rendered text, whitespace-normalized and capped — the
   * same extraction the client's `read()` uses, but for a page you are
   * already driving. This is how an agent reads content it built up through
   * interaction (search results, a cart, a logged-in view) without re-fetching
   * the URL in a throwaway session.
   */
  async pageText(page: Page, { maxChars = 8000 }: { maxChars?: number } = {}): Promise<PageTextResult> {
    const full = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    );
    return { text: full.slice(0, maxChars), truncated: full.length > maxChars, textLength: full.length };
  }

  /**
   * The current page's content as LLM-optimized markdown: headings, links,
   * lists, tables and code fences survive; navigation chrome, scripts and
   * hidden elements are dropped. Prefer this over {@link pageText} when the
   * consumer is a model — structure is signal, and boilerplate isn't. Same
   * capping contract as `pageText` (`maxChars`, `truncated`, full pre-cap
   * length as `markdownLength`).
   */
  async pageMarkdown(page: Page, opts: { maxChars?: number } = {}): Promise<PageMarkdownResult> {
    return pageMarkdown(page, opts);
  }

  /**
   * On self-resizing pages the remote occasionally zeroes or shrinks the
   * emulated window after a programmatic scroll, making Page.captureScreenshot
   * throw "Cannot take screenshot with 0 height" or return a short capture.
   * Verify the live window against the desktop clip we own and re-apply the
   * metrics when they drifted. Non-desktop pages use the device's real profile,
   * which we never touch.
   */
  async #ensureViewport(page: Page, { force = false }: { force?: boolean } = {}): Promise<void> {
    const clip = getClip(page);
    if (!clip) return;
    const size = await page
      .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      .catch(() => null);
    if (!force && size && size.w >= clip.width && size.h >= clip.height) return;
    await page
      .setViewport({ width: clip.width, height: clip.height, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
      .catch(() => {});
  }

  /**
   * Screenshot clipped to the current viewport: the (device-capped) desktop size
   * in desktop mode, else the real mobile device screen. Both fit within the
   * physical surface, so no tiling and no captureBeyondViewport. Re-applies the
   * emulated metrics when the window drifted (the "0 height" failure), retries
   * the capture (the shared remote occasionally times out mid-command), and
   * reports the actual captured pixel size so a partial capture is never silent.
   */
  async captureViewport(
    page: Page,
    { path, retries = 3, onRetry }: { path?: string; retries?: number; onRetry?: (info: RetryInfo) => void } = {},
  ): Promise<CaptureResult> {
    const clip: Clip =
      getClip(page) ?? (await page.evaluate(() => ({ x: 0, y: 0, width: screen.width, height: screen.height })));
    let buffer: Uint8Array | undefined = await withRetry(
      async () => {
        await this.#ensureViewport(page);
        return page.screenshot({ path, clip, captureBeyondViewport: false });
      },
      { attempts: retries, onRetry },
    );
    // Captured pixels can only be >= the CSS clip (deviceScaleFactor >= 1), so
    // smaller means the emulation collapsed mid-capture: restore + retry once.
    let size = pngSize(buffer);
    if (size && (size.width < clip.width || size.height < clip.height)) {
      await this.#ensureViewport(page, { force: true });
      const again = await page.screenshot({ path, clip, captureBeyondViewport: false }).catch(() => undefined);
      if (again) {
        buffer = again;
        size = pngSize(buffer);
      }
    }
    return { buffer, clip, width: size?.width, height: size?.height };
  }

  /**
   * A one-call health check for the current page: HTTP status, title, how much
   * text actually rendered, and a `blocked` heuristic. The remote device walks
   * through most bot walls, but walls that 429/403 the first document (Kasada,
   * some Cloudflare) briefly serve a near-empty challenge page before the real
   * content swaps in — `blocked` flags that so a caller can wait and retry
   * rather than act on a challenge screen.
   *
   * @param response - the goto() return value, if you have it.
   */
  async pageInfo(page: Page, response: HTTPResponse | null = null): Promise<PageInfo> {
    const status = response ? response.status() : 0;
    const title = (await page.title().catch(() => '')) || '';
    const textLength = await this.renderedTextLength(page);
    // Classify whenever the page is short enough to be a possible challenge page,
    // then let isBlocked() decide from the DOM evidence rather than the length alone.
    const challenge = textLength < SHORT_PAGE_TEXT ? await classifyChallenge(page) : null;
    const blocked = isBlocked(status, textLength, challenge);
    const info: PageInfo = { url: page.url(), status, title, textLength, blocked };
    if (blocked && challenge) {
      info.challenge = challenge;
      info.clearable = CHALLENGE_CLEARABLE[challenge] || 'maybe';
    }
    return info;
  }

  /**
   * Poll until the page has rendered at least `minTextLength` chars of body text
   * (or, with `containsText`, until that string appears — the match's excerpt is
   * returned) or `timeoutMs` elapses — the "did the wall clear / did the JS
   * finish?" wait. Returns the final {@link pageInfo} plus:
   *   - `settled`: whether the wait condition was actually met
   *   - `excerpt`: the matched text with surrounding context (containsText only)
   *   - `stalled`: true when the page showed NO progress (no DOM mutation, no
   *     network request, no text change) for `stallMs` while the condition was
   *     unmet — the signature of a hard block that will never clear. Returned
   *     immediately instead of running down the timeout; rotate identity instead
   *     of waiting longer.
   *
   * `stallMs: 0` disables stall detection.
   */
  async waitForContent(
    page: Page,
    {
      minTextLength = 200,
      timeoutMs = 15000,
      intervalMs = 1000,
      containsText,
      stallMs = 10000,
    }: {
      minTextLength?: number;
      timeoutMs?: number;
      intervalMs?: number;
      containsText?: string;
      stallMs?: number;
    } = {},
  ): Promise<ContentWait> {
    const findText = (needle: string): Promise<string | null> =>
      page
        .evaluate((n: string) => {
          const body = document.body ? document.body.innerText : '';
          const i = body.toLowerCase().indexOf(n.toLowerCase());
          if (i < 0) return null;
          return body.slice(Math.max(0, i - 150), i + n.length + 150).replace(/\s+/g, ' ').trim();
        }, needle)
        .catch(() => null);

    let requests = 0;
    const onRequest = (): void => {
      requests += 1;
    };
    page.on('request', onRequest);
    try {
      let info = await this.pageInfo(page);
      let excerpt = containsText ? await findText(containsText) : null;
      const met = (): boolean => (containsText ? excerpt != null : info.textLength >= minTextLength);
      let lastMut = await mutationCount(page);
      let lastReq = requests;
      let lastLen = info.textLength;
      let lastActivity = Date.now();
      const deadline = Date.now() + timeoutMs;
      while (!met() && Date.now() < deadline) {
        await sleep(intervalMs);
        info = await this.pageInfo(page);
        if (containsText) excerpt = await findText(containsText);
        const mut = await mutationCount(page); // a DROP in the count means the context was replaced (navigation) — that's activity too
        const active =
          requests > lastReq ||
          info.textLength !== lastLen ||
          (mut != null && (lastMut == null || mut !== lastMut));
        if (active) lastActivity = Date.now();
        lastReq = requests;
        lastLen = info.textLength;
        lastMut = mut;
        if (!met() && stallMs > 0 && Date.now() - lastActivity >= stallMs) {
          const extra: { excerpt?: string } = {};
          if (excerpt != null) extra.excerpt = excerpt;
          return {
            ...info,
            ...extra,
            settled: false,
            stalled: true,
            recommendation:
              'no challenge progress (no DOM mutation, network request, or text change) — this identity looks hard-blocked; get a fresh one instead of waiting',
          };
        }
      }
      const extra: { excerpt?: string } = {};
      if (excerpt != null) extra.excerpt = excerpt;
      return { ...info, ...extra, settled: met(), stalled: false };
    } finally {
      page.off('request', onRequest);
    }
  }

  /**
   * A compact, ref-tagged outline of the page's interactive elements and
   * headings — the accessibility surface an agent needs to DRIVE a page rather
   * than just look at a screenshot. Each line is `[eN] role "name"`; the ref
   * `eN` is stamped onto the element (data-archonum-ref) so {@link click} and
   * {@link type} can act on it by ref. Far cheaper than a screenshot (text, not
   * vision tokens). Pierces OPEN shadow roots (web-component controls surface)
   * AND same-origin iframes (their elements get refs, tagged `[iframe]`, and
   * are actionable like any other); cross-origin iframes can't be read, so a
   * `[frame]` marker line reports each one instead of silence. Re-run after any
   * navigation — refs are only valid until the DOM changes.
   */
  async snapshot(page: Page, { maxNodes = 400 }: { maxNodes?: number } = {}): Promise<string> {
    return snapshotOutline(page, { maxNodes });
  }

  /**
   * Find one element by the same accessible name/role {@link snapshot} shows
   * (case-insensitive exact-or-contains match), or by a raw CSS `selector`, and
   * stamp it with ref `e1`. Returns `"e1"` or `null`. This is how a flow targets
   * elements across *fresh* sessions — snapshot refs are ephemeral and can't be
   * carried between sessions, but a name/selector re-resolves anywhere.
   */
  async locate(
    page: Page,
    { name, role, selector }: { name?: string; role?: string; selector?: string } = {},
  ): Promise<string | null> {
    return locateRef(page, { name, role, selector });
  }

  /**
   * Click an element by its {@link snapshot} ref, with human-like mouse movement
   * and timing. Throws (naming the overlay) if another element covers the target,
   * unless `force`. Reports what the click actually DID (`effect`): 'navigation',
   * 'dom-change', or 'none' — 'none' usually means the widget ignores synthetic
   * mouse events and wants keyboard activation. Pass `fallback: true` to retry
   * via focus + Enter automatically in that case (`via: 'enter'` when that's what
   * worked); it's opt-in because a click whose effect is merely DELAYED past the
   * watch window would be activated twice. Re-snapshot afterwards — the click may
   * have changed the page.
   */
  async click(
    page: Page,
    ref: string | number,
    opts: { force?: boolean; fallback?: boolean } = {},
  ): Promise<{ effect: EffectResult; via: 'mouse' | 'enter' }> {
    return clickAction(page, ref, this.#human, opts);
  }

  /**
   * Type into an input/textarea by its {@link snapshot} ref, character by
   * character with jittered delays and the occasional longer pause — both to
   * look human AND because typeahead widgets (location/search autocompletes) only
   * fire on real per-keystroke events, not an instant string dump. Focuses via a
   * human click, clears existing text first unless `clear: false`, and presses
   * Enter after when `submit: true`. `verify` (default true) reads the field back
   * and throws if the text didn't land (an overlay ate it, wrong field focused);
   * set false for widgets that reformat input beyond recognition.
   */
  async type(
    page: Page,
    ref: string | number,
    text: string,
    opts: { submit?: boolean; clear?: boolean; verify?: boolean } = {},
  ): Promise<void> {
    return typeAction(page, ref, text, this.#human, opts);
  }

  /**
   * Choose option(s) in a <select> by its {@link snapshot} ref. `value` is
   * matched against each option's visible label OR its value attribute, so an
   * agent can pass the label it saw in the snapshot without knowing the
   * underlying value. Accepts one value or an array (multi-select).
   * Reports `effect` like {@link click} ('none' = the app ignored the change event).
   */
  async select(page: Page, ref: string | number, value: string | string[]): Promise<{ effect: EffectResult }> {
    return selectAction(page, ref, value);
  }

  /**
   * Press a key or key-combo — it goes to whatever's focused, so pass `ref` to
   * focus a {@link snapshot} element first. Combos join with '+' and hold the
   * modifiers: "Enter", "Escape", "ArrowDown", "PageDown", "Control+A".
   * Reports `effect` like {@link click} ('none' = the key changed nothing).
   */
  async press(page: Page, key: string, opts: { ref?: string | number } = {}): Promise<{ effect: EffectResult }> {
    return pressAction(page, key, this.#human, opts);
  }

  /**
   * Scroll the page, or bring one element into view. With `ref`, centers that
   * {@link snapshot} element in the viewport; otherwise scrolls the window in
   * `direction`: 'down' | 'up' (~one viewport, with overlap) or 'top' | 'bottom'.
   */
  async scroll(
    page: Page,
    opts: { direction?: 'down' | 'up' | 'top' | 'bottom'; ref?: string | number } = {},
  ): Promise<void> {
    return scrollAction(page, this.#human, opts);
  }

  /**
   * Replay a declarative flow on this session's page — see {@link runFlow}.
   */
  async runFlow(page: Page, steps: FlowStep[] = [], { log }: { log?: (msg: string) => void } = {}): Promise<void> {
    return runFlow(page, steps, { session: this, ...(log ? { log } : {}) });
  }

  /**
   * Disconnect (never close): the browser is a shared remote device that should
   * keep running for the next user. Closes only pages this session opened.
   */
  async disconnect(): Promise<void> {
    for (const page of await this.browser.pages().catch(() => [])) {
      if (wasCreated(page)) await page.close().catch(() => {});
    }
    this.browser.disconnect();
  }
}

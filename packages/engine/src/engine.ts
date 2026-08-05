import type { ArchonumClient, ArchonumClientOptions, ConnectionInfo } from '@archonum/sdk';
import { ArchonumClient as Client } from '@archonum/sdk';
import type { PuppeteerLifeCycleEvent } from 'puppeteer-core';
import { ArchonumSession, puppeteer } from './session.js';
import { sleep } from './util.js';
import type { Clip, CompareResult, ReadResult } from './types.js';
import type { FlowStep } from './flow.js';

export interface ArchonumEngineOptions {
  /** Human-like input cadence on the session's actions. Default: true. */
  humanize?: boolean;
  /** Puppeteer protocol timeout for the remote connection. Default: 120000. */
  protocolTimeout?: number;
}

/**
 * What {@link ArchonumEngine.capture} returns. Distinct from `CaptureResult`, which is
 * `ArchonumSession#captureViewport`'s shape.
 */
export interface OneShotCapture {
  buffer: Uint8Array | undefined;
  clip: Clip;
  status: number;
  title: string;
  textLength: number;
  info: ConnectionInfo;
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
    if (this.client.connectRetries < 1) {
      throw new Error('ArchonumEngine#connect: "connectRetries" must be at least 1');
    }
    let lastErr: Error | undefined;
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
        // Anything can be thrown in JS; normalise once so the log line and the
        // eventual rethrow both see a real Error.
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr = error;
        if (attempt === this.client.connectRetries) break;
        const wait = Math.min(2 ** attempt, 8);
        this.log(`handshake attempt ${attempt} failed (${error.message}); retrying in ${wait}s...`);
        await sleep(wait * 1000);
      }
    }
    throw lastErr;
  }

  /**
   * One-shot: connect, navigate, let the page settle, screenshot clipped to the
   * device viewport, and disconnect. Returns the buffer + some diagnostics.
   */
  async capture(
    url: string,
    {
      path,
      desktop = false,
      settleMs = 15000,
      navTimeout = 90000,
      waitUntil = 'load',
    }: {
      path?: string;
      desktop?: boolean;
      settleMs?: number;
      navTimeout?: number;
      waitUntil?: PuppeteerLifeCycleEvent;
    } = {},
  ): Promise<OneShotCapture> {
    const session = await this.connect();
    try {
      const page = await session.newPage({ desktop });
      const response = await page.goto(url, { waitUntil, timeout: navTimeout });
      await sleep(settleMs);

      const status = response ? response.status() : 0;
      const title = (await page.title()) || '(no title)';
      const textLength = await session.renderedTextLength(page);

      const { buffer, clip } = await session.captureViewport(page, {
        path,
        onRetry: ({ attempt, attempts, error }) =>
          this.log(`✗ screenshot attempt ${attempt}/${attempts}: ${error.message}`),
      });
      return { buffer, clip, status, title, textLength, info: session.info };
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Run the SAME flow across several exit countries in parallel — each in its
   * own fresh session — and return per-country results. This is the archonum
   * way to compare regional pricing/availability: because it re-runs a real
   * interactive flow per country (not just a homepage fetch), it works for
   * multi-step tasks like a full search flow. `steps` is a declarative flow;
   * omit it to just load `url`. Optionally pull one value per country with
   * `extract` (a CSS selector — e.g. the price) and/or capture a screenshot
   * each.
   */
  async compareFlow(
    url: string,
    {
      countries,
      steps = [],
      extract,
      screenshot = false,
      desktop = true,
      excerptChars = 800,
    }: {
      countries: string[];
      steps?: FlowStep[];
      extract?: string;
      screenshot?: boolean;
      desktop?: boolean;
      excerptChars?: number;
    },
  ): Promise<CompareResult[]> {
    return Promise.all(
      countries.map(async (country) => {
        const session = await this.connect({ country });
        try {
          const page = await session.newPage({ desktop });
          const res = await page.goto(url, { waitUntil: 'load', timeout: 90000 });
          await session.runFlow(page, steps, { log: (msg) => this.log(`[${country}] ${msg}`) });
          // After a flow the final page came from clicks, not a navigation we hold a
          // response for — so report status from the response only when no steps ran.
          const info = await session.pageInfo(page, steps.length ? null : res);
          const excerpt = await page.evaluate(
            (n) => (document.body ? document.body.innerText : '').trim().replace(/\s+/g, ' ').slice(0, n),
            excerptChars,
          );
          const result: CompareResult = { country, ...info, excerpt };
          if (extract) {
            result.extracted = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              return el ? (el as HTMLElement).innerText.trim().replace(/\s+/g, ' ') : null;
            }, extract);
          }
          if (screenshot) {
            const { buffer } = await session.captureViewport(page);
            result.screenshot = buffer;
          }
          return result;
        } finally {
          await session.disconnect().catch(() => {});
        }
      }),
    );
  }

  /**
   * One-shot "fetch, but unblockable": connect (optionally from a given exit
   * country), load the URL, wait for real content to render, and return the
   * page's rendered text. The stealth counterpart to a plain HTTP fetch — it
   * gets past bot walls, runs full client-side JS, and can read a page as seen
   * from `country`. Stateless (connect + disconnect); for interaction use
   * {@link connect} + a session instead.
   */
  async read(
    url: string,
    {
      country,
      desktop = true,
      minTextLength = 200,
      waitForText,
      settleMs = 500,
      timeoutMs = 15000,
      navTimeout = 90000,
      maxChars = 8000,
      screenshot = false,
    }: {
      country?: string;
      desktop?: boolean;
      minTextLength?: number;
      waitForText?: string;
      settleMs?: number;
      timeoutMs?: number;
      navTimeout?: number;
      maxChars?: number;
      screenshot?: boolean;
    } = {},
  ): Promise<ReadResult> {
    const session = await this.connect({ country });
    try {
      const page = await session.newPage({ desktop });
      const deadline = Date.now() + timeoutMs;
      const res = await page.goto(url, { waitUntil: 'load', timeout: navTimeout });
      const wait = await session.waitForContent(page, { minTextLength, containsText: waitForText, timeoutMs });
      let settled = wait.settled;
      // Quiet period: the target being met doesn't mean rendering finished —
      // keep sampling until the text length holds still for settleMs.
      if (settleMs > 0) {
        let last = wait.textLength;
        for (;;) {
          await sleep(settleMs);
          const len = await session.renderedTextLength(page).catch(() => last);
          if (len === last) break;
          last = len;
          if (Date.now() >= deadline) {
            settled = false;
            break;
          }
        }
      }
      const info = await session.pageInfo(page, res); // status from the navigation response
      const { text, truncated } = await session.pageText(page, { maxChars });
      const result: ReadResult = { ...info, settled, text, truncated };
      if (wait.stalled) result.stalled = true;
      if (wait.excerpt != null) result.excerpt = wait.excerpt;
      if (screenshot) result.screenshot = (await session.captureViewport(page)).buffer;
      return result;
    } finally {
      await session.disconnect();
    }
  }
}

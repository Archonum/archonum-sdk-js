import type { Page, PuppeteerLifeCycleEvent } from 'puppeteer-core';
import type { ArchonumSession } from './session.js';
import { sleep } from './util.js';

/**
 * One step of a declarative flow (see {@link runFlow}). Step shapes (one
 * `action` each):
 *   { action: 'goto', url, waitUntil? }
 *   { action: 'click',  target?|selector?, role?, optional? }
 *   { action: 'type',   target?|selector?, role?, text, submit?, clear?, optional? }
 *   { action: 'select', target?|selector?, role?, value, optional? }
 *   { action: 'press',  key, target?|selector? }         // target/selector focuses first
 *   { action: 'scroll', direction?, target?|selector? }  // target/selector scrolls into view
 *   { action: 'wait', ms }
 *   { action: 'waitForContent', minTextLength?, timeoutMs? }
 * `optional: true` skips a targeting step whose element isn't found (cookie
 * banners, popups that only sometimes appear).
 */
export interface FlowStep {
  action: 'goto' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'wait' | 'waitForContent';
  target?: string;
  selector?: string;
  role?: string;
  url?: string;
  waitUntil?: PuppeteerLifeCycleEvent;
  text?: string;
  value?: string | string[];
  key?: string;
  direction?: 'down' | 'up' | 'top' | 'bottom';
  submit?: boolean;
  clear?: boolean;
  ms?: number;
  minTextLength?: number;
  timeoutMs?: number;
  optional?: boolean;
}

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
  for (const step of steps) {
    const loc = { ...(step.target !== undefined ? { name: step.target } : {}), ...(step.role !== undefined ? { role: step.role } : {}), ...(step.selector !== undefined ? { selector: step.selector } : {}) };
    const hasTarget = step.target != null || step.selector != null;
    switch (step.action) {
      case 'goto':
        await page.goto(step.url as string, { waitUntil: step.waitUntil || 'load', timeout: 90000 });
        break;
      case 'wait':
        await sleep(step.ms ?? 1000);
        break;
      case 'waitForContent':
        await session.waitForContent(page, { minTextLength: step.minTextLength, timeoutMs: step.timeoutMs });
        break;
      case 'press':
        await session.press(page, step.key as string, { ref: hasTarget ? (await session.locate(page, loc)) ?? undefined : undefined });
        break;
      case 'scroll': {
        const ref = hasTarget ? await session.locate(page, loc) : null;
        await session.scroll(page, { direction: step.direction || 'down', ref: ref ?? undefined });
        break;
      }
      case 'click':
      case 'type':
      case 'select': {
        const ref = await session.locate(page, loc);
        if (!ref) {
          if (step.optional) {
            log(`skipped ${step.action} (not found): ${step.target ?? step.selector}`);
            continue;
          }
          throw new Error(`runFlow: could not locate ${JSON.stringify(step.target ?? step.selector)} for ${step.action}`);
        }
        if (step.action === 'click') await session.click(page, ref);
        else if (step.action === 'type') await session.type(page, ref, step.text as string, { submit: step.submit, clear: step.clear });
        else await session.select(page, ref, step.value as string | string[]);
        break;
      }
      default:
        throw new Error(`runFlow: unknown step action ${JSON.stringify(step.action)}`);
    }
    log(`${step.action}${step.target ? ` ${JSON.stringify(step.target)}` : ''}`);
  }
}

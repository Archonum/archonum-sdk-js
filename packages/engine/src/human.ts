import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { mutationCount } from './mutation.js';
import { sleep } from './util.js';
import type { EffectResult } from './types.js';

/**
 * Human-like timing. Behavioural bot walls flag the superhuman cadence of raw CDP
 * input, so every interaction routes its pauses through here. `enabled: false`
 * turns them into no-ops for maximum speed.
 */
export class Humanizer {
  constructor(readonly enabled: boolean) {}

  /** Uniform random in [min, max). */
  rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  /** Think-time pause with a random duration — a no-op when disabled. */
  async pause(min: number, max: number): Promise<void> {
    if (this.enabled) await sleep(this.rand(min, max));
  }
}

/** If the click point is covered by an unrelated element, describe it; else null. */
export async function occluder(el: ElementHandle<Element>, point: { x: number; y: number }): Promise<string | null> {
  return el.evaluate((target, x, y) => {
    // Hit-test in the target's OWN document: for an element inside a
    // same-origin iframe, translate the main-viewport point into that frame's
    // coordinates first — elementFromPoint on the main document would just
    // report the <iframe> itself and flag every in-frame click as covered.
    const doc = target.ownerDocument;
    let win: Window | null = doc.defaultView;
    while (win && win.frameElement) {
      const r = win.frameElement.getBoundingClientRect();
      x -= r.left;
      y -= r.top;
      win = win.parent;
    }
    const top = doc.elementFromPoint(x, y);
    if (!top || top === target || target.contains(top) || top.contains(target)) return null;
    const role = top.getAttribute('role') || top.tagName.toLowerCase();
    const name = (top.getAttribute('aria-label') || top.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `<${role}${name ? ` "${name}"` : ''}>`;
  }, point.x, point.y);
}

/**
 * Click an element the way a person would: scroll it into view, move the
 * cursor to it along a multi-step path (not a teleport), hover a beat, then
 * press with a realistic down→up duration and settle. The mouse path + timing
 * are what behavioural bot walls look for — a trusted click that arrives with
 * no preceding movement is the tell. Falls back to a plain click if the
 * element has no hit-testable point.
 */
export async function humanClick(
  page: Page,
  el: ElementHandle<Element>,
  human: Humanizer,
  { force = false, onBeforePress }: { force?: boolean; onBeforePress?: () => Promise<void> | void } = {},
): Promise<void> {
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {});
  await human.pause(120, 400);
  let point: { x: number; y: number };
  try {
    point = await el.clickablePoint(); // viewport-relative, hit-tested — what el.click() uses internally
  } catch {
    await onBeforePress?.();
    await el.click();
    await human.pause(150, 500);
    return;
  }
  // Refuse to click through an overlay (a modal/cookie wall covering the target),
  // which is how "click/type succeeded" but nothing happened — name the blocker.
  if (!force) {
    const blocker = await occluder(el, point);
    if (blocker) throw new Error(`target is covered by ${blocker} — dismiss it first, then retry (force:true skips this check for false positives)`);
  }
  const steps = human.enabled ? Math.round(human.rand(12, 28)) : 1;
  await page.mouse.move(point.x + human.rand(-3, 3), point.y + human.rand(-3, 3), { steps });
  await human.pause(40, 140); // hover before pressing
  // Arm the effect watcher here, not before the scroll/move — lazy-loading
  // triggered by scrolling into view would otherwise count as a click effect.
  await onBeforePress?.();
  await page.mouse.down();
  await human.pause(40, 110); // press duration
  await page.mouse.up();
  await human.pause(150, 500); // settle before the next action
}

/**
 * Watcher for whether an action ACTUALLY changed anything — the guard against
 * the application-layer silent no-op (event dispatched, page ignored it, e.g.
 * widgets that only activate on trusted or keyboard events). `arm()` right
 * before dispatching, then `result()` polls up to its timeout and returns:
 *   'navigation'  — the page navigated (checked first, so it short-circuits)
 *   'dom-change'  — at least one DOM mutation since arm()
 *   'none'        — nothing observable happened
 *   'unknown'     — the page couldn't be instrumented; no claim either way
 * Always `dispose()` (removes the navigation listener) when done.
 */
export async function effectWatch(page: Page): Promise<{
  arm: () => Promise<void>;
  result: (timeoutMs?: number) => Promise<EffectResult>;
  dispose: () => void;
}> {
  const state: { navigated: boolean; url: string; base: number | null } = {
    navigated: false,
    url: page.url(),
    base: null,
  };
  const onNav = (frame: Frame): void => {
    if (frame === page.mainFrame()) state.navigated = true;
  };
  page.on('framenavigated', onNav);
  const arm = async (): Promise<void> => {
    state.navigated = false;
    state.url = page.url();
    state.base = await mutationCount(page);
  };
  const result = async (timeoutMs = 1000): Promise<EffectResult> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (state.navigated || page.url() !== state.url) return 'navigation';
      if (state.base == null) return 'unknown';
      const n = await mutationCount(page);
      if (n == null || n < state.base) return 'navigation'; // counter reset ⇒ fresh context
      if (n > state.base) return 'dom-change';
      if (Date.now() >= deadline) return 'none';
      await sleep(100);
    }
  };
  const dispose = (): void => { page.off('framenavigated', onNav); };
  return { arm, result, dispose };
}

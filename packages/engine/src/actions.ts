import type { KeyInput, Page } from 'puppeteer-core';
import { resolveRef } from './dom-scan.js';
import { effectWatch, humanClick, type Humanizer } from './human.js';
import type { EffectResult } from './types.js';

/**
 * Click an element by its {@link snapshotOutline} ref, with human-like mouse movement
 * and timing. Throws (naming the overlay) if another element covers the target,
 * unless `force`. Reports what the click actually DID (`effect`): 'navigation',
 * 'dom-change', or 'none' — 'none' usually means the widget ignores synthetic
 * mouse events and wants keyboard activation. Pass `fallback: true` to retry
 * via focus + Enter automatically in that case (`via: 'enter'` when that's what
 * worked); it's opt-in because a click whose effect is merely DELAYED past the
 * watch window would be activated twice. Re-snapshot afterwards — the click may
 * have changed the page.
 */
export async function click(
  page: Page,
  ref: string | number,
  human: Humanizer,
  { force = false, fallback = false }: { force?: boolean; fallback?: boolean } = {},
): Promise<{ effect: EffectResult; via: 'mouse' | 'enter' }> {
  const el = await resolveRef(page, ref);
  const watch = await effectWatch(page);
  try {
    await humanClick(page, el, human, { force, onBeforePress: watch.arm });
    let effect = await watch.result(1000);
    let via: 'mouse' | 'enter' = 'mouse';
    if (effect === 'none' && fallback) {
      // The accessible activation path — widgets that ignore synthetic clicks
      // usually listen for keydown Enter/Space on the focused element.
      await el.focus().catch(() => {});
      await human.pause(80, 200);
      await watch.arm();
      await page.keyboard.press('Enter');
      const retry = await watch.result(1000);
      if (retry !== 'none') {
        effect = retry;
        via = 'enter';
      }
    }
    return { effect, via };
  } finally {
    watch.dispose();
  }
}

/**
 * Type into an input/textarea by its {@link snapshotOutline} ref, character by
 * character with jittered delays and the occasional longer pause — both to
 * look human AND because typeahead widgets (location/search autocompletes) only
 * fire on real per-keystroke events, not an instant string dump. Focuses via a
 * human click, clears existing text first unless `clear: false`, and presses
 * Enter after when `submit: true`. `verify` (default true) reads the field back
 * and throws if the text didn't land (an overlay ate it, wrong field focused);
 * set false for widgets that reformat input beyond recognition.
 */
export async function type(
  page: Page,
  ref: string | number,
  text: string,
  human: Humanizer,
  { submit = false, clear = true, verify = true }: { submit?: boolean; clear?: boolean; verify?: boolean } = {},
): Promise<void> {
  const el = await resolveRef(page, ref);
  await humanClick(page, el, human); // focusing — throws (naming the overlay) if the field is covered
  if (clear) {
    await el.evaluate((node) => {
      const input = node as HTMLInputElement;
      return typeof input.select === 'function' && input.select();
    }); // OS-independent select-all
  }
  for (const ch of text) {
    await page.keyboard.type(ch);
    await human.pause(45, 165);
    if (human.enabled && Math.random() < 0.08) await human.pause(200, 500); // occasional "thinking" beat
  }
  // Ground truth: read the field back. Containment tolerates autocompletes that
  // reformat the value ("Bologna" → "Bologna, Italy"); a total mismatch
  // means the keystrokes went nowhere — fail loudly instead of lying.
  if (verify) {
    const got = await el.evaluate((node) => {
      const input = node as HTMLInputElement;
      return (input.value != null ? input.value : node.textContent) || '';
    });
    if (!got.includes(text)) {
      throw new Error(
        `type did not land — the field still reads ${JSON.stringify(got.slice(0, 60))}. ` +
          `An overlay may be intercepting input; snapshot to find it, dismiss it, and retry ` +
          `(or pass verify:false for a widget that reformats input).`,
      );
    }
  }
  if (submit) {
    await human.pause(200, 500);
    await page.keyboard.press('Enter');
  }
}

/**
 * Choose option(s) in a <select> by its {@link snapshotOutline} ref. `value` is
 * matched against each option's visible label OR its value attribute, so an
 * agent can pass the label it saw in the snapshot without knowing the
 * underlying value. Accepts one value or an array (multi-select).
 * Reports `effect` like {@link click} ('none' = the app ignored the change event).
 *
 * KNOWN TELL, no fix available: Puppeteer's `select()` sets `.value` and dispatches
 * `input`/`change` from page script, so both arrive with `isTrusted === false` and
 * without a preceding pointer/focus sequence — a site listening on the <select> can
 * detect that with one boolean. Measured, not theoretical. The CDP `Input` domain
 * cannot drive a native <select> (crbug 40943840), and the obvious workaround —
 * focus + ArrowDown + Enter — was tested and does NOT move the selection: the
 * keydowns are trusted but the value never changes and no change event fires. Don't
 * re-attempt that without re-measuring; it silently no-ops.
 */
export async function select(
  page: Page,
  ref: string | number,
  value: string | string[],
): Promise<{ effect: EffectResult }> {
  const el = await resolveRef(page, ref);
  const wanted = Array.isArray(value) ? value : [value];
  // Resolve labels → values in-page, then hand native <select> the values.
  const values = await el.evaluate((node, wanted: string[]) => {
    const sel = node as HTMLSelectElement;
    const opts = Array.from(sel.options || []);
    return wanted.map((w) => {
      const match = opts.find((o) => o.value === w || o.label === w || (o.textContent ?? '').trim() === w);
      return match ? match.value : w;
    });
  }, wanted);
  const watch = await effectWatch(page);
  try {
    await watch.arm();
    const selected = await el.select(...values);
    if (selected.length === 0) throw new Error(`select: no <option> matched ${JSON.stringify(wanted)}`);
    return { effect: await watch.result(1000) };
  } finally {
    watch.dispose();
  }
}

/**
 * Press a key or key-combo — it goes to whatever's focused, so pass `ref` to
 * focus a {@link snapshotOutline} element first. Combos join with '+' and hold the
 * modifiers: "Enter", "Escape", "ArrowDown", "PageDown", "Control+A".
 * Reports `effect` like {@link click} ('none' = the key changed nothing).
 */
export async function press(
  page: Page,
  key: string,
  human: Humanizer,
  { ref }: { ref?: string | number } = {},
): Promise<{ effect: EffectResult }> {
  if (ref != null) await (await resolveRef(page, ref)).focus();
  const watch = await effectWatch(page);
  try {
    await watch.arm();
    const parts = key.split('+');
    const main = parts.pop() as KeyInput;
    for (const mod of parts) {
      await page.keyboard.down(mod as KeyInput);
      await human.pause(20, 80);
    }
    await page.keyboard.down(main);
    await human.pause(30, 90); // key held briefly, like a real press
    await page.keyboard.up(main);
    for (const mod of parts.reverse()) {
      await human.pause(20, 80);
      await page.keyboard.up(mod as KeyInput);
    }
    return { effect: await watch.result(1000) };
  } finally {
    watch.dispose();
  }
}

/**
 * Scroll the page, or bring one element into view. With `ref`, centers that
 * {@link snapshotOutline} element in the viewport; otherwise scrolls the window in
 * `direction`: 'down' | 'up' (~one viewport, with overlap) or 'top' | 'bottom'.
 */
export async function scroll(
  page: Page,
  human: Humanizer,
  { direction = 'down', ref }: { direction?: 'down' | 'up' | 'top' | 'bottom'; ref?: string | number } = {},
): Promise<void> {
  if (ref != null) {
    const el = await resolveRef(page, ref);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await human.pause(150, 400);
    return;
  }
  if (direction === 'top' || direction === 'bottom') {
    await page.evaluate((d: 'top' | 'bottom') => window.scrollTo(0, d === 'bottom' ? document.body.scrollHeight : 0), direction);
    return;
  }
  // 'down'/'up': dispatch real wheel events in a few jittered ticks (with the
  // physical scroll a person makes) rather than one instant jump.
  const sign = direction === 'up' ? -1 : 1;
  const viewport = await page.evaluate(() => window.innerHeight);
  const ticks = human.enabled ? Math.round(human.rand(3, 6)) : 1;
  const perTick = Math.round((viewport * 0.9) / ticks);
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel({ deltaY: sign * perTick });
    await human.pause(60, 180);
  }
}

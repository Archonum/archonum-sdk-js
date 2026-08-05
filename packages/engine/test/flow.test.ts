import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, type FlowStep } from '../src/flow.js';

/** Records every call, with its full argument list, so the dispatch can be asserted without a browser. */
function fakes(locate: (target: unknown) => string | null = () => 'e1') {
  const calls: string[] = [];
  const page = {
    goto: async (url: string, opts: { waitUntil?: string; timeout?: number }) => {
      calls.push(`goto ${url} ${JSON.stringify(opts)}`);
      return null;
    },
  };
  const session = {
    locate: async (_page: unknown, target: unknown) => { calls.push(`locate ${JSON.stringify(target)}`); return locate(target); },
    click: async (_page: unknown, ref: string) => { calls.push(`click ${ref}`); return { effect: 'dom-change', via: 'mouse' }; },
    type: async (_page: unknown, ref: string, text: string, opts: { submit?: boolean; clear?: boolean }) => {
      calls.push(`type ${ref} ${text} ${JSON.stringify(opts)}`);
    },
    select: async (_page: unknown, ref: string, value: string) => { calls.push(`select ${ref} ${value}`); return { effect: 'dom-change' }; },
    press: async (_page: unknown, key: string, opts: { ref?: string }) => {
      calls.push(`press ${key} ${JSON.stringify(opts)}`);
      return { effect: 'none' };
    },
    scroll: async (_page: unknown, opts: { direction?: string; ref?: string }) => { calls.push(`scroll ${JSON.stringify(opts)}`); },
    waitForContent: async (_page: unknown, opts: { minTextLength?: number; timeoutMs?: number }) => {
      calls.push(`waitForContent ${JSON.stringify(opts)}`);
      return {};
    },
  };
  return { calls, page, session };
}

const run = (steps: FlowStep[], f = fakes(), log?: (msg: string) => void) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runFlow(f.page as any, steps, { session: f.session as any, ...(log ? { log } : {}) });

test('runFlow dispatches each step to the right session method, with the right arguments', async () => {
  const f = fakes();
  const logged: string[] = [];
  await run([
    { action: 'goto', url: 'https://example.com/' },
    { action: 'type', target: 'Search', text: 'parka', submit: true, clear: false },
    { action: 'click', target: 'Go' },
    { action: 'select', target: 'Size', value: 'M' },
    { action: 'press', key: 'Escape' },
    { action: 'press', key: 'ArrowDown', target: 'Filter' },
    { action: 'scroll' },
    { action: 'scroll', direction: 'bottom' },
    { action: 'waitForContent', minTextLength: 500, timeoutMs: 3000 },
  ], f, (msg) => logged.push(msg));
  assert.deepEqual(f.calls, [
    'goto https://example.com/ {"waitUntil":"load","timeout":90000}',
    'locate {"name":"Search"}',
    'type e1 parka {"submit":true,"clear":false}',
    'locate {"name":"Go"}',
    'click e1',
    'locate {"name":"Size"}',
    'select e1 M',
    'press Escape {}',
    'locate {"name":"Filter"}',
    'press ArrowDown {"ref":"e1"}',
    'scroll {"direction":"down"}',
    'scroll {"direction":"bottom"}',
    'waitForContent {"minTextLength":500,"timeoutMs":3000}',
  ]);
  // The trailing per-step log(...) line: action alone when there's no target, action + its
  // JSON-quoted target when there is one.
  assert.deepEqual(logged, [
    'goto',
    'type "Search"',
    'click "Go"',
    'select "Size"',
    'press',
    'press "Filter"',
    'scroll',
    'scroll',
    'waitForContent',
  ]);
});

test('runFlow skips an optional step whose target is missing, and logs it', async () => {
  const f = fakes(() => null);
  const logged: string[] = [];
  await run([{ action: 'click', target: 'Accept all', optional: true }], f, (msg) => logged.push(msg));
  assert.deepEqual(f.calls, ['locate {"name":"Accept all"}']);
  // Pinned byte-for-byte: proves nothing else got logged, and rules out an implementation
  // that used `break` instead of `continue` (a loose regex match would pass either way).
  assert.deepEqual(logged, ['skipped click (not found): Accept all']);
});

test('runFlow throws when a required target is missing', async () => {
  await assert.rejects(
    () => run([{ action: 'click', target: 'Buy now' }], fakes(() => null)),
    /could not locate "Buy now" for click/,
  );
});

test('runFlow rejects an unknown action', async () => {
  await assert.rejects(
    () => run([{ action: 'teleport' } as unknown as FlowStep], fakes()),
    /unknown step action "teleport"/,
  );
});

test('runFlow waits the requested time for a wait step, and defaults to 1000ms when ms is omitted', async () => {
  const started = process.hrtime.bigint();
  await run([{ action: 'wait', ms: 20 }], fakes());
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs >= 15, `expected >= 15ms, got ${elapsedMs}`);
  // Upper bound: an implementation that ignores step.ms and always sleeps the ?? 1000
  // default would still pass a lower-bound-only check.
  assert.ok(elapsedMs < 200, `expected < 200ms, got ${elapsedMs}`);

  const startedDefault = process.hrtime.bigint();
  await run([{ action: 'wait' }], fakes());
  const defaultMs = Number(process.hrtime.bigint() - startedDefault) / 1e6;
  assert.ok(defaultMs >= 995, `expected >= 995ms (the ?? 1000 default), got ${defaultMs}`);
});

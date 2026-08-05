import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

test('withRetry returns the first successful value without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries until the call succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`boom ${calls}`);
      return calls;
    },
    { attempts: 5, delayMs: 0 },
  );
  assert.equal(result, 3);
  assert.equal(calls, 3);
});

test('withRetry throws the last error after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { attempts: 3, delayMs: 0 }),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('withRetry reports every failed attempt to onRetry', async () => {
  const seen: Array<{ attempt: number; attempts: number; message: string }> = [];
  await assert.rejects(
    () => withRetry(async () => { throw new Error('nope'); }, {
      attempts: 2,
      delayMs: 0,
      onRetry: ({ attempt, attempts, error }) => seen.push({ attempt, attempts, message: error.message }),
    }),
  );
  assert.deepEqual(seen, [
    { attempt: 1, attempts: 2, message: 'nope' },
    { attempt: 2, attempts: 2, message: 'nope' },
  ]);
});

test('withRetry throws a clear error when attempts is 0, instead of throwing undefined', async () => {
  await assert.rejects(
    () => withRetry(async () => 'never', { attempts: 0 }),
    /attempts.*must be at least 1/,
  );
});

test('withRetry normalises a non-Error rejection before reporting it', async () => {
  const seen: Error[] = [];
  await assert.rejects(
    () => withRetry(async () => { throw 'plain string failure'; }, {
      attempts: 2,
      delayMs: 0,
      onRetry: ({ error }) => seen.push(error),
    }),
    (err: unknown) => err instanceof Error && err.message === 'plain string failure',
  );
  assert.equal(seen.length, 2);
  assert.ok(seen.every((e) => e instanceof Error), 'onRetry always receives a real Error');
  assert.equal(seen[0].message, 'plain string failure');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHALLENGE_CLEARABLE, isBlocked, SHORT_PAGE_TEXT } from '../src/challenge.js';

test('a 429 or 403 is blocked regardless of how much text rendered', () => {
  assert.equal(isBlocked(429, 50_000, null), true);
  assert.equal(isBlocked(403, 50_000, null), true);
});

test('a page with plenty of text is not blocked', () => {
  assert.equal(isBlocked(200, SHORT_PAGE_TEXT, null), false);
  assert.equal(isBlocked(200, 5000, null), false);
  // Status 0 (no navigation response held) must not by itself mean blocked.
  assert.equal(isBlocked(0, 5000, null), false);
});

test('a short page with no challenge markers is NOT blocked', () => {
  // The https://example.com/ case: 129 characters, healthy, nothing challenge-like.
  assert.equal(isBlocked(200, 129, 'unknown'), false);
  assert.equal(isBlocked(304, 129, 'unknown'), false);
});

test('a short page IS blocked when the DOM shows something challenge-like', () => {
  for (const kind of [
    'cloudflare-turnstile',
    'cloudflare-js-challenge',
    'akamai',
    'perimeterx',
    'datadome',
    'generic-interstitial',
    'unknown-empty',
  ] as const) {
    assert.equal(isBlocked(200, 100, kind), true, `${kind} should count as blocked`);
  }
});

test('every challenge kind has a clearable rating', () => {
  for (const kind of Object.keys(CHALLENGE_CLEARABLE)) {
    const rating = CHALLENGE_CLEARABLE[kind as keyof typeof CHALLENGE_CLEARABLE];
    assert.ok(['likely', 'maybe', 'unlikely'].includes(rating), `${kind} -> ${rating}`);
  }
});

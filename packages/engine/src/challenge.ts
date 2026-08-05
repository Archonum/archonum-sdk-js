import type { Page } from 'puppeteer-core';
import type { ChallengeKind, Clearable } from './types.js';

// How likely each challenge type is to clear on its own for a real device just
// waiting — the caller's cue to either keep polling or rotate identity.
export const CHALLENGE_CLEARABLE: Record<ChallengeKind, Clearable> = {
  'cloudflare-js-challenge': 'likely',
  'cloudflare-turnstile': 'maybe',
  akamai: 'maybe',
  perimeterx: 'unlikely',
  datadome: 'unlikely',
  'generic-interstitial': 'maybe',
  'unknown-empty': 'unlikely',
  unknown: 'maybe',
};

/**
 * Which bot-wall vendor/type is blocking the page, from main-frame DOM
 * markers. Meant to be called when the page is `blocked` — the answer tells
 * a caller whether waiting is worth it (see CHALLENGE_CLEARABLE): a Cloudflare
 * JS challenge usually clears on a real device; an `unknown-empty` page never will.
 */
export async function classifyChallenge(page: Page): Promise<ChallengeKind> {
  return page
    .evaluate((): ChallengeKind => {
      const q = (sel: string): boolean => {
        try {
          return !!document.querySelector(sel);
        } catch {
          return false;
        }
      };
      const html = document.documentElement ? document.documentElement.innerHTML.slice(0, 200000) : '';
      const title = (document.title || '').toLowerCase();
      if (q('iframe[src*="challenges.cloudflare.com"], .cf-turnstile') || html.includes('challenges.cloudflare.com/turnstile'))
        return 'cloudflare-turnstile';
      if (q('#challenge-running, #cf-challenge-running, #challenge-form, #challenge-stage') ||
          html.includes('/cdn-cgi/challenge-platform/') || title.includes('just a moment'))
        return 'cloudflare-js-challenge';
      if (q('#sec-cpt-if') || html.includes('/_sec/cp_challenge/') || html.includes('/akam/'))
        return 'akamai';
      if (q('#px-captcha') || html.includes('_pxAppId'))
        return 'perimeterx';
      if (q('#datadome, iframe[src*="captcha-delivery.com"]'))
        return 'datadome';
      const text = document.body ? document.body.innerText.trim() : '';
      if (text.length < 20) return 'unknown-empty';
      if (/verify(ing)? you are|checking your browser|access denied|are you a robot|captcha|unusual traffic/i.test(text))
        return 'generic-interstitial';
      return 'unknown';
    })
    .catch((): ChallengeKind => 'unknown');
}

/** Text below this is short enough to be worth classifying as a possible challenge page. */
export const SHORT_PAGE_TEXT = 200;

/**
 * Whether a page should be reported as blocked, given its HTTP status and — when
 * the page looked short enough to be suspicious — what {@link classifyChallenge}
 * found in the DOM.
 *
 * A 429 or 403 is blocked outright. Beyond that, a SHORT page is only blocked when
 * the DOM actually shows something challenge-like: a vendor marker, an
 * interstitial phrase, or a near-empty body. Short text alone is not evidence —
 * `https://example.com/` renders 129 characters and is a perfectly healthy page,
 * and reporting it as `blocked` (with `challenge: 'unknown'`) tells an agent to
 * wait out a challenge or rotate identity for no reason.
 *
 * @param challenge - the classification, or null when the page was not short
 *   enough to bother classifying.
 */
export function isBlocked(status: number, textLength: number, challenge: ChallengeKind | null): boolean {
  if (status === 429 || status === 403) return true;
  if (textLength >= SHORT_PAGE_TEXT) return false;
  // Short page: believe the DOM, not the length. 'unknown' means we looked and
  // found no challenge markers at all.
  return challenge !== null && challenge !== 'unknown';
}

import type { Page } from 'puppeteer-core';
import type { Clip } from './types.js';

/** The screenshot clip we own for a page (desktop mode only). */
const clips = new WeakMap<Page, Clip>();
/** Pages this SDK opened itself — the only ones disconnect() may close. */
const created = new WeakSet<Page>();

export const setClip = (page: Page, clip: Clip): void => void clips.set(page, clip);
export const getClip = (page: Page): Clip | undefined => clips.get(page);
export const markCreated = (page: Page, wasOurs: boolean): void => {
  if (wasOurs) created.add(page);
  else created.delete(page);
};
export const wasCreated = (page: Page): boolean => created.has(page);

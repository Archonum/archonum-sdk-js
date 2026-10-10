import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopUserAgentMetadata } from '../src/session.js';

const UA = 'Mozilla/5.0 (Linux; Android 12; SM-A217F Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.120 Safari/537.36';
const none = { brands: null, fullVersionList: null, platform: '', platformVersion: '', architecture: '' };

test('desktop client hints are derived from the UA when the page had no userAgentData (about:blank)', () => {
  const m = desktopUserAgentMetadata(UA, none);
  assert.ok(m);
  assert.deepEqual(m.brands.map((b) => `${b.brand} ${b.version}`), ['Chromium 148', 'Google Chrome 148', 'Not_A Brand 8']);
  assert.equal(m.fullVersionList?.[0].version, '148.0.7778.120');
  assert.equal(m.fullVersion, '148.0.7778.120', 'older WebViews reject the override without it');
  assert.equal(m.platform, 'Android');
  assert.equal(m.platformVersion, '12');
  assert.equal(m.mobile, false);
  assert.equal(m.model, '');
});

test("the page's own hints win when it has them", () => {
  const brands = [{ brand: 'Chromium', version: '148' }, { brand: 'Google Chrome', version: '148' }];
  const m = desktopUserAgentMetadata(UA, { ...none, brands, platform: 'Android', platformVersion: '12.0.0' });
  assert.deepEqual(m?.brands, brands);
  assert.equal(m?.platformVersion, '12.0.0');
});

test('no Chrome in the UA and no hints: nothing to claim', () => {
  assert.equal(desktopUserAgentMetadata('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0', none), undefined);
});

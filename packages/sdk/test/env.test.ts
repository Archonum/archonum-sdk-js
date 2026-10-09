import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, readEnvConfig, gatewayHostFromUrl } from '../src/env.js';

test('readEnvConfig reads ARCHONUM_TOKEN as token', () => {
  const cfg = readEnvConfig({ ARCHONUM_TOKEN: 'tok', ARCHONUM_USERNAME: 'user' } as NodeJS.ProcessEnv);
  assert.equal(cfg.token, 'tok');
  assert.equal(cfg.username, 'user');
});

test('readEnvConfig falls back to ARCHONUM_PASSWORD when ARCHONUM_TOKEN is absent', () => {
  const cfg = readEnvConfig({ ARCHONUM_PASSWORD: 'pw' } as NodeJS.ProcessEnv);
  assert.equal(cfg.token, 'pw');
});

test('readEnvConfig falls back to ARCHONUM_CDP_PASSWORD when ARCHONUM_TOKEN and ARCHONUM_PASSWORD are absent', () => {
  const cfg = readEnvConfig({ ARCHONUM_CDP_PASSWORD: 'cdp-pw' } as NodeJS.ProcessEnv);
  assert.equal(cfg.token, 'cdp-pw');
});

test('readEnvConfig prefers ARCHONUM_TOKEN over both fallbacks', () => {
  const cfg = readEnvConfig({
    ARCHONUM_TOKEN: 'tok',
    ARCHONUM_PASSWORD: 'pw',
    ARCHONUM_CDP_PASSWORD: 'cdp-pw',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.token, 'tok');
});

test('readEnvConfig falls back to ARCHONUM_CDP_USERNAME when ARCHONUM_USERNAME is absent', () => {
  const cfg = readEnvConfig({ ARCHONUM_CDP_USERNAME: 'cdp-user' } as NodeJS.ProcessEnv);
  assert.equal(cfg.username, 'cdp-user');
});

test('readEnvConfig has no username default any more', () => {
  const cfg = readEnvConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.username, undefined);
  assert.equal(cfg.token, undefined);
  assert.equal(cfg.gateway, undefined);
  assert.equal(cfg.baseUrl, undefined);
});

test('readEnvConfig derives a bare host:port gateway from ARCHONUM_CDP_BASE_URL', () => {
  const cfg = readEnvConfig({ ARCHONUM_CDP_BASE_URL: 'http://stagegw.archonum.com:10900' } as NodeJS.ProcessEnv);
  assert.equal(cfg.gateway, 'stagegw.archonum.com:10900');
});

test('readEnvConfig prefers ARCHONUM_GATEWAY over ARCHONUM_CDP_BASE_URL', () => {
  const cfg = readEnvConfig({
    ARCHONUM_GATEWAY: 'gw:1',
    ARCHONUM_CDP_BASE_URL: 'http://stagegw.archonum.com:10900',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.gateway, 'gw:1');
});

test('readEnvConfig leaves TLS to the client default unless ARCHONUM_GATEWAY_TLS turns it off', () => {
  assert.equal(readEnvConfig({} as NodeJS.ProcessEnv).tls, undefined);
  assert.equal(readEnvConfig({ ARCHONUM_GATEWAY_TLS: 'false' } as NodeJS.ProcessEnv).tls, false);
  assert.equal(readEnvConfig({ ARCHONUM_GATEWAY_TLS: '0' } as NodeJS.ProcessEnv).tls, false);
  assert.equal(readEnvConfig({ ARCHONUM_GATEWAY_TLS: 'true' } as NodeJS.ProcessEnv).tls, true);
});

test('readEnvConfig reads ARCHONUM_BASE_URL', () => {
  const cfg = readEnvConfig({ ARCHONUM_BASE_URL: 'https://stage.archonum.com' } as NodeJS.ProcessEnv);
  assert.equal(cfg.baseUrl, 'https://stage.archonum.com');
});

test('readEnvConfig reads every ARCHONUM_ variable at once', () => {
  const cfg = readEnvConfig({
    ARCHONUM_GATEWAY: 'gw:1',
    ARCHONUM_GATEWAY_TLS: 'false',
    ARCHONUM_BASE_URL: 'https://stage.archonum.com',
    ARCHONUM_USERNAME: 'user',
    ARCHONUM_TOKEN: 'tok',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg, { gateway: 'gw:1', tls: false, baseUrl: 'https://stage.archonum.com', username: 'user', token: 'tok' });
});

test('gatewayHostFromUrl handles a full URL, a bare host:port, and garbage', () => {
  assert.equal(gatewayHostFromUrl('http://stagegw.archonum.com:10900'), 'stagegw.archonum.com:10900');
  assert.equal(gatewayHostFromUrl('stagegw.archonum.com:10900'), 'stagegw.archonum.com:10900');
  assert.equal(gatewayHostFromUrl('not a url at all'), undefined);
  assert.equal(gatewayHostFromUrl('garbage'), undefined);
});

test('loadDotEnv loads a .env from the cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-env-'));
  writeFileSync(join(dir, '.env'), 'ARCHONUM_TEST_LOADED=yes\n');
  const cwd = process.cwd();
  delete process.env.ARCHONUM_TEST_LOADED;
  try {
    process.chdir(dir);
    loadDotEnv();
    assert.equal(process.env.ARCHONUM_TEST_LOADED, 'yes');
  } finally {
    process.chdir(cwd);
    delete process.env.ARCHONUM_TEST_LOADED;
  }
});

test('loadDotEnv is a silent no-op when no .env exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-noenv-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.doesNotThrow(() => loadDotEnv());
  } finally {
    process.chdir(cwd);
  }
});

test('loadDotEnv never overrides an already-set variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archonum-prec-'));
  writeFileSync(join(dir, '.env'), 'ARCHONUM_TEST_PREC=from_dotenv\n');
  const cwd = process.cwd();
  process.env.ARCHONUM_TEST_PREC = 'from_shell';
  try {
    process.chdir(dir);
    loadDotEnv();
    assert.equal(process.env.ARCHONUM_TEST_PREC, 'from_shell');
  } finally {
    process.chdir(cwd);
    delete process.env.ARCHONUM_TEST_PREC;
  }
});

test('an empty-string variable falls through to the next fallback', () => {
  // Guards the `||` chains in readEnvConfig: swapping any of them for `??` would
  // let an empty string win and produce a confusing 401 instead of using the
  // credential that is actually set.
  const cfg = readEnvConfig({
    ARCHONUM_TOKEN: '',
    ARCHONUM_PASSWORD: 'from-password',
    ARCHONUM_USERNAME: '',
    ARCHONUM_CDP_USERNAME: 'from-cdp-username',
    ARCHONUM_GATEWAY: '',
    ARCHONUM_CDP_BASE_URL: 'http://gw.example.com:10900',
    ARCHONUM_BASE_URL: '',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.token, 'from-password');
  assert.equal(cfg.username, 'from-cdp-username');
  assert.equal(cfg.gateway, 'gw.example.com:10900');
  assert.equal(cfg.baseUrl, undefined, 'an empty baseUrl becomes undefined so the client default applies');
});

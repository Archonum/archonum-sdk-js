import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArchonumClient } from '../src/client.js';

const creds = { username: 'relayer', token: 's3cret' };

test('the constructor requires a token; the username is optional', () => {
  assert.throws(() => new ArchonumClient({ username: 'relayer' }), /token is required/);
  assert.throws(() => new ArchonumClient({}), /token is required/);
  const tokenOnly = new ArchonumClient({ token: 'tok' });
  assert.equal(tokenOnly.token, 'tok');
  assert.equal(tokenOnly.username, undefined);
  assert.equal(new ArchonumClient({ token: 'tok', username: '' }).username, undefined);
});

test('withCreds sends token= for a token-only client, and the legacy pair when a username is set', () => {
  const tokenOnly = new URL(new ArchonumClient({ token: 's3cret', country: 'ch' }).withCreds('ws://gw/devtools/browser/x'));
  assert.equal(tokenOnly.searchParams.get('token'), 's3cret');
  assert.equal(tokenOnly.searchParams.get('username'), null);
  assert.equal(tokenOnly.searchParams.get('password'), null);
  assert.equal(tokenOnly.searchParams.get('country'), 'ch');

  const pair = new URL(new ArchonumClient({ username: 'relayer', token: 's3cret' }).withCreds('ws://gw/devtools/browser/x'));
  assert.equal(pair.searchParams.get('username'), 'relayer');
  assert.equal(pair.searchParams.get('password'), 's3cret');
  assert.equal(pair.searchParams.get('token'), null);
});

test('token and the deprecated password option are interchangeable', () => {
  const viaToken = new ArchonumClient({ username: 'relayer', token: 'tok' });
  assert.equal(viaToken.token, 'tok');
  assert.equal(viaToken.password, 'tok');

  const viaPassword = new ArchonumClient({ username: 'relayer', password: 'pw' });
  assert.equal(viaPassword.token, 'pw');
  assert.equal(viaPassword.password, 'pw');
});

test('withCreds appends credentials and the client country', () => {
  const client = new ArchonumClient({ ...creds, country: 'ch' });
  const url = new URL(client.withCreds('ws://gw:10900/devtools/browser/abc'));
  assert.equal(url.searchParams.get('username'), 'relayer');
  assert.equal(url.searchParams.get('password'), 's3cret');
  assert.equal(url.searchParams.get('country'), 'ch');
  assert.equal(url.protocol, 'ws:');
});

test('withCreds omits country when it is empty, and honours a per-call override', () => {
  const client = new ArchonumClient({ ...creds, country: '' });
  assert.equal(new URL(client.withCreds('http://gw:10900/json/version')).searchParams.get('country'), null);
  assert.equal(new URL(client.withCreds('http://gw:10900/json/version', 'it')).searchParams.get('country'), 'it');
});

test('getConnectionInfo requests /json/version on the configured gateway and parses it', async () => {
  const seen: string[] = [];
  const client = new ArchonumClient({ ...creds, gateway: 'gw.test:10900', country: 'de', fetch: async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ Browser: 'Chrome/148', webSocketDebuggerUrl: 'wss://gw.test:10900/devtools/browser/xyz' }), { status: 200 });
  } });
  const info = await client.getConnectionInfo();
  assert.equal(info.Browser, 'Chrome/148');
  assert.equal(seen.length, 1);
  const requested = new URL(seen[0]);
  assert.equal(requested.origin + requested.pathname, 'https://gw.test:10900/json/version', 'TLS by default');
  assert.equal(requested.searchParams.get('country'), 'de');
  assert.equal(requested.searchParams.get('password'), 's3cret');
});

test('tls: false talks plaintext to the gateway', async () => {
  const seen: string[] = [];
  const client = new ArchonumClient({ ...creds, gateway: 'gateway:10900', tls: false, fetch: async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://gateway:10900/devtools/browser/xyz' }), { status: 200 });
  } });
  await client.getConnectionInfo();
  assert.equal(new URL(seen[0]).protocol, 'http:');
});

test('getConnectionInfo throws on a non-OK response and on a non-JSON body', async () => {
  const bad = new ArchonumClient({ ...creds, fetch: async () => new Response('<html>502</html>', { status: 502 }) });
  await assert.rejects(() => bad.getConnectionInfo(), /gateway HTTP 502/);

  const html = new ArchonumClient({ ...creds, fetch: async () => new Response('<html>hi</html>', { status: 200 }) });
  await assert.rejects(() => html.getConnectionInfo(), /non-JSON body/);
});

test('getCDPUrl retries a flaky gateway and returns the credentialed ws URL', async () => {
  let calls = 0;
  const logged: string[] = [];
  const client = new ArchonumClient({
    ...creds,
    country: 'ch',
    connectRetries: 4,
    retryDelayMs: 0,
    log: (msg) => logged.push(msg),
    fetch: async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 502 });
      return new Response(JSON.stringify({ Browser: 'Chrome/148', webSocketDebuggerUrl: 'ws://gw:10900/devtools/browser/abc' }), { status: 200 });
    },
  });
  const url = new URL(await client.getCDPUrl());
  assert.equal(calls, 3);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.searchParams.get('country'), 'ch');
  assert.equal(url.searchParams.get('username'), 'relayer');
  assert.equal(logged.length, 2, 'each failed attempt is logged');
});

test('getCDPUrl gives up after `attempts` and honours a country override', async () => {
  const client = new ArchonumClient({ ...creds, retryDelayMs: 0, fetch: async () => new Response('', { status: 502 }) });
  await assert.rejects(() => client.getCDPUrl({ attempts: 2 }), /gateway HTTP 502/);

  const ok = new ArchonumClient({ ...creds, country: 'ch', fetch: async (url) => {
    assert.equal(new URL(url).searchParams.get('country'), 'us');
    return new Response(JSON.stringify({ Browser: 'x', webSocketDebuggerUrl: 'ws://gw:1/devtools/browser/a' }), { status: 200 });
  } });
  assert.equal(new URL(await ok.getCDPUrl({ country: 'us' })).searchParams.get('country'), 'us');
});

test('fromEnv builds a client from ARCHONUM_* and lets overrides win', () => {
  const prev = { ...process.env };
  try {
    process.env.ARCHONUM_TOKEN = 'env-tok';
    process.env.ARCHONUM_USERNAME = 'relayer';
    const client = ArchonumClient.fromEnv({ country: 'us' });
    assert.equal(client.token, 'env-tok');
    assert.equal(client.username, 'relayer');
    assert.equal(client.country, 'us');
    assert.equal(client.gateway, 'gateway.archonum.com:10900');
    assert.equal(client.tls, true);
    assert.equal(client.baseUrl, 'https://app.archonum.com');
  } finally {
    process.env = prev;
  }
});

test('baseUrl defaults to https://app.archonum.com, and a trailing slash still produces a correct URL', async () => {
  const seen: string[] = [];
  const client = new ArchonumClient({ ...creds, baseUrl: 'https://stage.archonum.com/', fetch: async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ healthy: true }), { status: 200 });
  } });
  await client.getHealth();
  assert.equal(seen[0], 'https://stage.archonum.com/api/v1/health/');

  const defaultClient = new ArchonumClient({ ...creds });
  assert.equal(defaultClient.baseUrl, 'https://app.archonum.com');
});

test('getHealth parses the health payload and sends no Authorization header', async () => {
  let seenHeaders: Record<string, string> | undefined;
  const client = new ArchonumClient({ ...creds, fetch: async (_url, init) => {
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ healthy: true }), { status: 200 });
  } });
  const health = await client.getHealth();
  assert.deepEqual(health, { healthy: true });
  assert.equal(seenHeaders?.Authorization, undefined);
});

test('getCredits sends exactly Authorization: Token <token> and returns the balance', async () => {
  let seenHeaders: Record<string, string> | undefined;
  let calls = 0;
  const client = new ArchonumClient({ ...creds, fetch: async (_url, init) => {
    calls += 1;
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ username: 'relayer', credits: 1234 }), { status: 200 });
  } });
  const balance = await client.getCredits();
  assert.deepEqual(balance, { username: 'relayer', credits: 1234 });
  assert.deepEqual(seenHeaders, { Authorization: 'Token s3cret' });
  assert.equal(calls, 1);
});

test('getCredits maps 401 to an actionable message and does not retry', async () => {
  let calls = 0;
  const client = new ArchonumClient({ ...creds, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
  } });
  await assert.rejects(() => client.getCredits(), /archonum API: invalid or missing token/);
  assert.equal(calls, 1);
});

test('getCredits maps 402 including the API error text and does not retry', async () => {
  let calls = 0;
  const client = new ArchonumClient({ ...creds, fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'Insufficient credits. Browser sessions cost 5 MB.' }), { status: 402 });
  } });
  await assert.rejects(() => client.getCredits(), /archonum API: Insufficient credits\. Browser sessions cost 5 MB\./);
  assert.equal(calls, 1);
});

test('getCredits maps a generic 500 to a bare status message and does not retry', async () => {
  let calls = 0;
  const client = new ArchonumClient({ ...creds, fetch: async () => {
    calls += 1;
    return new Response('internal error', { status: 500 });
  } });
  await assert.rejects(() => client.getCredits(), /archonum API HTTP 500/);
  assert.equal(calls, 1);
});

test('getHealth throws on a non-JSON 200 body and does not retry', async () => {
  let calls = 0;
  const client = new ArchonumClient({ ...creds, fetch: async () => {
    calls += 1;
    return new Response('<html>hi</html>', { status: 200 });
  } });
  await assert.rejects(() => client.getHealth(), /archonum API returned a non-JSON body/);
  assert.equal(calls, 1);
});

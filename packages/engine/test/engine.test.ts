import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArchonumClient } from '@archonum/sdk';
import { ArchonumEngine } from '../src/engine.js';

test('connect() throws a clear error when connectRetries is 0, instead of throwing undefined', async () => {
  const client = new ArchonumClient({ username: 'relayer', password: 's3cret', connectRetries: 0 });
  const engine = new ArchonumEngine(client);
  await assert.rejects(() => engine.connect(), /connectRetries.*must be at least 1/);
});

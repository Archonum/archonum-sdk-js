import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pngSize } from '../src/png.js';

/** Minimal PNG header: signature + IHDR length/type + width/height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('pngSize reads width and height from the IHDR chunk', () => {
  assert.deepEqual(pngSize(pngHeader(1280, 800)), { width: 1280, height: 800 });
});

test('pngSize returns null for input that is not a PNG', () => {
  assert.equal(pngSize(undefined), null);
  assert.equal(pngSize(new Uint8Array(10)), null, 'too short');
  assert.equal(pngSize(new Uint8Array(24)), null, 'missing PNG signature');
});

test('pngSize works on a Buffer view with a non-zero byteOffset', () => {
  const padded = Buffer.concat([Buffer.alloc(8), Buffer.from(pngHeader(640, 480))]);
  assert.deepEqual(pngSize(padded.subarray(8)), { width: 640, height: 480 });
});

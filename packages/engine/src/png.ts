/** Width/height from a PNG's IHDR — cheap detection of partial captures. */
export function pngSize(bytes: Uint8Array | undefined): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

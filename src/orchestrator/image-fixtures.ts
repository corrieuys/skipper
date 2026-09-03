/**
 * Hand-built minimal image byte fixtures for tests of the file-artifact path.
 * Only the headers matter to `image-meta.ts`; the pixel payloads are not valid
 * for a decoder, which is fine because nothing here decodes them.
 */

function u32be(n: number): number[] { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u16be(n: number): number[] { return [(n >>> 8) & 0xff, n & 0xff]; }
function u16le(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff]; }
function u24le(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]; }
function str(s: string): number[] { return Array.from(s, (c) => c.charCodeAt(0)); }

/** PNG signature + IHDR chunk with the given dimensions + a fake IEND. */
export function pngBytes(width: number, height: number, padTo = 0): Uint8Array {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...str("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    ...u32be(0), ...str("IEND"), 0, 0, 0, 0,
  ];
  while (bytes.length < padTo) bytes.push(0);
  return new Uint8Array(bytes);
}

/** SOI + APP0 + SOF0 (baseline) header with the given dimensions + EOI. */
export function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...str("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}

export function gifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([...str("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0, 0x3b]);
}

/** RIFF/WEBP container with a VP8X chunk carrying the canvas size. */
export function webpBytes(width: number, height: number): Uint8Array {
  const chunk = [...str("VP8X"), ...u32be(10).reverse(), 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  const body = [...str("WEBP"), ...chunk];
  return new Uint8Array([...str("RIFF"), ...u32be(body.length).reverse(), ...body, 0, 0, 0, 0]);
}

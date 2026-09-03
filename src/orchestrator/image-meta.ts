/**
 * Dependency-free image sniffing for uploaded file artifacts: identify PNG,
 * JPEG, WebP and GIF by magic bytes and read the pixel dimensions from the
 * header. Anything else returns null, which callers treat as "not an image".
 */

export interface ImageMeta {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export const IMAGE_EXTENSIONS: Record<ImageMeta["mime"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function u16be(b: Uint8Array, i: number): number { return (b[i]! << 8) | b[i + 1]!; }
function u16le(b: Uint8Array, i: number): number { return b[i]! | (b[i + 1]! << 8); }
function u24le(b: Uint8Array, i: number): number { return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16); }
function u32be(b: Uint8Array, i: number): number { return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!; }
function ascii(b: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = start; i < start + len && i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}

function png(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return null;
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = u16be(b, i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { mime: "image/jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xda) break; // start of scan: no SOF found before it
    if (len < 2) return null;
    i += 2 + len;
  }
  // A JPEG we could not parse the SOF from is still a JPEG; dimensions unknown.
  return { mime: "image/jpeg", width: 0, height: 0 };
}

function gif(b: Uint8Array): ImageMeta | null {
  if (b.length < 10) return null;
  const head = ascii(b, 0, 6);
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  return { mime: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
}

function webp(b: Uint8Array): ImageMeta | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
    const width = (((b1 & 0x3f) << 8) | b0) + 1;
    const height = (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)) + 1;
    return { mime: "image/webp", width, height };
  }
  if (chunk === "VP8X") {
    return { mime: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return { mime: "image/webp", width: 0, height: 0 };
}

/** Sniff a supported image by magic bytes; null when the bytes are not one. */
export function detectImage(bytes: Uint8Array): ImageMeta | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}

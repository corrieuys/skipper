import { describe, it, expect } from "bun:test";
import { detectImage } from "./image-meta";
import { gifBytes, jpegBytes, pngBytes, webpBytes } from "./image-fixtures";

describe("detectImage", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(detectImage(pngBytes(2048, 1536))).toEqual({ mime: "image/png", width: 2048, height: 1536 });
  });

  it("reads JPEG dimensions from the SOF0 segment", () => {
    expect(detectImage(jpegBytes(640, 480))).toEqual({ mime: "image/jpeg", width: 640, height: 480 });
  });

  it("reads GIF and WebP (VP8X) dimensions", () => {
    expect(detectImage(gifBytes(12, 34))).toEqual({ mime: "image/gif", width: 12, height: 34 });
    expect(detectImage(webpBytes(300, 200))).toEqual({ mime: "image/webp", width: 300, height: 200 });
  });

  it("returns null for non-image bytes", () => {
    expect(detectImage(new TextEncoder().encode("%PDF-1.4 hello"))).toBeNull();
    expect(detectImage(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

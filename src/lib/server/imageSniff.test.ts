import { describe, expect, it } from 'vitest';
import { readImageSize, sniffImageType } from './imageSniff';

const bytes = (...parts: (number | number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'number' ? [p] : typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
  );
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, n >> 8];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

// JPEG with an APP0 (JFIF) and an APP1 (EXIF) segment before the SOF0, like a real camera file.
function jpeg(width: number, height: number, sof = 0xc0) {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], be16(16), 'JFIF\0', [1, 1, 0], be16(1), be16(1), [0, 0],
    [0xff, 0xe1], be16(10), 'Exif\0\0', [0, 0],
    [0xff, sof], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9]
  );
}

function png(width: number, height: number) {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
}

function webpLossy(width: number, height: number) {
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [10, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(width), le16(height), [0, 0, 0, 0]);
}

function webpLossless(width: number, height: number) {
  const w = width - 1;
  const h = height - 1;
  // 14 bits of width-1 then 14 bits of height-1, packed little endian into 4 bytes.
  const packed = (w & 0x3fff) | ((h & 0x3fff) << 14);
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [5, 0, 0, 0], [0x2f], le16(packed & 0xffff), le16(packed >>> 16), [0, 0, 0, 0]);
}

function webpExtended(width: number, height: number) {
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0, 0], le24(width - 1), le24(height - 1), [0, 0, 0, 0]);
}

describe('sniffImageType', () => {
  it('recognises JPEG, PNG and WebP by magic bytes', () => {
    expect(sniffImageType(jpeg(10, 10))).toBe('jpeg');
    expect(sniffImageType(png(10, 10))).toBe('png');
    expect(sniffImageType(webpLossy(10, 10))).toBe('webp');
  });
  it('rejects SVG, HTML, junk and empty input', () => {
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(bytes('<!DOCTYPE html><html></html>'))).toBeNull();
    expect(sniffImageType(bytes('GIF89a....'))).toBeNull();
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('readImageSize', () => {
  it('reads a JPEG SOF0 after APP0 and EXIF segments', () => {
    expect(readImageSize(jpeg(4972, 3217))).toEqual({ width: 4972, height: 3217 });
  });
  it('reads a progressive JPEG (SOF2)', () => {
    expect(readImageSize(jpeg(640, 480, 0xc2))).toEqual({ width: 640, height: 480 });
  });
  it('reads PNG IHDR', () => {
    expect(readImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });
  it('reads WebP VP8, VP8L and VP8X', () => {
    expect(readImageSize(webpLossy(5000, 3000))).toEqual({ width: 5000, height: 3000 });
    expect(readImageSize(webpLossless(1234, 987))).toEqual({ width: 1234, height: 987 });
    expect(readImageSize(webpLossless(16384, 16384))).toEqual({ width: 16384, height: 16384 });
    expect(readImageSize(webpExtended(6000, 4000))).toEqual({ width: 6000, height: 4000 });
  });
  it('gives null for junk, SVG and HTML', () => {
    expect(readImageSize(bytes('<svg></svg>'))).toBeNull();
    expect(readImageSize(bytes('<html><body>hi</body></html>'))).toBeNull();
    expect(readImageSize(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull();
  });
  it('gives null for truncated files', () => {
    expect(readImageSize(jpeg(100, 100).slice(0, 12))).toBeNull();
    expect(readImageSize(jpeg(100, 100).slice(0, 2))).toBeNull();
    expect(readImageSize(png(100, 100).slice(0, 20))).toBeNull();
    expect(readImageSize(webpLossy(100, 100).slice(0, 25))).toBeNull();
  });
  it('terminates on JPEG fill bytes, and on a short length at the end of the buffer', () => {
    // Fill bytes (extra FF) before the SOF0 marker are skipped.
    const filled = bytes([0xff, 0xd8], [0xff, 0xff, 0xff, 0xc0], be16(17), [8], be16(50), be16(60), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    expect(readImageSize(filled)).toEqual({ width: 60, height: 50 });
    // Only fill bytes to the end of the buffer.
    expect(readImageSize(bytes([0xff, 0xd8, 0xff], new Array(40).fill(0xff)))).toBeNull();
    // A segment whose length is below 2, and one that runs past the end of the buffer.
    expect(readImageSize(bytes([0xff, 0xd8], [0xff, 0xe0], be16(1), [0, 0]))).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8], [0xff, 0xe0], be16(60000), [0, 0]))).toBeNull();
    // Marker at the very end with no length bytes.
    expect(readImageSize(bytes([0xff, 0xd8], [0xff, 0xe0, 0x00]))).toBeNull();
  });
  it('gives null for a PNG with no IHDR, a JPEG with no frame header and a zero-sized image', () => {
    const noIhdr = png(10, 10);
    noIhdr[12] = 0x58;
    expect(readImageSize(noIhdr)).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8, 0xff, 0xe0], be16(4), [0, 0], [0xff, 0xd9]))).toBeNull();
    expect(readImageSize(png(0, 10))).toBeNull();
  });
});

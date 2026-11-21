// Pure image header sniffing for uploads: what is this buffer really, and how big? The declared
// content type and file name are never trusted. Reads headers only, never decodes pixels.
// Supports JPEG, PNG and WebP; anything else (SVG, HTML, junk, truncated files) gives null.

export type SniffedType = 'jpeg' | 'png' | 'webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Uint8Array, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

// Magic bytes only: JPEG FF D8 FF, PNG 89 'PNG', WebP 'RIFF' .... 'WEBP'.
export function sniffImageType(buf: Uint8Array): SniffedType | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, PNG_SIGNATURE.slice(0, 4))) return 'png';
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'webp';
  return null;
}

// Pixel size from the header, or null if the type is unknown or the header is truncated/invalid.
export function readImageSize(buf: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(buf);
  const size = type === 'jpeg' ? jpegSize(buf) : type === 'png' ? pngSize(buf) : type === 'webp' ? webpSize(buf) : null;
  if (!size || size.width < 1 || size.height < 1) return null;
  return size;
}

function u16be(buf: Uint8Array, o: number): number {
  return (buf[o] << 8) | buf[o + 1];
}
function u32be(buf: Uint8Array, o: number): number {
  return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
}
function u24le(buf: Uint8Array, o: number): number {
  return buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
}

// PNG: 8 byte signature, then the IHDR chunk (length, 'IHDR', width, height).
function pngSize(buf: Uint8Array) {
  if (!startsWith(buf, PNG_SIGNATURE) || buf.length < 24 || !ascii(buf, 12, 'IHDR')) return null;
  return { width: u32be(buf, 16), height: u32be(buf, 20) };
}

// JPEG: walk the marker segments until a start-of-frame (SOF0-SOF15, bar DHT/JPG/DAC) and read the
// height and width from it. APPn/EXIF segments before it are skipped by their length.
function jpegSize(buf: Uint8Array) {
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    let marker = buf[pos + 1];
    // Fill bytes: any number of 0xFF before the marker code.
    while (marker === 0xff && pos + 2 < buf.length) {
      pos++;
      marker = buf[pos + 1];
    }
    // Markers with no length: standalone (TEM, RSTn, SOI, EOI).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) return null;
    const length = u16be(buf, pos + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // Segment: length(2) precision(1) height(2) width(2)
      if (pos + 9 > buf.length) return null;
      return { width: u16be(buf, pos + 7), height: u16be(buf, pos + 5) };
    }
    // 0xDA (start of scan) before any frame header means a broken file.
    if (marker === 0xda) return null;
    pos += 2 + length;
  }
  return null;
}

// WebP: RIFF container; the first chunk is 'VP8 ' (lossy), 'VP8L' (lossless) or 'VP8X' (extended).
function webpSize(buf: Uint8Array) {
  if (buf.length < 16) return null;
  const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    // Canvas width-1 and height-1 as 24-bit little endian at offsets 24 and 27.
    return { width: u24le(buf, 24) + 1, height: u24le(buf, 27) + 1 };
  }
  if (chunk === 'VP8L') {
    // Signature byte 0x2F at 20, then 14 bits of width-1 and 14 bits of height-1, little endian.
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes) then start code 9D 01 2A at 23, then 14-bit width and height (little endian).
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: (buf[26] | (buf[27] << 8)) & 0x3fff, height: (buf[28] | (buf[29] << 8)) & 0x3fff };
  }
  return null;
}

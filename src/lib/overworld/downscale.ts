// Browser-side downscaling for map uploads, so a huge source file never reaches the server.
// `targetSize` is pure and unit tested; `prepareMapImage` uses canvas and only runs in a browser
// (it is wired into the upload form in Unit C).
import { CLIENT_MAX_EDGE, CLIENT_MAX_PIXELS } from './palette';

export type TargetSize = { width: number; height: number; scaled: boolean };

// The size to resize to: no bigger than maxEdge on the long side and maxPixels in total, never
// upscaled, aspect ratio kept, rounded down. The pixel cap matters because iOS limits a canvas to
// about 16.7 MP, and a square 5000 x 5000 would be 25 MP.
export function targetSize(
  width: number,
  height: number,
  limits: { maxEdge?: number; maxPixels?: number } = {}
): TargetSize {
  const maxEdge = limits.maxEdge ?? CLIENT_MAX_EDGE;
  const maxPixels = limits.maxPixels ?? CLIENT_MAX_PIXELS;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new RangeError('Image size must be positive.');
  }
  const factor = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (factor >= 1) return { width, height, scaled: false };
  return {
    width: Math.max(1, Math.floor(width * factor)),
    height: Math.max(1, Math.floor(height * factor)),
    scaled: true
  };
}

// width/height are the size being uploaded; originalWidth/originalHeight are the picked file's own size.
export type PreparedImage = {
  blob: Blob;
  width: number;
  height: number;
  type: string;
  originalWidth: number;
  originalHeight: number;
};

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// A JPEG or WebP already inside the limits and smaller than this goes up untouched.
const UNTOUCHED_MAX_BYTES = 8 * 1024 * 1024;
const QUALITY = 0.85;

// A decoded image we can read the size of and draw from, whichever way the browser decoded it.
type Decoded = { width: number; height: number; source: CanvasImageSource; close: () => void };

async function decode(file: File): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
  } catch {
    // Fall back to an <img> element (older browsers).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

// Check the file type, decode it, and resize/re-encode it if it is over the limits.
// Throws an Error whose message is fit to show to the user.
export async function prepareMapImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('Use a JPEG, PNG or WebP image.');

  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error('This image is too big for this device to resize. Try uploading it from a computer.');
  }

  try {
    const target = targetSize(decoded.width, decoded.height);

    // Already fine: don't re-encode (and lose quality) for nothing.
    if (!target.scaled && file.type !== 'image/png' && file.size <= UNTOUCHED_MAX_BYTES) {
      return { blob: file, width: decoded.width, height: decoded.height, type: file.type, originalWidth: decoded.width, originalHeight: decoded.height };
    }

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This image is too big for this device to resize. Try uploading it from a computer.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

    // Prefer WebP; Safari quietly hands back a PNG for it, so check what we actually got.
    let blob = await toBlob(canvas, 'image/webp');
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg');
    if (!blob) throw new Error('This image is too big for this device to resize. Try uploading it from a computer.');
    return { blob, width: target.width, height: target.height, type: blob.type, originalWidth: decoded.width, originalHeight: decoded.height };
  } finally {
    decoded.close();
  }
}

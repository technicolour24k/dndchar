import { error } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { resolveTokenLibraryPath } from '$vtt/tokenLibrary.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg'
};

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.ogv']);

function streamBody(filePath: string, opts?: { start: number; end: number }) {
  return Readable.toWeb(createReadStream(filePath, opts)) as ReadableStream;
}

// Range support, mirroring vtt/api/uploads/[filename] - animated library
// entries need <video> seeking/progressive playback the same way uploaded
// map/token videos do. Static image packs keep the plain full-buffer read
// they've always used; no need to touch that path for this.
async function getVideoResponse(resolved: string, mime: string, request: Request) {
  let size: number;
  try {
    size = (await fs.stat(resolved)).size;
  } catch {
    throw error(404, 'not_found');
  }

  const baseHeaders: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes'
  };

  const range = request.headers.get('range');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start: number;
    let end: number;
    if (match[1] !== '') {
      start = Number(match[1]);
      end = match[2] !== '' ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    return new Response(streamBody(resolved, { start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1)
      }
    });
  }

  return new Response(streamBody(resolved), {
    headers: { ...baseHeaders, 'content-length': String(size) }
  });
}

export async function GET({ params, request }) {
  const resolved = resolveTokenLibraryPath(params.path ?? '');
  if (!resolved) throw error(400, 'invalid_path');

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw error(400, 'invalid_path');

  if (VIDEO_EXT.has(ext)) return getVideoResponse(resolved, mime, request);

  try {
    const buffer = await fs.readFile(resolved);
    return new Response(buffer, {
      headers: {
        'content-type': mime,
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
  } catch {
    throw error(404, 'not_found');
  }
}

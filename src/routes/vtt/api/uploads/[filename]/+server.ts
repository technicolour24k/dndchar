import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'vtt-uploads');
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg'
};

function streamBody(filePath: string, opts?: { start: number; end: number }) {
  // Streamed rather than fs.readFile'd into one buffer: video map backgrounds
  // are tens of MB, and <video> elements expect Range requests to work.
  return Readable.toWeb(createReadStream(filePath, opts)) as ReadableStream;
}

export async function GET({ params, request }) {
  const filename = params.filename ?? '';
  // Reject anything that isn't a bare filename (blocks path traversal via ../).
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw error(400, 'invalid_filename');

  const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
  if (!mime) throw error(400, 'invalid_filename');

  const filePath = path.join(UPLOAD_DIR, filename);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw error(404, 'not_found');
  }

  const baseHeaders: Record<string, string> = {
    'content-type': mime,
    // Filenames are unique per upload (timestamp + random), so immutable is safe.
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes'
  };

  // Single-range support only ("bytes=start-end", "bytes=start-", or the
  // suffix form "bytes=-n") - that's all <video> seeking/progressive playback
  // needs. Anything else (multi-range, malformed) deliberately falls through
  // to a full 200, which RFC 9110 permits a server to do with any Range.
  const range = request.headers.get('range');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start: number;
    let end: number;
    if (match[1] !== '') {
      start = Number(match[1]);
      end = match[2] !== '' ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      // Suffix form: last n bytes.
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}` }
      });
    }
    return new Response(streamBody(filePath, { start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1)
      }
    });
  }

  return new Response(streamBody(filePath), {
    headers: { ...baseHeaders, 'content-length': String(size) }
  });
}

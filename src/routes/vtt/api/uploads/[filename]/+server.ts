import { error } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'vtt-uploads');
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

export async function GET({ params }) {
  const filename = params.filename ?? '';
  // Reject anything that isn't a bare filename (blocks path traversal via ../).
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) throw error(400, 'invalid_filename');

  const mime = MIME_BY_EXT[path.extname(filename).toLowerCase()];
  if (!mime) throw error(400, 'invalid_filename');

  try {
    const buffer = await fs.readFile(path.join(UPLOAD_DIR, filename));
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

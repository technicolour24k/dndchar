import { error } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveTokenLibraryPath } from '$vtt/tokenLibrary.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

export async function GET({ params }) {
  const resolved = resolveTokenLibraryPath(params.path ?? '');
  if (!resolved) throw error(400, 'invalid_path');

  const mime = MIME_BY_EXT[path.extname(resolved).toLowerCase()];
  if (!mime) throw error(400, 'invalid_path');

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

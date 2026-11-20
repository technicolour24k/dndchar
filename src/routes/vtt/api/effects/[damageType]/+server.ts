import { error } from '@sveltejs/kit';
import fs from 'node:fs/promises';
import { resolveEffectPath } from '$vtt/effectsLibrary.js';

export async function GET({ params }) {
  const resolved = resolveEffectPath(params.damageType ?? '');
  if (!resolved) throw error(400, 'invalid_damage_type');

  try {
    const buffer = await fs.readFile(resolved);
    return new Response(buffer, {
      headers: {
        'content-type': 'audio/mpeg',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
  } catch {
    throw error(404, 'not_found');
  }
}

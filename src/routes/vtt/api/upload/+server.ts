import { error, json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'vtt-uploads');
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_BYTES = 15 * 1024 * 1024;

// Lets the GM drop in a custom map background or token image on the fly
// instead of relying on a hardcoded URL. Saved to a runtime-writable
// directory (not `static/`, which is baked into the build) and served back
// via the sibling GET route.
export async function POST({ request }) {
  const formData = await request.formData();
  const file = formData.get('image');

  if (!(file instanceof File)) throw error(400, 'no_image');
  if (!file.type.startsWith('image/')) throw error(400, 'invalid_type');
  if (file.size > MAX_BYTES) throw error(400, 'file_too_large');

  const ext = ALLOWED_EXT.has(path.extname(file.name).toLowerCase())
    ? path.extname(file.name).toLowerCase()
    : '';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  return json({ url: `/vtt/api/uploads/${filename}` });
}

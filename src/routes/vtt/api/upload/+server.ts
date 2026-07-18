import { error, json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'vtt-uploads');
const ALLOWED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Lets the GM drop in a custom map background, token image, or ambient music
// track on the fly instead of relying on a hardcoded URL. Saved to a
// runtime-writable directory (not `static/`, which is baked into the build)
// and served back via the sibling GET route. Accepts either an "image" or
// "audio" form field so the one endpoint covers both upload flows.
export async function POST({ request }) {
  const formData = await request.formData();
  const imageFile = formData.get('image');
  const audioFile = formData.get('audio');
  const file = imageFile instanceof File ? imageFile : audioFile instanceof File ? audioFile : null;

  if (!file) throw error(400, 'no_file');

  const isImage = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  if (!isImage && !isAudio) throw error(400, 'invalid_type');

  const allowedExt = isImage ? ALLOWED_IMAGE_EXT : ALLOWED_AUDIO_EXT;
  if (file.size > (isImage ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) throw error(400, 'file_too_large');

  const ext = allowedExt.has(path.extname(file.name).toLowerCase())
    ? path.extname(file.name).toLowerCase()
    : '';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  return json({ url: `/vtt/api/uploads/${filename}` });
}

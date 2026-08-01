import { error, json } from '@sveltejs/kit';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'vtt-uploads');
const ALLOWED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a']);
const ALLOWED_VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.ogv']);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// One static cap for map backgrounds regardless of image vs video - a JPG
// scan/photo of a physical map can be just as large as a short video loop,
// so there's no reason to split these. Must stay under BODY_SIZE_LIMIT
// (server.js, now 65M to give this headroom) - adapter-node rejects larger
// bodies before this route ever runs, so a cap at or above that limit would
// be advertised-but-unreachable (the exact trap the original 512K default
// set for images, and which the old 20M limit set for 20-25MB audio).
const MAX_MAP_BYTES = 60 * 1024 * 1024;

// Lets the GM drop in a custom map background (image or looping video), token
// image, or ambient music track on the fly instead of relying on a hardcoded
// URL. Saved to a runtime-writable directory (not `static/`, which is baked
// into the build) and served back via the sibling GET route. The form field
// name ("image" / "audio" / "video") declares the media kind so each gets its
// own size cap.
export async function POST({ request }) {
  const formData = await request.formData();
  const imageFile = formData.get('image');
  const audioFile = formData.get('audio');
  const videoFile = formData.get('video');
  const file =
    imageFile instanceof File ? imageFile
    : audioFile instanceof File ? audioFile
    : videoFile instanceof File ? videoFile
    : null;

  if (!file) throw error(400, 'no_file');

  const isImage = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isAudio && !isVideo) throw error(400, 'invalid_type');

  const allowedExt = isImage ? ALLOWED_IMAGE_EXT : isAudio ? ALLOWED_AUDIO_EXT : ALLOWED_VIDEO_EXT;
  const maxBytes = isAudio ? MAX_AUDIO_BYTES : MAX_MAP_BYTES;
  if (file.size > maxBytes) throw error(400, 'file_too_large');

  const ext = allowedExt.has(path.extname(file.name).toLowerCase())
    ? path.extname(file.name).toLowerCase()
    : '';
  // The extension matters more for video than it used to for images: the
  // client decides <img> vs <video> by the served URL's extension (see
  // static/vtt-app/render/mapLayers.js isVideoUrl), and the GET route derives
  // content-type from it. A video with an unrecognized extension would save
  // but never play, so reject it outright instead.
  if (isVideo && !ext) throw error(400, 'invalid_extension');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, filename), Buffer.from(await file.arrayBuffer()));

  return json({ url: `/vtt/api/uploads/${filename}` });
}

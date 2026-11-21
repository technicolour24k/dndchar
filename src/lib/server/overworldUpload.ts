import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, SERVER_MAX_EDGE, SERVER_MAX_PIXELS } from '$lib/overworld/palette';
import { readImageSize, sniffImageType, type SniffedType } from '$lib/server/imageSniff';
import { OverworldError } from '$lib/server/overworldError';
import { overworldImageDir } from '$lib/server/uploadStorage';

// Validation and file handling for overworld map uploads. The database side lives in the service.
// Nothing the client declares is trusted beyond a first sanity check: the real type and size come
// from the file's own header bytes.

const DECLARED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT_BY_TYPE: Record<SniffedType, 'jpg' | 'png' | 'webp'> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const MIME_BY_TYPE: Record<SniffedType, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export type ValidatedImage = { buffer: Buffer; ext: 'jpg' | 'png' | 'webp'; width: number; height: number };

// Same shape as the migration's image_file CHECK: a bare file name.
const SAFE_FILE = /^[A-Za-z0-9._-]{1,100}$/;
export const isSafeImageFileName = (name: string) => SAFE_FILE.test(name) && !name.includes('..') && !name.startsWith('.');

/**
 * Checks a File from a multipart form: size, declared type, magic bytes and the pixel size read from
 * the header. The stored extension comes from the sniffed type, so a PNG declared as JPEG is stored
 * as .png. Throws OverworldError (bad_image / too_large) with a message fit to show.
 */
export async function validateUpload(file: unknown): Promise<ValidatedImage> {
  if (!(file instanceof File) || file.size === 0) throw new OverworldError('bad_image', 'Choose an image to upload.');
  if (file.size > MAX_UPLOAD_BYTES) throw new OverworldError('too_large', 'That image is over 15 MB. Resize it and try again.');
  if (!DECLARED_TYPES.includes(file.type)) throw new OverworldError('bad_image', 'Use a JPEG, PNG or WebP image.');

  const buffer = Buffer.from(await file.arrayBuffer());
  // Re-check on the real bytes (File.size is what the client claimed in the multipart part).
  if (buffer.length > MAX_UPLOAD_BYTES) throw new OverworldError('too_large', 'That image is over 15 MB. Resize it and try again.');

  const type = sniffImageType(buffer);
  if (!type) throw new OverworldError('bad_image', 'Use a JPEG, PNG or WebP image.');
  const size = readImageSize(buffer);
  if (!size) throw new OverworldError('bad_image', 'That image could not be read.');
  if (Math.max(size.width, size.height) > SERVER_MAX_EDGE || size.width * size.height > SERVER_MAX_PIXELS) {
    throw new OverworldError('too_large', 'That image is too many pixels across. Resize it and try again.');
  }
  return { buffer, ext: EXT_BY_TYPE[type], width: size.width, height: size.height };
}

/** Writes the image into the campaign's overworld folder (created if needed) and returns its file name. */
export async function writeImageFile(campaignId: string, image: ValidatedImage): Promise<string> {
  const dir = overworldImageDir(campaignId);
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${image.ext}`;
  try {
    await fs.writeFile(path.join(dir, fileName), image.buffer, { flag: 'wx' });
  } catch (error) {
    // A failure part-way (disk full...) can leave a partial file behind: remove it, then report.
    await removeImageFile(campaignId, fileName);
    throw error;
  }
  return fileName;
}

/** Best-effort delete: a leftover file is harmless, so this logs and never throws. */
export async function removeImageFile(campaignId: string, fileName: string): Promise<void> {
  if (!isSafeImageFileName(fileName)) return;
  try {
    await fs.unlink(path.join(overworldImageDir(campaignId), fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not delete overworld image', fileName, error);
  }
}

/** Writes the file, then runs `then(fileName)` (the database write). If that throws, the file is removed again. */
export async function storeImageThenRun<T>(
  campaignId: string,
  image: ValidatedImage,
  then: (fileName: string) => Promise<T>
): Promise<T> {
  const fileName = await writeImageFile(campaignId, image);
  try {
    return await then(fileName);
  } catch (error) {
    await removeImageFile(campaignId, fileName);
    throw error;
  }
}

/**
 * The content-type to serve a stored image with, taken from the file's own first bytes (never its
 * name). Null if the file is missing or is not a JPEG/PNG/WebP.
 */
export async function sniffHandleImageType(handle: FileHandle): Promise<string | null> {
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    const type = sniffImageType(head.subarray(0, bytesRead));
    return type ? MIME_BY_TYPE[type] : null;
  } catch {
    return null;
  }
}

export async function sniffStoredImageType(filePath: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    const type = sniffImageType(head.subarray(0, bytesRead));
    return type ? MIME_BY_TYPE[type] : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

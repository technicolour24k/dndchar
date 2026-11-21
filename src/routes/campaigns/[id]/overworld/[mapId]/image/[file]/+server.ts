import { error } from '@sveltejs/kit';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { getMapImageForViewer } from '$lib/server/services/overworld';
import { sniffHandleImageType } from '$lib/server/overworldUpload';

// GET /campaigns/<id>/overworld/<mapId>/image/<file>
//
// Serves a map's CURRENT image to a logged-in member who may see the map (the hooks redirect a
// logged-out request to login before it gets here). Everything else is a plain 404, so the URL
// reveals nothing: not a member (site admin or not), map not shared yet, archived map, wrong campaign,
// or a file name that is not the map's current image (e.g. the old one after a replace).
//
// The content-type is a fixed image/* taken from the file's own header bytes, never its name, and
// nosniff plus a locked-down CSP stop a browser treating it as anything else. The file name is unique
// per upload, so `immutable` is safe, and `private` keeps Cloudflare (which fronts the app) from
// caching it at the edge, which would let anyone with the URL skip the membership check.
//
// The file is opened ONCE: the type check and the streamed body use the same handle, so a replace
// that deletes the file mid-request cannot make the two disagree (the open handle keeps the bytes).
export const GET: RequestHandler = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) throw error(404, 'Not found');

  const filePath = await getMapImageForViewer(user.id, params.id, params.mapId, params.file);
  if (!filePath) throw error(404, 'Not found');

  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
  } catch {
    throw error(404, 'Not found');
  }

  try {
    const contentType = await sniffHandleImageType(handle);
    if (!contentType) throw error(404, 'Not found');
    const { size } = await handle.stat();

    // The stream owns the handle from here and closes it when it ends or fails.
    const body = Readable.toWeb(handle.createReadStream({ start: 0 })) as ReadableStream;
    handle = undefined;
    return new Response(body, {
      headers: {
        'content-type': contentType,
        'content-length': String(size),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=31536000, immutable'
      }
    });
  } finally {
    // Only still set if we bailed out before handing it to the stream.
    await handle?.close();
  }
};

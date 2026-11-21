import { fail, isRedirect, type ActionFailure } from '@sveltejs/kit';
import { OverworldError } from '$lib/server/overworldError';

// Runs an overworld service call inside a form action. OverworldErrors carry user-facing messages
// ("Only a DM can change this pin.") and become an inline form error; anything else is logged and
// shown as a generic message so raw error text never reaches the page. Same idea as
// campaignAction.ts's attempt().
const STATUS: Record<OverworldError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  limit: 400,
  invalid: 400,
  route_changed: 409,
  archived: 403,
  bad_image: 400,
  too_large: 413,
  length_required: 411
};

// Adds the map the action was about to a failure, so the page can show the message in that map's row.
export function withMapId(failure: ActionFailure<{ error: string }>, mapId: string) {
  return fail(failure.status, { ...failure.data, mapId });
}

export async function attemptOverworld<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<{ error: string }> }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof OverworldError) return { ok: false, failure: fail(STATUS[error.code], { error: error.message }) };
    console.error('[overworld] unexpected error', error);
    return { ok: false, failure: fail(500, { error: 'Something went wrong, please try again.' }) };
  }
}

// An upload request this big is refused before its body is read. The image limit is 15 MB; the extra
// covers the multipart framing and the other form fields.
export const MAX_UPLOAD_REQUEST_BYTES = 16 * 1024 * 1024 + 512 * 1024;
// The small forms (rename, share, hide...) are a few hundred bytes; anything near this is not one.
export const MAX_FORM_REQUEST_BYTES = 64 * 1024;

/**
 * Checks the DECLARED body size (the content-length header) before request.formData() is called.
 * Over the cap is 'too_large' (413). With `requireLength` a missing or non-numeric header is
 * 'length_required' (411): browsers always send it for the multipart Blob upload, so only odd clients
 * (chunked bodies) are turned away. This trusts the header; the server's BODY_SIZE_LIMIT (65 MB in
 * server.js) is the backstop for anything that lies or sends no length.
 */
export function assertDeclaredSize(request: Request, max: number, requireLength: boolean): void {
  const header = request.headers.get('content-length');
  const declared = header === null || header.trim() === '' ? NaN : Number(header);
  if (!Number.isFinite(declared) || declared < 0) {
    if (requireLength) throw new OverworldError('length_required', 'The upload needs a known size. Try again from the map page.');
    return;
  }
  if (declared > max) throw new OverworldError('too_large', 'That request is too big.');
}

/** Upload actions: length required, up to the image cap. */
export const assertUploadSizeDeclared = (request: Request) => assertDeclaredSize(request, MAX_UPLOAD_REQUEST_BYTES, true);

/** Small form actions: capped, so a huge body is never parsed. */
export const assertSmallFormDeclared = (request: Request) => assertDeclaredSize(request, MAX_FORM_REQUEST_BYTES, false);

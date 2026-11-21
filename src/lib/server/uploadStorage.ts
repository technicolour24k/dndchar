import path from 'node:path';
import { isUuid } from '$lib/server/services/access';

// Where uploaded files live on disk.
//
// UPLOAD_DIR (absolute path) is the storage root. In production it is /data/uploads, on the Railway
// volume mounted at /data, so files survive deploys. Locally it is unset and falls back to
// <cwd>/data. Overworld map images go under <root>/overworld/<campaignId>/.
//
// The older VTT battle-map uploads still use their own cwd-based folder and are NOT moved here.

let warnedAboutProductionDefault = false;

// Tests only: lets the "warns once" behaviour be checked more than once per process.
export function resetUploadDirWarning(): void {
  warnedAboutProductionDefault = false;
}

/** True when production is running without UPLOAD_DIR (uploads would be lost on the next deploy). */
export function uploadDirIsEphemeral(): boolean {
  return process.env.NODE_ENV === 'production' && !(process.env.UPLOAD_DIR ?? '').trim();
}

export function uploadDir(): string {
  const configured = (process.env.UPLOAD_DIR ?? '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`UPLOAD_DIR must be an absolute path (got "${configured}"), e.g. /data/uploads.`);
    }
    return configured;
  }
  if (uploadDirIsEphemeral() && !warnedAboutProductionDefault) {
    warnedAboutProductionDefault = true;
    console.warn('UPLOAD_DIR is not set: uploads are stored inside the container and will be lost on the next deploy.');
  }
  return path.join(process.cwd(), 'data');
}

/** <uploadDir>/overworld/<campaignId>. Only ever built from a real uuid, so it cannot escape the root. */
export function overworldImageDir(campaignId: string): string {
  if (!isUuid(campaignId)) throw new Error('Invalid campaign id for an overworld image folder.');
  return path.join(uploadDir(), 'overworld', campaignId);
}

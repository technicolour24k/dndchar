// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
//
// Indexes the bundled ambient tracks under assets/music/ so the GM can pick
// one when setting a map, mirroring how tokenLibrary.js exposes bundled
// token art. Kept outside static/ for the same reason as the token packs -
// runtime-served rather than baked into the build.
import fs from 'node:fs';
import path from 'node:path';

const MUSIC_ROOT = path.join(process.cwd(), 'assets', 'music');
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a']);

let cachedIndex = null;

// "victory_march_for_heroes.mp3" -> "Victory March For Heroes"
function toFriendlyName(filename) {
  return filename
    .replace(path.extname(filename), '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Lazily built once per process - fixed bundled art, nothing to invalidate
// short of a restart (same rationale as getTokenLibraryIndex).
export function getMusicLibraryIndex() {
  if (cachedIndex) return cachedIndex;

  let dirents;
  try {
    dirents = fs.readdirSync(MUSIC_ROOT, { withFileTypes: true });
  } catch {
    cachedIndex = [];
    return cachedIndex;
  }

  cachedIndex = dirents
    .filter((d) => d.isFile() && AUDIO_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => ({ filename: d.name, friendlyName: toFriendlyName(d.name) }))
    .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));

  return cachedIndex;
}

// Resolves a client-supplied filename to an on-disk file, rejecting anything
// that isn't a bare filename in MUSIC_ROOT (blocks path traversal). Real
// track titles routinely contain spaces/commas/parens/brackets (see
// toFriendlyName above), so the traversal guard has to be the resolved-path
// prefix check below, not a restrictive character allowlist - a strict
// regex here previously 400'd legitimate filenames like "Battle Against
// Unseen Forces (Calm Ver).ogg".
export function resolveMusicLibraryPath(filename) {
  if (!filename || filename.includes('/') || filename.includes('\\')) return null;
  const resolved = path.resolve(MUSIC_ROOT, filename);
  const rootWithSep = MUSIC_ROOT + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

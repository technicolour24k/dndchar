// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
//
// Indexes bundled attack/ambience clips under assets/creature-sounds/ - each
// top-level folder is a "creature type" (e.g. dragons/, goblins/) containing
// one or more clips, searched recursively through any subfolders too (e.g.
// dragons/red/roar1.mp3 and dragons/breath/fire1.ogg both count as "dragons"
// clips - subfolders are just organizational, not separate selectable
// types). Folder names double as both the value stored on a token's
// soundFolder field and the label shown in the GM's dropdown/soundboard,
// mirroring how musicLibrary.js/tokenLibrary.js expose their own bundled
// folders. A random file from a creature's folder plays whenever it attacks
// (see fx:play in handlers/token.js); the GM's soundboard lets any folder be
// triggered on demand via the same mechanism (soundboard:play).
import fs from 'node:fs';
import path from 'node:path';

const CREATURE_SOUNDS_ROOT = path.join(process.cwd(), 'assets', 'creature-sounds');
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a']);

let cachedFolders = null;
const cachedFilesByFolder = new Map(); // folder name -> string[] of paths relative to that folder

function isAudioFile(name) {
  return AUDIO_EXT.has(path.extname(name).toLowerCase());
}

// Lazily built once per process - fixed bundled folders, nothing to
// invalidate short of a restart (same rationale as getMusicLibraryIndex).
export function getCreatureSoundFolders() {
  if (cachedFolders) return cachedFolders;

  let dirents;
  try {
    dirents = fs.readdirSync(CREATURE_SOUNDS_ROOT, { withFileTypes: true });
  } catch {
    cachedFolders = [];
    return cachedFolders;
  }

  cachedFolders = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  return cachedFolders;
}

function isKnownFolder(folder) {
  return getCreatureSoundFolders().includes(folder);
}

// Recursively collects audio files under `dir`, returning each as a path
// relative to `folderRoot` with forward slashes (so it works directly as a
// URL path segment regardless of OS) - same recursive-walk shape as
// tokenLibrary.js's walk(), just without the source/category split token
// packs need.
function walkAudioFiles(dir, folderRoot, entries) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    const full = path.join(dir, dirent.name);

    if (dirent.isDirectory()) {
      walkAudioFiles(full, folderRoot, entries);
      continue;
    }

    if (!dirent.isFile() || !isAudioFile(dirent.name)) continue;
    entries.push(path.relative(folderRoot, full).split(path.sep).join('/'));
  }
}

// Lists every clip inside a folder, including subfolders - used by the
// soundboard to pick a specific clip rather than a random one. Rejects
// unknown folder names (also closes off path traversal, same guard as
// resolveCreatureSoundPath). Cached per folder - fixed bundled content,
// nothing to invalidate short of a restart.
export function getCreatureSoundFiles(folder) {
  if (!isKnownFolder(folder)) return [];
  if (cachedFilesByFolder.has(folder)) return cachedFilesByFolder.get(folder);

  const folderRoot = path.join(CREATURE_SOUNDS_ROOT, folder);
  const entries = [];
  walkAudioFiles(folderRoot, folderRoot, entries);
  entries.sort((a, b) => a.localeCompare(b));

  cachedFilesByFolder.set(folder, entries);
  return entries;
}

// Picks one random clip from a folder (any subfolder included) - the server
// does the picking (rather than the client) so every client in a broadcast
// hears the same clip. Returns null if the folder is unknown or empty.
export function pickRandomCreatureSoundFile(folder) {
  const files = getCreatureSoundFiles(folder);
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

// Resolves a client-supplied folder + relative-path-within-folder (which may
// itself contain subfolder segments, e.g. "red/roar1.mp3") to an on-disk
// file, rejecting anything that isn't a known folder + a path that stays
// inside it (blocks path traversal). Real clip/subfolder names can contain
// spaces/commas/parens same as the music library, so the traversal guard is
// the resolved-path prefix check below, not a restrictive character
// allowlist (see musicLibrary.js's resolveMusicLibraryPath for the same
// fix/rationale).
export function resolveCreatureSoundPath(folder, relativeFilePath) {
  if (!isKnownFolder(folder) || !relativeFilePath) return null;
  const folderRoot = path.join(CREATURE_SOUNDS_ROOT, folder);
  const resolved = path.resolve(folderRoot, relativeFilePath);
  const folderWithSep = folderRoot + path.sep;
  if (!resolved.startsWith(folderWithSep)) return null;
  return resolved;
}

// Builds the URL a client should fetch to play a given clip - each path
// segment is percent-encoded individually (not the path as a whole, which
// would turn its "/" separators into "%2F" and break the [...rest] route
// below), same approach as tokenLibrary's libraryImageUrl in main.js.
export function creatureSoundUrl(folder, relativeFilePath) {
  const encodedFolder = encodeURIComponent(folder);
  const encodedPath = relativeFilePath.split('/').map(encodeURIComponent).join('/');
  return `/vtt/api/creature-sounds/${encodedFolder}/${encodedPath}`;
}

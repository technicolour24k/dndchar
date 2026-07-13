// @ts-nocheck — plain untyped JS by design, see vtt/README.md.
//
// Indexes the bundled Forgotten Adventures token art (assets/images/
// Forgotten_Adventures_Tokens/) so the GM can browse/search it in the token
// picker instead of only uploading custom art. This folder lives outside
// static/ on purpose — at ~700MB it shouldn't be baked into the production
// build — so it's served at runtime the same way vtt-uploads is.
import fs from 'node:fs';
import path from 'node:path';

const LIBRARY_ROOT = path.join(process.cwd(), 'assets', 'images', 'Forgotten_Adventures_Tokens');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

let cachedIndex = null;

// "Elf_Archfey_Warlock_A1_Staff_Magic_01.png" -> "Elf Archfey Warlock A1 Staff Magic 01"
function toFriendlyName(filename) {
  const base = filename.replace(path.extname(filename), '');
  return base
    .replace(/^!+/, '') // sort-priority prefixes like !Core_Barbarian_...
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function walk(dir, relativeSegments, category, entries) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;

    if (dirent.isDirectory()) {
      walk(path.join(dir, dirent.name), [...relativeSegments, dirent.name], category, entries);
      continue;
    }

    if (!IMAGE_EXT.has(path.extname(dirent.name).toLowerCase())) continue;

    entries.push({
      path: [...relativeSegments, dirent.name].join('/'),
      category,
      friendlyName: toFriendlyName(dirent.name),
    });
  }
}

// Lazily built once per process — this is a fixed set of bundled art, not
// user content, so there's nothing to invalidate short of a restart.
export function getTokenLibraryIndex() {
  if (cachedIndex) return cachedIndex;

  const entries = [];
  let topLevel;
  try {
    topLevel = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });
  } catch {
    cachedIndex = [];
    return cachedIndex;
  }

  for (const dirent of topLevel) {
    if (!dirent.isDirectory()) continue;
    const category = dirent.name.replace(/^!+/, '');
    walk(path.join(LIBRARY_ROOT, dirent.name), [dirent.name], category, entries);
  }

  entries.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
  cachedIndex = entries;
  return cachedIndex;
}

// Resolves a client-supplied relative path to an on-disk file, rejecting
// anything that would escape LIBRARY_ROOT (path traversal).
export function resolveTokenLibraryPath(relativePath) {
  const resolved = path.resolve(LIBRARY_ROOT, relativePath);
  const rootWithSep = LIBRARY_ROOT + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

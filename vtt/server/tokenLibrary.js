// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
//
// Indexes token art bundled under assets/images/tokens/ so the GM/players can
// browse/search it in the token picker instead of only uploading custom art.
// Each top-level folder in there is treated as its own "source" pack - e.g.
// Forgotten_Adventures_Tokens/ - whose (prettified) folder name doubles as
// both the picker's source filter and credit to whoever made it. Kept
// separate from the rest of assets/images/ (which holds unrelated one-off UI
// icons) and outside static/ on purpose - these packs run into the hundreds
// of MB, which shouldn't be baked into the production build - so it's served
// at runtime the same way vtt-uploads is.
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_PACKS_ROOT = path.join(process.cwd(), 'assets', 'images', 'tokens');
// Phase 11: some packs (e.g. HoloHeroes_AnimatedTokens_Tokens) ship .webm
// alongside their static art - without these extensions here, the indexer
// silently skips every animated file and the picker never lists them.
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.m4v', '.webm', '.ogv']);

let cachedIndex = null;

function titleCaseWords(str) {
  return str
    .replace(/^!+/, '') // sort-priority prefixes like !Core_Adventurers
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

// "Elf_Archfey_Warlock_A1_Staff_Magic_01.png" -> "Elf Archfey Warlock A1 Staff Magic 01"
function toFriendlyName(filename) {
  return titleCaseWords(filename.replace(path.extname(filename), '')).join(' ');
}

// "Forgotten_Adventures_Tokens" -> "Forgotten Adventures" (a trailing "Tokens"
// is just generic labeling, not part of the pack's identity/credit)
function toFriendlySourceName(folderName) {
  const words = titleCaseWords(folderName);
  if (words.length > 1 && words[words.length - 1].toLowerCase() === 'tokens') words.pop();
  return words.join(' ');
}

function walk(dir, relativeSegments, source, category, entries) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;

    if (dirent.isDirectory()) {
      walk(path.join(dir, dirent.name), [...relativeSegments, dirent.name], source, category, entries);
      continue;
    }

    if (!MEDIA_EXT.has(path.extname(dirent.name).toLowerCase())) continue;

    entries.push({
      path: [...relativeSegments, dirent.name].join('/'),
      source,
      category,
      friendlyName: toFriendlyName(dirent.name),
    });
  }
}

// Lazily built once per process - this is a fixed set of bundled art, not
// user content, so there's nothing to invalidate short of a restart.
export function getTokenLibraryIndex() {
  if (cachedIndex) return cachedIndex;

  const entries = [];
  let packDirs;
  try {
    packDirs = fs.readdirSync(TOKEN_PACKS_ROOT, { withFileTypes: true });
  } catch {
    cachedIndex = [];
    return cachedIndex;
  }

  for (const packDirent of packDirs) {
    if (!packDirent.isDirectory() || packDirent.name.startsWith('.')) continue;
    const source = toFriendlySourceName(packDirent.name);
    const packRoot = path.join(TOKEN_PACKS_ROOT, packDirent.name);

    let categoryDirs;
    try {
      categoryDirs = fs.readdirSync(packRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const categoryDirent of categoryDirs) {
      if (!categoryDirent.isDirectory() || categoryDirent.name.startsWith('.')) continue;
      const category = categoryDirent.name.replace(/^!+/, '');
      walk(
        path.join(packRoot, categoryDirent.name),
        [packDirent.name, categoryDirent.name],
        source,
        category,
        entries,
      );
    }
  }

  entries.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
  cachedIndex = entries;
  return cachedIndex;
}

// Resolves a client-supplied relative path to an on-disk file, rejecting
// anything that would escape TOKEN_PACKS_ROOT (path traversal).
export function resolveTokenLibraryPath(relativePath) {
  const resolved = path.resolve(TOKEN_PACKS_ROOT, relativePath);
  const rootWithSep = TOKEN_PACKS_ROOT + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

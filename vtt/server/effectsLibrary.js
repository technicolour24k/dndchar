// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
//
// Resolves a damage-type name to its bundled hit-sound under assets/effects/,
// played on every client when an attack/spell lands (see 'fx:play' in
// wsServer.js). Unlike tokenLibrary/musicLibrary this isn't user-browsable -
// there's exactly one file per known damage type, chosen automatically - so
// there's no index, just a fixed allowlist doubling as the traversal guard.
import path from 'node:path';

const EFFECTS_ROOT = path.join(process.cwd(), 'assets', 'effects');
const DAMAGE_TYPES = new Set(['bludgeoning', 'piercing', 'slashing', 'magic']);

export function resolveEffectPath(damageType) {
  if (!DAMAGE_TYPES.has(damageType)) return null;
  return path.join(EFFECTS_ROOT, `${damageType}.mp3`);
}

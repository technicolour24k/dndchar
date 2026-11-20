import { query } from '$lib/server/db';

export type CreatureTemplate = {
  id: string;
  name: string;
  tokenJson: Record<string, unknown>;
};

type CreatureTemplateRow = {
  id: string;
  name: string;
  token_json: Record<string, unknown>;
};

// Scoped to the saving GM's own account, same as characters - a small
// trusted group may have more than one GM, each with their own creature
// library, rather than one shared global list.
export async function listCreatureTemplates(ownerUserId: string): Promise<CreatureTemplate[]> {
  const result = await query<CreatureTemplateRow>(
    `SELECT id, name, token_json FROM creature_templates WHERE owner_user_id = $1 ORDER BY name ASC`,
    [ownerUserId]
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, tokenJson: row.token_json }));
}

export async function createCreatureTemplate(
  ownerUserId: string,
  name: string,
  tokenJson: Record<string, unknown>
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO creature_templates (owner_user_id, name, token_json) VALUES ($1, $2, $3) RETURNING id`,
    [ownerUserId, name, JSON.stringify(tokenJson)]
  );
  return result.rows[0].id;
}

// Scoped by owner in the WHERE clause (not a separate ownership check) so a
// mismatched id/owner pair just deletes nothing rather than needing a
// separate 403 path.
export async function deleteCreatureTemplate(ownerUserId: string, id: string): Promise<void> {
  await query(`DELETE FROM creature_templates WHERE id = $1 AND owner_user_id = $2`, [id, ownerUserId]);
}

// ---------------------------------------------------------------------------
// Editing (the /creatures page). Only the fields the VTT actually reads when it
// spawns a template are editable - these names match the token_json that the
// VTT's saveTokenAsTemplate() writes (static/vtt-app/main.js): `ac`,
// `stats.hp`, `stats.maxHp`, `speedFt`, `visionNormalFt`, `visionDarkFt`.
// Creating templates and editing their actions stays in the VTT.
// ---------------------------------------------------------------------------

export const TEMPLATE_NAME_MAX = 80;
const NUMBER_MAX = 999;
const HP_MAX = 9999;

// What the form is allowed to change. Absent keys mean "leave as it is".
// `ac: null` is a real value - the VTT treats a null AC as "unknown".
export type TemplatePatch = {
  name?: string;
  ac?: number | null;
  speedFt?: number;
  visionNormalFt?: number;
  visionDarkFt?: number;
  stats?: { hp?: number; maxHp?: number };
};

// Anything with a FormData-style get() works, so this stays testable without a browser.
type FormLike = { get(key: string): unknown };

// A whole number from a form field, clamped to 0..max. Blank or non-numeric gives null
// (callers treat that as "don't touch this field").
function clampedInt(raw: unknown, max: number): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(0, Math.round(n)));
}

// Pure: turns raw form values into a safe patch. Unknown fields are never read, so they can't
// reach token_json. A blank AC clears it to null (unknown), matching the VTT; any other blank
// or invalid number is simply left unchanged.
export function sanitiseTemplatePatch(form: FormLike): TemplatePatch {
  const patch: TemplatePatch = {};

  const name = form.get('name');
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, TEMPLATE_NAME_MAX);

  const acRaw = form.get('ac');
  if (typeof acRaw === 'string') {
    if (acRaw.trim() === '') patch.ac = null;
    else {
      const ac = clampedInt(acRaw, NUMBER_MAX);
      if (ac !== null) patch.ac = ac;
    }
  }

  for (const key of ['speedFt', 'visionNormalFt', 'visionDarkFt'] as const) {
    const value = clampedInt(form.get(key), NUMBER_MAX);
    if (value !== null) patch[key] = value;
  }

  const hp = clampedInt(form.get('hp'), HP_MAX);
  const maxHp = clampedInt(form.get('maxHp'), HP_MAX);
  if (hp !== null || maxHp !== null) {
    patch.stats = {};
    if (hp !== null) patch.stats.hp = hp;
    if (maxHp !== null) patch.stats.maxHp = maxHp;
  }

  return patch;
}

// Pure: the jsonb fragment to merge into token_json. `stats` is merged into the existing
// stats object here (a plain `||` would replace it wholesale and lose any other keys).
export function buildTokenJsonPatch(existing: Record<string, unknown>, patch: TemplatePatch): Record<string, unknown> {
  const { name: _name, stats, ...rest } = patch;
  const out: Record<string, unknown> = { ...rest };
  if (stats) {
    const oldStats = existing.stats && typeof existing.stats === 'object' ? (existing.stats as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...oldStats, ...stats };
    // HP above max is almost always a typo here (HP 70 for a max of 7), so cap it at max.
    if (typeof merged.hp === 'number' && typeof merged.maxHp === 'number' && merged.hp > merged.maxHp) merged.hp = merged.maxHp;
    out.stats = merged;
  }
  return out;
}

// Returns false when no template matched (wrong id, or not the caller's). Owner-scoped in the
// WHERE clause, same as delete. Read-then-write is fine here: one GM editing their own list.
export async function updateCreatureTemplate(ownerUserId: string, id: string, patch: TemplatePatch): Promise<boolean> {
  const current = await query<{ token_json: Record<string, unknown> }>(
    `SELECT token_json FROM creature_templates WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId]
  );
  if (current.rows.length === 0) return false;

  const tokenPatch = buildTokenJsonPatch(current.rows[0].token_json ?? {}, patch);
  const result = await query(
    `UPDATE creature_templates
        SET name = COALESCE($3, name), token_json = token_json || $4::jsonb, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId, patch.name ?? null, JSON.stringify(tokenPatch)]
  );
  return (result.rowCount ?? 0) > 0;
}

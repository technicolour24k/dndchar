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

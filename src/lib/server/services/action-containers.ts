import type pg from 'pg';

// Shared by the admin and catalogue action writers. An item's action is a content_definitions row
// (content_type='action'), keyed 'action:content:<contentId>:<trigger>'. Older rows made by
// catalogue.ts used the bare 'content:<contentId>:<trigger>' key, so both are matched and the
// prefixed form is only inserted when neither exists.
export async function findOrCreateActionContainer(
  client: pg.PoolClient,
  contentId: string,
  trigger: string,
  name: string,
  description: string,
  // Kept so callers don't change; the owner now always comes from the parent content (see the insert below).
  _ownerUserId: string | null
): Promise<string> {
  const prefixed = `action:content:${contentId}:${trigger}`;
  const bare = `content:${contentId}:${trigger}`;
  // An archived match is un-archived rather than ignored: ignoring it would collide on the unique key.
  const find = () => client.query<{ id: string; is_archived: boolean }>(
    `SELECT id, is_archived FROM content_definitions WHERE content_type='action' AND content_key IN ($1,$2)
     ORDER BY (content_key=$1) DESC LIMIT 1`, [prefixed, bare]);
  // A per-content action container is only ever reused here when someone is attaching an action to
  // that same content, so an archived one is brought back (its old steps come back with it) rather
  // than failing on the unique content key. No UI archives these auto-created containers today.
  const reuse = async (row: { id: string; is_archived: boolean }) => {
    if (row.is_archived) await client.query('UPDATE content_definitions SET is_archived=false, updated_at=now() WHERE id=$1', [row.id]);
    return row.id;
  };
  const found = await find();
  if (found.rowCount) return reuse(found.rows[0]);
  // Race-safe: a concurrent insert of the same key makes this a no-op, and we re-select.
  // Homebrew library: an action container is never offered on its own, so it inherits its parent's scope, owner and
  // campaign. That keeps a personal entry's action personal (and out of everyone else's pickers).
  const created = await client.query<{ id: string }>(
    `INSERT INTO content_definitions(content_key,content_type,name,description,source_kind,owner_user_id,activation_type,scope,campaign_id)
     SELECT $1,'action',$2,$3,'homebrew',parent.owner_user_id,'active_use',parent.scope,parent.campaign_id
     FROM content_definitions parent WHERE parent.id=$4 ON CONFLICT DO NOTHING RETURNING id`,
    [prefixed, name, description, contentId]);
  if (created.rowCount) return created.rows[0].id;
  const again = await find();
  if (!again.rowCount) throw new Error('Could not create the action container.');
  return reuse(again.rows[0]);
}

// Links an action container to content (idempotent on content + container + trigger).
export async function linkActionContainer(client: pg.PoolClient, contentId: string, containerId: string, trigger: string): Promise<void> {
  await client.query(
    `INSERT INTO content_action_links(content_id,action_container_id,trigger_type) VALUES($1,$2,$3)
     ON CONFLICT(content_id,action_container_id,trigger_type) DO NOTHING`, [contentId, containerId, trigger]);
}

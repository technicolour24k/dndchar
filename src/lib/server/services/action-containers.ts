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
  ownerUserId: string | null
): Promise<string> {
  const prefixed = `action:content:${contentId}:${trigger}`;
  const bare = `content:${contentId}:${trigger}`;
  const found = await client.query<{ id: string }>(
    `SELECT id FROM content_definitions WHERE content_type='action' AND content_key IN ($1,$2)
     ORDER BY (content_key=$1) DESC LIMIT 1`, [prefixed, bare]);
  if (found.rowCount) return found.rows[0].id;
  const created = await client.query<{ id: string }>(
    `INSERT INTO content_definitions(content_key,content_type,name,description,source_kind,owner_user_id,activation_type)
     VALUES($1,'action',$2,$3,'homebrew',$4,'active_use') RETURNING id`,
    [prefixed, name, description, ownerUserId]);
  return created.rows[0].id;
}

// Links an action container to content (idempotent on content + container + trigger).
export async function linkActionContainer(client: pg.PoolClient, contentId: string, containerId: string, trigger: string): Promise<void> {
  await client.query(
    `INSERT INTO content_action_links(content_id,action_container_id,trigger_type) VALUES($1,$2,$3)
     ON CONFLICT(content_id,action_container_id,trigger_type) DO NOTHING`, [contentId, containerId, trigger]);
}

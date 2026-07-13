import type pg from 'pg';

export type EffectApplicationResult = { status: 'applied' | 'refreshed' | 'stacked' | 'rejected'; effectId: string; name: string };
export function effectApplicationDecision(hasExisting:boolean,behavior:'refresh'|'stack'|'reject'){
  if(!hasExisting)return'applied' as const;
  return behavior==='refresh'?'refreshed' as const:behavior==='stack'?'stacked' as const:'rejected' as const;
}

export async function applyCharacterEffect(
  client: pg.PoolClient,
  characterId: string,
  effectId: string,
  options: { sourceContentInstanceId?: string | null; sourceKey?: string | null; remainingRounds?: number | null } = {}
): Promise<EffectApplicationResult> {
  const definition = await client.query<any>(`SELECT id, name, stack_behavior, duration_rounds, default_expiry_boundary, effect_key
    FROM effect_definitions WHERE id=$1 AND is_archived=false`, [effectId]);
  if (!definition.rowCount) throw new Error('Effect is unavailable.');
  const effect = definition.rows[0];

  // Find the unified Container for this effect (content_definitions where content_type='condition').
  const containerLookup = await client.query<{ id: string }>(
    `SELECT id FROM content_definitions WHERE content_key = 'condition:' || $1 AND content_type = 'condition' LIMIT 1`,
    [effect.effect_key]
  );
  const containerId = containerLookup.rows[0]?.id ?? null;

  const existing = await client.query<any>(`SELECT id FROM active_character_effects
    WHERE character_id=$1 AND effect_id=$2 ORDER BY started_at DESC FOR UPDATE`, [characterId, effectId]);
  const rounds = options.remainingRounds ?? effect.duration_rounds ?? null;
  const decision = effectApplicationDecision(Boolean(existing.rowCount), effect.stack_behavior);
  if (decision === 'rejected') return { status: decision, effectId, name: effect.name };
  if (decision === 'refreshed') {
    await client.query(`UPDATE active_character_effects SET remaining_rounds=$2, expires_at=NULL,
      source_content_instance_id=$3, source_key=$4, expiry_boundary=$5, started_at=now(), metadata_json='{}',
      container_id=COALESCE(container_id, $6)
      WHERE id=$1`,
      [existing.rows[0].id, rounds, options.sourceContentInstanceId ?? null,
       options.sourceKey ?? null, effect.default_expiry_boundary, containerId]);
    return { status: 'refreshed', effectId, name: effect.name };
  }
  await client.query(`INSERT INTO active_character_effects
    (character_id, effect_id, container_id, source_content_instance_id, source_key, remaining_rounds, expiry_boundary)
    VALUES($1, $2, $3, $4, $5, $6, $7)`,
    [characterId, effectId, containerId, options.sourceContentInstanceId ?? null,
     options.sourceKey ?? null, rounds, effect.default_expiry_boundary]);
  return { status: decision, effectId, name: effect.name };
}

export async function removeCharacterEffect(client: pg.PoolClient, characterId: string, effectId: string): Promise<number> {
  const result = await client.query(
    `DELETE FROM active_character_effects WHERE character_id=$1 AND (
      effect_id=$2
      OR container_id = (
        SELECT cd.id FROM content_definitions cd
        JOIN effect_definitions ed ON cd.content_key = 'condition:' || ed.effect_key
        WHERE ed.id=$2 AND cd.content_type='condition' LIMIT 1
      )
    )`,
    [characterId, effectId]
  );
  return result.rowCount || 0;
}

import type pg from 'pg';

// `effectId` in the result is the condition container id (content_definitions.id), kept under the
// legacy field name so callers do not change.
export type EffectApplicationResult = { status: 'applied' | 'refreshed' | 'stacked' | 'rejected'; effectId: string; name: string };
export function effectApplicationDecision(hasExisting:boolean,behavior:'refresh'|'stack'|'reject'){
  if(!hasExisting)return'applied' as const;
  return behavior==='refresh'?'refreshed' as const:behavior==='stack'?'stacked' as const:'rejected' as const;
}

// Applies a condition container to a character. Rows are keyed by container_id only; the legacy
// effect_id column is left NULL.
export async function applyCharacterEffect(
  client: pg.PoolClient,
  characterId: string,
  containerId: string,
  options: { sourceContentInstanceId?: string | null; sourceKey?: string | null; remainingRounds?: number | null } = {}
): Promise<EffectApplicationResult> {
  const definition = await client.query<any>(`SELECT id, name, stack_behavior, duration_rounds,
      COALESCE(expiry_boundary, 'round_end') AS expiry_boundary
    FROM content_definitions WHERE id=$1 AND content_type='condition' AND is_archived=false`, [containerId]);
  if (!definition.rowCount) throw new Error('Effect is unavailable.');
  const effect = definition.rows[0];

  const existing = await client.query<any>(`SELECT id FROM active_character_effects
    WHERE character_id=$1 AND container_id=$2 ORDER BY started_at DESC FOR UPDATE`, [characterId, containerId]);
  const rounds = options.remainingRounds ?? effect.duration_rounds ?? null;
  const decision = effectApplicationDecision(Boolean(existing.rowCount), effect.stack_behavior);
  if (decision === 'rejected') return { status: decision, effectId: containerId, name: effect.name };
  if (decision === 'refreshed') {
    await client.query(`UPDATE active_character_effects SET remaining_rounds=$2, expires_at=NULL,
      source_content_instance_id=$3, source_key=$4, expiry_boundary=$5, started_at=now(), metadata_json='{}'
      WHERE id=$1`,
      [existing.rows[0].id, rounds, options.sourceContentInstanceId ?? null,
       options.sourceKey ?? null, effect.expiry_boundary]);
    return { status: 'refreshed', effectId: containerId, name: effect.name };
  }
  await client.query(`INSERT INTO active_character_effects
    (character_id, container_id, source_content_instance_id, source_key, remaining_rounds, expiry_boundary)
    VALUES($1, $2, $3, $4, $5, $6)`,
    [characterId, containerId, options.sourceContentInstanceId ?? null,
     options.sourceKey ?? null, rounds, effect.expiry_boundary]);
  return { status: decision, effectId: containerId, name: effect.name };
}

export async function removeCharacterEffect(client: pg.PoolClient, characterId: string, containerId: string): Promise<number> {
  const result = await client.query(
    `DELETE FROM active_character_effects WHERE character_id=$1 AND container_id=$2`,
    [characterId, containerId]
  );
  return result.rowCount || 0;
}

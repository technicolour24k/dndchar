import { query, withTransaction } from '$lib/server/db';

export type EncounterDetail = {
  id: string; name: string; roundNumber: number; currentTurnIndex: number; isActive: boolean;
  participants: Array<{ id: string; characterId: string | null; name: string; initiative: number }>;
};

export async function listEncounters(userId: string): Promise<EncounterDetail[]> {
  const encounters = await query<any>('SELECT * FROM encounters WHERE owner_user_id = $1 ORDER BY updated_at DESC', [userId]);
  const participants = encounters.rows.length ? await query<any>(`SELECT p.* FROM encounter_participants p
    WHERE encounter_id = ANY($1::uuid[]) ORDER BY initiative DESC, sort_order`, [encounters.rows.map((row: any) => row.id)]) : { rows: [] };
  return encounters.rows.map((row: any) => ({ id: row.id, name: row.name, roundNumber: row.round_number,
    currentTurnIndex: row.current_turn_index, isActive: row.is_active,
    participants: participants.rows.filter((participant: any) => participant.encounter_id === row.id).map((participant: any) => ({
      id: participant.id, characterId: participant.character_id, name: participant.name, initiative: participant.initiative
    })) }));
}

export async function createEncounter(userId: string, name: string): Promise<string> {
  const result = await query<{ id: string }>('INSERT INTO encounters (owner_user_id, name) VALUES ($1,$2) RETURNING id', [userId, name.trim() || 'New Encounter']);
  return result.rows[0].id;
}

// Unlike addEncounterParticipant (which requires the same user to own both the
// encounter and the character - fine for a GM building their own initiative
// order), joining combat from the character sheet is inherently cross-user:
// the GM owns the encounter, the player owns the character. Only character
// ownership is checked here; the encounter just has to exist and be active.
export async function joinEncounterAsCharacter(userId: string, encounterId: string, characterId: string): Promise<void> {
  const result = await query(
    `INSERT INTO encounter_participants (encounter_id, character_id, name, initiative)
     SELECT e.id, c.id, c.name, 0 FROM characters c JOIN encounters e ON e.id = $1
     WHERE c.id = $2 AND c.owner_user_id = $3 AND e.is_active = true
     ON CONFLICT (encounter_id, character_id) DO NOTHING`,
    [encounterId, characterId, userId]
  );
  if (!result.rowCount) throw new Error('Encounter not found, not active, or character not yours.');
}

export async function closeEncounter(userId: string, encounterId: string): Promise<void> {
  await query('UPDATE encounters SET is_active=false, updated_at=now() WHERE id=$1 AND owner_user_id=$2', [encounterId, userId]);
}

// Combat-log write paths (VTT attack resolution, character-sheet HP edits) need to
// know "is this encounter still running" without going through the owning GM's
// session - is_active is enough on its own, no ownership check.
export async function isEncounterActive(encounterId: string): Promise<boolean> {
  const result = await query<{ is_active: boolean }>('SELECT is_active FROM encounters WHERE id=$1', [encounterId]);
  return result.rows[0]?.is_active ?? false;
}

// A character may be a participant in more than one past encounter; only the
// most recently updated *active* one counts as "currently in combat" for
// combat-log purposes.
export async function getActiveEncounterForCharacter(characterId: string): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT e.id FROM encounters e
     JOIN encounter_participants p ON p.encounter_id = e.id
     WHERE p.character_id = $1 AND e.is_active = true
     ORDER BY e.updated_at DESC LIMIT 1`,
    [characterId]
  );
  return result.rows[0]?.id ?? null;
}

export type EncounterHistoryItem = { id: string; name: string; isActive: boolean; createdAt: string };

// Every encounter a character has ever joined, most recent first - unlike
// getActiveEncounterForCharacter, this deliberately includes stopped/ended
// encounters too (it backs the "Combat History" list, not the live combat-log gate).
export async function listEncountersForCharacter(characterId: string): Promise<EncounterHistoryItem[]> {
  const result = await query<any>(
    `SELECT e.id, e.name, e.is_active, e.created_at
     FROM encounters e JOIN encounter_participants p ON p.encounter_id = e.id
     WHERE p.character_id = $1
     ORDER BY e.created_at DESC`,
    [characterId]
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, isActive: row.is_active, createdAt: row.created_at }));
}

export async function isCharacterInEncounter(characterId: string, encounterId: string): Promise<boolean> {
  const result = await query(
    'SELECT 1 FROM encounter_participants WHERE character_id = $1 AND encounter_id = $2',
    [characterId, encounterId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getEncounter(encounterId: string): Promise<{ id: string; name: string; isActive: boolean; createdAt: string } | null> {
  const result = await query<any>('SELECT id, name, is_active, created_at FROM encounters WHERE id = $1', [encounterId]);
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, isActive: row.is_active, createdAt: row.created_at } : null;
}

export async function addEncounterParticipant(userId: string, encounterId: string, characterId: string, initiative: number): Promise<void> {
  await query(`INSERT INTO encounter_participants (encounter_id, character_id, name, initiative)
    SELECT $1, c.id, c.name, $3 FROM characters c JOIN encounters e ON e.id=$1
    WHERE c.id=$2 AND c.owner_user_id=$4 AND e.owner_user_id=$4
    ON CONFLICT (encounter_id, character_id) DO UPDATE SET initiative=EXCLUDED.initiative`,
    [encounterId, characterId, initiative, userId]);
  await query(`UPDATE character_content_resources r SET current_value=max_value
    FROM content_resource_definitions d, character_content_instances i, characters c
    WHERE r.resource_definition_id=d.id AND r.character_content_id=i.id AND i.character_id=$1
      AND c.id=i.character_id AND c.owner_user_id=$2 AND d.recharge_period='encounter'`, [characterId, userId]);
}

export async function advanceEncounterTurn(userId: string, encounterId: string): Promise<void> {
  await withTransaction(async (client) => {
    const encounter = await client.query<any>('SELECT * FROM encounters WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [encounterId, userId]);
    if (!encounter.rowCount) throw new Error('Encounter not found.');
    const participants = await client.query<any>('SELECT * FROM encounter_participants WHERE encounter_id=$1 ORDER BY initiative DESC, sort_order', [encounterId]);
    if (!participants.rowCount) return;
    const previous = encounter.rows[0].current_turn_index;
    const next = (previous + 1) % participants.rows.length;
    const newRound = encounter.rows[0].round_number + (next === 0 ? 1 : 0);
    const previousCharacterId = participants.rows[previous]?.character_id;
    const nextCharacterId = participants.rows[next]?.character_id;
    if (previousCharacterId) await client.query(`UPDATE active_character_effects SET remaining_rounds=GREATEST(0,remaining_rounds-1)
      WHERE character_id=$1 AND remaining_rounds IS NOT NULL AND expiry_boundary='turn_end'`, [previousCharacterId]);
    if (nextCharacterId) await client.query(`UPDATE active_character_effects SET remaining_rounds=GREATEST(0,remaining_rounds-1)
      WHERE character_id=$1 AND remaining_rounds IS NOT NULL AND expiry_boundary='turn_start'`, [nextCharacterId]);
    await client.query('UPDATE encounters SET current_turn_index=$2, round_number=$3, updated_at=now() WHERE id=$1', [encounterId, next, newRound]);
    if (next === 0) {
      const characterIds = participants.rows.map((row: any) => row.character_id).filter(Boolean);
      await client.query(`UPDATE active_character_effects SET remaining_rounds=GREATEST(0,remaining_rounds-1)
        WHERE character_id=ANY($1::uuid[]) AND remaining_rounds IS NOT NULL AND expiry_boundary='round_end'`, [characterIds]);
      await client.query(`DELETE FROM active_character_effects WHERE character_id=ANY($1::uuid[]) AND remaining_rounds=0`, [characterIds]);
      await client.query(`UPDATE character_content_resources r SET current_value=max_value
        FROM content_resource_definitions d, character_content_instances i
        WHERE r.resource_definition_id=d.id AND r.character_content_id=i.id
          AND i.character_id=ANY($1::uuid[]) AND d.recharge_period='round'`, [characterIds]);
    }
    await client.query(`DELETE FROM active_character_effects WHERE remaining_rounds=0 AND character_id=ANY($1::uuid[])`,
      [participants.rows.map((row: any) => row.character_id).filter(Boolean)]);
  });
}

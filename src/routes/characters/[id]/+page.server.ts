import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
import { query } from '$lib/server/db';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { getCharacter, listItemCategories, listVersions, restoreCharacterVersion, spendHitDice, updateCharacter } from '$lib/server/services/characters';
import { addContentToCharacter, advanceCharacterRound, advanceCharacterTurn, castCharacterSpell, createHomebrewContent, listCatalogue, newBattle, removeContentFromCharacter, restCharacter, setCharacterContentState, spendSpellSlot, triggerCharacterContentActions, useContentResource, useInventoryCatalogueItem, useInventoryResource } from '$lib/server/services/catalogue';
import { getActiveEncounterForCharacter, listEncountersForCharacter } from '$lib/server/services/encounters';
import { getUserVttSessionId, leaveRoom, logRoll } from '$lib/server/services/rollLog';
import { getRoomGameSessionId, listGameSessionsForUser, logSessionNote } from '$lib/server/services/gameSessions';
import { sessions } from '$vtt/store.js';

export async function load({ params, locals }) {
  const character = await getCharacter(locals.user!.id, params.id);
  if (!character) throw error(404, 'Character not found.');

  return {
    character,
    itemCategories: await listItemCategories(),
    catalogue: await listCatalogue(locals.user!.id),
    versions: await listVersions(locals.user!.id, params.id),
    // All three - activeVttSessionId (the one thing a player joins),
    // activeEncounterId, activeGameSessionId - are user-scoped, not
    // character-scoped: a player joins a room once, and every character sheet
    // they open reflects it. Combat/session activity is derived live from
    // that room's in-memory state, not a separate join per feature.
    activeVttSessionId: await getUserVttSessionId(locals.user!.id),
    activeEncounterId: await getActiveEncounterForCharacter(params.id),
    // Pure room-derivation (getRoomGameSessionId), not the fallback-chained
    // getActiveGameSessionForUser - the character sheet must only ever
    // reflect/post to what's active in the room the player is actually
    // connected to, never a stale session joined ages ago via a different
    // flow (that fallback is scoped to SessionNotesModal's own join check).
    activeGameSessionId: await getRoomGameSessionId(locals.user!.id),
    encounterHistory: await listEncountersForCharacter(params.id),
    // Session Notes history is user-scoped too (see above) - shown in the
    // Session Notes tab the same way Past Encounters is shown in the Combat
    // tab, rather than needing its own separate /sessions list page.
    gameSessionHistory: await listGameSessionsForUser(locals.user!.id)
  };
}

export const actions = {
  save: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Manual save');
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { saved: true };
  },
  autosave: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Autosave');
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { autosaved: true };
  },
  resource: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Resource update');
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return fail(200, { resourceUpdated: true });
  },
  restoreVersion: async ({ request, params, locals }) => {
    const form = await request.formData();
    const versionId = String(form.get('versionId') || '');
    if (!versionId) return fail(400, { restoreFailed: true });

    await restoreCharacterVersion(locals.user!.id, params.id, versionId);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { restored: true };
  },
  addContent: async ({ request, params, locals }) => {
    const form = await request.formData();
    await addContentToCharacter(locals.user!.id, params.id, String(form.get('contentId') || ''));
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  createHomebrew: async ({ request, params, locals }) => {
    requireAdmin(locals.user);
    const form = await request.formData();
    const contentId = await createHomebrewContent(locals.user!.id, form);
    await addContentToCharacter(locals.user!.id, params.id, contentId);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  addInventoryItem: async ({ request, params, locals }) => {
    const form = await request.formData();
    const name = String(form.get('name') || '').trim();
    if (!name) return fail(400, { error: 'Name is required.' });
    const quantity = Math.max(1, Math.min(999, Number(form.get('quantity')) || 1));
    const category = String(form.get('category') || 'gear');
    const rawLocation = String(form.get('location') || 'backpack');
    const location = ['equipped', 'backpack', 'misc'].includes(rawLocation) ? rawLocation : 'backpack';
    const notes = String(form.get('notes') || '');
    const result = await query(`
      WITH owned AS (SELECT id FROM characters WHERE id=$1 AND owner_user_id=$2)
      INSERT INTO character_inventory_items
        (character_id, name, category, location, quantity, equipped, is_equipment,
         ac_bonus, to_hit_bonus, damage_bonus, attack_ability, proficient,
         damage_rolls, effects, notes, sort_order)
      SELECT $1, $3, $4, $7, $5, false, false, 0, 0, 0, 'str', true, '', '', $6,
        COALESCE((SELECT max(sort_order)+1 FROM character_inventory_items WHERE character_id=$1), 0)
      FROM owned
    `, [params.id, locals.user!.id, name, category, quantity, notes, location]);
    if (!result.rowCount) return fail(403, { error: 'Character not found.' });
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  removeContent: async ({ request, params, locals }) => {
    const form = await request.formData();
    await removeContentFromCharacter(locals.user!.id, params.id, String(form.get('instanceId') || ''));
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  contentState: async ({ request, params, locals }) => {
    const form = await request.formData();
    await setCharacterContentState(locals.user!.id, params.id, String(form.get('instanceId') || ''), form);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  contentResource: async ({ request, params, locals }) => {
    const form = await request.formData();
    await useContentResource(locals.user!.id, params.id, String(form.get('resourceId') || ''), Number(form.get('delta')) || 0);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  inventoryResource:async({request,params,locals})=>{const form=await request.formData();await useInventoryResource(locals.user!.id,params.id,String(form.get('resourceId')||''),Number(form.get('delta'))||0);emitRealtimeEvent('resource:changed',{characterId:params.id});return{contentUpdated:true};},
  spellSlot: async ({ request, params, locals }) => {
    const form = await request.formData();
    await spendSpellSlot(locals.user!.id, params.id, String(form.get('slotType')) as 'standard' | 'pact', Number(form.get('slotLevel')), Number(form.get('delta')) || 0);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  rest: async ({ request, params, locals }) => {
    const form = await request.formData();
    await restCharacter(locals.user!.id, params.id, String(form.get('restType')) as 'short_rest' | 'long_rest');
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  advanceRound: async ({ params, locals }) => {
    await advanceCharacterRound(locals.user!.id, params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  advanceTurn: async ({ params, locals }) => {
    await advanceCharacterTurn(locals.user!.id, params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  newBattle: async ({ params, locals }) => {
    await newBattle(locals.user!.id, params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  useItem: async ({ request, params, locals }) => {
    const form = await request.formData();
    const itemResult=await useInventoryCatalogueItem(locals.user!.id, params.id, String(form.get('inventoryId') || ''));
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true, itemResult };
  },
  triggerContent:async({request,params,locals})=>{
    const form=await request.formData();
    const itemResult=await triggerCharacterContentActions(locals.user!.id,params.id,String(form.get('instanceId')||''));
    emitRealtimeEvent('resource:changed',{characterId:params.id});
    return{contentUpdated:true,itemResult};
  },
  castSpell:async({request,params,locals})=>{
    const itemResult=await castCharacterSpell(locals.user!.id,params.id,await request.formData());
    emitRealtimeEvent('resource:changed',{characterId:params.id});return{contentUpdated:true,itemResult};
  },
  // The one join a player needs, covering combat, rolls, and session notes at
  // once - see encounters.ts's getActiveEncounterForCharacter and
  // gameSessions.ts's getActiveGameSessionForUser for how the other two derive
  // themselves from this same room join instead of requiring their own.
  joinRoom: async ({ request, locals }) => {
    const form = await request.formData();
    const roomId = String(form.get('roomId') || '').trim().toUpperCase();
    if (!roomId) return fail(400, { joinRoomError: 'Enter a room code.' });
    // VTT rooms are in-memory only (vtt/server/store.js) - validate against the
    // live sessions Map directly rather than any DB table, same supported
    // SvelteKit-into-vtt/server import already used by the combat start/stop route.
    if (!sessions.has(roomId)) return fail(400, { joinRoomError: 'That room code was not found.' });
    await query('UPDATE users SET active_vtt_session_id = $1 WHERE id = $2', [roomId, locals.user!.id]);
    return { joinedRoom: true };
  },
  // Explicit opt-out - the room join is plain persisted account state (it
  // survives logout/login on purpose, so a player reconnecting mid-game
  // doesn't have to re-join), so it needs a deliberate way to clear it rather
  // than relying on it expiring on its own.
  leaveRoom: async ({ locals }) => {
    await leaveRoom(locals.user!.id);
    return { leftRoom: true };
  },
  logRoll: async ({ request, params, locals }) => {
    const form = await request.formData();
    const label = String(form.get('label') || '').trim();
    const total = Number(form.get('total'));
    const breakdown = String(form.get('breakdown') || '');
    const natural = Number(form.get('natural'));
    if (!label || !Number.isFinite(total)) return fail(400, { logRollError: 'Invalid roll.' });

    const sessionId = await getUserVttSessionId(locals.user!.id);
    if (!sessionId) return { loggedRoll: false }; // not in a room - nothing to log, not an error

    const nameRow = await query<{ name: string }>(
      'SELECT name FROM characters WHERE id = $1 AND owner_user_id = $2',
      [params.id, locals.user!.id]
    );
    const name = nameRow.rows[0]?.name || 'A character';
    await logRoll(sessionId, `${name} rolled a ${total} on ${label}.`, { label, total, breakdown, natural });
    return { loggedRoll: true };
  },
  postSessionNote: async ({ request, locals }) => {
    const form = await request.formData();
    const message = String(form.get('message') || '').trim();
    if (!message) return fail(400, { postSessionNoteError: 'Nothing to post.' });

    const gameSessionId = await getRoomGameSessionId(locals.user!.id);
    if (!gameSessionId) return fail(400, { postSessionNoteError: 'Join a session first.' });

    try {
      await logSessionNote(gameSessionId, locals.user!.id, message);
    } catch {
      return fail(400, { postSessionNoteError: 'That session is no longer active.' });
    }
    return { postedSessionNote: true };
  },
  spendHitDice: async ({ request, params, locals }) => {
    const form = await request.formData();
    const classIndex = Math.max(0, Number(form.get('classIndex')) || 0);
    const spent = Math.max(1, Math.min(99, Number(form.get('spent')) || 1));
    const classLevel = Math.max(1, Number(form.get('classLevel')) || 1);
    const hpGained = Math.max(0, Number(form.get('hpGained')) || 0);
    await spendHitDice(locals.user!.id, params.id, classIndex, spent, classLevel, hpGained);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  }
};

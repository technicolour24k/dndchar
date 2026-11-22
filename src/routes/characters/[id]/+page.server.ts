import { error, fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
import { query } from '$lib/server/db';
import { assertCanActForCharacter, assertCanEditCharacter } from '$lib/server/services/access';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { getCharacterWithAccess, listItemCategories, restoreCharacterVersion, spendHitDice, StaleSheetError, updateCharacter } from '$lib/server/services/characters';
import { CostShortfallError } from '$lib/server/services/cost-engine';
import { openCostGate, runWithGate } from '$lib/server/vttCostGate';
import { activationFromCastForm, parseActivation } from '$lib/server/vttCostApproval';
import { adjustCharacterPool } from '$lib/server/services/resource-pools';
import { adjustTurnPool } from '$lib/server/services/turn-state';
import { resetLiveTokenMovement } from '$lib/server/vttTurn';
import { addContentToCharacter, advanceCharacterRound, advanceCharacterTurn, castCharacterSpell, payTurnActivation, createHomebrewContent, newBattle, removeContentFromCharacter, restCharacter, setCharacterContentState, spendSpellSlot, triggerCharacterContentActions, useContentResource, useInventoryCatalogueItem, useInventoryResource } from '$lib/server/services/catalogue';
import { attempt } from '$lib/server/campaignAction';
import { openCampaignRoomForMember, pruneDepartedCharacterTokens } from '$lib/server/services/campaignRooms';
import { addCharacterToCampaign, getCampaignByRoomCode, listMyCampaignOptions, removeCharacterFromCampaign, setCharacterPartyActive } from '$lib/server/services/campaigns';
import { getActiveEncounterForCharacter } from '$lib/server/services/encounters';
import { getUserVttSessionId, leaveRoom, logRoll } from '$lib/server/services/rollLog';
import { getRoomGameSessionId, logSessionNote } from '$lib/server/services/gameSessions';
import { sessions } from '$vtt/store.js';
import { poolSummary } from '$lib/rules/attackRoll';

// db-traffic-reduction Phase 4: load() only carries what the sheet renders on every
// view - versions (VersionList.svelte) and the Activity Log's Past Encounters/Past
// Sessions tabs are now fetched lazily, only when those rarely-opened modals actually
// open, via GET .../versions and GET .../history. depends('app:character-sheet') lets
// every button action narrow invalidateAll() down to just this load(), instead of
// re-running the whole page tree (see the Narrow refresh changes below/in the form).
export async function load({ params, locals, depends }) {
  depends('app:character-sheet');
  // Lets in anyone who can VIEW (owner, any campaign member, admin). The access flags tell the sheet
  // WHY (owner / DM / admin override / plain viewer) so it can show the right badge and go read-only
  // when canEdit is false. Every write action below re-checks edit/act rights itself.
  const loaded = await getCharacterWithAccess(locals.user!.id, params.id);
  if (!loaded) throw error(404, 'Character not found.');
  const { character, access } = loaded;
  // The owner's display name, only needed when someone else is editing the sheet.
  const ownerName = access.isOwner
    ? null
    : (await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [character.ownerUserId])).rows[0]?.display_name ?? null;

  // Independent reads, so they can run concurrently rather than one round-trip each.
  const [itemCategories, myCampaigns, activeVttSessionId, activeEncounterId, activeGameSessionId] = await Promise.all([
    listItemCategories(),
    // For the sheet's "Add to campaign" select (the campaigns this user is a member of).
    listMyCampaignOptions(locals.user!.id),
    // All three below - activeVttSessionId (the one thing a player joins),
    // activeEncounterId, activeGameSessionId - are user-scoped, not
    // character-scoped: a player joins a room once, and every character sheet
    // they open reflects it. Combat/session activity is derived live from
    // that room's in-memory state, not a separate join per feature.
    getUserVttSessionId(locals.user!.id),
    getActiveEncounterForCharacter(params.id),
    // Pure room-derivation (getRoomGameSessionId), not the fallback-chained
    // getActiveGameSessionForUser - the character sheet must only ever
    // reflect/post to what's active in the room the player is actually
    // connected to, never a stale session joined ages ago via a different
    // flow (that fallback is scoped to SessionNotesModal's own join check).
    getRoomGameSessionId(locals.user!.id)
  ]);

  return {
    character,
    access,
    ownerName,
    itemCategories,
    myCampaigns,
    activeVttSessionId,
    activeEncounterId,
    activeGameSessionId
  };
}

export const actions = {
  // Campaign membership of this character (B5). The campaign service does the permission checks.
  // Results use their own keys so the sheet's own "saved" / error banners are not triggered.
  setCampaign: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => addCharacterToCampaign(locals.user!.id, params.id, String(form.get('campaignId') || '')));
    // A move out of another campaign takes the token off that campaign's live map.
    if (result.ok) await pruneDepartedCharacterTokens();
    return result.ok ? { campaignDone: true } : fail(400, { campaignError: result.failure.data.error });
  },
  leaveCampaign: async ({ params, locals }) => {
    const result = await attempt(() => removeCharacterFromCampaign(locals.user!.id, params.id));
    if (result.ok) await pruneDepartedCharacterTokens();
    return result.ok ? { campaignDone: true } : fail(400, { campaignError: result.failure.data.error });
  },
  setPartyActive: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => setCharacterPartyActive(locals.user!.id, params.id, form.get('active') === '1'));
    return result.ok ? { campaignDone: true } : fail(400, { campaignError: result.failure.data.error });
  },
  save: async ({ request, params, locals }) => {
    const form = await request.formData();
    let sheetVersion: number;
    try {
      sheetVersion = await updateCharacter(locals.user!.id, params.id, form, 'Manual save');
    } catch (error) {
      // Stale-save guard: someone else saved since this sheet loaded. Nothing was written.
      if (error instanceof StaleSheetError) return fail(409, { staleSheet: true, error: error.message });
      throw error;
    }
    emitRealtimeEvent('character:updated', { characterId: params.id });
    // The new version goes back to the sheet so its next Save is not mistaken for a stale one.
    return { saved: true, sheetVersion };
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
    // Owner, campaign DM/co-DM or admin (the shared edit rule), then a plain insert.
    try { await assertCanEditCharacter({ query }, locals.user!.id, params.id); } catch { return fail(403, { error: 'Character not found.' }); }
    const result = await query(`
      INSERT INTO character_inventory_items
        (character_id, name, category, location, quantity, equipped, is_equipment,
         ac_bonus, to_hit_bonus, damage_bonus, attack_ability, proficient,
         damage_rolls, effects, notes, sort_order)
      VALUES ($1, $2, $3, $6, $4, false, false, 0, 0, 0, 'str', true, '', '', $5,
        COALESCE((SELECT max(sort_order)+1 FROM character_inventory_items WHERE character_id=$1), 0))
    `, [params.id, name, category, quantity, notes, location]);
    if (!result.rowCount) return fail(403, { error: 'Character not found.' });
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  // db-traffic-reduction Phase 4: equip/unequip used to submit the whole sheet form
  // (a full character rewrite plus a version snapshot) just to flip one row. This is
  // a single UPDATE instead - no version, no touching any other field the player may
  // have unsaved elsewhere. Writes exactly what toggleEquipped's old client code set
  // on the hidden fields: location follows equipped, and is_equipment is always left
  // true either way (equipment gear keeps its combat stats even parked in the backpack).
  setEquipped: async ({ request, params, locals }) => {
    const form = await request.formData();
    const inventoryId = String(form.get('inventoryId') || '');
    const equipped = String(form.get('equipped')) === 'true';
    if (!inventoryId) return fail(400, { error: 'Missing item.' });
    try { await assertCanEditCharacter({ query }, locals.user!.id, params.id); } catch { return fail(403, { error: 'Item not found.' }); }
    const result = await query(`
      UPDATE character_inventory_items
      SET equipped = $3,
          location = CASE WHEN $3 THEN 'equipped' ELSE 'backpack' END,
          is_equipment = true
      WHERE id = $1
        AND character_id = $2
    `, [inventoryId, params.id, equipped]);
    if (!result.rowCount) return fail(403, { error: 'Item not found.' });
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  // Same reasoning as setEquipped above: a single DELETE, no version, no whole-sheet
  // submit. character_inventory_resources rows for this item cascade (migration 016).
  removeInventoryItem: async ({ request, params, locals }) => {
    const form = await request.formData();
    const inventoryId = String(form.get('inventoryId') || '');
    if (!inventoryId) return fail(400, { error: 'Missing item.' });
    try { await assertCanEditCharacter({ query }, locals.user!.id, params.id); } catch { return fail(403, { error: 'Item not found.' }); }
    const result = await query(`
      DELETE FROM character_inventory_items
      WHERE id = $1
        AND character_id = $2
    `, [inventoryId, params.id]);
    if (!result.rowCount) return fail(403, { error: 'Item not found.' });
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
  poolAdjust: async ({ request, params, locals }) => {
    const form = await request.formData();
    await adjustCharacterPool(locals.user!.id, params.id, String(form.get('key') || ''), Number(form.get('delta')) || 0);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  // +/- on a per-turn action pool (bookkeeping, like poolAdjust). Delta changes what is left.
  turnAdjust: async ({ request, params, locals }) => {
    const form = await request.formData();
    await adjustTurnPool(locals.user!.id, params.id, String(form.get('key') || ''), Number(form.get('delta')) || 0);
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
    resetLiveTokenMovement(params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  advanceTurn: async ({ params, locals }) => {
    await advanceCharacterTurn(locals.user!.id, params.id);
    resetLiveTokenMovement(params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  newBattle: async ({ params, locals }) => {
    await newBattle(locals.user!.id, params.id);
    resetLiveTokenMovement(params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  useItem: async ({ request, params, locals }) => {
    const form = await request.formData();
    let itemResult;
    // The cost gate decides, before the transaction, whether this may go over budget (DM approval, the DM's own
    // go-ahead, or the no-DM "Did your DM OK this?"). Form fields: approvalId, override ('dm' | 'self').
    const inventoryId = String(form.get('inventoryId') || '');
    const gate = await openCostGate({ userId: locals.user!.id, characterId: params.id, activation: { kind: 'item', inventoryId }, approvalId: form.get('approvalId'), override: form.get('override') });
    if (!gate.ok) return fail(gate.status, { costError: gate.body });
    try { itemResult=await runWithGate(gate, (override) => useInventoryCatalogueItem(locals.user!.id, params.id, inventoryId, override)); } catch (error) { if (error instanceof CostShortfallError) return fail(409, { costShortfall: error.shortfalls, costMode: gate.mode, costActivation: gate.activation }); throw error; }
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true, itemResult };
  },
  triggerContent:async({request,params,locals})=>{
    const form=await request.formData();
    let itemResult;
    const instanceId=String(form.get('instanceId')||'');
    const gate=await openCostGate({userId:locals.user!.id,characterId:params.id,activation:{kind:'content',instanceId},approvalId:form.get('approvalId'),override:form.get('override')});
    if(!gate.ok)return fail(gate.status,{costError:gate.body});
    try{itemResult=await runWithGate(gate,(override)=>triggerCharacterContentActions(locals.user!.id,params.id,instanceId,override));}catch(error){if(error instanceof CostShortfallError)return fail(409,{costShortfall:error.shortfalls,costMode:gate.mode,costActivation:gate.activation});throw error;}
    emitRealtimeEvent('resource:changed',{characterId:params.id});
    return{contentUpdated:true,itemResult};
  },
  // Pays a weapon attack's action (and spends an Extra Attack follow-up when chosen). The sheet then rolls
  // locally. Fields: kind=weapon_attack, inventoryId, timing (action|bonus_action|reaction), followup (use|skip).
  payTurn:async({request,params,locals})=>{
    const form=await request.formData();
    const text=(key:string)=>String(form.get(key)||'');
    const activation=parseActivation({kind:text('kind'),inventoryId:text('inventoryId')||null,
      ...(text('timing')?{timing:text('timing')}:{}),...(text('followup')?{followup:text('followup')}:{})});
    if(!activation||activation.kind!=='weapon_attack'||!activation.inventoryId)return fail(400,{costError:{error:'bad_activation'}});
    const gate=await openCostGate({userId:locals.user!.id,characterId:params.id,activation,approvalId:form.get('approvalId'),override:form.get('override')});
    if(!gate.ok)return fail(gate.status,{costError:gate.body});
    let itemResult;
    try{itemResult=(await runWithGate(gate,(override)=>payTurnActivation(locals.user!.id,params.id,activation,override))).results;}catch(error){if(error instanceof CostShortfallError)return fail(409,{costShortfall:error.shortfalls,costMode:gate.mode,costActivation:gate.activation});throw error;}
    emitRealtimeEvent('resource:changed',{characterId:params.id});
    return{contentUpdated:true,itemResult};
  },
  castSpell:async({request,params,locals})=>{
    let itemResult;
    const form=await request.formData();
    const gate=await openCostGate({userId:locals.user!.id,characterId:params.id,activation:activationFromCastForm(form),approvalId:form.get('approvalId'),override:form.get('override')});
    if(!gate.ok)return fail(gate.status,{costError:gate.body});
    try{itemResult=await runWithGate(gate,(override)=>castCharacterSpell(locals.user!.id,params.id,form,override));}catch(error){if(error instanceof CostShortfallError)return fail(409,{costShortfall:error.shortfalls,costMode:gate.mode,costActivation:gate.activation});throw error;}
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
    // A campaign's table has a fixed room code and may not be live yet (a restart wipes it): a real
    // member (admin override does not apply) opens it on demand. Anyone else gets the same message
    // as a wrong code, so a campaign room code reveals nothing.
    // The canonical code comes from the campaign row (a dashed or lower-case entry still matches),
    // so no phantom room is ever created or saved under a mistyped spelling.
    const campaign = await getCampaignByRoomCode(roomId);
    let joinCode = roomId;
    if (campaign) {
      joinCode = campaign.roomCode;
      const role = campaign.isArchived ? null : await openCampaignRoomForMember({ id: campaign.id, roomCode: joinCode }, locals.user!.id);
      if (!role) return fail(400, { joinRoomError: 'That room code was not found.' });
    } else if (!sessions.has(roomId)) {
      return fail(400, { joinRoomError: 'That room code was not found.' });
    }
    await query('UPDATE users SET active_vtt_session_id = $1 WHERE id = $2', [joinCode, locals.user!.id]);
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

    // Optional d20 pool fields (older clients don't send them, and get today's plain message).
    // Anything out of range is dropped rather than rejected: the pool only words the log line.
    const intField = (name: string) => {
      const raw = form.get(name);
      return raw === null || raw === '' ? NaN : Number(raw);
    };
    const poolSize = intField('poolSize');
    const poolNet = intField('poolNet');
    const poolKept = intField('poolKept');
    const poolManualAdv = intField('poolManualAdv');
    const poolManualDis = intField('poolManualDis');
    const poolValid = [poolSize, poolNet, poolKept, poolManualAdv, poolManualDis].every(Number.isInteger)
      && poolSize >= 1 && poolSize <= 11 && Math.abs(poolNet) === poolSize - 1
      && poolKept >= 1 && poolKept <= 20
      && poolManualAdv >= 0 && poolManualAdv <= 5 && poolManualDis >= 0 && poolManualDis <= 5;
    const pool = poolValid ? {
      size: poolSize, net: poolNet, direction: poolNet > 0 ? 'highest' as const : poolNet < 0 ? 'lowest' as const : 'flat' as const,
      advantage: 0, disadvantage: 0, manualAdvantage: poolManualAdv, manualDisadvantage: poolManualDis, rolls: [], kept: poolKept
    } : null;
    const summary = pool ? poolSummary(pool) : '';
    // INTERIM: the manual damage-dice delta (weapon attacks only), kept in details for reference.
    const manualDamageDiceRaw = intField('manualDamageDice');
    const manualDamageDice = Number.isInteger(manualDamageDiceRaw) && Math.abs(manualDamageDiceRaw) <= 5 ? manualDamageDiceRaw : 0;

    const sessionId = await getUserVttSessionId(locals.user!.id);
    if (!sessionId) return { loggedRoll: false }; // not in a room - nothing to log, not an error

    // Only someone who can ACT for the character (owner, campaign DM/co-DM) logs a roll as them. A
    // site admin editing the sheet, or a viewer, never has a roll logged under the character's name.
    try { await assertCanActForCharacter({ query }, locals.user!.id, params.id); } catch { return { loggedRoll: false }; }
    const nameRow = await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [params.id]);
    const name = nameRow.rows[0]?.name || 'A character';
    await logRoll(sessionId, `${name} rolled a ${total} on ${label}${summary ? ` (${summary})` : ''}.`,
      { label, total, breakdown, natural, ...(pool ? { pool } : {}), ...(manualDamageDice ? { manualDamageDice } : {}) });
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
    // Only used to seed max_value if this pool has never been saved before - an existing pool's
    // max is left alone (see spendHitDice's comment in characters.ts).
    const defaultMax = Math.max(1, Number(form.get('defaultMax')) || 1);
    const hpGained = Math.max(0, Number(form.get('hpGained')) || 0);
    await spendHitDice(locals.user!.id, params.id, classIndex, spent, defaultMax, hpGained);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  }
};

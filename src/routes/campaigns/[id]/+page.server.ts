import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit';
import { attempt } from '$lib/server/campaignAction';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { leaveState, memberControls } from '$lib/server/campaignControls';
import { countActiveFindTables } from '$lib/server/services/forage';
import { listUnreviewedOverrides, reviewOverride } from '$lib/server/services/resource-pools';
import { announceCostUndo } from '$lib/server/vttCostGate';
import { query } from '$lib/server/db';
import { announceDeck, announceDmTasks } from '$lib/server/vttDeckAnnounce';
import {
  DeckError, listAvailableDecks, listCampaignDecks, listDrawsForCampaign, listOpenDmTasks, revertDraw, setCampaignDeck, setDrawTaskDone
} from '$lib/server/services/decks';
import { listMapsForViewer } from '$lib/server/services/overworld';
import { dropCampaignPreviews, dropUserPreviews } from '$lib/server/overworldNotify';
import { ejectAllFromCampaignVoice, ejectFromCampaignVoice } from '$lib/server/voice/voiceEject';
import { closeCampaignRoom, kickFromCampaignRoom, pruneDepartedCharacterTokens, syncGmSeats } from '$lib/server/services/campaignRooms';
import {
  addCharacterToCampaign,
  archiveCampaign,
  getCampaignPage,
  leaveCampaign,
  regenerateInviteCode,
  removeCharacterFromCampaign,
  removeMember,
  setCharacterPartyActive,
  setCampaignActionEconomy,
  setMemberRole,
  updateCampaignDetails
} from '$lib/server/services/campaigns';
import type { CampaignRole } from '$lib/types/campaign';

// Deck actions throw DeckErrors with player-facing messages; anything else is logged and shown generically.
async function deckAttempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<{ error: string }> }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof DeckError) return { ok: false, failure: fail(error.code === 'forbidden' ? 403 : 400, { error: error.message }) };
    console.error('[campaigns] unexpected deck error', error);
    return { ok: false, failure: fail(500, { error: 'Something went wrong, please try again.' }) };
  }
}

// Every action below only forwards to the campaign service, which does the real permission check
// (access.ts). The controls computed in load are just what to show. Membership changes also reach
// the live VTT room: a removed or departed member is kicked, a demoted one is kicked so they
// reconnect with a ticket for their new role, and an archived campaign's room is closed. The
// database change has already committed by then, so the room just catches up.
export async function load({ params, locals }) {
  const user = locals.user!;
  const page = await getCampaignPage(user.id, params.id);
  if (!page) throw error(404, 'Campaign not found.');

  const viewer = { userId: user.id, role: page.access.role, isAdmin: page.access.isAdmin };
  const archived = page.campaign.isArchived;
  return {
    ...page,
    viewerId: user.id,
    controls: memberControls(viewer, page.members, archived),
    leave: leaveState(viewer, page.members, archived),
    hasNoDm: !page.members.some((m) => m.role === 'dm'),
    // DMs and admins get a "Find tables: N active" line (foraging needs at least one table). Null for everyone else.
    findTableCount: page.access.canManage && !archived ? await countActiveFindTables(page.campaign.id) : null,
    // Over-budget uses a player confirmed with "my DM OK'd it", waiting for a DM to mark OK or undo. canManage only.
    overrideReviews: page.access.canManage && !archived ? await listUnreviewedOverrides(params.id) : [],
    // Maps this viewer may open (campaign role only, so null for a non-member, site admin or not).
    overworld: await listMapsForViewer(user.id, params.id),
    // Decks (decks plan, unit 9). Everyone who can view the page sees the enabled decks and the draw log; only a
    // DM / co-DM / admin gets the disabled ones, the add list and the open tasks (the services check it again).
    decks: await listCampaignDecks(params.id, { includeDisabled: page.access.canManage }),
    availableDecks: page.access.canManage && !archived ? await listAvailableDecks(params.id) : [],
    draws: await listDrawsForCampaign(user.id, params.id),
    deckTasks: page.access.canManage && !archived ? await listOpenDmTasks(user.id, params.id) : [],
    // The admin banner is for people who only have access through the override.
    viaAdmin: page.access.isAdmin && !page.access.isDm
  };
}

const ROLES: CampaignRole[] = ['dm', 'co_dm', 'player'];

export const actions = {
  update: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() =>
      updateCampaignDetails(locals.user!.id, params.id, String(form.get('name') || ''), String(form.get('description') || ''))
    );
    return result.ok ? { saved: 'details' } : result.failure;
  },

  // DM-only: which action-economy profile the campaign plays by. Open sheets and VTT tokens re-sync.
  setActionEconomy: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => setCampaignActionEconomy(locals.user!.id, params.id, String(form.get('actionEconomy') || '')));
    if (!result.ok) return result.failure;
    for (const characterId of result.value) emitRealtimeEvent('resource:changed', { characterId });
    return { saved: 'actionEconomy' };
  },

  regenerate: async ({ params, locals }) => {
    const result = await attempt(() => regenerateInviteCode(locals.user!.id, params.id));
    return result.ok ? { saved: 'invite' } : result.failure;
  },

  setRole: async ({ request, params, locals }) => {
    const form = await request.formData();
    const role = String(form.get('role') || '') as CampaignRole;
    if (!ROLES.includes(role)) return fail(400, { error: 'Unknown role.' });
    const result = await attempt(() => setMemberRole(locals.user!.id, params.id, String(form.get('userId') || ''), role));
    if (result.ok) {
      for (const id of result.value?.demotedToPlayer ?? []) {
        kickFromCampaignRoom(result.value?.roomCode, id, 'role_changed');
        dropUserPreviews(params.id, id);
      }
      // A swap or admin "make primary" changes who outranks whom, so refresh seated GMs' rank.
      await syncGmSeats(params.id, result.value?.roomCode);
    }
    return result.ok ? { saved: 'role' } : result.failure;
  },

  removeMember: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => removeMember(locals.user!.id, params.id, String(form.get('userId') || '')));
    if (result.ok) {
      kickFromCampaignRoom(result.value?.roomCode, result.value?.targetUserId, 'removed_from_campaign');
      // Fire and forget: never throws, never delays or fails the action (see voiceEject.ts).
      void ejectFromCampaignVoice(params.id, result.value?.targetUserId);
      if (result.value?.targetUserId) dropUserPreviews(params.id, result.value.targetUserId);
      // Removing the primary promotes the co-DM, whose seated socket is now 'primary'.
      await syncGmSeats(params.id, result.value?.roomCode);
      // Their characters left the campaign, so their tokens leave the live map.
      await pruneDepartedCharacterTokens();
    }
    return result.ok ? { saved: 'removed' } : result.failure;
  },

  leave: async ({ params, locals }) => {
    const result = await attempt(() => leaveCampaign(locals.user!.id, params.id));
    if (!result.ok) return result.failure;
    kickFromCampaignRoom(result.value?.roomCode, locals.user!.id, 'removed_from_campaign');
    void ejectFromCampaignVoice(params.id, locals.user!.id);
    dropUserPreviews(params.id, locals.user!.id);
    await syncGmSeats(params.id, result.value?.roomCode);
    await pruneDepartedCharacterTokens();
    throw redirect(303, '/campaigns');
  },

  archive: async ({ params, locals }) => {
    const result = await attempt(() => archiveCampaign(locals.user!.id, params.id));
    if (!result.ok) return result.failure;
    closeCampaignRoom(result.value?.roomCode);
    void ejectAllFromCampaignVoice(params.id);
    dropCampaignPreviews(params.id);
    throw redirect(303, '/campaigns');
  },

  addCharacter: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => addCharacterToCampaign(locals.user!.id, String(form.get('characterId') || ''), params.id));
    // Moving a character in from another campaign takes its token off that campaign's map.
    if (result.ok) await pruneDepartedCharacterTokens();
    return result.ok ? { saved: 'character' } : result.failure;
  },

  removeCharacter: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => removeCharacterFromCampaign(locals.user!.id, String(form.get('characterId') || ''), params.id));
    // The character left the campaign, so its token leaves the live map.
    if (result.ok) await pruneDepartedCharacterTokens();
    return result.ok ? { saved: 'character' } : result.failure;
  },

  // Over-budget review (cost engine). OK just marks it; Undo refunds what it spent. Both are idempotent.
  reviewOk: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => reviewOverride(locals.user!.id, params.id, String(form.get('activationId') || ''), 'ok'));
    return result.ok ? { reviewed: result.value.message } : result.failure;
  },

  reviewUndo: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => reviewOverride(locals.user!.id, params.id, String(form.get('activationId') || ''), 'undo'));
    if (!result.ok) return result.failure;
    const done = result.value;
    if (done.status === 'undone' && done.characterId) {
      await announceCostUndo({ characterId: done.characterId, characterName: done.characterName ?? 'Someone', label: done.sourceLabel ?? 'use', refunded: done.refunded ?? [], roomId: done.roomId ?? null });
    }
    return { reviewed: done.message };
  },

  // Decks: the DM turns a global deck on or off for this campaign (selection, not authoring).
  setDeck: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await deckAttempt(() => setCampaignDeck({
      userId: locals.user!.id, campaignId: params.id, deckId: String(form.get('deckId') || ''), enabled: form.get('enabled') === '1'
    }));
    return result.ok ? { saved: 'decks' } : result.failure;
  },

  // Undo a deck draw (or cancel an undecided Ace). The table and open sheets catch up through announceDeck.
  undoDraw: async ({ request, locals }) => {
    const form = await request.formData();
    const result = await deckAttempt(() => revertDraw({ userId: locals.user!.id, drawId: String(form.get('drawId') || '') }));
    if (!result.ok) return result.failure;
    if (result.value.status === 'reverted') await announceDeck(result.value, 'undone');
    return { saved: 'draws', note: result.value.status === 'reverted' ? result.value.revertNote : 'Cancelled.' };
  },

  taskDone: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await deckAttempt(() => setDrawTaskDone({
      userId: locals.user!.id, drawId: String(form.get('drawId') || ''), taskId: String(form.get('taskId') || ''), done: true
    }));
    if (!result.ok) return result.failure;
    // The GM's open-task list at the table updates live.
    const room = await query<{ room_code: string | null }>('SELECT room_code FROM campaigns WHERE id = $1', [result.value.campaignId]);
    if (room.rows[0]?.room_code) await announceDmTasks(room.rows[0].room_code, result.value.campaignId);
    return { saved: 'draws' };
  },

  setActive: async ({ request, params, locals }) => {
    const form = await request.formData();
    const active = form.get('active') === '1';
    const result = await attempt(() => setCharacterPartyActive(locals.user!.id, String(form.get('characterId') || ''), active, params.id));
    return result.ok ? { saved: 'character' } : result.failure;
  }
};

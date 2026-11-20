import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  ADMIN_FIND_STATUSES, clearUnmarkedCheck, listFindFilterOptions, listFindsForAdmin, revertFind
} from '$lib/server/services/forage';
import { announceUndo, publishFindChanged } from '$lib/server/vttForageRoll';

// Finds review (forage unit D): admin only. /admin/* is already gated by hooks.server.ts
// (requireAdmin); the actions re-check the role anyway, because they change inventory. Each find
// shows the campaign it ran in and can be filtered by it ("none" = older finds made before
// campaigns existed). Moving review and undo to campaign DMs is a later change (it would filter on
// finds.campaign_id). Find TABLE authoring is a separate page at /forage/tables (campaign DMs + admins).
//
// Filters live in the URL (a GET form): ?campaign=<id|none>&session=<game session id>&character=<id>&status=<all|dm|self|...>.

export const load: PageServerLoad = async ({ url }) => {
  const gameSessionId = url.searchParams.get('session') ?? '';
  const characterId = url.searchParams.get('character') ?? '';
  const campaignId = url.searchParams.get('campaign') ?? '';
  const requested = url.searchParams.get('status') ?? 'all';
  const status = (ADMIN_FIND_STATUSES as readonly string[]).includes(requested) ? requested : 'all';
  const [finds, options, stuck] = await Promise.all([
    listFindsForAdmin({ gameSessionId, characterId, status, campaignId }),
    listFindFilterOptions(),
    // Unmarked self-serve checks block that player's next forage, so they're always listed in full.
    listFindsForAdmin({ status: 'checked' })
  ]);
  return { finds, options, stuck, filter: { campaign: campaignId, session: gameSessionId, character: characterId, status } };
};

export const actions: Actions = {
  // Undo a found haul (either mode). The page confirms first. Reduces or removes only the inventory
  // rows the find wrote to, and returns the note describing exactly what happened.
  undoFind: async ({ request, locals }) => {
    if (locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
    const findId = String((await request.formData()).get('findId') ?? '');
    const reverted = await revertFind({ findId, adminUserId: locals.user.id });
    if (!reverted) return fail(409, { error: 'That find can no longer be undone (it was already undone, it found nothing, or it is not a found haul).' });
    await announceUndo(reverted, findId);
    return { undone: findId, note: reverted.note || 'Nothing needed removing.' };
  },

  // Closes a stuck unmarked check as failed so the player can forage again. Nothing is added.
  clearCheck: async ({ request, locals }) => {
    if (locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
    const findId = String((await request.formData()).get('findId') ?? '');
    const cleared = await clearUnmarkedCheck(findId);
    if (!cleared) return fail(409, { error: 'That check has already been marked or cleared.' });
    publishFindChanged(cleared.gameSessionId, findId);
    return { cleared: findId };
  }
};

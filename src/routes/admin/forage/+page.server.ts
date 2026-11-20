import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  ADMIN_FIND_STATUSES, clearUnmarkedCheck, listFindFilterOptions, listFindsForAdmin, revertFind
} from '$lib/server/services/forage';
import { announceUndo, publishFindChanged } from '$lib/server/vttForageRoll';

// Finds review (forage unit D): admin only, the de facto DM until campaigns exist. /admin/* is
// already gated by hooks.server.ts (requireAdmin); the actions re-check the role anyway, because
// they change inventory. Find TABLE authoring is a separate, non-admin page at /forage/tables.
//
// Filters live in the URL (a GET form): ?session=<game session id>&character=<id>&status=<all|dm|self|...>.

export const load: PageServerLoad = async ({ url }) => {
  const gameSessionId = url.searchParams.get('session') ?? '';
  const characterId = url.searchParams.get('character') ?? '';
  const requested = url.searchParams.get('status') ?? 'all';
  const status = (ADMIN_FIND_STATUSES as readonly string[]).includes(requested) ? requested : 'all';
  const [finds, options, stuck] = await Promise.all([
    listFindsForAdmin({ gameSessionId, characterId, status }),
    listFindFilterOptions(),
    // Unmarked self-serve checks block that player's next forage, so they're always listed in full.
    listFindsForAdmin({ status: 'checked' })
  ]);
  return { finds, options, stuck, filter: { session: gameSessionId, character: characterId, status } };
};

export const actions: Actions = {
  // Undo a found haul (either mode). The page confirms first. Reduces or removes only the inventory
  // rows the find wrote to, and returns the note describing exactly what happened.
  undoFind: async ({ request, locals }) => {
    if (locals.user?.role !== 'admin') return fail(403, { error: 'Admins only.' });
    const findId = String((await request.formData()).get('findId') ?? '');
    const reverted = await revertFind({ findId, adminUserId: locals.user.id });
    if (!reverted) return fail(409, { error: 'That find can no longer be undone (it was already undone, or it is not a found haul).' });
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

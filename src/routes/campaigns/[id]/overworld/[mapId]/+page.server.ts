import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { parsePinInput } from '$lib/overworld/input';
import { assertDeclaredSize, attemptOverworld, MAX_FORM_REQUEST_BYTES } from '$lib/server/overworldAction';
import { OverworldError } from '$lib/server/overworldError';
import { createPin, deletePin, getMapView, movePin, updatePin } from '$lib/server/services/overworld';

// The map viewer. Every action forwards to the overworld service, which does the real permission
// check (campaign role only; a non-member, site admin or not, gets 404). What load computes (canEdit,
// canChangeVisibility, the viewer flags) is just what to show.
//
// The map settings (rename, scale, share, replace image, hide) are NOT here: the settings sheet posts
// to the list page's actions (/campaigns/<id>/overworld?/updateMap ...).
export const load: PageServerLoad = async ({ params, locals, depends }) => {
  depends('overworld:map');
  const view = await getMapView(locals.user!.id, params.id, params.mapId);
  if (!view) throw error(404, 'Not found');
  return { campaignId: params.id, view };
};

// Reads a small form (declared size required and capped; a browser fetch with FormData always sends
// it) inside attemptOverworld, so a bad body is an inline error.
async function readForm(request: Request): Promise<FormData> {
  assertDeclaredSize(request, MAX_FORM_REQUEST_BYTES, true);
  return request.formData();
}

const pinIdOf = (form: FormData) => String(form.get('pinId') || '');

export const actions: Actions = {
  addPin: async ({ request, params, locals }) => {
    const result = await attemptOverworld(async () => {
      const parsed = parsePinInput(await readForm(request), 'create');
      if (!parsed.ok) throw new OverworldError('invalid', parsed.reason);
      return createPin(locals.user!.id, params.id, params.mapId, parsed.fields);
    });
    return result.ok ? { done: 'added', pinId: result.value } : result.failure;
  },

  updatePin: async ({ request, params, locals }) => {
    const result = await attemptOverworld(async () => {
      const form = await readForm(request);
      const parsed = parsePinInput(form, 'update');
      if (!parsed.ok) throw new OverworldError('invalid', parsed.reason);
      await updatePin(locals.user!.id, params.id, params.mapId, pinIdOf(form), parsed.fields);
    });
    return result.ok ? { done: 'updated' } : result.failure;
  },

  movePin: async ({ request, params, locals }) => {
    const result = await attemptOverworld(async () => {
      const form = await readForm(request);
      const parsed = parsePinInput(form, 'move');
      if (!parsed.ok) throw new OverworldError('invalid', parsed.reason);
      await movePin(locals.user!.id, params.id, params.mapId, pinIdOf(form), { x: parsed.fields.x!, y: parsed.fields.y! });
    });
    return result.ok ? { done: 'moved' } : result.failure;
  },

  deletePin: async ({ request, params, locals }) => {
    const result = await attemptOverworld(async () => {
      const form = await readForm(request);
      await deletePin(locals.user!.id, params.id, params.mapId, pinIdOf(form));
    });
    return result.ok ? { done: 'deleted' } : result.failure;
  }
};

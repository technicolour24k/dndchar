import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { parseMapFields } from '$lib/overworld/input';
import { assertSmallFormDeclared, assertUploadSizeDeclared, attemptOverworld, withMapId } from '$lib/server/overworldAction';
import { OverworldError } from '$lib/server/overworldError';
import { notifyMapGranted } from '$lib/server/overworldNotify';
import { validateUpload } from '$lib/server/overworldUpload';
import {
  archiveMap,
  assertCanManageMaps,
  createMap,
  listMapsForViewer,
  replaceMapImage,
  setMapGranted,
  updateMap
} from '$lib/server/services/overworld';
import { uploadDirIsEphemeral } from '$lib/server/uploadStorage';

// The overworld map list. Every action forwards to the overworld service, which does the real
// permission check (campaign role only: a non-member, site admin or not, gets 404 here). What the load
// computes is just what to show. The map settings actions live here too (the forms post to this page
// with a mapId), so the same actions serve the list and, later, the viewer's settings sheet.
//
// Every body is read INSIDE attemptOverworld, after a declared-size check, so a malformed or oversized
// request becomes an inline error instead of a raw 500 or a huge parse. The size check trusts the
// content-length header; the server's BODY_SIZE_LIMIT is the backstop for anything else.
export const load: PageServerLoad = async ({ params, locals, depends }) => {
  depends('overworld:list');
  const user = locals.user!;
  const list = await listMapsForViewer(user.id, params.id);
  if (!list) throw error(404, 'Not found');
  const campaign = await query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [params.id]);
  return {
    campaignId: params.id,
    campaignName: campaign.rows[0]?.name ?? '',
    list,
    // DMs get a warning when uploads would vanish on the next deploy (production, UPLOAD_DIR unset).
    uploadsEphemeral: list.viewer.canManage && uploadDirIsEphemeral()
  };
};

const mapIdOf = (form: FormData) => String(form.get('mapId') || '');

// Upload actions: check the DM rights (so a non-member gets 404, not a size error) and then the declared
// size (length required) BEFORE the body is read, so a refused or oversized request is never buffered.
async function readUploadForm(request: Request, userId: string, campaignId: string): Promise<FormData> {
  await assertCanManageMaps(userId, campaignId);
  assertUploadSizeDeclared(request);
  return request.formData();
}

// Small forms: capped declared size, then parse.
async function readSmallForm(request: Request): Promise<FormData> {
  assertSmallFormDeclared(request);
  return request.formData();
}

// Runs a per-map action. `mapId` is filled in as soon as the form is read, so both the success result
// and any failure carry it and the page can show the message next to that map.
async function mapAction(
  request: Request,
  read: (request: Request) => Promise<FormData>,
  run: (form: FormData, mapId: string) => Promise<unknown>,
  done: string
) {
  let mapId = '';
  const result = await attemptOverworld(async () => {
    const form = await read(request);
    mapId = mapIdOf(form);
    return run(form, mapId);
  });
  return result.ok ? { done, mapId } : withMapId(result.failure, mapId);
}

export const actions: Actions = {
  // Creating has no map yet, so its result is shown at the top of the page.
  create: async ({ request, params, locals }) => {
    const userId = locals.user!.id;
    const result = await attemptOverworld(async () => {
      const form = await readUploadForm(request, userId, params.id);
      const fields = parseMapFields(form);
      if (!fields.ok) throw new OverworldError('invalid', fields.reason);
      const image = await validateUpload(form.get('image'));
      await createMap(userId, params.id, { name: fields.name, milesAcross: fields.milesAcross }, image);
    });
    return result.ok ? { done: 'created' } : result.failure;
  },

  replaceImage: ({ request, params, locals }) =>
    mapAction(
      request,
      (req) => readUploadForm(req, locals.user!.id, params.id),
      async (form, mapId) => {
        const image = await validateUpload(form.get('image'));
        await replaceMapImage(locals.user!.id, params.id, mapId, image);
      },
      'replaced'
    ),

  updateMap: ({ request, params, locals }) =>
    mapAction(
      request,
      readSmallForm,
      async (form, mapId) => {
        const fields = parseMapFields(form);
        if (!fields.ok) throw new OverworldError('invalid', fields.reason);
        await updateMap(locals.user!.id, params.id, mapId, { name: fields.name, milesAcross: fields.milesAcross });
      },
      'updated'
    ),

  grant: async ({ request, params, locals }) => {
    const box: { value: { mapName: string; roomCode: string } | null } = { value: null };
    const outcome = await mapAction(
      request,
      readSmallForm,
      async (_form, mapId) => {
        box.value = await setMapGranted(locals.user!.id, params.id, mapId, true);
      },
      'granted'
    );
    // Tell anyone at the campaign's VTT table. (Unshare sends nothing.)
    if (box.value && 'done' in outcome) notifyMapGranted(box.value.roomCode, outcome.mapId, box.value.mapName);
    return outcome;
  },

  ungrant: ({ request, params, locals }) =>
    mapAction(request, readSmallForm, (_form, mapId) => setMapGranted(locals.user!.id, params.id, mapId, false), 'ungranted'),

  archive: ({ request, params, locals }) =>
    mapAction(request, readSmallForm, (_form, mapId) => archiveMap(locals.user!.id, params.id, mapId), 'archived')
};

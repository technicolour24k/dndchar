import { fail, isRedirect, redirect } from '@sveltejs/kit';
import { addContentResourceDefinition, grantContentFromContent } from '$lib/server/services/catalogue';
import {
  attachModifierToContent,
  attachEffectToAdminContent,
  detachEffectFromAdminContent,
  addSpellAccess,
  removeSpellAccess,
  attachActionToContent,
  detachActionFromContent,
  addContentResourceAction,
  createAdminContent,
  detachContentModifier,
  loadContentAdmin,
  removeContentResourceAction,
  toggleAdminContentArchive,
  updateAdminContent
} from '$lib/server/services/content-admin';
import type { ContentType } from '$lib/types/content';

type ActionEvent = { request: Request; locals: App.Locals };

export function createContentAdminPage(types: ContentType[], fallbackType: ContentType) {
  return {
    load: async ({ url }: { url: URL }) => loadContentAdmin(types, url.searchParams.get('content') || ''),
    actions: {
      create: async ({ request, locals }: ActionEvent) => {
        try {
          const form = await request.formData();
          const requested = String(form.get('contentType') || fallbackType) as ContentType;
          const type = types.includes(requested) ? requested : fallbackType;
          const id = await createAdminContent(locals.user!.id, type, form);
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not create entry.' });
        }
      },
      update: async ({ request }: ActionEvent) => {
        try {
          const id = await updateAdminContent(await request.formData());
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not update entry.' });
        }
      },
      archive: async ({ request }: ActionEvent) => {
        try { const id=await toggleAdminContentArchive(await request.formData());throw redirect(303,`?content=${id}`); }
        catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not archive entry.'});}
      },
      attachModifier: async ({ request }: ActionEvent) => {
        try {
          const id = await attachModifierToContent(await request.formData());
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not attach modifier.' });
        }
      },
      detachModifier: async ({ request }: ActionEvent) => {
        try {
          const id = await detachContentModifier(await request.formData());
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not remove modifier.' });
        }
      },
      attachEffect: async ({request}:ActionEvent)=>{try{const id=await attachEffectToAdminContent(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not attach Effect.'})}},
      detachEffect: async ({request}:ActionEvent)=>{try{const id=await detachEffectFromAdminContent(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not remove Effect.'})}},
      addResource: async ({ request }: ActionEvent) => {
        try {
          const form = await request.formData();
          await addContentResourceDefinition(form);
          throw redirect(303, `?content=${String(form.get('contentId') || '')}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not add resource.' });
        }
      },
      grantContent: async ({ request }: ActionEvent) => {
        try {
          const form = await request.formData();
          await grantContentFromContent(form);
          throw redirect(303, `?content=${String(form.get('sourceContentId') || '')}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not attach granted content.' });
        }
      }
      ,
      addResourceAction: async ({ request }: ActionEvent) => {
        try {
          const id = await addContentResourceAction(await request.formData());
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not add action.' });
        }
      },
      removeResourceAction: async ({ request }: ActionEvent) => {
        try {
          const id = await removeContentResourceAction(await request.formData());
          throw redirect(303, `?content=${id}`);
        } catch (error) {
          if (isRedirect(error)) throw error;
          return fail(400, { error: error instanceof Error ? error.message : 'Could not remove action.' });
        }
      }
      ,
      attachAction:async({request}:ActionEvent)=>{try{const id=await attachActionToContent(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not attach Action.'})}},
      detachAction:async({request}:ActionEvent)=>{try{const id=await detachActionFromContent(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not remove Action.'})}},
      addSpellAccess:async({request}:ActionEvent)=>{try{const id=await addSpellAccess(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not grant Spell.'})}},
      removeSpellAccess:async({request}:ActionEvent)=>{try{const id=await removeSpellAccess(await request.formData());throw redirect(303,`?content=${id}`)}catch(error){if(isRedirect(error))throw error;return fail(400,{error:error instanceof Error?error.message:'Could not remove Spell access.'})}}
    }
  };
}

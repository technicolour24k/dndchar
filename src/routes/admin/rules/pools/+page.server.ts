import { fail } from '@sveltejs/kit';
import { createPoolDefinition, listPoolDefinitions, togglePoolArchived, updatePoolDefinition } from '$lib/server/services/resource-pools';

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export async function load() {
  return { pools: await listPoolDefinitions({ includeArchived: true }) };
}

export const actions = {
  create: async ({ request }) => {
    try {
      return { saved: `Created ${await createPoolDefinition(await request.formData())}.` };
    } catch (error) {
      return fail(400, { error: message(error, 'Could not create the pool.') });
    }
  },
  update: async ({ request }) => {
    try {
      const form = await request.formData();
      await updatePoolDefinition(String(form.get('key') || ''), form);
      return { saved: 'Saved.' };
    } catch (error) {
      return fail(400, { error: message(error, 'Could not save the pool.') });
    }
  },
  archive: async ({ request }) => {
    try {
      await togglePoolArchived(String((await request.formData()).get('key') || ''));
      return { saved: 'Updated.' };
    } catch (error) {
      return fail(400, { error: message(error, 'Could not update the pool.') });
    }
  }
};

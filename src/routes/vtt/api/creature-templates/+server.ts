import { json } from '@sveltejs/kit';
import { listCreatureTemplates, createCreatureTemplate } from '$lib/server/services/creatureTemplates';

// Normal authenticated browser route (VTT static client calls this directly
// with a real session cookie), same posture as session-notes/+server.ts -
// no internal-secret bridge needed since vtt/server's ws process never
// originates a template itself.
export async function GET({ locals }) {
  const templates = await listCreatureTemplates(locals.user!.id);
  return json({ templates });
}

export async function POST({ request, locals }) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const tokenJson = body?.tokenJson && typeof body.tokenJson === 'object' ? body.tokenJson : null;
  if (!name || !tokenJson) return json({ error: 'missing_fields' }, { status: 400 });

  const id = await createCreatureTemplate(locals.user!.id, name, tokenJson);
  return json({ id });
}

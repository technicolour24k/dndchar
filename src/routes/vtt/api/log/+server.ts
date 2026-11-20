import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { logCombatEvent, listCombatLogEntries } from '$lib/server/services/combatLog';

// vtt/server/handlers/token.js is plain @ts-nocheck JS living outside SvelteKit's
// module graph (see docs/vtt-current-state.md Section 6 for why) - it can't import
// $lib/server/services/combatLog.ts directly (that needs $env/dynamic/private,
// which only resolves inside SvelteKit's own runtime), so the ws handler reaches
// this endpoint over a loopback HTTP call instead. This is a server-to-server call
// with no browser session to authenticate against, hence the shared-secret header
// rather than locals.user. Both sides fall back to the same default so this works
// out of the box; set VTT_INTERNAL_SECRET in production to harden it.
const INTERNAL_SECRET = env.VTT_INTERNAL_SECRET || 'vtt-internal-dev-secret';

export async function POST({ request }) {
  if (request.headers.get('x-vtt-internal-secret') !== INTERNAL_SECRET) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const encounterId = typeof body?.encounterId === 'string' ? body.encounterId : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  if (!encounterId || !message) return json({ error: 'missing_fields' }, { status: 400 });

  const entry = await logCombatEvent(encounterId, message, body?.details ?? {});
  return json(entry);
}

// Read side is used by the character sheet's polling combat-log panel and (on
// join/reconnect) the VTT client itself. hooks.server.ts exempts this whole
// path from its normal locals.user gate (to let the POST side above through
// unauthenticated from the ws process), so this handler checks locals.user
// itself instead. Matches this app's existing posture of no per-campaign
// ownership locks (see CLAUDE.md): any signed-in user who knows the encounter
// id can read its log, no additional ownership check.
export async function GET({ url, locals }) {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const encounterId = url.searchParams.get('encounterId') || '';
  const afterId = url.searchParams.get('afterId') || undefined;
  if (!encounterId) return json({ error: 'missing_encounter_id' }, { status: 400 });

  const entries = await listCombatLogEntries(encounterId, afterId);
  return json({ entries });
}

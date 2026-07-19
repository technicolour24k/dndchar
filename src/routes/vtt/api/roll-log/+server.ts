import { json } from '@sveltejs/kit';
import { listRollLogEntries } from '$lib/server/services/rollLog';

// GET only - unlike /vtt/api/log, nothing outside the normal SvelteKit request
// path ever writes a roll entry (rolls only ever originate from the character
// sheet, which already has direct server-side DB access), so there's no
// internal-secret POST side and no hooks.server.ts exemption needed here -
// this route stays behind the normal locals.user gate.
export async function GET({ url }) {
  const sessionId = url.searchParams.get('sessionId') || '';
  const afterId = url.searchParams.get('afterId') || undefined;
  if (!sessionId) return json({ error: 'missing_session_id' }, { status: 400 });

  const entries = await listRollLogEntries(sessionId, afterId);
  return json({ entries });
}

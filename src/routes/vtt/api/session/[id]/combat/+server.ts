import { json } from '@sveltejs/kit';
import { sessions, broadcast } from '$vtt/store.js';
import { createEncounter, closeEncounter } from '$lib/server/services/encounters';
import { isRoomGm } from '$lib/server/vttForage';

// Start/Stop Combat for the GM. Unlike a per-attack combat-log write (which
// happens inside vtt/server's ws process and has to reach this app over HTTP,
// see ../../log/+server.ts), this endpoint runs as normal SvelteKit route code -
// it can import both the DB-backed encounters service AND the VTT's in-memory
// session store ($vtt alias, the supported SvelteKit-route-into-vtt/server
// direction) directly, no ws round trip required. Mutating `session` here is
// visible immediately to vtt/server/handlers/token.js, since both sides share
// the exact same globalThis-backed Map (see vtt/server/store.js).
export async function POST({ request, params, locals }) {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });
  // A campaign's table is run by its GM (a ticketed seat, see vtt/server/handlers/join.js). Not even
  // a site admin gets past this unless they hold the seat. Quick rooms stay open to anyone who
  // knows the code: a known POC gap, accepted for throwaway rooms.
  if (session.campaignId && !isRoomGm(session, locals.user!.id)) return json({ error: 'not_gm' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'start') {
    const encounterId = await createEncounter(locals.user!.id, `VTT combat - room ${params.id}`);
    session.encounterId = encounterId;
    broadcast(params.id!, () => ({ type: 'combat:state', active: true, encounterId }));
    return json({ encounterId });
  }

  if (action === 'stop') {
    if (session.encounterId) {
      await closeEncounter(locals.user!.id, session.encounterId);
    }
    session.encounterId = null;
    broadcast(params.id!, () => ({ type: 'combat:state', active: false, encounterId: null }));
    return json({ ok: true });
  }

  return json({ error: 'invalid_action' }, { status: 400 });
}

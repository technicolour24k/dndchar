import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { listRollLogEntries, logRoll } from '$lib/server/services/rollLog';

// Must match the fallback in vtt/server/handlers/dice.js - see that file's
// comment for why this is a shared-secret header rather than a normal
// authenticated request.
const INTERNAL_SECRET = env.VTT_INTERNAL_SECRET || 'vtt-internal-dev-secret';

// POST side (Phase 9): the freeform dice roller's WS handler (dice.js) is
// plain @ts-nocheck JS living outside SvelteKit's module graph, same
// constraint as token.js's combat-log write path - see /vtt/api/log's own
// comment for why that means a loopback HTTP call instead of a direct
// import of rollLog.ts. Character-sheet rolls still go through the
// ?/logRoll form action directly (same process, no HTTP hop needed), so
// this is the freeform roller's only write path.
export async function POST({ request }) {
  if (request.headers.get('x-vtt-internal-secret') !== INTERNAL_SECRET) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const message = typeof body?.message === 'string' ? body.message : '';
  if (!sessionId || !message) return json({ error: 'missing_fields' }, { status: 400 });

  const visibility = body?.visibility === 'gm' ? 'gm' : 'public';
  const entry = await logRoll(sessionId, message, body?.details ?? {}, visibility);
  return json(entry ?? { ok: true });
}

// Read side is used by the VTT client on join/reconnect to backfill the Roll
// Log panel. Adding the POST side above means this path now has to be added
// to hooks.server.ts's bypass list too (a single pathname bypasses the hook
// for every method at that path, same as /vtt/api/log) - so, exactly like
// that route's GET, this handler re-checks locals.user itself now that the
// hook no longer enforces it here. Beyond that, no per-campaign ownership
// check (see CLAUDE.md): any signed-in user who knows the room's sessionId
// can read its backlog. GM-private rolls never reach this table in the first
// place (see logRoll's visibility branch), so they can't leak through here.
export async function GET({ url, locals }) {
  if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });

  const sessionId = url.searchParams.get('sessionId') || '';
  const afterId = url.searchParams.get('afterId') || undefined;
  if (!sessionId) return json({ error: 'missing_session_id' }, { status: 400 });

  const entries = await listRollLogEntries(sessionId, afterId);
  return json({ entries });
}

import { redirect } from '@sveltejs/kit';

// hooks.server.ts already requires a logged-in user for any non-public route,
// so locals.user is guaranteed here. The VTT client itself is a plain static
// app (no SvelteKit framework, per the POC spec) — this route's only job is
// to hand it the signed-in user's identity so players don't have to type
// their name in separately from the account they're already using.
export function load({ locals }) {
  const user = locals.user!;
  const params = new URLSearchParams({ playerId: user.id, playerName: user.displayName });
  throw redirect(303, `/vtt-app/index.html?${params.toString()}`);
}

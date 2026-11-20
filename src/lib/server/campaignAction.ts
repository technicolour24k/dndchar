import { fail, isRedirect, type ActionFailure } from '@sveltejs/kit';
import { CampaignError } from '$lib/server/campaignError';

export { CampaignError };

// Runs a campaign service call inside a form action. The services throw CampaignErrors with
// user-facing messages ("This campaign already has a co-DM."), which become an inline form error.
// Anything else (a database error, a bug) is logged and shown as a generic message, so raw
// error text never reaches the page. Redirects thrown by the action itself pass straight through.
export async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: ActionFailure<{ error: string }> }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof CampaignError) return { ok: false, failure: fail(400, { error: error.message }) };
    console.error('[campaigns] unexpected error', error);
    return { ok: false, failure: fail(500, { error: 'Something went wrong, please try again.' }) };
  }
}

/** The signed-in user's id. The hook already redirects anonymous users, this is the belt and braces. */
export function requireUserId(locals: { user: { id: string } | null }): string {
  if (!locals.user) throw new Error('Not signed in.');
  return locals.user.id;
}

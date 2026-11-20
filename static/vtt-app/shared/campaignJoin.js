// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure helpers for joining a campaign's VTT table (campaign-system plan, unit F). No DOM, no fetch,
// so they can be unit tested from src/ (see src/lib/server/vttCampaignClient.test.ts) and the
// browser imports the same file. campaign.js does the fetching and the drawing; every decision about
// WHAT to do after a ticket failure, a join error, a kick or a closed socket lives here.
//
// The server side of this contract is vtt/server/handlers/join.js and
// src/routes/vtt/api/campaigns/[id]/ticket/+server.ts. Tickets are single use and expire after 60s,
// so every connect and reconnect fetches a fresh one.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads ?campaignId=&role= from the page URL. null = not a campaign table (a Quick room page). */
export function readCampaignParams(search) {
  const params = new URLSearchParams(search || '');
  const campaignId = params.get('campaignId');
  if (!campaignId || !UUID.test(campaignId)) return null;
  // Anything other than an explicit 'gm' opens as a player; the server decides what is allowed anyway.
  return { campaignId, role: params.get('role') === 'gm' ? 'gm' : 'player' };
}

/** How long a join has to hold before reconnect back-off resets (a join-then-close flap keeps backing off). */
export const STABLE_JOIN_MS = 10000;

/** Where "sign in" sends a logged-out table tab: the login page, which returns here afterwards (its ?next flow). */
export function loginHref(campaignId, role) {
  const back = `/vtt-app/index.html?${new URLSearchParams({ campaignId, role: role === 'gm' ? 'gm' : 'player' }).toString()}`;
  return `/login?next=${encodeURIComponent(back)}`;
}

/** The table link the lobby and the campaign page use (a mirror of tableHref in src/lib/campaigns/vttLinks.ts). */
export function tableHref(campaignId, role, user) {
  const params = new URLSearchParams({ campaignId, role: role === 'gm' ? 'gm' : 'player' });
  if (user && user.id) params.set('playerId', user.id);
  if (user && user.name) params.set('playerName', user.name);
  return `/vtt-app/index.html?${params.toString()}`;
}

export const STOP_MESSAGE = "Couldn't join the table. Try again from the table lobby.";
export const REMOVED_MESSAGE = "You're no longer in this campaign, or it has been archived, so the table has closed for you.";
export const GM_REPLACED_MESSAGE = "The DM has taken the GM seat. You're now viewing the table as a player.";
export const NOT_DM_MESSAGE = "You're not a DM for this campaign any more, so you've joined as a player.";

/** Button labels. campaign.js maps the action names below onto these. */
export const ACTION_LABELS = {
  takeover: 'Take over the GM seat',
  player: 'Open as player',
  lobby: 'Back to the lobby',
  retry: 'Try again',
  signin: 'Sign in'
};

/**
 * What to do when the ticket request fails. `status` 0 means the request never got an answer
 * (network down, server restarting); `error` is the route's error code if it sent one.
 * kinds: 'fallback_player' (ask again as a player), 'retry' (try again shortly), 'login' (signed out),
 * 'stop' (show a message).
 */
export function describeTicketFailure({ status, error, requestedRole }) {
  // A logged-out session is redirected to the login page, which the client sees as a 401.
  if (status === 401) {
    return { kind: 'login', title: 'Signed out', message: 'Your login has expired - sign in again.', actions: ['signin', 'lobby'] };
  }
  if (status === 403 && error === 'not_dm' && requestedRole === 'gm') {
    return { kind: 'fallback_player', message: NOT_DM_MESSAGE };
  }
  if (status === 403) return { kind: 'stop', title: 'Not at this table', message: REMOVED_MESSAGE, actions: ['lobby'] };
  if (status === 404) {
    return { kind: 'stop', title: 'Campaign not found', message: "That campaign couldn't be found. It may have been removed.", actions: ['lobby'] };
  }
  if (status === 0 || status >= 500) {
    return { kind: 'retry', message: "Can't reach the server just now. Trying again..." };
  }
  return { kind: 'stop', title: "Couldn't join the table", message: STOP_MESSAGE, actions: ['lobby'] };
}

/**
 * What to do with a `join:error` from the websocket server.
 * ctx.auto: this attempt was an automatic reconnect (or a reload of a tab that already had the
 * table), so a takeover of our OWN stale socket needs no question. ctx.ticketRetried: a fresh
 * ticket was already tried once for this join.
 * kinds: 'retry_ticket', 'takeover', 'prompt' (a question with buttons), 'stop' (message + buttons).
 */
export function describeJoinError(msg, ctx = {}) {
  const reason = msg && msg.reason;
  switch (reason) {
    case 'bad_ticket':
    case 'session_not_found':
      // An expired or already-used ticket (slow network, a double connect): fetch a fresh one, once.
      if (!ctx.ticketRetried) return { kind: 'retry_ticket' };
      return { kind: 'stop', title: "Couldn't join the table", message: STOP_MESSAGE, actions: ['lobby'] };

    case 'ticket_required':
      return { kind: 'stop', title: "Couldn't join the table", message: STOP_MESSAGE, actions: ['lobby'] };

    case 'gm_seat_taken': {
      if (!msg.canTakeOver) return gmAlreadyClaimed();
      // heldBy 'self' = our own older socket (a second tab, or a stale one after sleep or a refresh).
      // Older servers don't send it; treat that as somebody else, which asks first (the safe choice).
      if (msg.heldBy === 'self') {
        if (ctx.auto) return { kind: 'takeover', takeoverOf: 'self' };
        return {
          kind: 'prompt',
          title: 'Table already open',
          message: 'You already have this table open elsewhere. Take over here? The other window will switch to a player view.',
          actions: ['takeover', 'player', 'lobby'],
          takeoverOf: 'self'
        };
      }
      return {
        kind: 'prompt',
        title: 'Your co-DM is running the table',
        message: 'Taking over the GM seat moves them to a player view. You can also open the table as a player and leave them to it.',
        actions: ['takeover', 'player', 'lobby'],
        takeoverOf: 'co'
      };
    }

    case 'gm_already_claimed':
      return gmAlreadyClaimed();

    default:
      return { kind: 'stop', title: "Couldn't join the table", message: `${STOP_MESSAGE}${reason ? ` (${reason})` : ''}`, actions: ['lobby'] };
  }
}

function gmAlreadyClaimed() {
  return {
    kind: 'prompt',
    title: 'The DM is running this table',
    message: 'The GM seat is already taken. You can open the table as a player instead.',
    actions: ['player', 'lobby']
  };
}

/** What to do with a `kicked` message. 'stop' ends it; 'reconnect' asks for a fresh ticket (the role may have changed). */
export function describeKick(reason) {
  if (reason === 'removed_from_campaign') {
    return { kind: 'stop', title: 'Removed from the table', message: REMOVED_MESSAGE, actions: ['lobby'] };
  }
  if (reason === 'role_changed') {
    return { kind: 'reconnect', message: 'Your role in this campaign has changed, so you are being reconnected.' };
  }
  return { kind: 'stop', title: 'Disconnected', message: 'You were disconnected from the table. You can reopen it from the lobby.', actions: ['retry', 'lobby'] };
}

/**
 * How long to wait before the next automatic attempt. Once we have been joined, keep trying for as
 * long as it takes (a server restart can take a while, like the Quick room reconnect). A table we
 * never managed to join gives up after a few tries so a real problem doesn't spin for ever.
 * -> { delayMs } or { giveUp: true }
 */
export function reconnectPlan({ everJoined, attempt }) {
  if (!everJoined && attempt >= 5) return { giveUp: true };
  return { delayMs: attempt < 3 ? 1500 : 5000 };
}

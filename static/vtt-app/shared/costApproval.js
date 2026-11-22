// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure helpers for the cost-engine DM approval UI (cost-engine plan, unit 6). No DOM, no fetch, so they
// can be unit tested from src/ (src/lib/server/vttCostApprovalView.test.ts) and shared by the character
// sheet (Svelte), the VTT player client and the VTT GM sidebar (plain JS). The server decides everything
// (src/lib/server/vttCostGate.ts); this file only words the prompts and picks the next step.

export const CAPACITY_SENTENCE = "It doesn't look like you've got the capacity to do that.";
export const WAITING_TEXT = 'Waiting for the DM...';
/** An approval stops working this long after the DM approved it (mirrors APPROVAL_TTL_MS on the server). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** "Needs 1 Vowfire, you have 0" for each short line. */
export function shortfallLines(shortfalls) {
  return (shortfalls || []).map((line) => `Needs ${line.needed} ${line.label}, you have ${line.available}`);
}

/**
 * What the prompt for a 409 'insufficient' shows. `mode` is the server's: dm_self (you are the DM),
 * ask_dm (a DM is connected), no_dm (nobody is). 'no_dm_pending' is no_dm for a request that is already
 * waiting when the DM leaves: the safe choice withdraws it.
 * The `primary` choice is the focused one and the one Escape or a backdrop click picks. For no_dm
 * that is "No - cancel", and going ahead is the deliberate second button.
 */
export function promptSpec(mode) {
  if (mode === 'dm_self') {
    return {
      mode, question: `${CAPACITY_SENTENCE} You're the DM - go ahead anyway?`,
      primary: { id: 'go_ahead', label: 'Go ahead' }, secondary: { id: 'cancel', label: 'Cancel' }, escape: 'cancel', note: ''
    };
  }
  if (mode === 'no_dm' || mode === 'no_dm_pending') {
    return {
      mode, question: `${CAPACITY_SENTENCE} There's no DM connected right now. Did your DM OK this?`,
      primary: mode === 'no_dm' ? { id: 'cancel', label: 'No - cancel' } : { id: 'withdraw', label: 'No - withdraw' },
      secondary: { id: 'self', label: "Yes, the DM OK'd it" },
      escape: mode === 'no_dm' ? 'cancel' : 'withdraw', note: "It'll be logged for your DM to review."
    };
  }
  return {
    mode: 'ask_dm', question: `${CAPACITY_SENTENCE} Do you want to ask the DM?`,
    primary: { id: 'ask', label: 'Ask the DM' }, secondary: { id: 'cancel', label: 'Cancel' }, escape: 'cancel', note: ''
  };
}

/** The mode for a response body or error code from the server, else null. */
export function modeFrom(body) {
  const mode = body?.mode || body?.error;
  return mode === 'dm_self' || mode === 'ask_dm' || mode === 'no_dm' ? mode : null;
}

/** Is this server response a "can't afford it" 409 the UI can offer a way past? */
export function isInsufficient(body) {
  return body?.error === 'insufficient' && Array.isArray(body.shortfalls);
}

const APPROVAL_REASONS = {
  not_found: "That approval has gone, so it can't be used.",
  not_approved: 'That approval was already used or is not approved yet.',
  expired: 'That approval ran out after 15 minutes. Ask again if you still want to.',
  wrong_activation: 'That approval was for something different.',
  wrong_character: 'That approval was for a different character.',
  not_yours: 'That approval belongs to someone else.'
};

/** Plain text for a refused override or approval (the server's `costError` / 4xx body). */
export function approvalErrorText(body) {
  if (body?.error === 'approval_invalid') return APPROVAL_REASONS[body.reason] || 'That approval can no longer be used.';
  if (body?.error === 'forbidden') return 'Only the DM can go ahead over budget.';
  if (body?.error === 'wrong_room' || body?.error === 'not_in_room') return "You aren't in the right room for that.";
  return 'Could not go ahead with that.';
}

/** What to tell a player whose request closed without them using it. Null when nothing needs saying. */
export function closedMessage(outcome) {
  if (outcome === 'denied') return 'The DM said no - nothing was spent.';
  if (outcome === 'expired') return 'The approval ran out after 15 minutes - nothing was spent. Ask again if you still want to.';
  if (outcome === 'withdrawn') return 'The request was cancelled - nothing was spent.';
  return null;
}

/** "The DM approved Fireball" for the banner shown when the original click was lost (a reload). */
export function bannerText(request) {
  return `The DM approved ${request?.activationLabel || 'that'}${request?.waive ? ' (it will cost nothing)' : ''}.`;
}

/**
 * What the player's UI should do with the latest /mine answer.
 *   none            nothing pending
 *   waiting         asked, DM connected: show "Waiting for the DM..."
 *   no_dm_pending   asked, but the DM has since left: show the no-DM prompt
 *   resume          approved and we still hold the original click: run it with the approval
 *   banner          approved, but the click was lost: offer "Use now"
 * `holdingId` is the id of the request the held click is waiting on (null when nothing is held).
 */
export function mineStep(mine, holdingId) {
  const request = mine?.request;
  if (!request) return 'none';
  if (request.status === 'approved') return holdingId && holdingId === request.id ? 'resume' : 'banner';
  if (request.status === 'pending') return mine.dmPresent ? 'waiting' : 'no_dm_pending';
  return 'none';
}

/** Ms left on an approval (0 once spent or expired), on the server's clock. */
export function approvalMsLeft(request, serverNow) {
  if (!request || request.status !== 'approved' || !request.approvedAt) return 0;
  return Math.max(0, request.approvedAt + APPROVAL_TTL_MS - serverNow);
}

/**
 * The form entries and sheet action that re-run an activation (used by the banner's "Use now").
 * Mirrors castCharacterSpell's / useInventoryCatalogueItem's / triggerCharacterContentActions's fields.
 */
export function formForActivation(activation) {
  if (!activation) return null;
  if (activation.kind === 'spell') {
    const entries = [['instanceId', activation.instanceId]];
    if (activation.slotType) entries.push(['slotType', activation.slotType]);
    if (activation.slotLevel) entries.push(['slotLevel', String(activation.slotLevel)]);
    if (activation.followup) entries.push(['followup', activation.followup]);
    return { action: 'castSpell', entries };
  }
  if (activation.kind === 'spell_access') {
    const entries = [['spellAccessId', activation.spellAccessId], ['inventoryItemId', activation.inventoryItemId]];
    if (activation.slotType) entries.push(['slotType', activation.slotType]);
    if (activation.slotLevel) entries.push(['slotLevel', String(activation.slotLevel)]);
    if (activation.followup) entries.push(['followup', activation.followup]);
    return { action: 'castSpell', entries };
  }
  if (activation.kind === 'weapon_attack') {
    // Only a real weapon can be re-run from the sheet (an id-less attack has no sheet row), and a dash never.
    if (!activation.inventoryId) return null;
    const entries = [['kind', 'weapon_attack'], ['inventoryId', activation.inventoryId]];
    if (activation.timing) entries.push(['timing', activation.timing]);
    if (activation.followup) entries.push(['followup', activation.followup]);
    return { action: 'payTurn', entries };
  }
  if (activation.kind === 'item') return { action: 'useItem', entries: [['inventoryId', activation.inventoryId]] };
  if (activation.kind === 'content') return { action: 'triggerContent', entries: [['instanceId', activation.instanceId]] };
  return null;
}

// --- The GM side ------------------------------------------------------------------------------

/** "Aria - Fireball (short 1 Vowfire)" */
export function gmRequestText(request) {
  const short = (request?.shortfalls || []).map((line) => `${Math.max(1, line.needed - line.available)} ${line.label}`).join(', ');
  return `${request?.characterName || 'Someone'} - ${request?.activationLabel || 'something'}${short ? ` (short ${short})` : ''}`;
}

/** The requests the GM still has to decide (pending only), oldest first. */
export function pendingQueue(costRequests) {
  return Object.values(costRequests || {})
    .filter((request) => request && request.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Applies a cost:update (replace/insert) or cost:closed (remove) to a costRequests map, in place. */
export function applyCostMessage(costRequests, msg) {
  if (msg?.type === 'cost:update' && msg.request?.characterId) {
    costRequests[msg.request.characterId] = msg.request;
  } else if (msg?.type === 'cost:closed') {
    for (const [characterId, request] of Object.entries(costRequests)) {
      if (request.id === msg.requestId) delete costRequests[characterId];
    }
  }
  return costRequests;
}

/** Wording for a failed GM decision. */
export function gmErrorText(code) {
  if (code === 'stale_request') return 'That request has already gone.';
  if (code === 'wrong_status') return 'That request was already decided.';
  if (code === 'busy') return 'Still working on that one.';
  if (code === 'not_gm') return "Only the room's GM can decide this.";
  return 'Could not do that. Try again.';
}

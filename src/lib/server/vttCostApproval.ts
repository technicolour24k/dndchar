import crypto from 'node:crypto';
import { sessions, broadcast, publish, dmPresent, costViewForPlayer } from '$vtt/store.js';
import { activationSignature } from '$lib/rules/cost';
import { isRoomGm } from '$lib/server/vttForage';
import type { Activation, CostShortfall, SlotType } from '$lib/types/cost';
import type { CostOverride } from '$lib/server/services/cost-engine';

// Cost-engine DM approval: the in-memory request state on the VTT room (docs: plans/dndchar/cost-engine,
// Unit 5). Modelled on vttForage.ts and kept pure (no DB) so it is tested with fake sessions. The
// request lives on the room as session.costRequests[characterId]. Overspends are paid in the DB by
// the cost engine; this file only holds who asked, who approved and when.
//
// The socket only notifies: cost:update goes to the GM (everything) and the requester (their own
// view), cost:ping goes to the room topic with no detail. NEVER add cost:* to the watchable
// broadcast types in vtt/server/store.js (watch subscriptions are unauthenticated).

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export type CostRequestStatus = 'pending' | 'approved' | 'used';
export type CostOutcome = 'used' | 'denied' | 'withdrawn' | 'expired';

export type CostRequest = {
  id: string;
  characterId: string;
  characterName: string;
  playerId: string;
  playerName: string;
  source: 'sheet' | 'vtt';
  activation: Activation;
  activationLabel: string;
  shortfalls: CostShortfall[];
  // 'used' only while the approved activation is running (so a second click can't reuse it).
  status: CostRequestStatus;
  createdAt: number;
  approvedBy?: string;
  approvedByName?: string;
  approvedAt?: number;
  waive?: boolean;
  /** True while a GM action is mid-flight, so a double click can't act twice. Not sent to the player. */
  busy?: boolean;
};

type Recipient = { role: string | null; playerId: string | null };

export function costMap(session: any): Record<string, CostRequest> {
  return (session.costRequests ??= {});
}

export function getCostRequest(session: any, requestId: unknown): CostRequest | null {
  if (typeof requestId !== 'string') return null;
  for (const request of Object.values(session.costRequests ?? {}) as CostRequest[]) {
    if (request.id === requestId) return request;
  }
  return null;
}

/** Finds a request by id in any live room (a scan of the tiny sessions map). */
export function findCostRequest(requestId: unknown): { session: any; request: CostRequest } | null {
  for (const session of sessions.values()) {
    const request = getCostRequest(session, requestId);
    if (request) return { session, request };
  }
  return null;
}

/** The user's own request, by id, in any live room. */
export function findOwnCostRequest(userId: string, requestId: unknown): { session: any; request: CostRequest } | null {
  const found = findCostRequest(requestId);
  return found && found.request.playerId === userId ? found : null;
}

export function newCostRequest(input: {
  characterId: string; characterName: string; playerId: string; playerName: string; source: 'sheet' | 'vtt';
  activation: Activation; activationLabel: string; shortfalls: CostShortfall[];
}): CostRequest {
  return { id: crypto.randomUUID(), ...input, status: 'pending', createdAt: Date.now() };
}

// --- Using an approval ------------------------------------------------------------------------

export type ApprovalVerdict = { ok: true } | { ok: false; reason: 'not_approved' | 'wrong_character' | 'wrong_activation' | 'expired' | 'not_yours' };

/** May this approval unlock this exact activation, for this user, right now? */
export function approvalVerdict(
  request: CostRequest, input: { userId: string; characterId: string; signature: string; now?: number }
): ApprovalVerdict {
  if (request.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (request.characterId !== input.characterId) return { ok: false, reason: 'wrong_character' };
  if (request.playerId !== input.userId) return { ok: false, reason: 'not_yours' };
  if (activationSignature(request.activation) !== input.signature) return { ok: false, reason: 'wrong_activation' };
  if ((input.now ?? Date.now()) - (request.approvedAt ?? 0) > APPROVAL_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** Marks an approved request as in use. Synchronous on purpose: no await between the verdict and this. */
export function claimApproval(request: CostRequest): void {
  request.status = 'used';
}

/** The activation failed for another reason (e.g. "not prepared"), so the player may retry. */
export function releaseApproval(request: CostRequest): void {
  if (request.status === 'used') request.status = 'approved';
}

// --- Who is the DM, which room ---------------------------------------------------------------

/** Does this room belong to the character's campaign (both null = a Quick room for a campaign-less character)? */
export function roomMatchesCampaign(session: any, characterCampaignId: string | null | undefined): boolean {
  return (session.campaignId ?? null) === (characterCampaignId ?? null);
}

/**
 * Campaign DM/co-DM of the character's campaign (from access), or the live GM of a room that belongs to
 * the character's campaign. A room-GM claim in any other room (e.g. a Quick room anyone can create and
 * join as GM) never counts for a campaign character. A site admin is neither.
 */
export function isActorDm(input: { isCampaignDm: boolean; session: any | null; userId: string; characterCampaignId?: string | null }): boolean {
  if (input.isCampaignDm) return true;
  return !!input.session && roomMatchesCampaign(input.session, input.characterCampaignId) && isRoomGm(input.session, input.userId);
}

export type CostRoom = { session: any | null; error?: undefined } | { session?: undefined; error: 'not_in_room' | 'wrong_room' };

/**
 * The live room a cost request belongs to.
 *   - A campaign character always uses its campaign's OWN room (campaigns.room_code), whatever the
 *     player's active room or roomId say, so "is a DM present" is always about the campaign's table.
 *   - A campaign-less character uses the explicit roomId or the owner's active room, and only a room
 *     with no campaign (a Quick room) matches.
 *   - An explicit roomId that is live must match the character's campaign strictly (else wrong_room)
 *     and have the actor in it (a player, a token owner or the GM).
 */
export function resolveCostRoom(input: {
  userId: string; roomId?: string | null; ownerActiveRoomId?: string | null; characterCampaignId?: string | null;
  campaignRoomCode?: string | null;
}): CostRoom {
  const matchesCampaign = (session: any) => roomMatchesCampaign(session, input.characterCampaignId);
  const explicit = input.roomId ? sessions.get(input.roomId) ?? null : null;
  if (explicit) {
    const tokens = Object.values(explicit.tokens ?? {}) as any[];
    const inRoom = !!explicit.players?.[input.userId] || tokens.some((token) => token.ownerId === input.userId) || isRoomGm(explicit, input.userId);
    if (!inRoom) return { error: 'not_in_room' };
    if (!matchesCampaign(explicit)) return { error: 'wrong_room' };
  }
  if (input.characterCampaignId) {
    const own = input.campaignRoomCode ? sessions.get(input.campaignRoomCode) ?? null : null;
    return { session: own && matchesCampaign(own) ? own : null };
  }
  const active = input.ownerActiveRoomId ? sessions.get(input.ownerActiveRoomId) ?? null : null;
  const candidates = [explicit, active && matchesCampaign(active) ? active : null].filter(Boolean);
  return { session: candidates.find((session) => dmPresent(session)) ?? candidates[0] ?? null };
}

// --- Messages ---------------------------------------------------------------------------------

/** cost:update for one recipient: the GM gets the whole request, the requester their own view. */
export function costMessageFor(recipient: Recipient, request: CostRequest) {
  if (recipient.role === 'gm') return { type: 'cost:update', request: { ...request, busy: undefined } };
  if (recipient.role === 'player' && recipient.playerId && recipient.playerId === request.playerId) {
    return { type: 'cost:update', request: costViewForPlayer(request) };
  }
  return null;
}

export function costClosedFor(recipient: Recipient, request: CostRequest, outcome: CostOutcome) {
  const message = { type: 'cost:closed', requestId: request.id, characterId: request.characterId, playerId: request.playerId, outcome };
  if (recipient.role === 'gm') return message;
  if (recipient.role === 'player' && recipient.playerId && recipient.playerId === request.playerId) return message;
  return null;
}

/** Detail-free "fetch /mine" nudge on the room's watch topic. Carries only the user id. */
export function costNudge(sessionId: string): void {
  // No user id and no detail: watch subscriptions are unauthenticated. Clients just re-fetch /mine.
  publish(`room:${sessionId}`, { type: 'cost:ping' });
}

/** Closes approved requests older than the approval window (called whenever a request is made). */
export function sweepExpiredCostRequests(session: any, now = Date.now()): void {
  for (const request of Object.values(costMap(session))) {
    if (request.status === 'approved' && now - (request.approvedAt ?? 0) > APPROVAL_TTL_MS) closeCostRequest(session, request, 'expired');
  }
}

export function broadcastCostUpdate(session: any, request: CostRequest): void {
  broadcast(session.id, (recipient: Recipient) => costMessageFor(recipient, request));
  costNudge(session.id);
}

/** Removes the request (if it is still the live one) and tells the GM and the requester. */
export function closeCostRequest(session: any, request: CostRequest, outcome: CostOutcome): void {
  const map = costMap(session);
  if (map[request.characterId] === request) delete map[request.characterId];
  broadcast(session.id, (recipient: Recipient) => costClosedFor(recipient, request, outcome));
  costNudge(session.id);
}

// --- Activations from request input -----------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

function slotChoiceOf(raw: any): { slotType?: SlotType; slotLevel?: number } {
  const slotType = raw?.slotType === 'standard' || raw?.slotType === 'pact' ? raw.slotType : undefined;
  const level = Number(raw?.slotLevel);
  const slotLevel = Number.isInteger(level) && level >= 1 && level <= 9 ? level : undefined;
  return { ...(slotType ? { slotType } : {}), ...(slotLevel ? { slotLevel } : {}) };
}

/** An activation descriptor from a request body, or null if it isn't well formed. */
export function parseActivation(raw: any): Activation | null {
  if (!raw || typeof raw !== 'object') return null;
  // An explicit follow-up choice ('use' | 'skip' | 'require'); anything else is not a valid activation.
  if (raw.followup !== undefined && raw.followup !== 'use' && raw.followup !== 'skip' && raw.followup !== 'require') return null;
  const followup = raw.followup ? { followup: raw.followup as 'use' | 'skip' | 'require' } : {};
  if (raw.kind === 'spell' && isId(raw.instanceId)) return { kind: 'spell', instanceId: raw.instanceId, ...slotChoiceOf(raw), ...followup };
  if (raw.kind === 'spell_access' && isId(raw.spellAccessId) && isId(raw.inventoryItemId)) {
    return { kind: 'spell_access', spellAccessId: raw.spellAccessId, inventoryItemId: raw.inventoryItemId, ...slotChoiceOf(raw), ...followup };
  }
  if (raw.kind === 'item' && isId(raw.inventoryId)) return { kind: 'item', inventoryId: raw.inventoryId };
  if (raw.kind === 'content' && isId(raw.instanceId)) return { kind: 'content', instanceId: raw.instanceId };
  if (raw.kind === 'weapon_attack') {
    // A real weapon (uuid) or an id-less attack named by a label (Unarmed Strike, a GM-added action).
    const hasId = raw.inventoryId !== null && raw.inventoryId !== undefined;
    if (hasId && !isId(raw.inventoryId)) return null;
    if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== 'string' || raw.label.length > 80)) return null;
    if (!hasId && !(typeof raw.label === 'string' && raw.label.trim())) return null;
    if (raw.timing !== undefined && !ATTACK_TIMINGS.includes(raw.timing)) return null;
    return {
      kind: 'weapon_attack', inventoryId: hasId ? raw.inventoryId : null,
      ...(!hasId ? { label: raw.label.trim() } : {}), ...(raw.timing ? { timing: raw.timing } : {}), ...followup
    };
  }
  if (raw.kind === 'dash' && Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= 9) return { kind: 'dash', count: raw.count };
  return null;
}

const ATTACK_TIMINGS = ['action', 'bonus_action', 'reaction'];

/** The activation castCharacterSpell derives from its form (same fields, same slot normalising). */
export function activationFromCastForm(form: FormData): Activation {
  const slot = slotChoiceOf({ slotType: String(form.get('slotType') || ''), slotLevel: form.get('slotLevel') });
  const choice = String(form.get('followup') || '');
  const followup = choice === 'use' || choice === 'skip' || choice === 'require' ? { followup: choice as 'use' | 'skip' | 'require' } : {};
  const accessId = String(form.get('spellAccessId') || '');
  if (accessId) return { kind: 'spell_access', spellAccessId: accessId, inventoryItemId: String(form.get('inventoryItemId') || ''), ...slot, ...followup };
  return { kind: 'spell', instanceId: String(form.get('instanceId') || ''), ...slot, ...followup };
}

// --- Roll-log wording -------------------------------------------------------------------------

/** "1 Vowfire, 2 Level 3 Spell Slot": how much each short line is short by. */
export function shortfallText(shortfalls: CostShortfall[]): string {
  return shortfalls.map((line) => `${Math.max(1, line.needed - line.available)} ${line.label}`).join(', ');
}

const verbFor = (activation: Activation) => (activation.kind === 'spell' || activation.kind === 'spell_access' ? 'cast' : 'used');

// "Aria cast Fireball", "Aria attacked with Longsword", "Aria dashed". The engine labels a weapon
// attack "<weapon> attack" and a dash "Dash", so those read naturally here.
function whatDid(activation: Activation, label: string): string {
  if (activation.kind === 'dash') return 'dashed';
  if (activation.kind === 'weapon_attack') return `attacked with ${label.replace(/ attack$/, '')}`;
  return `${verbFor(activation)} ${label}`;
}

/** The public roll-log line for an override that let a short activation through. */
export function overrideLogMessage(input: {
  characterName: string; label: string; activation: Activation; kind: CostOverride['kind']; shortfalls: CostShortfall[];
  waived: boolean; approvedByName?: string;
}): string {
  const head = `${input.characterName} ${whatDid(input.activation, input.label)} over budget (short ${shortfallText(input.shortfalls)})`;
  if (input.kind === 'dm_approved') return `${head} - approved by ${input.approvedByName || 'the DM'}${input.waived ? ', spending nothing' : ''}.`;
  if (input.kind === 'dm_self') return `${head} - the DM's call${input.waived ? ', spending nothing' : ''}.`;
  return `${head} - the player says the DM OK'd it (not yet reviewed).`;
}

export function denyLogMessage(request: Pick<CostRequest, 'characterName' | 'activationLabel'>): string {
  return `The DM declined ${request.characterName}'s ${request.activationLabel}.`;
}

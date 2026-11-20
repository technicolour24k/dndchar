import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions, dmPresent, forageViewForPlayer } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { forageItemCount } from '$lib/rules/forage';
import { getSuggestedCheck, getUnmarkedSelfFind, markSelfFind, startSelfFind } from '$lib/server/services/forage';
import {
  broadcastForageUpdate, closeRequest, canWithdraw, findPendingForUser, forageMap, forageNudge, forageResultsMap,
  newRequest, resolveForageRoom, rollLogMessage
} from '$lib/server/vttForage';
import {
  ForageRollError, forageLogDetails, logForageRoll, previewForageAdvantage, rollForageCheck
} from '$lib/server/vttForageRoll';
import { isUuid, loadOwnedCharacter, parseChoice, shortText } from '$lib/server/vttForageApi';

// Player-facing forage actions (vtt-forage plan, unit B). All writes are HTTP, the socket only
// notifies. Every character action first checks the character is the caller's own. The mode is
// decided here, at submit time: DM mode when the room is live and has a connected account GM,
// otherwise self-serve (the player marks their own check and the haul goes straight in).
//
// Statuses: 400 bad input, 403 not allowed in that room, 404 not your character, 409 a conflict the
// client can act on ('resume' carries the existing in-flight forage so the popup can reopen it).

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, { status });

export const POST: RequestHandler = async ({ locals, request }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  try {
    if (action === 'preview') return await previewAction(userId, body);
    if (action === 'start') return await startAction(userId, locals.user!.displayName, body);
    if (action === 'self_mark') return await selfMarkAction(userId, body);
    if (action === 'withdraw') return withdrawAction(userId, body);
    if (action === 'dismiss') return dismissAction(userId, body);
  } catch (error) {
    if (error instanceof ForageRollError) {
      return err(error.code, error.code === 'bad_skill' ? 400 : 404);
    }
    console.error('[forage] action failed', action, error);
    return err('server_error', 500);
  }
  return err('invalid_action', 400);
};

// The no-roll sources for the popup's advantage panel (sheet modifiers plus the character's token
// conditions when it has a token in the room).
async function previewAction(userId: string, body: any) {
  const owned = await loadOwnedCharacter(userId, body?.characterId);
  if (!owned) return err('not_found', 404);
  const room = resolveForageRoom({
    userId, roomId: shortText(body?.roomId, 64) || null, characterId: body.characterId,
    tokenId: shortText(body?.tokenId, 200) || null, activeRoomId: owned.activeRoomId
  });
  if (room.error) return err(room.error, 403);
  const preview = await previewForageAdvantage({
    characterId: body.characterId, skillKey: shortText(body?.skillKey, 40), token: room.token,
    sessionId: room.session?.id ?? null, body
  });
  return json(preview);
}

async function startAction(userId: string, displayName: string, body: any) {
  const owned = await loadOwnedCharacter(userId, body?.characterId);
  if (!owned) return err('not_found', 404);
  const characterId: string = body.characterId;

  const picked = await parseChoice(body);
  if ('error' in picked) return err(picked.error, picked.error === 'table_empty' ? 409 : 400);

  // Everything async that has to happen before the in-memory check-and-set below, so that two
  // quick starts can't both pass the "nothing in flight" check (no await between it and the set).
  const unmarked = await getUnmarkedSelfFind(userId);
  if (unmarked) return err('resume', 409, { unmarkedSelf: unmarked });
  const suggestedCheck = await getSuggestedCheck(picked.choice.tableId);

  const room = resolveForageRoom({
    userId, roomId: shortText(body?.roomId, 64) || null, characterId,
    tokenId: shortText(body?.tokenId, 200) || null, activeRoomId: owned.activeRoomId
  });
  if (room.error) return err(room.error, 403);
  const session = room.session;

  // One forage in flight per user, across rooms and modes.
  const pending = findPendingForUser(userId);
  if (pending) return err('resume', 409, { pending: forageViewForPlayer(pending.request), roomId: pending.session.id });

  if (session && dmPresent(session)) {
    // DM mode: nothing is rolled yet. The request waits for the GM, pre-filled with the picks.
    const created = newRequest({
      playerId: userId, playerName: displayName, characterId, characterName: owned.name,
      tokenId: room.token?.id ?? null, source: shortText(body?.roomId, 64) ? 'vtt' : 'sheet',
      choice: picked.choice, suggestedCheck
    });
    forageMap(session)[userId] = created;
    // A new request replaces the finder's old closed result.
    delete forageResultsMap(session)[userId];
    broadcastForageUpdate(session, created);
    return json({ mode: 'dm', roomId: session.id, request: forageViewForPlayer(created) });
  }

  // Self-serve: the server rolls the check now and logs it as an unmarked find.
  const check = await rollForageCheck({
    characterId, skillKey: picked.choice.skillKey, token: room.token, sessionId: session?.id ?? null, body
  });
  const started = await startSelfFind({
    characterId, finderUserId: userId, tableId: picked.choice.tableId, check,
    roomCode: session?.id ?? null, gameSessionId: session?.gameSessionId ?? null
  });
  if ('conflict' in started) return err('resume', 409, { unmarkedSelf: started.existing });
  return json({ mode: 'self', findId: started.findId, tableId: picked.choice.tableId, check });
}

async function selfMarkAction(userId: string, body: any) {
  if (!isUuid(body?.findId)) return err('stale', 409);
  const marked = await markSelfFind({
    findId: body.findId, userId, passed: body.passed === true,
    tableId: isUuid(body?.tableId) ? body.tableId : undefined
  });
  if (!marked.ok) return err(marked.error, marked.error === 'bad_table' ? 400 : 409);

  const result = marked.result;
  const itemCount = forageItemCount(result.lines.map((line) => ({ itemId: line.itemId, qty: line.qty })));
  if (result.status === 'found') emitRealtimeEvent('character:updated', { characterId: result.characterId });

  // Public roll-log line (no item names), only if the forage's room is live.
  const name = await characterName(result.characterId);
  await logForageRoll(
    result.roomCode,
    rollLogMessage({ characterName: name, check: result.check, outcome: result.status, mode: 'self', itemCount }),
    forageLogDetails({ check: result.check, outcome: result.status, mode: 'self', itemCount, findId: body.findId })
  );
  if (result.roomCode && sessions.has(result.roomCode)) forageNudge(result.roomCode, userId);
  return json({ status: result.status, lines: result.lines, check: result.check });
}

async function characterName(characterId: string): Promise<string> {
  const row = await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [characterId]);
  return row.rows[0]?.name ?? 'Someone';
}

// The finder withdraws a DM-mode request, if canWithdraw allows it.
function withdrawAction(userId: string, body: any) {
  const pending = findPendingForUser(userId);
  if (!pending || pending.request.id !== body?.requestId) return err('stale_request', 409);
  if (!canWithdraw(pending.session, pending.request)) return err('cannot_withdraw', 409);
  closeRequest(pending.session, pending.request, 'cancelled', {}, false);
  return json({ ok: true });
}

// The finder dismisses their last DM-mode result (clears it from the room).
function dismissAction(userId: string, body: any) {
  for (const session of sessions.values()) {
    const result = session.forageResults?.[userId];
    if (result && result.requestId === body?.requestId) {
      delete session.forageResults[userId];
      forageNudge(session.id, userId);
      return json({ ok: true });
    }
  }
  return json({ ok: true });
}

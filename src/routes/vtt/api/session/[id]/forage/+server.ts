import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { forageItemCount, rollFind, validateFindLines } from '$lib/rules/forage';
import { approveDmFind, getActiveTable, getSuggestedCheck } from '$lib/server/services/forage';
import {
  broadcastForageUpdate, closeRequest, forageMap, getRequest, isRoomGm, rollLogMessage,
  type ForagePreview, type ForageRequest
} from '$lib/server/vttForage';
import {
  ForageRollError, forageLogDetails, logForageRoll, previewForageAdvantage, rollForageCheck
} from '$lib/server/vttForageRoll';
import { advantageBody, isUuid, parseChoice, shortText } from '$lib/server/vttForageApi';
import type { ForageCatalogueTable } from '$lib/types/forage';

// The room GM's forage actions (vtt-forage plan, unit B). Room-scoped and GM-only: isRoomGm means
// the caller's account is the one stored in session.gmSocketId. A GM who opened the VTT directly
// (placeholder 'gm', no account) gets 403 and their room counts as "no DM" for forage.
//
// Every action echoes the request id, so a stale click on an old popup gets 409 stale_request
// instead of acting on a newer request. A request is only ever touched at the stage the action
// expects (409 wrong_stage). Slow actions take a `busy` flag first so a double click can't run twice.

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, { status });

export const POST: RequestHandler = async ({ locals, params, request: httpRequest }) => {
  const session = sessions.get(params.id!);
  if (!session) return err('session_not_found', 404);
  if (!isRoomGm(session, locals.user!.id)) return err('not_gm', 403);

  const body = await httpRequest.json().catch(() => ({}));
  // Rooms made before the forage deploy have no forage map.
  forageMap(session);
  const request = getRequest(session, body?.requestId);
  if (!request) return err('stale_request', 409);

  const action = body?.action;
  if (action === 'cancel') return cancelAction(session, request);
  if (request.busy) return err('busy', 409);

  request.busy = true;
  try {
    if (action === 'preview') return await previewAction(session, request, body);
    if (action === 'check') return await checkAction(session, request, body);
    if (action === 'mark') return await markAction(session, request, body);
    if (action === 'reroll') return await rerollAction(session, request, body);
    if (action === 'approve') return await approveAction(session, request, body);
    return err('invalid_action', 400);
  } catch (error) {
    if (error instanceof ForageRollError) return err(error.code, error.code === 'bad_skill' ? 400 : 404);
    console.error('[forage] GM action failed', action, error);
    return err('server_error', 500);
  } finally {
    request.busy = false;
  }
};

const wrongStage = (request: ForageRequest) => err('wrong_stage', 409, { stage: request.stage });
// True while this exact request is still the one in the room (the GM may have cancelled mid-await).
const stillLive = (session: any, request: ForageRequest) => forageMap(session)[request.playerId] === request;
const tokenOf = (session: any, request: ForageRequest) => (request.tokenId ? session.tokens?.[request.tokenId] ?? null : null);

// The GM popup's advantage panel, for the stage before the check.
async function previewAction(session: any, request: ForageRequest, body: any) {
  if (request.stage !== 'requested') return wrongStage(request);
  const preview = await previewForageAdvantage({
    characterId: request.characterId, skillKey: shortText(body?.skillKey, 40), token: tokenOf(session, request),
    sessionId: session.id, body
  });
  return json(preview);
}

// The GM rolls the check, possibly after changing the player's picks.
async function checkAction(session: any, request: ForageRequest, body: any) {
  if (request.stage !== 'requested') return wrongStage(request);
  const picked = await parseChoice(body);
  if ('error' in picked) return err(picked.error, picked.error === 'table_empty' ? 409 : 400);

  const check = await rollForageCheck({
    characterId: request.characterId, skillKey: picked.choice.skillKey, token: tokenOf(session, request),
    sessionId: session.id, body: advantageBody(picked.choice)
  });
  const suggestedCheck = await getSuggestedCheck(picked.choice.tableId);
  if (!stillLive(session, request)) return err('stale_request', 409);
  request.choice = picked.choice;
  request.suggestedCheck = suggestedCheck;
  request.check = check;
  request.stage = 'checked';
  broadcastForageUpdate(session, request);
  return json({ request });
}

function previewFor(table: ForageCatalogueTable, nat20: boolean, rolled: { lines: Array<{ itemId: string; qty: number }>; runs: number }): ForagePreview {
  const names = new Map(table.entries.map((entry) => [entry.itemId, entry.itemName]));
  return {
    tableId: table.id, tableName: table.name, nat20, runs: rolled.runs,
    lines: rolled.lines.map((line) => ({ itemId: line.itemId, name: names.get(line.itemId) ?? 'Unknown item', qty: line.qty })),
    tableEntries: table.entries.map((entry) => ({
      itemId: entry.itemId, name: entry.itemName, weight: entry.weight, qtyDie: entry.qtyDie, archived: entry.itemArchived
    }))
  };
}

// Rolls (or rerolls) the haul on a table and moves the request to the preview stage.
async function rollIntoPreview(session: any, request: ForageRequest, tableId: string) {
  const table = await getActiveTable(tableId);
  if (!table) return err('bad_table', 400);
  if (table.pickableCount === 0) return err('table_empty', 409);
  if (!stillLive(session, request)) return err('stale_request', 409);
  const nat20 = !!request.check?.nat20;
  request.preview = previewFor(table, nat20, rollFind(table.entries, table.typeDie, nat20, (sides) => Math.floor(Math.random() * sides) + 1));
  if (table.id !== request.choice.tableId) {
    const suggestedCheck = await getSuggestedCheck(table.id);
    if (!stillLive(session, request)) return err('stale_request', 409);
    request.choice = { ...request.choice, tableId: table.id };
    request.suggestedCheck = suggestedCheck;
  }
  request.stage = 'preview';
  broadcastForageUpdate(session, request);
  return json({ request });
}

// The GM marks the check pass or fail. A nat 1 forces a fail (a natural 20 does not auto-pass).
async function markAction(session: any, request: ForageRequest, body: any) {
  if (request.stage !== 'checked' || !request.check) return wrongStage(request);
  if (body?.passed !== true || request.check.nat1) {
    const message = rollLogMessage({ characterName: request.characterName, check: request.check, outcome: 'failed', mode: 'dm', itemCount: 0 });
    closeRequest(session, request, 'failed');
    await logForageRoll(session.id, message, forageLogDetails({ check: request.check, outcome: 'failed', mode: 'dm', itemCount: 0 }));
    return json({ ok: true, outcome: 'failed' });
  }
  return rollIntoPreview(session, request, isUuid(body?.tableId) ? body.tableId : request.choice.tableId);
}

async function rerollAction(session: any, request: ForageRequest, body: any) {
  if (request.stage !== 'preview') return wrongStage(request);
  return rollIntoPreview(session, request, isUuid(body?.tableId) ? body.tableId : request.preview?.tableId ?? request.choice.tableId);
}

// The GM approves the (possibly edited) haul. Claiming 'approving' happens before any await, so a
// double click can't approve twice; any failure puts the stage back so the GM can retry.
async function approveAction(session: any, request: ForageRequest, body: any) {
  if (request.stage !== 'preview' || !request.preview || !request.check) return wrongStage(request);
  request.stage = 'approving';
  const preview = request.preview;
  const check = request.check;
  try {
    const table = await getActiveTable(preview.tableId);
    if (!table) { request.stage = 'preview'; return err('bad_table', 400); }
    const valid = validateFindLines(body?.lines, table.entries);
    if (!valid.ok) { request.stage = 'preview'; return err('invalid_lines', 400, { message: valid.error }); }

    let saved;
    try {
      saved = await approveDmFind({
        characterId: request.characterId, finderUserId: request.playerId, tableId: preview.tableId, lines: valid.lines,
        nat20: check.nat20, check, gameSessionId: session.gameSessionId ?? null, roomCode: session.id
      });
    } catch (error) {
      console.error('[forage] approve failed', error);
      request.stage = 'preview';
      return err('approve_failed', 500);
    }

    // From here the haul is committed: nothing below may put the stage back.
    const itemCount = forageItemCount(valid.lines);
    closeRequest(session, request, 'approved', { lines: saved.lines, findId: saved.findId });
    emitRealtimeEvent('character:updated', { characterId: request.characterId });
    await logForageRoll(
      session.id,
      rollLogMessage({ characterName: request.characterName, check, outcome: 'found', mode: 'dm', itemCount }),
      forageLogDetails({ check, outcome: 'found', mode: 'dm', itemCount, findId: saved.findId })
    );
    return json({ findId: saved.findId, lines: saved.lines });
  } catch (error) {
    // Only reachable before the commit (the getActiveTable await); after closeRequest nothing throws.
    if (forageMap(session)[request.playerId] === request) request.stage = 'preview';
    throw error;
  }
}

// Cancel at any stage but 'approving'. Nothing is logged (the GM saw it live).
function cancelAction(session: any, request: ForageRequest) {
  if (request.stage === 'approving') return err('wrong_stage', 409, { stage: request.stage });
  closeRequest(session, request, 'cancelled');
  return json({ ok: true });
}

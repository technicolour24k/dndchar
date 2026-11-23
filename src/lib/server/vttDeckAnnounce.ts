import { query } from '$lib/server/db';
import { sessions, socketsBySession, broadcast, publish } from '$vtt/store.js';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { drawSummary } from '$lib/rules/decks';
import { listOpenDmTasks, recordTokenHpDeltas } from '$lib/server/services/decks';
import { logRoll } from '$lib/server/services/rollLog';
import { nudgeCharacterTokenHp } from '$lib/server/vttTokenHp';
import type { DrawView } from '$lib/types/decks';

// What happens AFTER a deck draw or undo has committed: the roll-log line, the table broadcast, a content-free
// ping for open sheets, the character-changed resync, and the HP nudge onto live PC tokens. Nothing here may
// fail the request (the database change is already done), so every step logs and carries on.
//
// Privacy: deck:drawn / deck:undone / deck:tasks go through broadcast() to the room's real participants only.
// They are NOT in store.js's WATCHABLE_BROADCAST_TYPES (watch subscriptions are unauthenticated). The watch topic
// only ever gets deck:ping, which names character ids and nothing else. The roll-log line is public by design
// (the result is public) and reaches watchers the same way every roll:log does.

export type AnnounceKind = 'drawn' | 'undone';

async function safely(label: string, step: () => unknown | Promise<unknown>) {
  try { await step(); } catch (error) { console.error(`[decks] announce ${label} failed`, error); }
}

/** The draw as every participant may see it: no user ids, no revert bookkeeping. */
function publicView(draw: DrawView) {
  return {
    id: draw.id, deckName: draw.deckName, campaignId: draw.campaignId, drawerCharacterId: draw.drawerCharacterId,
    drawerName: draw.drawerName, card: draw.card, success: draw.success, chosenValue: draw.chosenValue, status: draw.status,
    outcome: draw.outcome,
    results: draw.results.map((line) => ({ characterId: line.characterId, kind: line.kind, text: line.text, note: line.note })),
    dmTasks: draw.dmTasks.map((task) => ({ id: task.id, text: task.text, done: task.done })),
    revertNote: draw.revertNote
  };
}

/** The log wording: the summary headline plus what each line did, then what is waiting on the DM. */
function logText(draw: DrawView, kind: AnnounceKind): string {
  const head = drawSummary({ drawerId: draw.drawerCharacterId, card: draw.card, success: draw.success, chosenValue: draw.chosenValue, lines: [], tasks: [] },
    { [draw.drawerCharacterId]: draw.drawerName });
  if (kind === 'undone') return `The DM undid this draw. ${head}${draw.revertNote ? ` ${draw.revertNote}` : ''}`;
  const lines = draw.results.map((line) => `${line.text}.${line.note ? ` (${line.note})` : ''}`);
  const tasks = draw.dmTasks.filter((task) => !task.done).map((task) => `Waiting on the DM: ${task.text}.`);
  return [head, ...lines, ...tasks].join(' ');
}

/** Pushes each GM socket its own open-task list (the service re-checks that they may manage the campaign). */
export async function announceDmTasks(roomCode: string, campaignId: string): Promise<void> {
  const session = sessions.get(roomCode);
  if (!session) return;
  const gmIds = new Set<string>();
  for (const meta of socketsBySession.get(roomCode) ?? []) {
    if (meta.role === 'gm' && meta.gmUserId) gmIds.add(meta.gmUserId);
  }
  const open = new Map<string, unknown>();
  for (const gmId of gmIds) {
    await safely('tasks', async () => { open.set(gmId, await listOpenDmTasks(gmId, campaignId)); });
  }
  if (!open.size) return;
  broadcast(roomCode, (recipient: any) =>
    recipient.role === 'gm' && open.has(recipient.gmUserId) ? { type: 'deck:tasks', campaignId, open: open.get(recipient.gmUserId) } : null);
}

export async function announceDeck(draw: DrawView, kind: AnnounceKind): Promise<void> {
  const room = await query<{ room_code: string | null }>('SELECT room_code FROM campaigns WHERE id = $1', [draw.campaignId]).catch(() => null);
  const roomCode = room?.rows[0]?.room_code ?? null;
  const characterIds = Array.from(new Set([draw.drawerCharacterId, ...draw.results.map((line) => line.characterId)]));

  // HP first, so the tokens are right before anything tells the clients to look. A draw nudges by the sheet's
  // applied HP change and remembers what each token really took; an undo reverses each by its own stored amount.
  // Everything here runs after the commit, so none of it may throw out of this function.
  if (roomCode && sessions.has(roomCode)) {
    await safely('token hp', async () => {
      if (kind === 'drawn') {
        const deltas: Array<{ index: number; deltas: Record<string, number> }> = [];
        draw.results.forEach((line, index) => {
          if (line.kind !== 'hp' || line.after === line.before) return;
          const perToken = nudgeCharacterTokenHp(roomCode, line.characterId, line.after - line.before);
          if (Object.keys(perToken).length) deltas.push({ index, deltas: perToken });
        });
        await recordTokenHpDeltas(draw.id, deltas);
      } else {
        for (const line of draw.results) {
          if (line.kind !== 'hp') continue;
          for (const [tokenId, applied] of Object.entries(line.tokenHpDeltas ?? {})) nudgeCharacterTokenHp(roomCode, line.characterId, -applied, undefined, tokenId);
        }
      }
    });
  }

  if (roomCode) {
    await safely('roll log', () => logRoll(roomCode, logText(draw, kind), {
      kind: kind === 'drawn' ? 'deck_draw' : 'deck_undo', drawId: draw.id, cardId: draw.card.id, success: draw.success
    }));
    if (sessions.has(roomCode)) {
      await safely('broadcast', () => {
        const view = publicView(draw);
        broadcast(roomCode, () => kind === 'drawn' ? { type: 'deck:drawn', draw: view } : { type: 'deck:undone', drawId: draw.id, draw: view });
      });
      if (draw.dmTasks.length) await announceDmTasks(roomCode, draw.campaignId);
    }
    await safely('ping', () => publish(`room:${roomCode}`, { type: 'deck:ping', characterIds }));
  }
  for (const characterId of characterIds) await safely('resync', () => emitRealtimeEvent('resource:changed', { characterId }));
}

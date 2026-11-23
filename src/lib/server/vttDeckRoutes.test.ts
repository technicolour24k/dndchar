import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route behaviour with the deck service and the announcer mocked: input checks, the status and shape of errors,
// and that only resolved/undone draws are announced. Access itself is the service's job (decks.integration).
const service = {
  drawCard: vi.fn(), chooseValue: vi.fn(), revertDraw: vi.fn(), setDrawTaskDone: vi.fn(),
  listDecksForCharacter: vi.fn(), listDrawsForCampaign: vi.fn(), listOpenDmTasks: vi.fn(),
  // The per-user filter. Passes the draw through unless a test says otherwise.
  viewForUser: vi.fn()
};
const announceDeck = vi.fn();
const announceDmTasks = vi.fn();

vi.mock('$lib/server/db', () => ({ query: async () => ({ rows: [{ room_code: 'ROOM' }] }) }));
vi.mock('$lib/server/services/decks', () => {
  class DeckError extends Error { constructor(public code: string, message: string, public draw?: unknown) { super(message); } }
  return { DeckError, ...Object.fromEntries(Object.keys(service).map((key) => [key, (...args: unknown[]) => (service as any)[key](...args)])) };
});
vi.mock('$lib/server/vttDeckAnnounce', () => ({ announceDeck: (...a: unknown[]) => announceDeck(...a), announceDmTasks: (...a: unknown[]) => announceDmTasks(...a) }));

const { DeckError } = await import('$lib/server/services/decks') as any;
const list = await import('../../routes/vtt/api/decks/+server');
const drawRoute = await import('../../routes/vtt/api/decks/draw/+server');
const choose = await import('../../routes/vtt/api/decks/draws/[id]/choose/+server');
const undo = await import('../../routes/vtt/api/decks/draws/[id]/undo/+server');
const tasks = await import('../../routes/vtt/api/decks/draws/[id]/tasks/+server');

const U = '11111111-1111-4111-8111-111111111111';
const locals = { user: { id: 'u1' } };
const body = (value: unknown) => ({ json: async () => value });
const draw = (status: string) => ({ id: U, campaignId: 'camp', status });

beforeEach(() => { Object.values(service).forEach((fn) => fn.mockReset()); service.viewForUser.mockImplementation(async (_userId: string, view: unknown) => view); announceDeck.mockReset(); announceDmTasks.mockReset(); });

describe('deck routes', () => {
  it('rejects bad input with 400 before touching the service', async () => {
    expect((await drawRoute.POST({ locals, request: body({ characterId: 'x', deckId: U }) } as any)).status).toBe(400);
    expect((await choose.POST({ locals, params: { id: U }, request: body({ value: '11' }) } as any)).status).toBe(400);
    expect((await tasks.POST({ locals, params: { id: U }, request: body({ taskId: U }) } as any)).status).toBe(400);
    expect((await list.GET({ locals, url: new URL('http://x/vtt/api/decks') } as any)).status).toBe(400);
    expect(service.drawCard).not.toHaveBeenCalled();
  });

  it('maps service errors to 403 / 404 / 409 with { error, message } (choosing carries the draw)', async () => {
    const call = async (code: string, extra?: unknown) => {
      service.drawCard.mockRejectedValueOnce(new DeckError(code, 'nope', extra));
      const res = await drawRoute.POST({ locals, request: body({ characterId: U, deckId: U }) } as any);
      return { status: res.status, body: await res.json() };
    };
    expect(await call('forbidden')).toMatchObject({ status: 403, body: { error: 'forbidden', message: 'nope' } });
    expect((await call('not_found')).status).toBe(404);
    expect((await call('not_enabled')).status).toBe(409);
    expect(await call('choosing', { id: 'd1' })).toMatchObject({ status: 409, body: { error: 'choosing', draw: { id: 'd1' } } });
    service.revertDraw.mockRejectedValueOnce(new DeckError('already_undone', 'again'));
    expect((await undo.POST({ locals, params: { id: U } } as any)).status).toBe(409);
    service.revertDraw.mockRejectedValueOnce(new DeckError('forbidden', 'DM only'));
    expect((await undo.POST({ locals, params: { id: U } } as any)).status).toBe(403);
  });

  it('announces a resolved draw, a choice and an undo, but not an undecided Ace or a cancelled one', async () => {
    service.drawCard.mockResolvedValueOnce({ status: 'choosing', draw: draw('choosing') });
    await drawRoute.POST({ locals, request: body({ characterId: U, deckId: U }) } as any);
    expect(announceDeck).not.toHaveBeenCalled();
    service.drawCard.mockResolvedValueOnce({ status: 'resolved', draw: draw('resolved') });
    expect((await drawRoute.POST({ locals, request: body({ characterId: U, deckId: U }) } as any)).status).toBe(200);
    expect(announceDeck).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'resolved' }), 'drawn');
    service.chooseValue.mockResolvedValueOnce(draw('resolved'));
    await choose.POST({ locals, params: { id: U }, request: body({ value: 11 }) } as any);
    expect(service.chooseValue).toHaveBeenCalledWith({ userId: 'u1', drawId: U, value: 11 });
    service.revertDraw.mockResolvedValueOnce(draw('reverted'));
    await undo.POST({ locals, params: { id: U } } as any);
    expect(announceDeck).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'reverted' }), 'undone');
    service.revertDraw.mockResolvedValueOnce(draw('cancelled'));
    announceDeck.mockClear();
    await undo.POST({ locals, params: { id: U } } as any);
    expect(announceDeck).not.toHaveBeenCalled();
  });

  it('answers a draw and a choice with the per-user view, but announces the full draw', async () => {
    const full = { ...draw('resolved'), outcome: { text: 'cursed' } };
    const shown = { ...draw('resolved'), outcome: { text: 'generic' } };
    service.viewForUser.mockResolvedValue(shown);
    service.drawCard.mockResolvedValueOnce({ status: 'resolved', draw: full });
    const res = await (await drawRoute.POST({ locals, request: body({ characterId: U, deckId: U }) } as any)).json();
    expect(res.draw).toEqual(shown);
    expect(JSON.stringify(res)).not.toContain('cursed');
    expect(announceDeck).toHaveBeenLastCalledWith(full, 'drawn');
    expect(service.viewForUser).toHaveBeenCalledWith('u1', full);
    service.chooseValue.mockResolvedValueOnce(full);
    const chosen = await (await choose.POST({ locals, params: { id: U }, request: body({ value: 11 }) } as any)).json();
    expect(JSON.stringify(chosen)).not.toContain('cursed');
    expect(announceDeck).toHaveBeenLastCalledWith(full, 'drawn');
  });

  it('never forwards client targets: draw passes only the user, character and deck', async () => {
    service.drawCard.mockResolvedValueOnce({ status: 'resolved', draw: draw('resolved') });
    await drawRoute.POST({ locals, request: body({ characterId: U, deckId: U, cardId: 'gold:hearts:A', partyIds: ['x'], roomCode: 'EVIL' }) } as any);
    expect(service.drawCard).toHaveBeenCalledWith({ userId: 'u1', characterId: U, deckId: U });
  });

  it('serves the character view, the campaign log and the DM task list; ticks a task and pings the GMs', async () => {
    service.listDecksForCharacter.mockResolvedValueOnce({ decks: [], choosing: null, recent: [] });
    expect((await list.GET({ locals, url: new URL(`http://x/a?characterId=${U}`) } as any)).status).toBe(200);
    service.listOpenDmTasks.mockRejectedValueOnce(new DeckError('forbidden', 'DM only'));
    expect((await list.GET({ locals, url: new URL(`http://x/a?campaignId=${U}&tasks=1`) } as any)).status).toBe(403);
    service.listDrawsForCampaign.mockResolvedValueOnce([]);
    expect(await (await list.GET({ locals, url: new URL(`http://x/a?campaignId=${U}`) } as any)).json()).toEqual({ draws: [] });
    service.setDrawTaskDone.mockResolvedValueOnce(draw('resolved'));
    expect((await tasks.POST({ locals, params: { id: U }, request: body({ taskId: U, done: true }) } as any)).status).toBe(200);
    expect(announceDmTasks).toHaveBeenCalledWith('ROOM', 'camp');
  });
});

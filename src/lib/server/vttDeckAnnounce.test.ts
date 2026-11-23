import { beforeEach, describe, expect, it, vi } from 'vitest';

// The deck announcer's privacy split, asserted on the RAW payloads (what JSON.stringify would put on the wire):
// a GM socket gets the full joker text, every other socket and the roll log get the player wording only.
// Everything the announcer calls is faked, so no database or socket server is needed.

const sent: Array<{ who: string; raw: string }> = [];
const logRoll = vi.fn();
const sockets = new Set([
  { role: 'gm', gmUserId: 'dm1', who: 'gm' },
  { role: 'player', who: 'player' },
  { role: 'watcher', who: 'watcher' }
]);

vi.mock('$lib/server/db', () => ({ query: async () => ({ rows: [{ room_code: 'ROOM' }] }) }));
vi.mock('$vtt/store.js', () => ({
  sessions: new Map([['ROOM', {}]]),
  socketsBySession: new Map([['ROOM', sockets]]),
  // Mirrors the real broadcast: build a payload per socket and "send" the JSON text.
  broadcast: (_room: string, build: (meta: any) => unknown) => {
    for (const meta of sockets) {
      const payload = build(meta);
      if (payload) sent.push({ who: (meta as any).who, raw: JSON.stringify(payload) });
    }
  },
  publish: vi.fn()
}));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/decks', () => ({ listOpenDmTasks: vi.fn(async () => []), recordTokenHpDeltas: vi.fn() }));
vi.mock('$lib/server/services/rollLog', () => ({ logRoll: (...a: unknown[]) => logRoll(...a) }));
vi.mock('$lib/server/vttTokenHp', () => ({ nudgeCharacterTokenHp: vi.fn(() => ({})) }));
vi.mock('$lib/server/vttTokenAc', () => ({ followSheetAc: vi.fn() }));

const { announceDeck } = await import('./vttDeckAnnounce');
type Draw = Parameters<typeof announceDeck>[0];

// A black-backed Red Joker: a failure, so the hidden text is the cursed item.
const jokerDraw = (): Draw => ({
  id: 'd1', deckId: 'k', deckName: 'The Deck of Mystical Fate', campaignId: 'camp', drawerCharacterId: 'c1', drawerName: 'Aria',
  card: { id: 'black:joker_red', label: 'Red Joker', tags: { back: 'black', kind: 'joker', colour: 'red' }, value: null },
  success: false, chosenValue: null, status: 'resolved',
  outcome: { id: 'red_joker', name: 'Red Joker', text: 'The party finds a cursed item.', playerText: 'The party finds an item.', hideSuccess: true, rolls: [] },
  results: [],
  dmTasks: [{ id: 't1', text: 'The party finds a cursed item', characterIds: ['c1'], done: false, doneByUserId: null, doneAt: null, hidden: true }],
  createdAt: '', resolvedAt: '', revertedAt: null, revertNote: ''
});

beforeEach(() => { sent.length = 0; logRoll.mockReset(); });

describe('announceDeck privacy', () => {
  it('sends the GM the full text and every other socket the player wording', async () => {
    await announceDeck(jokerDraw(), 'drawn');
    const drawn = sent.filter((m) => JSON.parse(m.raw).type === 'deck:drawn');
    expect(drawn.map((m) => m.who).sort()).toEqual(['gm', 'player', 'watcher']);

    const gm = drawn.find((m) => m.who === 'gm')!;
    expect(gm.raw).toContain('cursed');
    expect(JSON.parse(gm.raw).draw.success).toBe(false);

    for (const other of drawn.filter((m) => m.who !== 'gm')) {
      expect(other.raw).not.toMatch(/cursed/i);
      expect(other.raw).not.toContain('playerText');
      const draw = JSON.parse(other.raw).draw;
      expect(draw.success).toBeNull();
      expect(draw.outcome.text).toBe('The party finds an item.');
      expect(draw.dmTasks).toEqual([{ id: 't1', text: '', done: false, hidden: true }]);
    }
  });

  it('does the same for an undo', async () => {
    await announceDeck({ ...jokerDraw(), status: 'reverted' }, 'undone');
    const player = sent.find((m) => m.who === 'player')!;
    expect(JSON.parse(player.raw).type).toBe('deck:undone');
    expect(player.raw).not.toMatch(/cursed/i);
    expect(sent.find((m) => m.who === 'gm')!.raw).toContain('cursed');
  });

  it('logs the player wording, with no result and no hidden text anywhere in the entry', async () => {
    await announceDeck(jokerDraw(), 'drawn');
    expect(logRoll).toHaveBeenCalledTimes(1);
    const [, text, details] = logRoll.mock.calls[0];
    expect(text).toBe('Aria drew the Red Joker (black back). The party finds an item. Waiting on the DM.');
    expect(JSON.stringify([text, details])).not.toMatch(/cursed/i);
    expect(details.success).toBeNull();
  });

  it('leaves an ordinary card alone, for everyone', async () => {
    const plain: Draw = {
      ...jokerDraw(), card: { id: 'gold:hearts:2', label: '2 of Hearts', tags: { back: 'gold' }, value: 2 }, success: true,
      outcome: { id: 'number_hearts', name: 'Temporary vitality', text: 'Each party member gains the card\'s value in temporary HP.', rolls: [] }, dmTasks: []
    };
    await announceDeck(plain, 'drawn');
    const drawn = sent.filter((entry) => JSON.parse(entry.raw).type === 'deck:drawn');
    // The GM socket always gets the deck:drawn frame (Unit 5 diagnosis: a missing DM toast is not a broadcast gap).
    expect(drawn.map((m) => m.who).sort()).toEqual(['gm', 'player', 'watcher']);
    for (const m of drawn) expect(JSON.parse(m.raw).draw.success).toBe(true);
    expect(logRoll.mock.calls[0][1]).toBe('Aria drew the 2 of Hearts (gold back): success.');
  });
});

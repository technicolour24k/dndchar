import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, sessions, socketsBySession } from '../../../vtt/server/store.js';
import { FORAGE_SELF_SKILLS } from '$lib/rules/skills';

// Rev 4: players learn nothing about tables or skills they weren't given. These tests drive the real
// route handlers with the database and the dice mocked out.

const CHARACTER = '11111111-1111-4111-8111-111111111111';
const catalogue = {
  tables: [
    { id: 't-meadow', name: 'Meadow - plants', areaType: 'meadow', category: 'plant', typeDie: 6, pickableCount: 4, isArchived: false, entries: [] },
    { id: 't-cave', name: 'Cave - ores', areaType: 'cave', category: 'ore', typeDie: 3, pickableCount: 4, isArchived: false, entries: [] },
    { id: 't-swamp', name: 'Swamp - gems', areaType: 'swamp', category: 'gem', typeDie: 2, pickableCount: 0, isArchived: false, entries: [] }
  ]
};

const queryMock = vi.fn();
const startSelfFind = vi.fn();
const markSelfFind = vi.fn();
const previewSkill = vi.fn();
const previewGeneric = vi.fn();
const rollCheck = vi.fn();

vi.mock('$lib/server/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/forage', () => ({
  loadForageCatalogue: async () => catalogue,
  listSuggestedChecks: async () => new Map([['t-meadow', 'Nature DC 12']]),
  getActiveTable: async (id: string) => catalogue.tables.find((t) => t.id === id) ?? null,
  getUnmarkedSelfFind: async () => null,
  getSuggestedCheck: async () => '',
  startSelfFind: (...args: unknown[]) => startSelfFind(...args),
  markSelfFind: (...args: unknown[]) => markSelfFind(...args),
  approveDmFind: vi.fn()
}));
vi.mock('$lib/server/vttForageRoll', () => ({
  ForageRollError: class extends Error { constructor(public code: string) { super(code); } },
  forageLogDetails: () => ({}),
  logForageRoll: async () => {},
  previewForageAdvantage: (...args: unknown[]) => previewSkill(...args),
  previewGenericAdvantage: (...args: unknown[]) => previewGeneric(...args),
  rollForageCheck: (...args: unknown[]) => rollCheck(...args)
}));

const player = await import('../../routes/vtt/api/forage/+server');
const tables = await import('../../routes/vtt/api/forage/tables/+server');

const check = { skillKey: 'nature', skillLabel: 'Nature', total: 15, natural: 12, nat20: false, nat1: false, text: '', poolSummary: '' };

function post(body: Record<string, unknown>) {
  return player.POST({
    locals: { user: { id: 'u1', displayName: 'Alice' } }, request: { json: async () => body }
  } as any);
}
function getTables(userId: string, roomId?: string) {
  return tables.GET({
    locals: { user: { id: userId } }, url: new URL(`http://x/vtt/api/forage/tables${roomId ? `?roomId=${roomId}` : ''}`)
  } as any);
}

/** A live room. With a live account GM it is DM mode, without one it is self-serve. */
function room(gmLive: boolean) {
  const session: any = createSession('ROOM');
  session.gmSocketId = 'gm-user';
  session.players = { u1: { id: 'u1', name: 'Alice', tokenIds: [], connected: true } };
  sessions.set('ROOM', session);
  socketsBySession.set('ROOM', new Set([
    { ws: { readyState: gmLive ? 1 : 3, OPEN: 1, send: vi.fn() }, role: 'gm', playerId: null, gmUserId: 'gm-user', watchTopics: new Set() }
  ]));
  return session;
}

beforeEach(() => {
  sessions.clear();
  socketsBySession.clear();
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: null }] });
  rollCheck.mockResolvedValue(check);
  startSelfFind.mockResolvedValue({ findId: 'f1' });
  previewSkill.mockResolvedValue({ sources: [], pool: null, skillLabel: 'Nature', bonus: 3 });
  previewGeneric.mockResolvedValue({ sources: [], pool: null });
});

describe('forage/tables', () => {
  it('gives a player only skills on the short list and plain area + category pairs, nothing else', async () => {
    room(true);
    const body = await (await getTables('u1', 'ROOM')).json();
    expect(body.skills.map((s: { key: string }) => s.key).sort()).toEqual([...FORAGE_SELF_SKILLS].sort());
    expect(body.skills.every((s: object) => Object.keys(s).sort().join() === 'key,name')).toBe(true);
    // Swamp has nothing pickable, so it isn't offered at all.
    expect(body.options).toEqual([{ areaType: 'meadow', category: 'plant' }, { areaType: 'cave', category: 'ore' }]);
    expect(body.tables).toBeUndefined();
    const text = JSON.stringify(body);
    for (const leak of ['Meadow - plants', 'Cave - ores', 'Swamp', 'pickable', 'suggested', 'Nature DC', 't-meadow']) {
      expect(text).not.toContain(leak);
    }
  });

  it('gives the room GM the full 18 skills and every table with names, counts and the suggested check', async () => {
    room(true);
    const body = await (await getTables('gm-user', 'ROOM')).json();
    expect(body.skills).toHaveLength(18);
    expect(body.tables.find((t: { id: string }) => t.id === 't-meadow')).toMatchObject({ name: 'Meadow - plants', pickableCount: 4, suggestedCheck: 'Nature DC 12' });
    expect(body.options).toBeUndefined();
  });

  it('treats a GM with no live socket like any other player', async () => {
    room(false);
    const body = await (await getTables('gm-user', 'ROOM')).json();
    expect(body.tables).toBeUndefined();
  });
});

describe('start in DM mode', () => {
  it('ignores any skill, area, category or table the player sends, and keeps only the counters', async () => {
    const session = room(true);
    const res = await post({
      action: 'start', characterId: CHARACTER, roomId: 'ROOM', skillKey: 'stealth', areaType: 'cave', category: 'ore',
      tableId: 't-cave', advantage: { disabled: ['x'], situationalAdvantage: 2, situationalDisadvantage: 1 }
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('dm');
    expect(session.forage.u1.choice).toEqual({
      skillKey: '', areaType: '', category: '', tableId: '',
      advantage: { disabled: ['x'], situationalAdvantage: 2, situationalDisadvantage: 1 }
    });
    expect(rollCheck).not.toHaveBeenCalled();
    expect(startSelfFind).not.toHaveBeenCalled();
  });

  it('needs no picks at all', async () => {
    room(true);
    const res = await post({ action: 'start', characterId: CHARACTER, roomId: 'ROOM' });
    expect(res.status).toBe(200);
  });
});

describe('start in self-serve mode', () => {
  const picks = { action: 'start', characterId: CHARACTER, roomId: 'ROOM', skillKey: 'nature', areaType: 'meadow', category: 'plant' };

  it('rejects a skill outside the short list with a friendly code', async () => {
    room(false);
    const res = await post({ ...picks, skillKey: 'stealth' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('skill_not_allowed');
    expect(startSelfFind).not.toHaveBeenCalled();
  });

  it('answers a missing, empty or unknown area + category the same neutral way', async () => {
    room(false);
    for (const where of [{ areaType: 'swamp', category: 'gem' }, { areaType: 'cave', category: 'plant' }, { areaType: 'nowhere', category: 'x' }]) {
      const res = await post({ ...picks, ...where });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('nothing_here');
    }
  });

  it('resolves the table itself and ignores a tableId from the player', async () => {
    room(false);
    const res = await post({ ...picks, tableId: 't-cave' });
    expect(res.status).toBe(200);
    expect(startSelfFind).toHaveBeenCalledWith(expect.objectContaining({ tableId: 't-meadow' }));
    expect(JSON.stringify(await res.json())).not.toContain('tableId');
  });

  it('asks a client that thought a DM was here to choose (the DM left before submit)', async () => {
    room(false);
    const res = await post({ action: 'start', characterId: CHARACTER, roomId: 'ROOM' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('skill_not_allowed');
  });

  it('turns a table that went empty or archived into a normal failed result, with no table error', async () => {
    markSelfFind.mockResolvedValue({
      ok: true, result: { status: 'failed', characterId: CHARACTER, roomCode: null, gameSessionId: null, check, lines: [] }
    });
    const res = await post({ action: 'self_mark', findId: '22222222-2222-4222-8222-222222222222', passed: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'failed', lines: [], check });
  });

  it('marks against the table fixed at start, ignoring a tableId from the player', async () => {
    markSelfFind.mockResolvedValue({ ok: false, error: 'stale' });
    await post({ action: 'self_mark', findId: '22222222-2222-4222-8222-222222222222', passed: true, tableId: '33333333-3333-4333-8333-333333333333' });
    expect(markSelfFind.mock.calls[0][0].tableId).toBeUndefined();
  });
});

describe('preview', () => {
  const body = { action: 'preview', characterId: CHARACTER, roomId: 'ROOM', advantage: {} };

  it('in DM mode shows only the generic sources and never reads a skill', async () => {
    room(true);
    const res = await post({ ...body, skillKey: 'stealth' });
    expect(res.status).toBe(200);
    expect(previewGeneric).toHaveBeenCalled();
    expect(previewSkill).not.toHaveBeenCalled();
    expect(Object.keys(await res.json()).sort()).toEqual(['pool', 'sources']);
  });

  it('in self-serve mode refuses a skill outside the short list', async () => {
    room(false);
    expect((await post({ ...body, skillKey: 'stealth' })).status).toBe(400);
    expect((await post({ ...body, skillKey: 'survival' })).status).toBe(200);
    expect(previewSkill).toHaveBeenCalledTimes(1);
  });
});

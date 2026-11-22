import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /vtt/api/characters/[id]/pool: manual +/- on a character pool from the VTT mini-sheet.
// The database and the services are mocked: this checks the route's input and error handling.
const adjustMock = vi.fn();
const getCharacterMock = vi.fn();
const emitMock = vi.fn();

vi.mock('$lib/server/services/resource-pools', () => ({ adjustCharacterPool: (...args: unknown[]) => adjustMock(...args) }));
vi.mock('$lib/server/services/characters', () => ({ getCharacter: (...args: unknown[]) => getCharacterMock(...args) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: (...args: unknown[]) => emitMock(...args) }));

const route = await import('../../routes/vtt/api/characters/[id]/pool/+server');

const post = (body: Record<string, unknown>) =>
  route.POST({ locals: { user: { id: 'u1' } }, params: { id: 'c1' }, request: { json: async () => body } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  adjustMock.mockResolvedValue(undefined);
  getCharacterMock.mockResolvedValue({ pools: [{ key: 'vowfire', label: 'Vowfire', current: 1, max: 2, rechargePeriod: 'long_rest', breakdown: [{ label: 'Base', value: 0 }] }] });
});

describe('pool route', () => {
  it('adjusts, tells tokens to re-sync, and answers with the current pools (no breakdown)', async () => {
    const response = await post({ key: 'vowfire', delta: -1 });
    expect(response.status).toBe(200);
    expect(adjustMock).toHaveBeenCalledWith('u1', 'c1', 'vowfire', -1);
    expect(emitMock).toHaveBeenCalledWith('resource:changed', { characterId: 'c1' });
    expect(await response.json()).toEqual({ pools: [{ key: 'vowfire', label: 'Vowfire', current: 1, max: 2, rechargePeriod: 'long_rest' }] });
  });

  it('refuses nonsense before touching anything', async () => {
    for (const body of [{}, { key: 'vowfire' }, { key: 'vowfire', delta: 0 }, { key: 'vowfire', delta: 1.5 }, { key: 'vowfire', delta: 500 }, { key: 7, delta: 1 }]) {
      expect((await post(body as any)).status).toBe(400);
    }
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it('is 404 when the caller cannot edit the character, and 400 for an unknown pool', async () => {
    adjustMock.mockRejectedValueOnce(new Error('Character not found.'));
    expect((await post({ key: 'vowfire', delta: 1 })).status).toBe(404);
    adjustMock.mockRejectedValueOnce(new Error('Unknown resource pool.'));
    expect(await (await post({ key: 'nope', delta: 1 })).json()).toEqual({ error: 'unknown_pool' });
    expect(emitMock).not.toHaveBeenCalled();
  });
});

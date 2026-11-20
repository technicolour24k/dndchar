import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, sessions, socketsBySession } from '../../../vtt/server/store.js';
import { newRequest } from './vttForage';

// Keep the route off the database: only previewForageAdvantage matters here.
const previewMock = vi.fn();
vi.mock('$lib/server/vttForageRoll', () => ({
  ForageRollError: class extends Error { constructor(public code: string) { super(code); } },
  forageLogDetails: () => ({}),
  logForageRoll: async () => {},
  previewForageAdvantage: (...args: unknown[]) => previewMock(...args),
  rollForageCheck: async () => ({})
}));
vi.mock('$lib/server/services/forage', () => ({ approveDmFind: vi.fn(), getActiveTable: vi.fn(), getSuggestedCheck: vi.fn() }));
vi.mock('$lib/server/vttForageApi', () => ({
  advantageBody: () => ({}), isUuid: () => true, parseChoice: vi.fn(), shortText: (v: unknown) => (typeof v === 'string' ? v : '')
}));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));

import { POST } from '../../routes/vtt/api/session/[id]/forage/+server';

function setup() {
  const session: any = createSession('ROOM');
  session.gmSocketId = 'gm-user';
  sessions.set('ROOM', session);
  socketsBySession.set('ROOM', new Set([{ ws: { readyState: 1, OPEN: 1, send: vi.fn() }, role: 'gm', playerId: null, gmUserId: 'gm-user', watchTopics: new Set() }]));
  const request = newRequest({
    playerId: 'u1', playerName: 'Alice', characterId: 'c1', characterName: 'Thorne', tokenId: null, source: 'vtt',
    choice: { skillKey: 'nature', areaType: 'meadow', category: 'plant', tableId: 't1', advantage: { disabled: [], situationalAdvantage: 0, situationalDisadvantage: 0 } }
  });
  session.forage.u1 = request;
  return { session, request };
}

const call = (requestId: string, action: string) =>
  POST({
    locals: { user: { id: 'gm-user' } }, params: { id: 'ROOM' },
    request: { json: async () => ({ action, requestId, skillKey: 'nature' }) }
  } as any);

beforeEach(() => {
  sessions.clear();
  socketsBySession.clear();
  previewMock.mockReset();
  previewMock.mockResolvedValue({ sources: [], pool: null, skillLabel: 'Nature', bonus: 3 });
});

describe('GM forage preview', () => {
  it('is not bounced by the busy lock, and never changes the request', async () => {
    const { request } = setup();
    request.busy = true; // e.g. a slow check is mid-flight
    const before = JSON.stringify(request);
    const res = await call(request.id, 'preview');
    expect(res.status).toBe(200);
    expect(JSON.stringify(request)).toBe(before);
    expect(request.busy).toBe(true); // the preview didn't release someone else's lock
  });

  it('still refuses a non-requested stage and other actions while busy', async () => {
    const { request } = setup();
    request.stage = 'checked';
    expect((await call(request.id, 'preview')).status).toBe(409);
    request.stage = 'requested';
    request.busy = true;
    expect((await call(request.id, 'check')).status).toBe(409); // busy
  });
});

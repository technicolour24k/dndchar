import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real voice-token route with the DB, access check and Daily client mocked out.

const getCampaignAccess = vi.fn();
const query = vi.fn();
const ensureRoom = vi.fn();
const createToken = vi.fn();
const fakeEnv: Record<string, string | undefined> = {};

vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => query(...a), withTransaction: vi.fn() }));
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...a: unknown[]) => getCampaignAccess(...a)
}));
vi.mock('$lib/server/voice/dailyClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/voice/dailyClient')>()),
  createDailyClient: () => ({ ensureRoom, createToken })
}));

const { DailyError } = await import('$lib/server/voice/dailyClient');
const route = await import('../../routes/vtt/api/campaigns/[id]/voice-token/+server');

const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
// A fresh user per test: the route throttles per user for 3 s.
let n = 0;
const nextUser = () => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, role: 'user', displayName: 'Tester' });

const post = (user: ReturnType<typeof nextUser>, id = CAMPAIGN) => route.POST({ params: { id }, locals: { user } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  Object.assign(fakeEnv, { DAILY_API_KEY: 'sk-secret', DAILY_DOMAIN: 'tonyj', DAILY_ROOM_PREFIX: 'dev-' });
  query.mockResolvedValue({ rows: [{ id: CAMPAIGN }] });
  getCampaignAccess.mockResolvedValue({ role: 'player', archived: false, isAdmin: false });
  ensureRoom.mockResolvedValue(undefined);
  createToken.mockResolvedValue('tok-123');
});

describe('voice-token route', () => {
  it('gives a member the url and token, uncached, without the key', async () => {
    const res = await post(nextUser());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      url: 'https://tonyj.daily.co/dev-22222222222242228222222222222222',
      token: 'tok-123',
      roomName: 'dev-22222222222242228222222222222222',
      userName: 'Tester'
    });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
    expect(ensureRoom).toHaveBeenCalledWith('dev-22222222222242228222222222222222');
    expect(createToken.mock.calls[0][0].properties).toMatchObject({ is_owner: false, permissions: { canSend: ['audio'] } });
  });
  it('lets a DM in too', async () => {
    getCampaignAccess.mockResolvedValue({ role: 'dm', archived: false, isAdmin: false });
    expect((await post(nextUser())).status).toBe(200);
  });
  it('403s a non-member', async () => {
    getCampaignAccess.mockResolvedValue({ role: null, archived: false, isAdmin: false });
    const res = await post(nextUser());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_member' });
    expect(createToken).not.toHaveBeenCalled();
  });
  it('403s a site admin who is not a member', async () => {
    getCampaignAccess.mockResolvedValue({ role: null, archived: false, isAdmin: true });
    expect((await post({ ...nextUser(), role: 'admin' })).status).toBe(403);
  });
  it('403s an archived campaign', async () => {
    getCampaignAccess.mockResolvedValue({ role: 'dm', archived: true, isAdmin: false });
    expect((await post(nextUser())).status).toBe(403);
  });
  it('403s when access is null', async () => {
    getCampaignAccess.mockResolvedValue(null);
    expect((await post(nextUser())).status).toBe(403);
  });
  it('404s a bad uuid and an unknown campaign', async () => {
    expect((await post(nextUser(), 'nope')).status).toBe(404);
    query.mockResolvedValue({ rows: [] });
    expect((await post(nextUser())).status).toBe(404);
  });
  it('503s when voice is not configured', async () => {
    delete fakeEnv.DAILY_API_KEY;
    const res = await post(nextUser());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'voice_not_configured' });
  });
  it('502s when Daily fails, logging no secrets', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    createToken.mockRejectedValue(new DailyError(500, 'boom', 'daily said no'));
    const res = await post(nextUser());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'voice_unavailable' });
    expect(JSON.stringify(err.mock.calls)).not.toContain('sk-secret');
    err.mockRestore();
  });
  it('429s a second request from the same user within 3 s', async () => {
    const user = nextUser();
    expect((await post(user)).status).toBe(200);
    const res = await post(user);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too_many_requests' });
  });
});

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

const post = (user: ReturnType<typeof nextUser>, id = CAMPAIGN, body?: unknown) =>
  route.POST({
    params: { id },
    locals: { user },
    request: { json: async () => { if (body === undefined) throw new Error('no body'); return body; } }
  } as any);

// The db mock answers by SQL: the campaign lookup, and the character-name lookup.
let characterRows: { name: string }[] = [];
function dbAnswers() {
  query.mockImplementation(async (sql: string) => (/FROM characters/.test(sql) ? { rows: characterRows } : { rows: [{ id: CAMPAIGN }] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  Object.assign(fakeEnv, { DAILY_API_KEY: 'sk-secret', DAILY_DOMAIN: 'tonyj', DAILY_ROOM_PREFIX: 'dev-' });
  characterRows = [];
  dbAnswers();
  getCampaignAccess.mockResolvedValue({ role: 'player', archived: false, isAdmin: false });
  ensureRoom.mockResolvedValue(undefined);
  createToken.mockResolvedValue('tok-123');
});

describe('voice name', () => {
  const nameOf = async (res: Response) => (await res.json()).userName;
  const tokenName = () => createToken.mock.calls[0][0].properties.user_name;

  it('is "Character (Player)" for a player with a character, and goes into the token', async () => {
    characterRows = [{ name: 'Thorne' }];
    const user = { ...nextUser(), displayName: 'Tony' };
    expect(await nameOf(await post(user))).toBe('Thorne (Tony)');
    expect(tokenName()).toBe('Thorne (Tony)');
  });
  it('falls back to the player name when they have no character in the campaign', async () => {
    expect(await nameOf(await post({ ...nextUser(), displayName: 'Tony' }))).toBe('Tony');
  });
  it('asks for the hinted character scoped to this user and campaign, and ignores a malformed hint', async () => {
    const hint = '33333333-3333-4333-8333-333333333333';
    const user = nextUser();
    await post(user, CAMPAIGN, { characterId: hint });
    const call = query.mock.calls.find((c) => /FROM characters/.test(c[0]))!;
    expect(call[0]).toContain('owner_user_id = $1 AND campaign_id = $2');
    expect(call[1]).toEqual([user.id, CAMPAIGN, hint]);
    query.mockClear();
    await post(nextUser(), CAMPAIGN, { characterId: "'; drop table--" });
    expect(query.mock.calls.find((c) => /FROM characters/.test(c[0]))![1][2]).toBeNull();
    query.mockClear();
    await post(nextUser(), CAMPAIGN, { characterId: 42 });
    expect(query.mock.calls.find((c) => /FROM characters/.test(c[0]))![1][2]).toBeNull();
  });
  it('is "DM (Name)" and "Co-DM (Name)" for DMs, without looking up characters', async () => {
    characterRows = [{ name: 'Ignored' }];
    getCampaignAccess.mockResolvedValue({ role: 'dm', archived: false, isAdmin: false });
    expect(await nameOf(await post({ ...nextUser(), displayName: 'Tony' }))).toBe('DM (Tony)');
    getCampaignAccess.mockResolvedValue({ role: 'co_dm', archived: false, isAdmin: false });
    expect(await nameOf(await post({ ...nextUser(), displayName: 'Sam' }))).toBe('Co-DM (Sam)');
    expect(query.mock.calls.some((c) => /FROM characters/.test(c[0]))).toBe(false);
  });
  it('still joins with the plain name if the character lookup fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM characters/.test(sql)) throw new Error('db hiccup');
      return { rows: [{ id: CAMPAIGN }] };
    });
    const res = await post({ ...nextUser(), displayName: 'Tony' });
    expect(res.status).toBe(200);
    expect(await nameOf(res)).toBe('Tony');
  });
  it('caps long names', async () => {
    characterRows = [{ name: 'C'.repeat(100) }];
    const name = await nameOf(await post({ ...nextUser(), displayName: 'P'.repeat(100) }));
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).toBe(`${'C'.repeat(30)} (${'P'.repeat(24)})`);
  });
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
    dbAnswers();
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

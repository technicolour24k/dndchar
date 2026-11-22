import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// voiceEject against a stubbed global fetch (no live Daily calls) and a mocked db.

const query = vi.fn();
const fakeEnv: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => query(...a), withTransaction: vi.fn() }));

const { ejectAllFromCampaignVoice, ejectFromCampaignVoice } = await import('./voice/voiceEject');

const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const ROOM = 'dev-22222222222242228222222222222222';
const KEY = 'sk-eject-secret';

let replies: { status: number; body?: unknown }[];
let calls: { url: string; init: RequestInit }[];
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  Object.assign(fakeEnv, { DAILY_API_KEY: KEY, DAILY_DOMAIN: 'tonyj', DAILY_ROOM_PREFIX: 'dev-' });
  replies = [];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const r = replies.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    })
  );
  query.mockReset();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  err.mockRestore();
});

describe('ejectFromCampaignVoice', () => {
  it('ejects the user from the campaign room with user_ids', async () => {
    await ejectFromCampaignVoice(CAMPAIGN, 'user-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.daily.co/v1/rooms/${ROOM}/eject`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ user_ids: ['user-1'] });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
  it('treats 404 (no call going) as success, silently', async () => {
    replies = [{ status: 404, body: { error: 'not-found', info: 'room does not seem to be hosting a call currently' } }];
    await expect(ejectFromCampaignVoice(CAMPAIGN, 'user-1')).resolves.toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });
  it('never throws on a Daily error, and logs status and code only', async () => {
    replies = [{ status: 500, body: { error: 'internal', info: KEY } }];
    await expect(ejectFromCampaignVoice(CAMPAIGN, 'user-1')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain('500 internal');
    expect(logged).not.toContain(KEY);
  });
  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`down ${KEY}`); }));
    await expect(ejectFromCampaignVoice(CAMPAIGN, 'user-1')).resolves.toBeUndefined();
    expect(JSON.stringify(err.mock.calls)).not.toContain(KEY);
  });
  it('does nothing when voice is not configured or there is no user', async () => {
    delete fakeEnv.DAILY_API_KEY;
    await ejectFromCampaignVoice(CAMPAIGN, 'user-1');
    fakeEnv.DAILY_API_KEY = KEY;
    await ejectFromCampaignVoice(CAMPAIGN, undefined);
    await ejectFromCampaignVoice(CAMPAIGN, null);
    expect(calls).toHaveLength(0);
  });
});

describe('ejectAllFromCampaignVoice', () => {
  it('ejects every member of the campaign', async () => {
    query.mockResolvedValue({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await ejectAllFromCampaignVoice(CAMPAIGN);
    expect(query.mock.calls[0][1]).toEqual([CAMPAIGN]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ user_ids: ['a', 'b'] });
  });
  it('chunks past 100 ids', async () => {
    query.mockResolvedValue({ rows: Array.from({ length: 150 }, (_, i) => ({ user_id: `u${i}` })) });
    await ejectAllFromCampaignVoice(CAMPAIGN);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init.body as string).user_ids).toHaveLength(100);
    expect(JSON.parse(calls[1].init.body as string).user_ids).toHaveLength(50);
  });
  it('does not even query when voice is off, and survives a db failure', async () => {
    delete fakeEnv.DAILY_DOMAIN;
    await ejectAllFromCampaignVoice(CAMPAIGN);
    expect(query).not.toHaveBeenCalled();
    fakeEnv.DAILY_DOMAIN = 'tonyj';
    query.mockRejectedValue(new Error('db down'));
    await expect(ejectAllFromCampaignVoice(CAMPAIGN)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDailyConfig, roomProperties, tokenProperties, voiceRoomName, voiceRoomUrl, type DailyConfig } from './voice/dailyConfig';
import { createDailyClient, DailyError, resetDailyClientState } from './voice/dailyClient';

// Config parsing, the exact bodies we send to Daily, and the REST client against a fake fetch.
// No live Daily calls anywhere in this file.

const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const KEY = 'sk-test-secret-key-123';

describe('readDailyConfig', () => {
  const base = { DAILY_API_KEY: KEY, DAILY_DOMAIN: 'tonyj', DAILY_ROOM_PREFIX: 'dev-' };

  it('reads a normal config with defaults', () => {
    expect(readDailyConfig(base)).toEqual({ apiKey: KEY, domain: 'tonyj', roomPrefix: 'dev-', maxParticipants: 10, sessionCapSeconds: 21600 });
  });
  it('is off when the key or domain is missing or blank', () => {
    expect(readDailyConfig({})).toBeNull();
    expect(readDailyConfig({ ...base, DAILY_API_KEY: '   ' })).toBeNull();
    expect(readDailyConfig({ ...base, DAILY_DOMAIN: '' })).toBeNull();
  });
  it('accepts a pasted URL or hostname for the domain', () => {
    expect(readDailyConfig({ ...base, DAILY_DOMAIN: 'https://tonyj.daily.co/' })?.domain).toBe('tonyj');
    expect(readDailyConfig({ ...base, DAILY_DOMAIN: 'TonyJ.daily.co' })?.domain).toBe('tonyj');
  });
  it('rejects a bad domain or prefix (and logs without the key)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readDailyConfig({ ...base, DAILY_DOMAIN: 'bad domain!' })).toBeNull();
    expect(readDailyConfig({ ...base, DAILY_ROOM_PREFIX: 'has space' })).toBeNull();
    expect(readDailyConfig({ ...base, DAILY_ROOM_PREFIX: 'waytoolongprefix' })).toBeNull();
    expect(JSON.stringify(err.mock.calls)).not.toContain(KEY);
    err.mockRestore();
  });
  it('defaults the prefix to empty when unset', () => {
    expect(readDailyConfig({ DAILY_API_KEY: KEY, DAILY_DOMAIN: 'tonyj' })?.roomPrefix).toBe('');
  });
  it('clamps the optional numbers', () => {
    expect(readDailyConfig({ ...base, DAILY_MAX_PARTICIPANTS: '1' })?.maxParticipants).toBe(2);
    expect(readDailyConfig({ ...base, DAILY_MAX_PARTICIPANTS: '999' })?.maxParticipants).toBe(50);
    expect(readDailyConfig({ ...base, DAILY_MAX_PARTICIPANTS: 'x' })?.maxParticipants).toBe(10);
    expect(readDailyConfig({ ...base, DAILY_SESSION_CAP_HOURS: '0' })?.sessionCapSeconds).toBe(3600);
    expect(readDailyConfig({ ...base, DAILY_SESSION_CAP_HOURS: '99' })?.sessionCapSeconds).toBe(12 * 3600);
  });
});

const config: DailyConfig = { apiKey: KEY, domain: 'tonyj', roomPrefix: 'dev-', maxParticipants: 10, sessionCapSeconds: 21600 };

describe('names and bodies', () => {
  it('derives the room name and url', () => {
    expect(voiceRoomName('dev-', CAMPAIGN)).toBe('dev-22222222222242228222222222222222');
    expect(voiceRoomName('', CAMPAIGN)).toBe('22222222222242228222222222222222');
    expect(voiceRoomUrl('tonyj', 'dev-abc')).toBe('https://tonyj.daily.co/dev-abc');
  });
  it('builds the exact room body: private, audio only, capped, no recording', () => {
    expect(roomProperties(config)).toEqual({
      privacy: 'private',
      properties: {
        max_participants: 10,
        start_video_off: true,
        start_audio_off: false,
        enable_screenshare: false,
        enable_chat: false,
        eject_after_elapsed: 21600
      }
    });
    expect(JSON.stringify(roomProperties(config))).not.toContain('enable_recording');
  });
  it('builds the exact token body', () => {
    const body = tokenProperties(config, { roomName: 'dev-x', userId: 'u1', displayName: `  ${'n'.repeat(80)}  `, nowSeconds: 1000 });
    expect(body).toEqual({
      properties: {
        room_name: 'dev-x',
        user_id: 'u1',
        user_name: 'n'.repeat(60),
        exp: 1600,
        is_owner: false,
        eject_after_elapsed: 21600,
        start_video_off: true,
        enable_screenshare: false,
        permissions: { canSend: ['audio'], hasPresence: true }
      }
    });
    expect(body.properties).not.toHaveProperty('eject_at_token_exp');
  });
});

type Reply = { status: number; body?: unknown };
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('daily client', () => {
  beforeEach(() => resetDailyClientState());

  it('updates an existing room and does not create', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await createDailyClient(config, f.impl).ensureRoom('dev-a');
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.daily.co/v1/rooms/dev-a']);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual(roomProperties(config));
  });
  it('creates the room when the update 404s', async () => {
    const f = fakeFetch([{ status: 404, body: { error: 'not-found', info: 'x' } }, { status: 200 }]);
    await createDailyClient(config, f.impl).ensureRoom('dev-b');
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.daily.co/v1/rooms/dev-b', 'https://api.daily.co/v1/rooms']);
    expect(JSON.parse(f.calls[1].init.body as string)).toEqual({ name: 'dev-b', ...roomProperties(config) });
  });
  it('treats a create race (409 or "already exists") as success', async () => {
    const f1 = fakeFetch([{ status: 404 }, { status: 409, body: { error: 'x' } }]);
    await expect(createDailyClient(config, f1.impl).ensureRoom('dev-c')).resolves.toBeUndefined();
    const f2 = fakeFetch([{ status: 404 }, { status: 400, body: { error: 'invalid-request-error', info: 'a room named dev-d already exists' } }]);
    await expect(createDailyClient(config, f2.impl).ensureRoom('dev-d')).resolves.toBeUndefined();
  });
  it('skips Daily on the second call for the same room', async () => {
    const f = fakeFetch([{ status: 200 }]);
    const c = createDailyClient(config, f.impl);
    await c.ensureRoom('dev-e');
    await c.ensureRoom('dev-e');
    expect(f.calls).toHaveLength(1);
  });
  it('shares one request between concurrent first calls', async () => {
    const f = fakeFetch([{ status: 200 }]);
    const c = createDailyClient(config, f.impl);
    await Promise.all([c.ensureRoom('dev-f'), c.ensureRoom('dev-f'), c.ensureRoom('dev-f')]);
    expect(f.calls).toHaveLength(1);
  });
  it('does not remember a failed ensure', async () => {
    const f = fakeFetch([{ status: 500, body: { error: 'boom' } }, { status: 200 }]);
    const c = createDailyClient(config, f.impl);
    await expect(c.ensureRoom('dev-g')).rejects.toBeInstanceOf(DailyError);
    await c.ensureRoom('dev-g');
    expect(f.calls).toHaveLength(2);
  });
  it('throws DailyError on non-2xx, with status and code, and never the key', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'authentication-error', info: 'bad key' } }]);
    const err = await createDailyClient(config, f.impl).createToken({ properties: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(DailyError);
    expect(err).toMatchObject({ status: 401, code: 'authentication-error' });
    expect(String(err.message)).not.toContain(KEY);
  });
  it('sends the bearer header and returns the token', async () => {
    const f = fakeFetch([{ status: 200, body: { token: 'tok-1' } }]);
    const body = tokenProperties(config, { roomName: 'dev-h', userId: 'u', displayName: 'N', nowSeconds: 1 });
    expect(await createDailyClient(config, f.impl).createToken(body)).toBe('tok-1');
    expect(f.calls[0].url).toBe('https://api.daily.co/v1/meeting-tokens');
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual(body);
  });
  it('rejects a 200 with no token', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    await expect(createDailyClient(config, f.impl).createToken({ properties: {} })).rejects.toBeInstanceOf(DailyError);
  });
  it('ejects a user by id', async () => {
    const f = fakeFetch([{ status: 200 }]);
    await createDailyClient(config, f.impl).ejectUser('dev-i', 'u9');
    expect(f.calls[0].url).toBe('https://api.daily.co/v1/rooms/dev-i/eject');
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ user_ids: ['u9'] });
  });
});

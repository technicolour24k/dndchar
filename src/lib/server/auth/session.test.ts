import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only $lib/server/db is mocked - session.ts's own in-memory cache (the thing
// under test) is exercised for real. Each test uses its own token so the
// module-level cache Map (shared across tests in this file, since there's no
// way to reset it without re-importing the module) never lets one test's
// cached entry leak into another's assertions.
vi.mock('$lib/server/db', () => ({ query: vi.fn() }));

import { query } from '$lib/server/db';
import { getUserForToken, invalidateSession, invalidateSessionsForUser } from './session';

const queryMock = vi.mocked(query);

function dbRow(overrides: Partial<{
  session_id: string;
  session_expires_at: Date;
  id: string;
  role: 'user' | 'admin';
}> = {}) {
  return {
    session_id: overrides.session_id ?? 'session-1',
    session_expires_at: overrides.session_expires_at ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    id: overrides.id ?? 'user-1',
    email: 'test@example.com',
    display_name: 'Test User',
    role: overrides.role ?? 'user',
    theme_background_color: '#14161b',
    theme_panel_color: '#292929',
    theme_text_color: '#f4f4f4'
  };
}

let tokenCounter = 0;
function freshToken(): string {
  tokenCounter += 1;
  return `token-${tokenCounter}`;
}

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getUserForToken (session cache)', () => {
  it('queries the DB on a cache miss and returns the mapped user', async () => {
    const token = freshToken();
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] } as any);

    const result = await getUserForToken(token);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result?.user.id).toBe('user-1');
    expect(result?.sessionId).toBe('session-1');
  });

  it('serves a repeat lookup within the TTL from cache, with no query', async () => {
    const token = freshToken();
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] } as any);

    await getUserForToken(token);
    const second = await getUserForToken(token);

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second?.user.id).toBe('user-1');
  });

  it('does not cache a miss - the very next lookup re-queries', async () => {
    const token = freshToken();
    queryMock.mockResolvedValueOnce({ rows: [] } as any);
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] } as any);

    const first = await getUserForToken(token);
    expect(first).toBeNull();

    const second = await getUserForToken(token);
    expect(second?.user.id).toBe('user-1');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('re-queries once the TTL has expired', async () => {
    vi.useFakeTimers();
    const token = freshToken();
    queryMock.mockResolvedValue({ rows: [dbRow()] } as any);

    await getUserForToken(token);
    expect(queryMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);

    await getUserForToken(token);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('respects a session expiry earlier than the 60s TTL', async () => {
    vi.useFakeTimers();
    const token = freshToken();
    queryMock.mockResolvedValue({ rows: [dbRow({ session_expires_at: new Date(Date.now() + 10_000) })] } as any);

    await getUserForToken(token);
    expect(queryMock).toHaveBeenCalledTimes(1);

    // Past the session's own expiry, but well within the 60s TTL - the cache
    // entry should already be gone because expiresAt = min(ttl, sessionExpiry).
    vi.advanceTimersByTime(11_000);

    await getUserForToken(token);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateSession forces a re-query for that session only', async () => {
    const tokenA = freshToken();
    const tokenB = freshToken();
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-a', id: 'user-a' })] } as any);
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-b', id: 'user-b' })] } as any);

    await getUserForToken(tokenA);
    await getUserForToken(tokenB);
    expect(queryMock).toHaveBeenCalledTimes(2);

    invalidateSession('session-a');

    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-a', id: 'user-a' })] } as any);
    await getUserForToken(tokenA);
    expect(queryMock).toHaveBeenCalledTimes(3);

    // tokenB's cache entry is untouched.
    await getUserForToken(tokenB);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('invalidateSessionsForUser forces a re-query for every session of that user', async () => {
    const tokenA = freshToken();
    const tokenB = freshToken();
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-c', id: 'user-shared' })] } as any);
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-d', id: 'user-shared' })] } as any);

    await getUserForToken(tokenA);
    await getUserForToken(tokenB);
    expect(queryMock).toHaveBeenCalledTimes(2);

    invalidateSessionsForUser('user-shared');

    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-c', id: 'user-shared' })] } as any);
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ session_id: 'session-d', id: 'user-shared' })] } as any);

    await getUserForToken(tokenA);
    await getUserForToken(tokenB);
    expect(queryMock).toHaveBeenCalledTimes(4);
  });
});

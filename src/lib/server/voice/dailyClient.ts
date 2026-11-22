import { roomProperties, type DailyConfig } from './dailyConfig';

// Thin Daily REST client (https://api.daily.co/v1). Never logs or throws the API key or a token.
// Endpoints (verified against docs.daily.co 2026-11-22):
//   POST /rooms/<name>        update a room
//   POST /rooms               create a room
//   POST /meeting-tokens      { properties } -> { token }
//   POST /rooms/<name>/eject  { user_ids: [...] } (max 100)

const BASE = 'https://api.daily.co/v1';
const TIMEOUT_MS = 10_000;

export class DailyError extends Error {
  constructor(
    public status: number,
    public code: string,
    public info: string
  ) {
    super(`daily ${status} ${code}${info ? `: ${info}` : ''}`);
    this.name = 'DailyError';
  }
}

// Held on globalThis like vtt/server/store.js so dev HMR doesn't duplicate it.
type Shared = { ensured: Set<string>; inflight: Map<string, Promise<void>> };
const KEY = Symbol.for('dndchar.voice.dailyClient');
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared>;
  g[KEY] ??= { ensured: new Set(), inflight: new Map() };
  return g[KEY];
}

/** Test helper: forget which rooms have been ensured. */
export function resetDailyClientState() {
  const s = shared();
  s.ensured.clear();
  s.inflight.clear();
}

export function createDailyClient(config: DailyConfig, fetchImpl: typeof fetch = fetch) {
  async function call(path: string, body: unknown): Promise<any> {
    const res = await fetchImpl(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new DailyError(res.status, String(data?.error ?? 'unknown'), String(data?.info ?? ''));
    return data;
  }

  async function doEnsure(roomName: string): Promise<void> {
    const props = roomProperties(config);
    try {
      // An update, so property changes shipped in a new deploy reach existing rooms.
      await call(`/rooms/${roomName}`, props);
      return;
    } catch (e) {
      if (!(e instanceof DailyError) || e.status !== 404) throw e;
    }
    try {
      await call('/rooms', { name: roomName, ...props });
    } catch (e) {
      // Lost a race with another instance creating it: fine. (Daily's exact status for this is
      // unverified, so accept 409 or any error whose message says it already exists.)
      if (e instanceof DailyError && (e.status === 409 || /already exists/i.test(e.info))) return;
      throw e;
    }
  }

  return {
    /** Make sure the room exists with our properties. Once per process per room. */
    ensureRoom(roomName: string): Promise<void> {
      const s = shared();
      if (s.ensured.has(roomName)) return Promise.resolve();
      const pending = s.inflight.get(roomName);
      if (pending) return pending;
      const p = doEnsure(roomName)
        .then(() => {
          s.ensured.add(roomName);
        })
        .finally(() => {
          s.inflight.delete(roomName);
        });
      s.inflight.set(roomName, p);
      return p;
    },

    async createToken(body: { properties: Record<string, unknown> }): Promise<string> {
      const data = await call('/meeting-tokens', body);
      if (typeof data?.token !== 'string' || !data.token) throw new DailyError(502, 'no_token', '');
      return data.token;
    },

    /** Used by Unit 4. A 404 (room never created) is the caller's to treat as fine. */
    async ejectUser(roomName: string, userId: string): Promise<void> {
      await call(`/rooms/${roomName}/eject`, { user_ids: [userId] });
    }
  };
}

import { sessions, broadcast, filterTokenForPlayer } from '$vtt/store.js';

// VTT token AC follows the sheet's resolved AC BY DELTA (decks plan, unit 5b).
//
// A PC token remembers the sheet AC it last followed (`token.sheetAc`). When the sheet's AC changes
// (a deck effect, its expiry or undo, a shield, Shield the spell, a rest, a restore...) the token's own AC
// moves by the same amount from wherever it is, so a GM's manual offset (cover, a house rule) stays on top.
// Only this server-side code writes `sheetAc`: token.js refuses it from clients and sanitises it on token:add.
//
// Two overlapping loads must not apply out of order, so work is serialised per character (a promise chain)
// and the delta is always worked out against `sheetAc` at the moment it is applied.
type Deps = {
  sessions: Map<string, any>;
  broadcast: (sessionId: string, build: (recipient: any) => unknown) => void;
  /** The character's resolved sheet AC, or null when it can't be loaded. */
  loadAc: (characterId: string) => Promise<number | null>;
};

async function loadSheetAc(characterId: string): Promise<number | null> {
  // Lazy: this module is imported by realtime.ts, which many services import.
  const { getCharacterForRoll } = await import('$lib/server/services/characters');
  const { characterStatsFor } = await import('$lib/rules/characterStats');
  const character = await getCharacterForRoll(characterId);
  return character ? characterStatsFor(character).armorClass.value : null;
}

const live: Deps = { sessions, broadcast, loadAc: loadSheetAc };

const clampAc = (value: number) => Math.max(0, Math.min(99, Math.round(value)));

function pcTokens(characterId: string, deps: Deps): Array<{ session: any; token: any }> {
  const found: Array<{ session: any; token: any }> = [];
  for (const session of deps.sessions.values()) {
    for (const token of Object.values<any>(session.tokens ?? {})) {
      if (token.type === 'pc' && token.characterId === characterId) found.push({ session, token });
    }
  }
  return found;
}

/** token:stat:update, as token.js sends it. A hidden token or an unrevealed map reaches the GM only. */
function tellRoom(deps: Deps, session: any, token: any, stat: string, value: number | null) {
  const mapHidden = session.map && !session.map.revealed;
  deps.broadcast(session.id, (recipient: any) => {
    if (recipient.role !== 'gm' && (token.hidden || mapHidden)) return null;
    return { type: 'token:stat:update', tokenId: token.id, stat, value, token: recipient.role === 'gm' ? token : filterTokenForPlayer(token) };
  });
}

/** Applies a freshly loaded sheet AC to one token. `move` false only records a missing baseline. */
function applyAc(deps: Deps, session: any, token: any, sheetAc: number, move: boolean) {
  const now = clampAc(sheetAc);
  if (typeof token.sheetAc !== 'number') {
    // No baseline yet: remember it, never move (we don't know what the token was relative to).
    token.sheetAc = now;
    tellRoom(deps, session, token, 'sheetAc', now);
    return;
  }
  const delta = now - token.sheetAc;
  if (!move || !delta) return;
  token.sheetAc = now;
  if (typeof token.ac === 'number') {
    // Accepted edge case: ac clamps at 0/99 while sheetAc keeps moving, so an offset can be lost at the extremes.
    token.ac = clampAc(token.ac + delta);
    tellRoom(deps, session, token, 'ac', token.ac);
    // A real AC change invalidates the discovered bound (same rule as token.js).
    if (token.knownAc != null) {
      token.knownAc = null;
      tellRoom(deps, session, token, 'knownAc', null);
    }
  }
  tellRoom(deps, session, token, 'sheetAc', now);
}

const chains = new Map<string, Promise<void>>();

function enqueue(characterId: string, job: () => Promise<void>): Promise<void> {
  const next = (chains.get(characterId) ?? Promise.resolve()).catch(() => {}).then(job);
  chains.set(characterId, next);
  const clear = () => { if (chains.get(characterId) === next) chains.delete(characterId); };
  next.then(clear, clear);
  return next;
}

async function followOne(characterId: string, deps: Deps, move: boolean) {
  const needed = pcTokens(characterId, deps).filter(({ token }) => move || typeof token.sheetAc !== 'number');
  if (!needed.length) return; // no live token, no database work
  const sheetAc = await deps.loadAc(characterId);
  if (sheetAc === null) return;
  // Re-scan after the await: tokens may have come and gone while the character loaded.
  for (const { session, token } of pcTokens(characterId, deps)) applyAc(deps, session, token, sheetAc, move);
}

/** Moves the linked PC tokens' AC by the change in each character's sheet AC. Errors are for the caller to log. */
export function followSheetAc(characterIds: string[], deps: Deps = live): Promise<void> {
  return Promise.all(Array.from(new Set(characterIds)).map((id) => enqueue(id, () => followOne(id, deps, true)))).then(() => {});
}

/** Records the current sheet AC on tokens that have no baseline yet, moving nothing (call BEFORE a change lands). */
export function primeSheetAc(characterIds: string[], deps: Deps = live): Promise<void> {
  return Promise.all(Array.from(new Set(characterIds)).map((id) => enqueue(id, () => followOne(id, deps, false)))).then(() => {});
}

/** Primes ONE token (by room and id): records the sheet AC as its baseline if it has none, never moving token.ac. */
export function primeTokenSheetAc(roomId: string, tokenId: string, deps: Deps = live): Promise<void> {
  const find = () => deps.sessions.get(roomId)?.tokens?.[tokenId];
  const first = find();
  if (!first || first.type !== 'pc' || !first.characterId) return Promise.resolve();
  return enqueue(first.characterId, async () => {
    if (typeof find()?.sheetAc === 'number') return;
    const sheetAc = await deps.loadAc(first.characterId);
    const token = find();
    if (sheetAc === null || !token || typeof token.sheetAc === 'number') return;
    applyAc(deps, deps.sessions.get(roomId), token, sheetAc, false);
  });
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const FOLLOW_DEBOUNCE_MS = 500;

/** Trailing debounce per character, fire and forget. Called from emitRealtimeEvent when a live PC token matches. */
export function scheduleFollowSheetAc(characterId: string, deps: Deps = live, delayMs = FOLLOW_DEBOUNCE_MS) {
  clearTimeout(timers.get(characterId));
  const timer = setTimeout(() => {
    timers.delete(characterId);
    followSheetAc([characterId], deps).catch((error) => console.error('[vtt] token AC follow failed', error));
  }, delayMs);
  timer.unref?.();
  timers.set(characterId, timer);
}

// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure helpers for per-person voice volume (listener-side, local only). No DOM, no Web Audio, so they
// can be unit tested. voice.js does the actual audio routing.

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 200;
export const VOLUME_DEFAULT = 100;
export const VOLUME_SLIDER_STEP = 5;
export const VOLUME_BUTTON_STEP = 10;

/** Whole percent in [0, max]. Anything that isn't a number gives the default (100). */
export function clampVolume(v, max = VOLUME_MAX) {
  const n = Number(v);
  if (!Number.isFinite(n)) return VOLUME_DEFAULT;
  return Math.min(max, Math.max(VOLUME_MIN, Math.round(n)));
}

/** One -/+ button press. dir is 1 or -1. Snaps to the step grid (95 up -> 100, 95 down -> 90). */
export function stepVolume(current, dir, step = VOLUME_BUTTON_STEP, max = VOLUME_MAX) {
  const c = clampVolume(current, max);
  const next = dir > 0 ? Math.floor(c / step) * step + step : Math.ceil(c / step) * step - step;
  return clampVolume(next, max);
}

/**
 * The storage key for a participant: the app user id. null (don't persist) when there's no user id,
 * or Daily has filled it in with the session id because the token had none.
 */
export function volumeKey(userId, sessionId) {
  if (typeof userId !== 'string') return null;
  const id = userId.trim();
  return id && id !== sessionId ? id : null;
}

/** Stored JSON -> Map<userId, pct>. A Map so a hostile "__proto__" key is just data. Bad input -> empty. */
export function parseVolumes(raw) {
  const out = new Map();
  if (typeof raw !== 'string' || !raw) return out;
  let data;
  try { data = JSON.parse(raw); } catch { return out; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [k, v] of Object.entries(data)) {
    if (!k || k.length > 100 || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const pct = clampVolume(v);
    if (pct !== VOLUME_DEFAULT) out.set(k, pct);
  }
  return out;
}

/** Map -> JSON object string, skipping entries at 100. */
export function serialiseVolumes(map) {
  const obj = {};
  for (const [k, v] of map) if (v !== VOLUME_DEFAULT) obj[k] = v;
  return JSON.stringify(obj);
}

/** A new Map with one volume changed (clamped). 100 removes the entry. Never mutates the input. */
export function withVolume(map, key, pct) {
  const next = new Map(map);
  const v = clampVolume(pct);
  if (v === VOLUME_DEFAULT) next.delete(key);
  else next.set(key, v);
  return next;
}

export const volumeText = (pct) => `${pct}%`;
/** Web Audio gain for a percentage. */
export const gainFor = (pct) => clampVolume(pct) / 100;
/** Only 100% plays straight through the element; anything else goes via the gain path. */
export const needsGain = (pct) => clampVolume(pct) !== VOLUME_DEFAULT;
/** el.volume for the no-Web-Audio fallback (can't boost). */
export const elementVolume = (pct) => Math.min(1, clampVolume(pct) / 100);

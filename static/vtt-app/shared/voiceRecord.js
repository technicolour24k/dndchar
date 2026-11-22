// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure helpers for in-browser session recording (daily-voice plan, Rev 4). No DOM, no MediaRecorder,
// no daily-js, so they can be unit tested. voiceRecorder.js does the Web Audio / MediaRecorder work.

/** Preferred first. Chromium/Firefox take webm/opus; Safari only does mp4 (AAC). */
export const RECORDING_MIME_CANDIDATES = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mime: 'audio/mp4', ext: 'm4a' }
];
/** Voice-grade; keeps a 5 hour session around 70 MB. */
export const RECORDING_BITRATE = 32000;
/** MediaRecorder timeslice: chunks arrive this often so memory use grows in small pieces. */
export const RECORDING_TIMESLICE_MS = 10000;
/** Tag on the Daily app message that announces a recorder to the call. */
export const RECORDING_MESSAGE_TYPE = 'voice:recording';

/** First supported candidate, or null. isSupported is MediaRecorder.isTypeSupported (injected). */
export function pickRecordingMime(isSupported) {
  for (const c of RECORDING_MIME_CANDIDATES) {
    try { if (isSupported(c.mime)) return c; } catch { /* treat as unsupported */ }
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/** <campaign>-<YYYY-MM-DD-HHmm>.<ext>, local time, safe for any filesystem. */
export function recordingFileName(campaignName, date, ext) {
  const slug = String(campaignName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'session';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${slug}-${stamp}.${ext}`;
}

/** 83000 -> "1:23", 3723000 -> "1:02:03". */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * What to change in the audio mix. current: Map id -> key it was built from; wanted: Map id -> { key }.
 * A source whose key changed (a new track) is removed and added again.
 */
export function diffSources(current, wanted) {
  const add = [];
  const remove = [];
  for (const [id, key] of current) {
    const w = wanted.get(id);
    if (!w || w.key !== key) remove.push(id);
  }
  for (const [id, w] of wanted) {
    if (current.get(id) !== w.key) add.push(id);
  }
  return { add, remove };
}

// ---- who is recording (the badge everyone sees) -------------------------------------------------
// recorders: plain object session_id -> name. Messages come over a Daily app message, which any
// participant can send, so this is an honest-group indicator, not a security control.

export function recordingMessage(on, name) {
  return on ? { type: RECORDING_MESSAGE_TYPE, on: true, name: String(name || '').slice(0, 60) } : { type: RECORDING_MESSAGE_TYPE, on: false };
}

/** New recorders map after an app message from fromId. Anything that isn't ours is ignored. */
export function applyRecordingMessage(recorders, data, fromId) {
  if (!data || typeof data !== 'object' || data.type !== RECORDING_MESSAGE_TYPE || !fromId) return recorders;
  const next = { ...recorders };
  if (data.on === true) next[fromId] = String(data.name || '').trim().slice(0, 60) || 'Someone';
  else delete next[fromId];
  return next;
}

/** Drop recorders who are no longer in the call. */
export function pruneRecorders(recorders, presentIds) {
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds || []);
  const next = {};
  for (const [id, name] of Object.entries(recorders || {})) if (present.has(id)) next[id] = name;
  return next;
}

/** "Recording (by Thorne (Tony))", or null when nobody is recording. Names sorted for a stable badge. */
export function badgeText(recorders) {
  const names = Object.values(recorders || {}).sort((a, b) => a.localeCompare(b));
  return names.length ? `Recording (by ${names.join(', ')})` : null;
}

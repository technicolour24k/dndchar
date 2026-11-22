// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the unit test import.
// Pure helpers for the voice dock (no DOM, no daily-js), so they can be unit-tested.
// Participant objects are daily-js participants: { session_id, user_name, local, audio, tracks }.
// user_name is user-controlled text: callers must render it with textContent, never innerHTML.

/** A level above this (0-1, from daily-js audio-level observers) counts as speaking. */
export const SPEECH_LEVEL = 0.05;
/** Keep the speaking ring up this long after the last loud sample, so it doesn't flicker. */
export const SPEAKING_HOLD_MS = 600;

/** True when the participant is sending audio. Prefers the track state, falls back to the audio flag. */
export function isAudioOn(p) {
  const state = p && p.tracks && p.tracks.audio && p.tracks.audio.state;
  if (state) return state !== 'off' && state !== 'blocked';
  return !!(p && p.audio);
}

/** Rows for the participant list: local first, then by name (case-insensitive). */
export function participantRows(participants, speakingIds, localId) {
  const speaking = speakingIds instanceof Set ? speakingIds : new Set(speakingIds || []);
  const rows = (participants || []).map((p) => {
    const id = p.session_id;
    const isLocal = !!p.local || (localId != null && id === localId);
    const name = String(p.user_name || '').trim() || 'Guest';
    return { id, name, isLocal, muted: !isAudioOn(p), speaking: speaking.has(id) };
  });
  rows.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);
  });
  return rows;
}

/** Which session ids count as speaking now, given when each was last loud. */
export function speakingIds(lastLoudAt, now, holdMs = SPEAKING_HOLD_MS) {
  const out = new Set();
  for (const [id, t] of Object.entries(lastLoudAt || {})) {
    if (now - t <= holdMs) out.add(id);
  }
  return out;
}

/**
 * What the dock shows for each state.
 * state: 'idle' | 'loading' | 'joining' | 'joined' | 'leaving' | 'error'
 * opts: { count, muted, message }
 */
export function dockLabel(state, opts = {}) {
  const count = Number.isFinite(opts.count) ? opts.count : 0;
  switch (state) {
    case 'loading':
      return { text: 'Voice: getting ready...', canJoin: false, canLeave: false, canMute: false, joinText: 'Join voice' };
    case 'joining':
      return { text: 'Voice: joining...', canJoin: false, canLeave: true, canMute: false, joinText: 'Join voice' };
    case 'joined':
      return {
        text: `Voice: ${count} in`,
        canJoin: false,
        canLeave: true,
        canMute: true,
        joinText: 'Join voice',
        muteText: opts.muted ? 'Unmute' : 'Mute'
      };
    case 'leaving':
      return { text: 'Voice: leaving...', canJoin: false, canLeave: false, canMute: false, joinText: 'Join voice' };
    case 'error':
      return { text: opts.message || 'Voice: something went wrong', canJoin: true, canLeave: false, canMute: false, joinText: 'Try again' };
    default:
      return { text: opts.message || 'Voice', canJoin: true, canLeave: false, canMute: false, joinText: 'Join voice' };
  }
}

/**
 * User-facing text for a failure. Codes are the voice-token route's errors plus a few of ours;
 * daily-js camera-error types ('permissions', 'not-found', ...) are accepted as-is.
 */
export function describeVoiceError(code) {
  switch (code) {
    case 'not_member':
      return "You're not a member of this campaign, so you can't join its voice.";
    case 'voice_not_configured':
      return "Voice isn't set up on this server.";
    case 'too_many_requests':
      return 'Slow down a moment, then try again.';
    case 'voice_unavailable':
      return "Voice service isn't responding. Try again in a bit.";
    case 'campaign_not_found':
      return "Couldn't find this campaign.";
    case 'network':
      return "Couldn't reach the server, try again.";
    case 'script_load':
      return "Couldn't load the voice library. Check your connection and try again.";
    case 'unsupported':
      return "This browser can't do voice chat.";
    case 'permissions':
      return 'Microphone blocked. Allow it for this site in your browser settings, then try again.';
    case 'not-found':
      return 'No microphone found.';
    case 'mic-in-use':
    case 'cam-mic-in-use':
      return 'Your microphone is being used by another app.';
    case 'undefined-mediadevices':
      return "This page can't use the microphone (it needs https or localhost).";
    default:
      return 'Voice hit a problem. Try again.';
  }
}

// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure idle rules for the voice dock (daily-voice plan, Unit 3). No DOM, no daily-js.
//
//   alone:   you've been the only one in the call for ALONE_LEAVE_MS          -> leave
//   silent:  nobody (you or anyone else) has spoken for SILENCE_PROMPT_MS     -> ask "still there?",
//            and leave PROMPT_GRACE_MS later if nobody answers (Stay, or anyone speaking, clears it)
//
// A hidden tab is NOT idle (people alt-tab to notes or a sheet while talking), so visibility is never
// consulted. And missing data counts as ACTIVE: until at least one audio signal (a level sample or an
// active-speaker event) has arrived, the silence rule never fires, so a broken audio-level observer
// can't kick people out of a live call.
import { SPEECH_LEVEL } from './voiceView.js';

export const ALONE_LEAVE_MS = 10 * 60 * 1000;
export const SILENCE_PROMPT_MS = 30 * 60 * 1000;
export const PROMPT_GRACE_MS = 60 * 1000;

/** The three timings, optionally divided (the ?voiceIdleTest=1 switch uses 60) for manual testing. */
export function idleTimings(divisor = 1) {
  const d = divisor > 0 ? divisor : 1;
  return { aloneMs: ALONE_LEAVE_MS / d, silenceMs: SILENCE_PROMPT_MS / d, graceMs: PROMPT_GRACE_MS / d };
}

export function isSpeech(level) {
  return typeof level === 'number' && level > SPEECH_LEVEL;
}

/**
 * Decide what to do right now.
 * Returns 'none' | 'prompt' | 'clear_prompt' | 'leave_alone' | 'leave_silent'.
 */
export function nextIdleAction({ now, participantCount, aloneSince, lastSpeechAt, promptShownAt, signalSeen, timings = idleTimings() }) {
  if (participantCount <= 1 && aloneSince != null && now - aloneSince >= timings.aloneMs) return 'leave_alone';
  if (!signalSeen) return 'none'; // unknown is treated as active
  if (promptShownAt != null) {
    if (lastSpeechAt >= promptShownAt) return 'clear_prompt'; // someone spoke since the prompt appeared
    return now - promptShownAt >= timings.graceMs ? 'leave_silent' : 'none';
  }
  return now - lastSpeechAt >= timings.silenceMs ? 'prompt' : 'none';
}

/** Small stateful wrapper so voice.js only reports events and asks tick(). */
export function createIdleTracker({ clock = Date.now, timings = idleTimings() } = {}) {
  let participantCount = 0;
  let aloneSince = null;
  let lastSpeechAt = clock();
  let promptShownAt = null;
  let signalSeen = false;
  return {
    /** Call whenever the participant count (including you) changes. */
    noteCount(n) {
      participantCount = n;
      if (n <= 1) { if (aloneSince == null) aloneSince = clock(); } else aloneSince = null;
    },
    /** Someone spoke (a level above the speech threshold, or an active-speaker event). */
    noteSpeech() { lastSpeechAt = clock(); signalSeen = true; },
    /** Any audio data arrived at all (a level sample, even a quiet one): the observers work. */
    noteSignal() { signalSeen = true; },
    /** "Stay" on the prompt. */
    stay() { lastSpeechAt = clock(); promptShownAt = null; },
    tick() {
      const action = nextIdleAction({ now: clock(), participantCount, aloneSince, lastSpeechAt, promptShownAt, signalSeen, timings });
      if (action === 'prompt') promptShownAt = clock();
      else if (action === 'clear_prompt') promptShownAt = null;
      return action;
    },
    get promptShown() { return promptShownAt != null; },
    promptSecondsLeft() {
      return promptShownAt == null ? 0 : Math.max(0, Math.ceil((timings.graceMs - (clock() - promptShownAt)) / 1000));
    }
  };
}

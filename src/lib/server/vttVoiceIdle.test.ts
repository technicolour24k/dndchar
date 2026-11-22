import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALONE_LEAVE_MS,
  PROMPT_GRACE_MS,
  SILENCE_PROMPT_MS,
  createIdleTracker,
  idleTimings,
  isSpeech,
  nextIdleAction
} from '../../../static/vtt-app/shared/voiceIdle.js';
import { describeEject, dockLabel, isMicError, pickDevices, rememberedDevice } from '../../../static/vtt-app/shared/voiceView.js';

const MIN = 60 * 1000;

describe('nextIdleAction (pure)', () => {
  const base = { now: 0, participantCount: 3, aloneSince: null, lastSpeechAt: 0, promptShownAt: null, signalSeen: true };

  it('leaves when alone for exactly 10 minutes, not a moment before', () => {
    const alone = { ...base, participantCount: 1, aloneSince: 0 };
    expect(nextIdleAction({ ...alone, now: ALONE_LEAVE_MS - 1 })).toBe('none');
    expect(nextIdleAction({ ...alone, now: ALONE_LEAVE_MS, lastSpeechAt: ALONE_LEAVE_MS })).toBe('leave_alone');
  });
  it('prompts after exactly 30 minutes of silence', () => {
    expect(nextIdleAction({ ...base, now: SILENCE_PROMPT_MS - 1 })).toBe('none');
    expect(nextIdleAction({ ...base, now: SILENCE_PROMPT_MS })).toBe('prompt');
  });
  it('leaves 60 s after the prompt, not before', () => {
    const shown = { ...base, promptShownAt: SILENCE_PROMPT_MS };
    expect(nextIdleAction({ ...shown, now: SILENCE_PROMPT_MS + PROMPT_GRACE_MS - 1 })).toBe('none');
    expect(nextIdleAction({ ...shown, now: SILENCE_PROMPT_MS + PROMPT_GRACE_MS })).toBe('leave_silent');
  });
  it('clears the prompt when someone spoke after it appeared', () => {
    expect(nextIdleAction({ ...base, promptShownAt: SILENCE_PROMPT_MS, lastSpeechAt: SILENCE_PROMPT_MS + 5, now: SILENCE_PROMPT_MS + 10 })).toBe('clear_prompt');
  });
  it('treats missing audio data as active: no silence rule until a signal has been seen', () => {
    expect(nextIdleAction({ ...base, signalSeen: false, now: 5 * 60 * MIN })).toBe('none');
    // ...but being alone still counts, it needs no audio data
    expect(nextIdleAction({ ...base, signalSeen: false, participantCount: 1, aloneSince: 0, now: ALONE_LEAVE_MS })).toBe('leave_alone');
  });
  it('divides the timings for the test switch', () => {
    expect(idleTimings(60)).toEqual({ aloneMs: 10_000, silenceMs: 30_000, graceMs: 1000 });
    expect(idleTimings(0).aloneMs).toBe(ALONE_LEAVE_MS);
  });
  it('isSpeech needs a number above the threshold', () => {
    expect(isSpeech(0.05)).toBe(false);
    expect(isSpeech(0.06)).toBe(true);
    expect(isSpeech(undefined)).toBe(false);
  });
});

describe('idle tracker (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('someone joining resets the alone timer', () => {
    const t = createIdleTracker();
    t.noteCount(1);
    vi.advanceTimersByTime(9 * MIN);
    t.noteCount(2);
    vi.advanceTimersByTime(5 * MIN);
    t.noteSpeech();
    t.noteCount(1); // they left again: the alone clock restarts now
    vi.advanceTimersByTime(9 * MIN + 59_000);
    expect(t.tick()).toBe('none');
    vi.advanceTimersByTime(1000);
    expect(t.tick()).toBe('leave_alone');
  });

  it('silence: prompt at 30 min, leave a minute later if unanswered', () => {
    const t = createIdleTracker();
    t.noteCount(3);
    t.noteSignal();
    vi.advanceTimersByTime(29 * MIN);
    expect(t.tick()).toBe('none');
    vi.advanceTimersByTime(1 * MIN);
    expect(t.tick()).toBe('prompt');
    expect(t.promptShown).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(t.tick()).toBe('none');
    expect(t.promptSecondsLeft()).toBe(30);
    vi.advanceTimersByTime(30_000);
    expect(t.tick()).toBe('leave_silent');
  });

  it('speech during the prompt clears it, and the clock restarts', () => {
    const t = createIdleTracker();
    t.noteCount(3);
    t.noteSignal();
    vi.advanceTimersByTime(30 * MIN);
    expect(t.tick()).toBe('prompt');
    vi.advanceTimersByTime(20_000);
    t.noteSpeech();
    expect(t.tick()).toBe('clear_prompt');
    expect(t.promptShown).toBe(false);
    vi.advanceTimersByTime(29 * MIN);
    expect(t.tick()).toBe('none');
  });

  it('Stay clears the prompt and restarts the silence clock', () => {
    const t = createIdleTracker();
    t.noteCount(3);
    t.noteSignal();
    vi.advanceTimersByTime(30 * MIN);
    expect(t.tick()).toBe('prompt');
    t.stay();
    expect(t.promptShown).toBe(false);
    vi.advanceTimersByTime(59 * 1000);
    expect(t.tick()).toBe('none');
    vi.advanceTimersByTime(30 * MIN);
    expect(t.tick()).toBe('prompt');
  });

  it('never prompts if no audio signal ever arrived (broken observers)', () => {
    const t = createIdleTracker();
    t.noteCount(3);
    vi.advanceTimersByTime(5 * 60 * MIN);
    expect(t.tick()).toBe('none');
  });

  it('the test switch shortens everything by 60', () => {
    const t = createIdleTracker({ timings: idleTimings(60) });
    t.noteCount(1);
    vi.advanceTimersByTime(10_000);
    expect(t.tick()).toBe('leave_alone');
  });
});

describe('dock label extras', () => {
  it('listen only: counted, no mute button', () => {
    expect(dockLabel('joined', { count: 2, listenOnly: true })).toMatchObject({ text: 'Voice: 2 in (listening only)', canMute: false });
  });
  it('an error can offer listen-only', () => {
    expect(dockLabel('error', { message: 'x', offerListenOnly: true }).canListenOnly).toBe(true);
    expect(dockLabel('error', { message: 'x' }).canListenOnly).toBe(false);
  });
  it('after a reload the join button reads Rejoin voice and is highlighted (no auto-join)', () => {
    expect(dockLabel('idle', { rejoin: true })).toMatchObject({ joinText: 'Rejoin voice', highlightJoin: true, canJoin: true });
    expect(dockLabel('idle')).toMatchObject({ joinText: 'Join voice', highlightJoin: false });
  });
  it('classifies mic errors', () => {
    expect(isMicError('permissions')).toBe(true);
    expect(isMicError('not-found')).toBe(true);
    expect(isMicError('connection-error')).toBe(false);
  });
  it('words an eject as the cap or a removal', () => {
    const cap = 6 * 60 * MIN;
    expect(describeEject(cap, cap)).toMatch(/time limit/);
    expect(describeEject(cap - 2 * MIN, cap)).toMatch(/time limit/);
    expect(describeEject(10 * MIN, cap)).toMatch(/removed/);
  });
});

describe('device helpers', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'a', label: 'USB Mic' },
    { kind: 'audioinput', deviceId: 'b', label: '' },
    { kind: 'audiooutput', deviceId: 'c', label: 'Headphones' },
    { kind: 'videoinput', deviceId: 'd', label: 'Cam' },
    { kind: 'audioinput', deviceId: '', label: 'broken' }
  ];
  it('lists only the wanted kind, naming unlabelled devices', () => {
    expect(pickDevices(devices, 'audioinput')).toEqual([
      { id: 'a', label: 'USB Mic' },
      { id: 'b', label: 'Microphone 2' }
    ]);
    expect(pickDevices(devices, 'audiooutput')).toEqual([{ id: 'c', label: 'Headphones' }]);
    expect(pickDevices(undefined as any, 'audioinput')).toEqual([]);
  });
  it('ignores a remembered id that no longer exists', () => {
    const list = pickDevices(devices, 'audioinput');
    expect(rememberedDevice('a', list)).toBe('a');
    expect(rememberedDevice('gone', list)).toBeNull();
    expect(rememberedDevice(null, list)).toBeNull();
  });
});

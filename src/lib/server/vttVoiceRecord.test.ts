import { describe, expect, it } from 'vitest';
import {
  RECORDING_MESSAGE_TYPE,
  applyRecordingMessage,
  badgeText,
  diffSources,
  formatElapsed,
  pickRecordingMime,
  pruneRecorders,
  recordingFileName,
  recordingMessage
} from '../../../static/vtt-app/shared/voiceRecord.js';

describe('pickRecordingMime', () => {
  it('prefers webm/opus', () => {
    expect(pickRecordingMime(() => true)).toEqual({ mime: 'audio/webm;codecs=opus', ext: 'webm' });
  });
  it('falls back to mp4 (Safari) and uses the m4a extension', () => {
    expect(pickRecordingMime((t: string) => t.startsWith('audio/mp4'))).toEqual({ mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' });
    expect(pickRecordingMime((t: string) => t === 'audio/mp4')).toEqual({ mime: 'audio/mp4', ext: 'm4a' });
  });
  it('is null when nothing is supported, and survives a throwing check', () => {
    expect(pickRecordingMime(() => false)).toBeNull();
    expect(pickRecordingMime(() => { throw new Error('x'); })).toBeNull();
  });
});

describe('recordingFileName', () => {
  const d = new Date(2026, 10, 22, 9, 5); // local time: 22 Nov 2026 09:05
  it('is campaign-date-time.ext in local time', () => {
    expect(recordingFileName('Curse of Strahd', d, 'webm')).toBe('curse-of-strahd-2026-11-22-0905.webm');
    expect(recordingFileName('Tonys Game', d, 'm4a')).toBe('tonys-game-2026-11-22-0905.m4a');
  });
  it('sanitises odd names, caps the length and falls back to session', () => {
    expect(recordingFileName('../../etc/passwd!!', d, 'webm')).toBe('etc-passwd-2026-11-22-0905.webm');
    expect(recordingFileName('', d, 'webm')).toBe('session-2026-11-22-0905.webm');
    expect(recordingFileName('???', d, 'webm')).toBe('session-2026-11-22-0905.webm');
    expect(recordingFileName('a'.repeat(100), d, 'webm').length).toBe(40 + '-2026-11-22-0905.webm'.length);
  });
});

describe('formatElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('0:00');
    expect(formatElapsed(undefined as any)).toBe('0:00');
  });
});

describe('diffSources', () => {
  const w = (o: Record<string, string>) => new Map(Object.entries(o).map(([id, key]) => [id, { key }]));
  it('adds newcomers and removes leavers', () => {
    expect(diffSources(new Map([['a', 't1']]), w({ a: 't1', b: 't2' }))).toEqual({ add: ['b'], remove: [] });
    expect(diffSources(new Map([['a', 't1'], ['b', 't2']]), w({ a: 't1' }))).toEqual({ add: [], remove: ['b'] });
  });
  it('swaps a source whose track changed', () => {
    expect(diffSources(new Map([['a', 't1']]), w({ a: 't9' }))).toEqual({ add: ['a'], remove: ['a'] });
  });
  it('does nothing when nothing changed', () => {
    expect(diffSources(new Map([['a', 't1']]), w({ a: 't1' }))).toEqual({ add: [], remove: [] });
  });
});

describe('recording badge state', () => {
  it('builds the message and caps the name', () => {
    expect(recordingMessage(true, 'DM (Tony)')).toEqual({ type: RECORDING_MESSAGE_TYPE, on: true, name: 'DM (Tony)' });
    expect(recordingMessage(true, 'n'.repeat(100)).name).toHaveLength(60);
    expect(recordingMessage(false, 'x')).toEqual({ type: RECORDING_MESSAGE_TYPE, on: false });
  });
  it('applies on and off messages per sender', () => {
    let r = applyRecordingMessage({}, recordingMessage(true, 'DM (Tony)'), 'p1');
    r = applyRecordingMessage(r, recordingMessage(true, 'Co-DM (Sam)'), 'p2');
    expect(badgeText(r)).toBe('Recording (by Co-DM (Sam), DM (Tony))');
    r = applyRecordingMessage(r, recordingMessage(false, ''), 'p1');
    expect(badgeText(r)).toBe('Recording (by Co-DM (Sam))');
    r = applyRecordingMessage(r, recordingMessage(false, ''), 'p2');
    expect(badgeText(r)).toBeNull();
  });
  it('ignores foreign or malformed messages and a missing sender', () => {
    const start = { p1: 'DM (Tony)' };
    expect(applyRecordingMessage(start, { type: 'something-else', on: true }, 'p9')).toBe(start);
    expect(applyRecordingMessage(start, null, 'p9')).toBe(start);
    expect(applyRecordingMessage(start, 'recording', 'p9')).toBe(start);
    expect(applyRecordingMessage(start, recordingMessage(true, 'x'), undefined)).toBe(start);
  });
  it('names a blank recorder "Someone"', () => {
    expect(badgeText(applyRecordingMessage({}, { type: RECORDING_MESSAGE_TYPE, on: true, name: '  ' }, 'p1'))).toBe('Recording (by Someone)');
  });
  it('drops recorders who left the call', () => {
    expect(pruneRecorders({ p1: 'A', p2: 'B' }, new Set(['p2']))).toEqual({ p2: 'B' });
    expect(pruneRecorders({ p1: 'A' }, [])).toEqual({});
  });
});

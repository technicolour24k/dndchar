import { describe, expect, it } from 'vitest';
import { SPEAKING_HOLD_MS, describeVoiceError, dockLabel, isAudioOn, participantRows, speakingIds } from '../../../static/vtt-app/shared/voiceView.js';

const p = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ session_id: id, user_name: name, local: false, audio: true, ...extra });

describe('isAudioOn', () => {
  it('prefers the track state', () => {
    expect(isAudioOn(p('a', 'A', { tracks: { audio: { state: 'off' } } }))).toBe(false);
    expect(isAudioOn(p('a', 'A', { tracks: { audio: { state: 'blocked' } } }))).toBe(false);
    expect(isAudioOn(p('a', 'A', { audio: false, tracks: { audio: { state: 'playable' } } }))).toBe(true);
    expect(isAudioOn(p('a', 'A', { tracks: { audio: { state: 'loading' } } }))).toBe(true);
  });
  it('falls back to the audio flag', () => {
    expect(isAudioOn(p('a', 'A', { audio: false }))).toBe(false);
    expect(isAudioOn(p('a', 'A'))).toBe(true);
  });
});

describe('participantRows', () => {
  it('puts the local participant first, then sorts by name case-insensitively', () => {
    const rows = participantRows([p('1', 'zed'), p('2', 'Bob'), p('3', 'me', { local: true }), p('4', 'alice')], new Set(), '3');
    expect(rows.map((r: any) => r.name)).toEqual(['me', 'alice', 'Bob', 'zed']);
    expect(rows[0].isLocal).toBe(true);
  });
  it('finds the local row by id when the local flag is missing', () => {
    expect(participantRows([p('1', 'x'), p('2', 'y')], [], '2')[0].id).toBe('2');
  });
  it('marks speaking and muted, and names blank users Guest', () => {
    const rows = participantRows([p('1', '  ', { audio: false }), p('2', 'Cy')], new Set(['2']), null);
    expect(rows.find((r: any) => r.id === '1')).toMatchObject({ name: 'Guest', muted: true, speaking: false });
    expect(rows.find((r: any) => r.id === '2')).toMatchObject({ muted: false, speaking: true });
  });
  it('keeps markup in names as plain text (callers render via textContent)', () => {
    expect(participantRows([p('1', '<img src=x onerror=alert(1)>')], [], null)[0].name).toBe('<img src=x onerror=alert(1)>');
  });
  it('handles empty input', () => {
    expect(participantRows(undefined as any, undefined as any, null)).toEqual([]);
  });
});

describe('speakingIds', () => {
  it('keeps a speaker for the hold time, then drops them', () => {
    const loud = { a: 1000, b: 1000 - SPEAKING_HOLD_MS - 1 };
    expect([...speakingIds(loud, 1000)]).toEqual(['a']);
    expect(speakingIds(loud, 1000 + SPEAKING_HOLD_MS).has('a')).toBe(true);
    expect(speakingIds(loud, 1000 + SPEAKING_HOLD_MS + 1).has('a')).toBe(false);
  });
});

describe('dockLabel', () => {
  it('idle can join only', () => {
    expect(dockLabel('idle')).toMatchObject({ canJoin: true, canLeave: false, canMute: false });
  });
  it('blocks Join while loading, joining, joined and leaving (no double joins)', () => {
    for (const s of ['loading', 'joining', 'joined', 'leaving']) expect(dockLabel(s).canJoin).toBe(false);
  });
  it('joined shows the count and a mute toggle', () => {
    expect(dockLabel('joined', { count: 3, muted: false })).toMatchObject({ text: 'Voice: 3 in', canMute: true, canLeave: true, muteText: 'Mute' });
    expect(dockLabel('joined', { count: 1, muted: true }).muteText).toBe('Unmute');
  });
  it('error shows the message and offers Try again', () => {
    expect(dockLabel('error', { message: 'nope' })).toMatchObject({ text: 'nope', canJoin: true, joinText: 'Try again' });
  });
});

describe('describeVoiceError', () => {
  it('maps the route errors', () => {
    expect(describeVoiceError('voice_not_configured')).toBe("Voice isn't set up on this server.");
    expect(describeVoiceError('not_member')).toMatch(/not a member/);
    expect(describeVoiceError('too_many_requests')).toMatch(/Slow down/);
    expect(describeVoiceError('voice_unavailable')).toMatch(/isn't responding/);
    expect(describeVoiceError('network')).toMatch(/reach the server/);
  });
  it('maps daily-js mic errors and falls back for unknown codes', () => {
    expect(describeVoiceError('permissions')).toMatch(/blocked/);
    expect(describeVoiceError('not-found')).toMatch(/No microphone/);
    expect(describeVoiceError('mic-in-use')).toMatch(/another app/);
    expect(describeVoiceError('whatever')).toMatch(/problem/);
    expect(describeVoiceError(undefined)).toMatch(/problem/);
  });
});

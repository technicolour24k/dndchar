import { describe, expect, it } from 'vitest';
import { voiceDisplayName } from './voice/voiceName';

describe('voiceDisplayName', () => {
  it('player with a character: Character (Player)', () => {
    expect(voiceDisplayName({ role: 'player', playerName: 'Tony', characterName: 'Thorne' })).toBe('Thorne (Tony)');
  });
  it('player without a character: just the player name', () => {
    expect(voiceDisplayName({ role: 'player', playerName: 'Tony', characterName: null })).toBe('Tony');
    expect(voiceDisplayName({ role: 'player', playerName: 'Tony', characterName: '   ' })).toBe('Tony');
  });
  it('DMs are labelled by campaign role regardless of characters', () => {
    expect(voiceDisplayName({ role: 'dm', playerName: 'Tony', characterName: 'Thorne' })).toBe('DM (Tony)');
    expect(voiceDisplayName({ role: 'co_dm', playerName: 'Sam', characterName: 'Thorne' })).toBe('Co-DM (Sam)');
  });
  it('tidies whitespace and falls back to Guest for an empty player name', () => {
    expect(voiceDisplayName({ role: 'player', playerName: '  ', characterName: ' A   B ' })).toBe('A B (Guest)');
  });
  it('caps each part', () => {
    expect(voiceDisplayName({ role: 'player', playerName: 'p'.repeat(80), characterName: 'c'.repeat(80) }).length).toBe(30 + 2 + 24 + 1);
  });
});

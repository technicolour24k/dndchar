import { describe, expect, it } from 'vitest';
import { nextQuery, safeNext } from './safeNext';

describe('safeNext', () => {
  it('accepts same-origin relative paths, with query and hash', () => {
    expect(safeNext('/campaigns/join/ABCDEFGHJK')).toBe('/campaigns/join/ABCDEFGHJK');
    expect(safeNext('/campaigns?q=abc&page=2')).toBe('/campaigns?q=abc&page=2');
    expect(safeNext('/characters/1#top')).toBe('/characters/1#top');
  });

  it('rejects open-redirect shapes', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'https://x',
      'http://x/y',
      'javascript:alert(1)',
      'evil.example',
      '/\t/evil.example',
      '/foo\\bar',
      '/a\nb',
      ''
    ]) {
      expect(safeNext(bad), bad).toBe('/dashboard');
    }
  });

  it('caps the length', () => {
    expect(safeNext('/' + 'a'.repeat(1999))).toHaveLength(2000);
    expect(safeNext('/' + 'a'.repeat(2000))).toBe('/dashboard');
  });

  it('rejects null and undefined', () => {
    expect(safeNext(null)).toBe('/dashboard');
    expect(safeNext(undefined)).toBe('/dashboard');
  });

  it('refuses to bounce back into login or register', () => {
    expect(safeNext('/login')).toBe('/dashboard');
    expect(safeNext('/login?next=/x')).toBe('/dashboard');
    expect(safeNext('/register')).toBe('/dashboard');
    expect(safeNext('/login/')).toBe('/dashboard');
    expect(safeNext('/register//?x=1')).toBe('/dashboard');
    expect(safeNext('/loginfoo')).toBe('/loginfoo');
  });
});

describe('nextQuery', () => {
  it('encodes a real destination and omits the default', () => {
    expect(nextQuery('/campaigns/join/ABC')).toBe('?next=%2Fcampaigns%2Fjoin%2FABC');
    expect(nextQuery('/dashboard')).toBe('');
    expect(nextQuery('')).toBe('');
  });
});

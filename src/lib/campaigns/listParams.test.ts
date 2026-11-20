import { describe, expect, it } from 'vitest';
import { formatInviteCode, listHref, parseListParams, roleLabel } from './listParams';

const parse = (qs: string, admin = false) => parseListParams(new URLSearchParams(qs), admin);

describe('parseListParams', () => {
  it('defaults to page 1, no search, no archived', () => {
    expect(parse('')).toEqual({ q: '', page: 1, includeArchived: false });
  });

  it('trims and caps the search', () => {
    expect(parse('q=%20%20dragon%20').q).toBe('dragon');
    expect(parse(`q=${'x'.repeat(200)}`).q).toHaveLength(80);
  });

  it('only accepts a positive whole page number', () => {
    expect(parse('page=3').page).toBe(3);
    expect(parse('page=0').page).toBe(1);
    expect(parse('page=-2').page).toBe(1);
    expect(parse('page=abc').page).toBe(1);
    expect(parse('page=2.7').page).toBe(2);
  });

  it('honours archived=1 for admins only', () => {
    expect(parse('archived=1', true).includeArchived).toBe(true);
    expect(parse('archived=1', false).includeArchived).toBe(false);
    expect(parse('archived=yes', true).includeArchived).toBe(false);
  });
});

describe('listHref', () => {
  it('omits defaults', () => {
    expect(listHref({ q: '', page: 1, includeArchived: false })).toBe('/campaigns');
  });

  it('keeps the search and archived flag across pages', () => {
    expect(listHref({ q: 'dragon keep', page: 2, includeArchived: true })).toBe('/campaigns?q=dragon+keep&archived=1&page=2');
    expect(listHref({ q: 'a&b', page: 1, includeArchived: false })).toBe('/campaigns?q=a%26b');
  });
});

describe('small formatters', () => {
  it('groups invite codes', () => {
    expect(formatInviteCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(formatInviteCode('SHORT')).toBe('SHORT');
  });
  it('labels roles', () => {
    expect(roleLabel('dm')).toBe('DM');
    expect(roleLabel('co_dm')).toBe('Co-DM');
    expect(roleLabel('player')).toBe('Player');
    expect(roleLabel(null)).toBe('Admin');
  });
});

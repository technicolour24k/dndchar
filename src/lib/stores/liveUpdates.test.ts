import { describe, expect, it } from 'vitest';
import { mergeLogEntries } from './liveUpdates';

type Entry = { id: string; createdAt: string; message: string };

function entry(id: string, createdAt: string, message = id): Entry {
  return { id, createdAt, message };
}

describe('mergeLogEntries', () => {
  it('dedupes by id, preferring the incoming copy', () => {
    const existing = [entry('a', '2026-01-01T00:00:00.000Z', 'old')];
    const incoming = [entry('a', '2026-01-01T00:00:00.000Z', 'new')];
    const result = mergeLogEntries(existing, incoming, 10);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('new');
  });

  it('sorts ascending by createdAt', () => {
    const existing = [entry('b', '2026-01-01T00:00:02.000Z')];
    const incoming = [entry('a', '2026-01-01T00:00:01.000Z'), entry('c', '2026-01-01T00:00:03.000Z')];
    const result = mergeLogEntries(existing, incoming, 10);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties on the same createdAt by id', () => {
    const existing = [entry('z', '2026-01-01T00:00:00.000Z')];
    const incoming = [entry('a', '2026-01-01T00:00:00.000Z')];
    const result = mergeLogEntries(existing, incoming, 10);
    expect(result.map((e) => e.id)).toEqual(['a', 'z']);
  });

  it('keeps only the last `cap` entries after sorting', () => {
    const existing = [entry('1', '2026-01-01T00:00:01.000Z'), entry('2', '2026-01-01T00:00:02.000Z')];
    const incoming = [entry('3', '2026-01-01T00:00:03.000Z')];
    const result = mergeLogEntries(existing, incoming, 2);
    expect(result.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('cap: Infinity keeps everything (SessionNotesModal full-history use)', () => {
    const existing = Array.from({ length: 50 }, (_, i) => entry(String(i), `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`));
    const result = mergeLogEntries(existing, [], Infinity);
    expect(result).toHaveLength(50);
  });

  it('returns an empty array when both inputs are empty', () => {
    expect(mergeLogEntries([], [], 10)).toEqual([]);
  });
});

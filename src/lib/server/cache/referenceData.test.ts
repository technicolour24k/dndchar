import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedReference, invalidateReferenceData } from './referenceData';

let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `key-${keyCounter}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cachedReference', () => {
  it('caches the result of a successful load', async () => {
    const key = freshKey();
    const load = vi.fn().mockResolvedValue('value');

    const first = await cachedReference(key, load);
    const second = await cachedReference(key, load);

    expect(first).toBe('value');
    expect(second).toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent loads for the same key into a single call', async () => {
    const key = freshKey();
    let resolveLoad: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve; }));

    const first = cachedReference(key, load);
    const second = cachedReference(key, load);

    resolveLoad!('value');

    expect(await first).toBe('value');
    expect(await second).toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidateReferenceData clears the cache so the next call re-loads', async () => {
    const key = freshKey();
    const load = vi.fn().mockResolvedValue('value');

    await cachedReference(key, load);
    invalidateReferenceData('test');
    await cachedReference(key, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected load - the next call retries', async () => {
    const key = freshKey();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('value');

    await expect(cachedReference(key, load)).rejects.toThrow('transient');
    await expect(cachedReference(key, load)).resolves.toBe('value');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('expires after the given TTL', async () => {
    vi.useFakeTimers();
    const key = freshKey();
    const load = vi.fn().mockResolvedValue('value');

    await cachedReference(key, load, { ttlMs: 1000 });
    vi.advanceTimersByTime(1001);
    await cachedReference(key, load, { ttlMs: 1000 });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps different keys independent', async () => {
    const keyA = freshKey();
    const keyB = freshKey();
    const loadA = vi.fn().mockResolvedValue('a');
    const loadB = vi.fn().mockResolvedValue('b');

    expect(await cachedReference(keyA, loadA)).toBe('a');
    expect(await cachedReference(keyB, loadB)).toBe('b');
    expect(await cachedReference(keyA, loadA)).toBe('a');

    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// --- subscribeTopic / watchdog / visibility (fake WebSocket, node environment) ---

type Listener = (event?: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
  }
  // Test helper: fire an event as the browser would.
  emit(type: string, event?: unknown) {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

// Minimal document stub: just enough for the visibilitychange listener.
function makeDocument() {
  const listeners: Listener[] = [];
  return {
    visibilityState: 'visible',
    addEventListener(_type: string, fn: Listener) {
      listeners.push(fn);
    },
    fire() {
      for (const fn of listeners) fn();
    }
  };
}

describe('liveUpdates connection behaviour', () => {
  let doc: ReturnType<typeof makeDocument>;

  // The module keeps its state at top level, so load a fresh copy per test.
  async function load() {
    vi.resetModules();
    return await import('./liveUpdates');
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    doc = makeDocument();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
    vi.stubGlobal('document', doc);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function noop() {}

  it('with the socket already open, onResync is async and runs once', async () => {
    const { subscribeTopic } = await load();
    const first = subscribeTopic('a', { onMessage: noop, onResync: noop });
    FakeWebSocket.instances[0].emit('open');

    const onResync = vi.fn();
    const second = subscribeTopic('b', { onMessage: noop, onResync });
    expect(onResync).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onResync).toHaveBeenCalledTimes(1);
    first();
    second();
  });

  it('unsubscribing before the microtask means onResync never runs', async () => {
    const { subscribeTopic } = await load();
    const keepAlive = subscribeTopic('a', { onMessage: noop, onResync: noop });
    FakeWebSocket.instances[0].emit('open');

    const onResync = vi.fn();
    const unsubscribe = subscribeTopic('b', { onMessage: noop, onResync });
    unsubscribe();
    await Promise.resolve();
    expect(onResync).not.toHaveBeenCalled();
    keepAlive();
  });

  it('the open event still resyncs every subscriber', async () => {
    const { subscribeTopic } = await load();
    const resyncA = vi.fn();
    const resyncB = vi.fn();
    const a = subscribeTopic('a', { onMessage: noop, onResync: resyncA });
    const b = subscribeTopic('b', { onMessage: noop, onResync: resyncB });
    expect(resyncA).not.toHaveBeenCalled();
    FakeWebSocket.instances[0].emit('open');
    expect(resyncA).toHaveBeenCalledTimes(1);
    expect(resyncB).toHaveBeenCalledTimes(1);
    a();
    b();
  });

  it('watchdog closes the old socket, reconnects at once, and ignores the old close event', async () => {
    vi.useFakeTimers();
    const { subscribeTopic } = await load();
    const unsubscribe = subscribeTopic('a', { onMessage: noop, onResync: noop });
    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.emit('open');

    vi.advanceTimersByTime(75_000);
    expect(oldSocket.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The stale socket's belated close must not null or replace the new one.
    const newSocket = FakeWebSocket.instances[1];
    oldSocket.emit('close');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    newSocket.emit('open');
    expect(newSocket.sent.length).toBe(1);
    unsubscribe();
  });

  it('visibilitychange to visible with an open socket resyncs each subscriber once', async () => {
    const { subscribeTopic } = await load();
    const resyncA = vi.fn();
    const resyncB = vi.fn();
    const a = subscribeTopic('a', { onMessage: noop, onResync: resyncA });
    const b = subscribeTopic('b', { onMessage: noop, onResync: resyncB });
    FakeWebSocket.instances[0].emit('open');
    resyncA.mockClear();
    resyncB.mockClear();

    doc.fire();
    expect(resyncA).toHaveBeenCalledTimes(1);
    expect(resyncB).toHaveBeenCalledTimes(1);
    a();
    b();
  });

  it('visibilitychange to visible with a closed socket reconnects', async () => {
    const { subscribeTopic } = await load();
    const onResync = vi.fn();
    const unsubscribe = subscribeTopic('a', { onMessage: noop, onResync });
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    onResync.mockClear();
    socket.readyState = FakeWebSocket.CLOSED;

    doc.fire();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onResync).not.toHaveBeenCalled();
    unsubscribe();
  });
});

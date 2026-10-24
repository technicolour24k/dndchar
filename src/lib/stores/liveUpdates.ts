// db-traffic-reduction Phase 5: one shared websocket per tab to the VTT's
// existing /vtt-ws server (see vtt/server/wsServer.js's 'watch' handling and
// store.js's setWatches/removeWatcher/publish) - replaces the four separate
// 4s/10s polls that used to live in CharacterSheetForm.svelte and
// SessionNotesModal.svelte (src/lib/stores/visiblePoll.ts, now unused).
//
// Deliberately NOT a Svelte store (no `subscribe`) - subscribeTopic() is a
// plain function returning a plain cleanup function, so it drops straight
// into a component's $effect the same way pollWhileVisible did.
//
// Reconnect is the only "fallback" this has: on every (re)connect it resends
// the full watch list and calls every subscriber's onResync, which is
// expected to do an incremental (afterId) re-fetch - Postgres stays
// authoritative and a missed message is always caught up on the next
// resync, per CLAUDE.md's "every (re)connect triggers an incremental
// re-fetch" rule. There is no poll fallback - see the plan's own 5h.

type Subscriber = {
  topic: string;
  onMessage: (msg: Record<string, unknown>) => void;
  onResync: () => void;
};

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 75_000;

let ws: WebSocket | null = null;
const subscribersByTopic = new Map<string, Set<Subscriber>>();

let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
let visibilityListenerAttached = false;

function isOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function allTopics(): string[] {
  return Array.from(subscribersByTopic.keys());
}

function sendWatchList(): void {
  if (isOpen()) ws!.send(JSON.stringify({ type: 'watch', topics: allTopics() }));
}

function resyncAllSubscribers(): void {
  for (const subs of subscribersByTopic.values()) {
    for (const sub of subs) sub.onResync();
  }
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }
}

// No message (including the server's own periodic {type:'hb'}) for this long
// means the connection is dead in a way the browser hasn't noticed yet
// (some proxies drop idle sockets without ever sending a close frame) -
// force a reconnect rather than waiting indefinitely.
function resetWatchdog(): void {
  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    if (ws) ws.close();
  }, WATCHDOG_TIMEOUT_MS);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || subscribersByTopic.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
}

function attachVisibilityListener(): void {
  if (visibilityListenerAttached || typeof document === 'undefined') return;
  visibilityListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isOpen() && subscribersByTopic.size > 0) {
      // Don't wait out the backoff timer - a tab coming back into view wants
      // to be live again immediately, not up to 30s later.
      clearReconnectTimer();
      connect();
    }
  });
}

function connect(): void {
  if (typeof WebSocket === 'undefined') return; // SSR guard - $effect never runs there anyway
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  attachVisibilityListener();

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/vtt-ws`);
  ws = socket;

  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    resetWatchdog();
    sendWatchList();
    resyncAllSubscribers();
  });

  socket.addEventListener('message', (event) => {
    if (ws !== socket) return;
    resetWatchdog();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'hb') return; // heartbeat-only frame, nothing to route
    const topic = msg.topic;
    if (typeof topic !== 'string') return;
    const subs = subscribersByTopic.get(topic);
    if (!subs) return;
    for (const sub of subs) sub.onMessage(msg);
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return; // a stale socket's belated close - the current one already replaced it
    ws = null;
    clearWatchdog();
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
}

function disconnect(): void {
  clearReconnectTimer();
  clearWatchdog();
  reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close();
  }
}

// Subscribes a component to `topic`. `onMessage` fires for every pushed
// message on that topic; `onResync` fires once as soon as the socket is (or
// becomes) open - on first subscribe if already connected, immediately after
// connecting if not, and again on every reconnect - and is expected to do an
// incremental (afterId-style) re-fetch to catch up on anything missed.
//
// Returns an unsubscribe function - call it from the owning $effect's
// cleanup, same shape as visiblePoll.ts's pollWhileVisible.
export function subscribeTopic(topic: string, { onMessage, onResync }: { onMessage: (msg: Record<string, unknown>) => void; onResync: () => void }): () => void {
  const sub: Subscriber = { topic, onMessage, onResync };
  let subs = subscribersByTopic.get(topic);
  if (!subs) {
    subs = new Set();
    subscribersByTopic.set(topic, subs);
  }
  subs.add(sub);

  if (isOpen()) {
    sendWatchList();
    onResync();
  } else {
    connect();
  }

  return function unsubscribe() {
    subs!.delete(sub);
    if (subs!.size === 0) subscribersByTopic.delete(topic);

    if (subscribersByTopic.size === 0) {
      disconnect();
    } else if (isOpen()) {
      sendWatchList();
    }
  };
}

// Dedupes `existing` + `incoming` by id, sorts ascending by createdAt (then
// id, for entries sharing a timestamp), and keeps only the last `cap`. Used
// both for a pushed single-entry merge and for merging a full afterId
// backlog fetch - same shape either way. Pass `cap: Infinity` for "no cap"
// (SessionNotesModal's full-session view).
export function mergeLogEntries<T extends { id: string; createdAt: string }>(existing: T[], incoming: T[], cap: number): T[] {
  const byId = new Map<string, T>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  const merged = Array.from(byId.values());
  merged.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged.slice(-cap);
}

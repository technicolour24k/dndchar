import type { OverworldVisibility, Pt } from '$lib/types/overworld';

// Live route preview, client side (Unit G). Its own socket to /vtt-ws, open only while the viewer page
// is mounted. Each (re)connect fetches a fresh one-use ticket from the live-ticket route, so rights are
// re-checked every time. Reconnects quietly with backoff; a refused ticket (404: no longer allowed to
// see the map) stops for good. Nothing here is stored anywhere: it only relays the drawer's points.

export type RemotePreview = { previewId: string; drawerName: string; points: Pt[]; visibility: OverworldVisibility; colour: string };
export type PreviewFrame = { points: Pt[]; visibility: OverworldVisibility; colour: string };

const SEND_EVERY_MS = 220; // about 4-5 frames a second
const KEEPALIVE_MS = 15_000; // the server clears a preview nobody refreshes for 30 s
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export function createLiveChannel(opts: {
  campaignId: string;
  mapId: string;
  onPreview: (p: RemotePreview) => void;
  onClear: (previewId: string) => void;
  onReset: () => void; // connection lost: drop every remote preview
  onReady?: () => void; // (re)joined: resend whatever is being drawn
}) {
  let ws: WebSocket | null = null;
  let ready = false;
  let stopped = false;
  let backoff = MIN_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Outgoing: the latest frame wins, sent at most every SEND_EVERY_MS, identical frames skipped.
  let wanted: PreviewFrame | null = null;
  let lastSentJson = '';
  let lastSentAt = 0;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  function flush() {
    sendTimer = undefined;
    if (!ready || !wanted) return;
    const json = JSON.stringify({ type: 'overworld:preview', ...wanted });
    if (json === lastSentJson) return;
    ws!.send(json);
    lastSentJson = json;
    lastSentAt = Date.now();
  }

  async function connect() {
    if (stopped) return;
    let ticket: string;
    try {
      const res = await fetch(`/campaigns/${opts.campaignId}/overworld/${opts.mapId}/live-ticket`, { method: 'POST' });
      if (res.status === 404 || res.status === 401 || res.status === 403) return; // not allowed: stay quiet, no retry
      if (!res.ok) throw new Error('ticket');
      ticket = (await res.json()).ticket;
    } catch {
      return retry();
    }
    if (stopped) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/vtt-ws`);
    ws = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'overworld:live:join', ticket })));
    socket.addEventListener('message', (event) => {
      if (ws !== socket) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'overworld:live:joined') {
        ready = true;
        backoff = MIN_BACKOFF_MS;
        lastSentJson = '';
        opts.onReady?.();
      } else if (msg.type === 'overworld:live:error') {
        // Bad or expired ticket (e.g. the tab slept): close, so the close handler fetches a fresh one.
        socket.close();
      } else if (msg.type === 'overworld:preview') opts.onPreview(msg);
      else if (msg.type === 'overworld:preview:clear') opts.onClear(msg.previewId);
    });
    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      ws = null;
      ready = false;
      opts.onReset();
      retry();
    });
    socket.addEventListener('error', () => socket.close());
  }

  function retry() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  void connect();
  keepAlive = setInterval(() => {
    lastSentJson = ''; // force a resend of the latest frame
    flush();
  }, KEEPALIVE_MS);

  return {
    /** Latest in-progress route; throttled and idempotent. */
    preview(frame: PreviewFrame) {
      wanted = frame;
      if (!ready || sendTimer) return;
      const wait = SEND_EVERY_MS - (Date.now() - lastSentAt);
      if (wait <= 0) flush();
      else sendTimer = setTimeout(flush, wait);
    },
    /** Stop previewing (cancel, save, switched to another tool). */
    clear() {
      wanted = null;
      clearTimeout(sendTimer);
      sendTimer = undefined;
      if (lastSentJson && ready) ws!.send(JSON.stringify({ type: 'overworld:preview:clear' }));
      lastSentJson = '';
    },
    /** Leaving the page. */
    close() {
      this.clear();
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(keepAlive);
      const socket = ws;
      ws = null;
      ready = false;
      socket?.close();
    }
  };
}

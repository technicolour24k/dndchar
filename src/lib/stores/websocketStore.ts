import { writable } from 'svelte/store';

type WebsocketState = {
  connected: boolean;
  lastEvent: string;
};

function createWebsocketStore() {
  const { subscribe, set, update } = writable<WebsocketState>({ connected: false, lastEvent: '' });

  return {
    subscribe,
    connect() {
      // Socket.IO is intentionally disabled until an adapter-node server wrapper
      // is added. This avoids repeated /socket.io polling 404s during normal use.
      if (typeof window === 'undefined') return;
      set({ connected: false, lastEvent: 'disabled' });
    },
    joinRoom(room: string) {
      update((state) => ({ ...state, lastEvent: `room queued: ${room}` }));
    }
  };
}

export const websocketStore = createWebsocketStore();

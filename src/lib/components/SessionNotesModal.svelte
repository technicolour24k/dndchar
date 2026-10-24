<script lang="ts">
  import { mergeLogEntries, subscribeTopic } from '$lib/stores/liveUpdates';

  type GameSession = { id: string; name: string; isActive: boolean; createdAt: string };
  type Note = { id: string; displayName: string; message: string; createdAt: string };

  let {
    gameSessionId,
    open,
    onClose
  }: {
    gameSessionId: string | null;
    open: boolean;
    onClose: () => void;
  } = $props();

  let gameSession = $state<GameSession | null>(null);
  let joined = $state(false);
  let notFound = $state(false);
  let notes = $state<Note[]>([]);
  let messageInput = $state('');
  let posting = $state(false);
  let joining = $state(false);

  // Rendered newest-first. `notes` itself and its afterId poll cursor above
  // stay oldest-first (ascending) untouched - only this render view is reversed.
  let notesNewestFirst = $derived([...notes].reverse());

  // Fetches fresh whenever the modal opens for a (possibly different)
  // session, and subscribes to that session's "game-session:<id>" topic for
  // new notes while open (db-traffic-reduction Phase 5 - see
  // src/lib/stores/liveUpdates.ts). This is a plain client-fetched modal,
  // not a page - it can be opened from anywhere (the /sessions list, the
  // character sheet, or the thin /sessions/[id] route for direct links)
  // without a navigation, so it owns its own data loading rather than
  // relying on a route's load(). No cap on `notes` here (unlike the
  // character sheet's own small panel) - this is the full-session view.
  $effect(() => {
    if (!open || !gameSessionId) return;
    const id = gameSessionId;
    gameSession = null;
    notes = [];
    notFound = false;
    let cancelled = false;

    async function loadGameSession() {
      const res = await fetch(`/vtt/api/game-sessions/${id}`);
      if (cancelled) return;
      if (!res.ok) {
        notFound = true;
        return;
      }
      const body = await res.json();
      gameSession = body.gameSession;
      joined = body.joined;
    }

    async function fetchNotesSince(afterId: string | undefined) {
      const qs = new URLSearchParams({ gameSessionId: id });
      if (afterId) qs.set('afterId', afterId);
      try {
        const res = await fetch(`/vtt/api/session-notes?${qs}`);
        if (res.ok) {
          const body = await res.json();
          if (body.notes?.length) notes = mergeLogEntries(notes, body.notes, Infinity);
        }
      } catch {
        // best-effort
      }
    }

    loadGameSession();
    const unsubscribe = subscribeTopic(`game-session:${id}`, {
      onResync: () => fetchNotesSince(notes.at(-1)?.id),
      onMessage: (msg) => {
        if (msg.type === 'game_session:note' && msg.note) {
          notes = mergeLogEntries(notes, [msg.note as Note], Infinity);
        }
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  });

  async function join() {
    if (!gameSessionId) return;
    joining = true;
    const res = await fetch(`/vtt/api/game-sessions/${gameSessionId}`, { method: 'POST' });
    joining = false;
    if (res.ok) joined = true;
  }

  async function post() {
    const message = messageInput.trim();
    if (!message || !gameSessionId) return;
    posting = true;
    await fetch('/vtt/api/session-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSessionId, message })
    }).catch(() => {});
    posting = false;
    messageInput = '';
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="modal-backdrop" role="presentation" onpointerdown={onClose}>
    <div class="panel modifier-modal" role="dialog" aria-modal="true" aria-labelledby="session-notes-modal-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
      {#if notFound}
        <div class="panel-head">
          <h2 id="session-notes-modal-title">Session not found</h2>
          <button type="button" class="text-button" onclick={onClose}>Close</button>
        </div>
      {:else if !gameSession}
        <div class="panel-head">
          <h2 id="session-notes-modal-title">Loading...</h2>
          <button type="button" class="text-button" onclick={onClose}>Close</button>
        </div>
      {:else}
        <div class="panel-head">
          <div>
            <h2 id="session-notes-modal-title">{gameSession.name}</h2>
            <p class="muted">{new Date(gameSession.createdAt).toLocaleString()} - {gameSession.isActive ? 'Active' : 'Ended'}</p>
          </div>
          <button type="button" class="text-button" onclick={onClose}>Close</button>
        </div>

        <div class="combat-log-entries">
          {#each notesNewestFirst as note (note.id)}
            <p class="encounter-log-line"><strong>{note.displayName}:</strong> {note.message}</p>
          {:else}
            <p class="muted">No notes yet.</p>
          {/each}
        </div>

        {#if joined && gameSession.isActive}
          <div class="field row">
            <input type="text" placeholder="Type a note and press Enter..." bind:value={messageInput} disabled={posting}
              onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); post(); } }} />
            <button type="button" disabled={posting || !messageInput.trim()} onclick={post}>Post</button>
          </div>
        {:else if gameSession.isActive}
          <button type="button" disabled={joining} onclick={join}>Join this session</button>
        {:else}
          <p class="muted">This session has ended - no new notes can be posted.</p>
        {/if}
      {/if}
    </div>
  </div>
{/if}

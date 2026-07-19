<script lang="ts">
  import { enhance } from '$app/forms';

  let { data, form } = $props();

  type Note = { id: string; displayName: string; message: string; createdAt: string };
  let notes = $state<Note[]>([]);

  // Polling picks up notes posted by *other* people; use:enhance below already
  // handles our own posts appearing instantly without a full reload.
  $effect(() => {
    notes = data.notes;
    let cancelled = false;
    let lastId: string | undefined = notes.at(-1)?.id;
    async function poll() {
      if (cancelled) return;
      const qs = new URLSearchParams({ gameSessionId: data.gameSession.id });
      if (lastId) qs.set('afterId', lastId);
      try {
        const res = await fetch(`/vtt/api/session-notes?${qs}`);
        if (res.ok) {
          const body = await res.json();
          if (body.notes?.length) {
            notes = [...notes, ...body.notes];
            lastId = body.notes[body.notes.length - 1].id;
          }
        }
      } catch {
        // best-effort
      }
    }
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  });
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Table Talk</p>
    <h1>{data.gameSession.name}</h1>
    <span class="muted">{new Date(data.gameSession.createdAt).toLocaleString()} - {data.gameSession.isActive ? 'Active' : 'Ended'}</span>
  </div>
</section>

<section class="panel stack">
  <div class="combat-log-entries">
    {#each notes as note (note.id)}
      <p class="encounter-log-line"><strong>{note.displayName}:</strong> {note.message}</p>
    {:else}
      <p class="muted">No notes yet.</p>
    {/each}
  </div>

  {#if data.joined && data.gameSession.isActive}
    <form method="POST" action="?/post" use:enhance={() => async ({ update, formElement }) => { await update({ reset: false }); formElement.reset(); }} class="inline">
      <input name="message" placeholder="Type a note and press Enter..." required autocomplete="off" />
      <button>Post</button>
    </form>
    {#if form?.postError}<p class="form-error">{form.postError}</p>{/if}
  {:else if data.gameSession.isActive}
    <form method="POST" action="?/join">
      <button>Join this session</button>
    </form>
    {#if form?.joinError}<p class="form-error">{form.joinError}</p>{/if}
  {:else}
    <p class="muted">This session has ended - no new notes can be posted.</p>
  {/if}
</section>

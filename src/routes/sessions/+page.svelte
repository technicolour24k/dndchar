<script lang="ts">
  let { data, form } = $props();
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Table Talk</p>
    <h1>Sessions</h1>
  </div>
  <form method="POST" action="?/create" class="inline">
    <input name="name" placeholder="Session name" required />
    <button>Start New Session</button>
  </form>
</section>

<form method="POST" action="?/join" class="inline">
  <input name="gameSessionId" placeholder="Session ID" required />
  <button>Join by ID</button>
</form>
{#if form?.joinError}<p class="form-error">{form.joinError}</p>{/if}

<div class="encounter-grid">
  {#each data.sessions as gameSession}
    <section class="panel stack encounter-card">
      <div class="panel-head">
        <div>
          <h2>{gameSession.name}</h2>
          <span>{new Date(gameSession.createdAt).toLocaleString()} - {gameSession.isActive ? 'Active' : 'Ended'}</span>
        </div>
        <a class="button-link" href="/sessions/{gameSession.id}">Open</a>
      </div>
    </section>
  {:else}
    <section class="panel"><p class="muted">No sessions yet - start one, or join with an ID a GM shared with you.</p></section>
  {/each}
</div>

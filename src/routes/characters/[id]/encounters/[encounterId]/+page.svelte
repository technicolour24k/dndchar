<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.encounter.name} - {data.character.name}</title>
</svelte:head>

<section class="panel stack encounter-print">
  <div class="panel-head">
    <div>
      <h1>{data.encounter.name}</h1>
      <p class="muted">
        {data.character.name} - {new Date(data.encounter.createdAt).toLocaleString()}
        - {data.encounter.isActive ? 'Active' : 'Ended'}
      </p>
    </div>
    <button type="button" class="no-print" onclick={() => window.print()}>Download as PDF</button>
  </div>

  <div class="stack">
    {#each data.entries as entry (entry.id)}
      <p class="encounter-log-line">{entry.message}</p>
    {:else}
      <p class="muted">No combat activity was logged for this encounter.</p>
    {/each}
  </div>
</section>

<style>
  .encounter-log-line {
    margin: 0;
    padding: 4px 0;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  }

  @media print {
    :global(.topbar) {
      display: none;
    }

    .no-print {
      display: none;
    }
  }
</style>

<script lang="ts">
  import { page } from '$app/state';

  // A map that was unshared or hidden while someone had it open (or a link that never worked) lands here.
  const embed = $derived(page.url.searchParams.get('embed') === '1');
</script>

<section class="panel campaign-box">
  {#if page.status === 404}
    <h2>This map isn't available any more.</h2>
    <p class="muted">It may have been hidden, or not shared with you yet.</p>
  {:else}
    <h2>Something went wrong.</h2>
    <p class="muted">{page.error?.message ?? 'Please try again.'}</p>
  {/if}
  <div>
    <a class="button-link compact-link" href="/campaigns/{page.params.id}/overworld{embed ? '?embed=1' : ''}">Back to the maps</a>
  </div>
</section>

<script lang="ts">
  import { enhance } from '$app/forms';

  let { data, form } = $props();
</script>

<section class="panel stack campaign-join">
  {#if data.campaign}
    <p class="eyebrow">Invite</p>
    <h1>Join {data.campaign.name}?</h1>
    <p class="muted">DM: {data.campaign.dmName ?? 'none yet'}</p>
    {#if form?.error}
      <p class="form-error">{form.error}</p>
    {/if}
    <form method="POST" action="?/join" use:enhance>
      <button type="submit">Join campaign</button>
    </form>
    <a class="text-button" href="/campaigns">Not now</a>
  {:else}
    <h1>This invite isn't valid any more</h1>
    <p class="muted">The code may have been replaced, or the campaign archived. Ask your DM for a new link.</p>
    <a class="button-link" href="/campaigns">Back to campaigns</a>
  {/if}
</section>

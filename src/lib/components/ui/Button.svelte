<script lang="ts">
  let { href = '', children }: { href?: string; children: import('svelte').Snippet } = $props();
</script>

{#if href}
  <a class="button-link" {href}>{@render children()}</a>
{:else}
  <button type="button">{@render children()}</button>
{/if}

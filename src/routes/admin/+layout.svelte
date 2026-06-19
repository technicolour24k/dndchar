<script lang="ts">
  import { page } from '$app/state';
  let { children } = $props();
  const links=[
    ['/admin/settings','Site Settings'],['/admin/catalogue','Catalogue Settings'],['/admin/items','Item Settings'],
    ['/admin/magic','Magic Settings'],['/admin/feats','Feat Settings']
  ];
</script>

<nav class="admin-nav" aria-label="Administration sections">
  {#each links as [href,label]}
    <a {href} class:active={page.url.pathname===href} aria-current={page.url.pathname===href?'page':undefined}>{label}</a>
  {/each}
</nav>

{@render children()}

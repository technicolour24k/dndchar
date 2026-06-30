<script lang="ts">
  import { page } from '$app/state';
  let { children } = $props();
  const links=[
    ['/admin/settings','Site Settings'],['/admin/rules/modifiers','Rules Library'],['/admin/items','Items'],
    ['/admin/magic','Spells'],['/admin/feats','Feats & Features']
  ];
  const futureLinks=['Magic Items','Conditions','Races','Backgrounds'];
</script>

<nav class="admin-nav admin-primary-nav" aria-label="Administration sections">
  {#each links as [href,label]}
    <a {href} class:active={page.url.pathname===href || (href==='/admin/rules/modifiers' && page.url.pathname.startsWith('/admin/rules'))} aria-current={page.url.pathname===href?'page':undefined}>{label}</a>
  {/each}
  {#each futureLinks as label}<span class="admin-nav-disabled" aria-disabled="true">{label}</span>{/each}
</nav>

{@render children()}

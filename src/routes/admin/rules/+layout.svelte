<script lang="ts">
  import { page } from '$app/state';
  let { children } = $props();
  const tabs=[['/admin/rules/modifiers','Modifiers'],['/admin/rules/effects','Effects'],['/admin/rules/hooks','Rule Hooks']];
</script>

<section class="page-head rules-page-head admin-page-intro">
  <div><p class="eyebrow">Administration</p><h1>Rules Library</h1><p>Create and manage reusable modifiers, effects, and advanced rule hooks.</p></div>
  <span class="admin-help-link" title="Modifiers are reusable mechanics. Effects add state and lifecycle around one or more modifiers.">ⓘ About the Rules Library</span>
</section>
<nav class="admin-nav rules-tabs" aria-label="Rules administration">
  {#each tabs as [href,label]}<a {href} class:active={page.url.pathname===href}>{label}</a>{/each}
</nav>
{@render children()}

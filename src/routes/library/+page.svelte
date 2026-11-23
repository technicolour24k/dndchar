<script lang="ts">
  import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';
  import type { ContentType } from '$lib/types/content';

  let { data, form } = $props();

  const tabs = [['item', 'Items'], ['spell', 'Spells'], ['feat', 'Feats and features']] as const;
  const titles: Record<string, string> = { item: 'Item Library', spell: 'Spell Library', feat: 'Feat Library' };
  const descriptions: Record<string, string> = {
    item: 'Your own items. Only you can edit them.',
    spell: 'Your own spells. Only you can edit them.',
    feat: 'Your own feats and class features. Only you can edit them.'
  };
  const allowedTypes = $derived((data.tab === 'feat' ? ['feat', 'class_feature'] : [data.tab]) as ContentType[]);
  // Keeps the tab (and the character you came from) on every link and form action in the editor.
  const extraQuery = $derived(`type=${data.tab}${data.from ? `&from=${data.from.id}` : ''}`);
  const tabHref = (tab: string) => `?type=${tab}${data.from ? `&from=${data.from.id}` : ''}`;
</script>

<ContentTypeAdmin
  {data} {form} mode="library" canAuthorMechanics={data.canAuthorMechanics} {extraQuery}
  title={titles[data.tab]} description={descriptions[data.tab]} createType={allowedTypes[0]} {allowedTypes}
>
  {#snippet top()}
    <div class="library-page-top stack">
      {#if data.from}<a class="button-link library-back" href={`/characters/${data.from.id}`}>Back to {data.from.name}</a>{/if}
      <nav class="library-tabs" aria-label="Library sections">
        {#each tabs as tab}<a href={tabHref(tab[0])} class:active={data.tab === tab[0]} aria-current={data.tab === tab[0] ? 'page' : undefined}>{tab[1]}</a>{/each}
      </nav>
      {#if !data.canAuthorMechanics}
        <p class="panel library-banner">Your library holds descriptive entries: names, descriptions and details. Rules such as bonuses, damage, costs and charges are added by a DM or admin. Once you DM a campaign, those controls appear here.</p>
      {/if}
      <p class="muted">Your entries show up in the picker on your characters' sheets. In a campaign, other players only see them once the DM switches your library on for that campaign.</p>
    </div>
  {/snippet}
</ContentTypeAdmin>

<style>
  .library-page-top { margin-bottom: 12px; }
  .library-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
  .library-tabs a, .library-back { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); text-decoration: none; font-weight: 700; }
  .library-tabs a.active { background: #153045; border-color: #62b7f0; }
  .library-back { justify-self: start; }
  .library-banner { padding: 12px; margin: 0; }
  /* 44px tap targets on a phone: the editor's own buttons, fields and list rows. */
  @media (max-width: 720px) {
    :global(.content-admin-layout button), :global(.content-admin-layout select), :global(.content-admin-layout input:not([type='checkbox'])),
    :global(.content-admin-layout summary), :global(.admin-library-item) { min-height: 44px; }
    :global(.content-admin-layout .inline) { min-height: 44px; display: flex; align-items: center; gap: 8px; }
    .library-tabs a { flex: 1 1 auto; }
  }
</style>

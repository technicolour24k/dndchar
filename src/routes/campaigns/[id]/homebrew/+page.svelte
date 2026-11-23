<script lang="ts">
  import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';
  import ConditionEditor from '$lib/components/library/ConditionEditor.svelte';
  import type { ContentType } from '$lib/types/content';

  let { data, form } = $props();

  const tabs = [['item', 'Items'], ['spell', 'Spells'], ['feat', 'Feats and features'], ['condition', 'Conditions']] as const;
  const titles: Record<string, string> = { item: 'Item Copies', spell: 'Spell Copies', feat: 'Feat Copies', condition: 'Condition Copies' };
  const allowedTypes = $derived((data.tab === 'feat' ? ['feat', 'class_feature'] : [data.tab]) as ContentType[]);
  const base = $derived(`/campaigns/${data.campaignId}/homebrew`);
  const extraQuery = $derived(`type=${data.tab}`);

  // "Campaign copy (from Bob's library, 23 Nov 2026)" for the selected entry.
  const selectedId = $derived(data.tab === 'condition' ? data.selected?.id : data.selectedContentId);
  const forkNote = $derived.by(() => {
    const info = selectedId ? data.forks?.[selectedId] : null;
    if (!info) return '';
    const when = info.at ? new Date(info.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const from = info.fromOwnerName ? `from ${info.fromOwnerName}'s library${when ? `, ${when}` : ''}` : when;
    return `Campaign copy${from ? ` (${from})` : ''}. Editing it never changes the original, and the original's owner never changes this copy.`;
  });
</script>

{#snippet header()}
  <div class="homebrew-top stack">
    <p class="eyebrow"><a href="/campaigns/{data.campaignId}">{data.campaignName}</a></p>
    <nav class="homebrew-tabs" aria-label="Campaign copies">
      {#each tabs as tab}<a href="{base}?type={tab[0]}" class:active={data.tab === tab[0]} aria-current={data.tab === tab[0] ? 'page' : undefined}>{tab[1]}</a>{/each}
      <a href="/campaigns/{data.campaignId}/decks">Decks</a>
    </nav>
    {#if data.archived}<p class="form-error">This campaign is archived, so its copies can no longer be changed.</p>{/if}
    <p class="muted">
      Copies of a member's homebrew, kept for this campaign when they left or when you pressed Keep a campaign copy. You can
      edit or archive them here. They are never made from scratch, and nothing is ever deleted. New uses in this campaign can
      pick them, so archive any you don't want offered. Copied decks are on the decks page.
    </p>
  </div>
{/snippet}

{#if data.tab === 'condition'}
  <section class="page-head"><div><h1>{titles.condition}</h1></div></section>
  {@render header()}
  {#if form?.error}<p class="form-error">{form.error}</p>{/if}
  <ConditionEditor
    {data} {form} canCreate={false} listTitle="Condition copies" emptyText="No condition copies yet." note={forkNote}
    selectHref={(id) => `${base}?type=condition&content=${id}`}
  />
{:else}
  <ContentTypeAdmin
    {data} {form} mode="campaign" canAuthorMechanics={true} {extraQuery} notice={forkNote}
    title={titles[data.tab]} description="Your campaign's own copies. Only DMs and co-DMs can edit them."
    createType={allowedTypes[0]} {allowedTypes} top={header}
  />
{/if}

<style>
  .homebrew-top { margin-bottom: 12px; }
  .homebrew-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
  .homebrew-tabs a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); text-decoration: none; font-weight: 700; }
  .homebrew-tabs a.active { background: #153045; border-color: #62b7f0; }
  /* 44px tap targets on a phone: the editor's own buttons, fields and list rows. */
  @media (max-width: 720px) {
    :global(.content-admin-layout button), :global(.content-admin-layout select), :global(.content-admin-layout input:not([type='checkbox'])),
    :global(.content-admin-layout summary), :global(.admin-library-item) { min-height: 44px; }
    :global(.content-admin-layout .inline) { min-height: 44px; display: flex; align-items: center; gap: 8px; }
    .homebrew-tabs a { flex: 1 1 auto; }
  }
</style>

<script lang="ts">
  import ConditionEditor from '$lib/components/library/ConditionEditor.svelte';

  let { data, form } = $props();

  const tabs = [['/library?type=item', 'Items'], ['/library?type=spell', 'Spells'], ['/library?type=feat', 'Feats and features'], ['/library/decks', 'Decks']] as const;
</script>

<section class="page-head">
  <div>
    <h1>Condition Library</h1>
    <p class="muted">
      Your own conditions, made of the shared modifiers. A DM switches your library on for a campaign, and then decks and
      sheets there can use them. Decks and characters that already have one keep it if the library is switched off. Use
      the same placeholders as on the admin Effects page (for example {'{value}'}) in a modifier's value.
    </p>
  </div>
</section>

<nav class="library-tabs" aria-label="Library sections">
  {#each tabs as tab}<a href={tab[0]}>{tab[1]}</a>{/each}
  <a href="/library/conditions" class="active" aria-current="page">Conditions</a>
</nav>

{#if !data.canAuthorMechanics}
  <p class="panel library-banner">Conditions are for DMs and admins, because they carry rules. You can still archive or restore any you already have.</p>
{/if}
{#if form?.error}<p class="form-error">{form.error}</p>{/if}

<ConditionEditor {data} {form} selectHref={(id) => `/library/conditions?condition=${id}`} />

<style>
  .library-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .library-tabs a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); text-decoration: none; font-weight: 700; }
  .library-tabs a.active { background: #153045; border-color: #62b7f0; }
  .library-banner { padding: 12px; margin: 0; }
  @media (max-width: 720px) { .library-tabs a { flex: 1 1 auto; } }
</style>

<script lang="ts">
  // db-traffic-reduction Phase 3: replaces the old catalogue <select> (which relied on the
  // sheet's load() shipping the entire, 300-row-capped catalogue). This is a debounced search
  // box against GET /api/catalogue/search - no DB hit once the server-side index is warm.
  //
  // Picking a result only fills the selection (via onPick); it does NOT add the content itself -
  // the existing "Add" button next to this component still does that, same as the old <select>,
  // so there's no accidental add from a stray click/Enter.
  import type { ContentType } from '$lib/types/content';

  type SearchEntry = { id: string; type: ContentType; name: string; spellLevel: number | null; sourceKind: 'srd' | 'homebrew' };

  let {
    type,
    placeholder = 'Search...',
    disabled = false,
    onPick
  }: {
    type: ContentType;
    placeholder?: string;
    disabled?: boolean;
    /** Called with the picked content id, or '' if the text changed since the last pick
     * (so a stale selection can't be added under a different displayed name). */
    onPick: (contentId: string) => void;
  } = $props();

  let query = $state('');
  let results = $state<SearchEntry[]>([]);
  let open = $state(false);
  let loading = $state(false);
  let errorMessage = $state('');
  let activeIndex = $state(-1);
  let hasPickedCurrentText = $state(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | undefined;

  // Don't let a pending debounce or in-flight search outlive the component.
  $effect(() => () => {
    clearTimeout(debounceTimer);
    abortController?.abort();
  });

  async function runSearch() {
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    loading = true;
    errorMessage = '';
    try {
      const params = new URLSearchParams({ type });
      if (query.trim()) params.set('q', query.trim());
      const response = await fetch(`/api/catalogue/search?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Search failed (${response.status}).`);
      const data = await response.json();
      results = Array.isArray(data.entries) ? data.entries : [];
      activeIndex = results.length ? 0 : -1;
    } catch (fetchError) {
      // A newer request superseded this one - just drop it, the newer one owns `results` now.
      if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
      errorMessage = 'Could not search the catalogue.';
      results = [];
      activeIndex = -1;
    } finally {
      loading = false;
    }
  }

  function scheduleSearch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 200);
  }

  function handleInput() {
    if (hasPickedCurrentText) {
      // The user is editing past a previous pick - clear the parent's selection so "Add"
      // can't fire against an id that no longer matches what's shown in the box.
      hasPickedCurrentText = false;
      onPick('');
    }
    open = true;
    scheduleSearch();
  }

  function handleFocus() {
    open = true;
    if (!results.length && !loading) void runSearch(); // empty query -> browsable top-20 list
  }

  function pick(entry: SearchEntry) {
    query = entry.name;
    hasPickedCurrentText = true;
    open = false;
    onPick(entry.id);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) { open = true; void runSearch(); return; }
      activeIndex = Math.min(activeIndex + 1, results.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        pick(results[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      open = false;
    }
  }

  function handleBlur() {
    // Delay closing so a click on a result (onmousedown below) registers before the listbox
    // disappears - a plain blur-triggered close would beat the click.
    setTimeout(() => { open = false; }, 150);
  }

  function badgeText(entry: SearchEntry): string {
    if (entry.type === 'spell') return `Lv ${entry.spellLevel ?? 0}`;
    return entry.sourceKind === 'srd' ? 'SRD' : 'Homebrew';
  }

  const listboxId = $derived(`catalogue-search-listbox-${type}`);
</script>

<div class="catalogue-search">
  <input
    type="text"
    role="combobox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
    autocomplete="off"
    {placeholder}
    aria-label={placeholder}
    {disabled}
    bind:value={query}
    oninput={handleInput}
    onfocus={handleFocus}
    onblur={handleBlur}
    onkeydown={handleKeydown}
  />
  {#if open}
    <ul class="catalogue-search-results" role="listbox" id={listboxId}>
      {#if loading}
        <li class="catalogue-search-status">Searching...</li>
      {:else if errorMessage}
        <li class="catalogue-search-status">{errorMessage}</li>
      {:else if !results.length}
        <li class="catalogue-search-status">No matches.</li>
      {:else}
        {#each results as entry, index (entry.id)}
          <li
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            class="catalogue-search-option"
            class:active={index === activeIndex}
            onmousedown={(event) => { event.preventDefault(); pick(entry); }}
          >
            <span class="catalogue-search-name">{entry.name}</span>
            <span class="catalogue-search-badge">{badgeText(entry)}</span>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>

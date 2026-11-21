<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { invalidate } from '$app/navigation';
  import MapUploadForm from '$lib/components/overworld/MapUploadForm.svelte';
  import { subscribeTopic } from '$lib/stores/liveUpdates';

  let { data, form } = $props();

  const list = $derived(data.list);
  const canManage = $derived(list.viewer.canManage);
  // Inside the VTT overlay (?embed=1) the links keep the flag so the top bar stays hidden.
  const embed = $derived(page.url.searchParams.get('embed') === '1');
  const suffix = $derived(embed ? '?embed=1' : '');

  const DONE: Record<string, string> = {
    created: 'Map added.',
    replaced: 'Image replaced.',
    updated: 'Saved.',
    granted: 'Shared with the party.',
    ungranted: 'Hidden from the party.',
    archived: 'Map hidden.'
  };

  // Live refresh: a map shared, renamed or hidden by someone else shows up without a reload. The topic
  // carries no content, it only says "re-fetch". Debounced; the first resync on connect is skipped.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void invalidate('overworld:list'), 300);
    };
    const stop = subscribeTopic(`overworld:${data.campaignId}`, {
      onMessage: (msg) => {
        if (msg.type === 'overworld:changed') refresh();
      },
      onResync: () => {
        if (first) first = false;
        else refresh();
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  });

  function confirmFirst(message: string): SubmitFunction {
    return ({ cancel }) => {
      if (!confirm(message)) cancel();
    };
  }
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Overworld</p>
    <h1>{data.campaignName}</h1>
  </div>
  {#if !embed}
    <a class="button-link compact-link" href="/campaigns/{data.campaignId}">Back to campaign</a>
  {/if}
</section>

<!-- Per-map results show in that map's row; this is for create (no map yet) and anything with no map id. -->
{#if !form?.mapId}
  {#if form?.error}
    <p class="form-error">{form.error}</p>
  {:else if form?.done}
    <p class="muted">{DONE[form.done] ?? 'Done.'}</p>
  {/if}
{/if}

<div class="stack">
  {#if canManage}
    <details class="panel campaign-panel">
      <summary>New map</summary>
      <div class="ow-settings">
        <MapUploadForm action="?/create" submitLabel="Add map">
          <label>
            Name
            <input name="name" maxlength="80" required />
          </label>
          <label>
            Miles across the map's width (optional)
            <input name="milesAcross" inputmode="decimal" placeholder="e.g. 1500" />
          </label>
        </MapUploadForm>
        {#if data.uploadsEphemeral}
          <p class="form-error">Uploads aren't on permanent storage yet and will vanish on the next deploy.</p>
        {/if}
      </div>
    </details>
  {/if}

  <section class="panel campaign-box">
    {#if list.maps.length === 0}
      <p class="muted">{canManage ? 'No maps yet. Add one above.' : "Your DM hasn't shared a map yet."}</p>
    {:else}
      <ul class="member-list">
        {#each list.maps as map (map.id)}
          <li>
            <div class="member-name">
              <strong>{map.name}</strong>
              {#if canManage && !map.granted}<span class="badge badge-muted">Not shared yet</span>{/if}
              <span class="muted">{map.pinCount} {map.pinCount === 1 ? 'pin' : 'pins'}</span>
            </div>
            <div class="member-actions">
              <a class="button-link compact-link" href="/campaigns/{data.campaignId}/overworld/{map.id}{suffix}">Open</a>
              {#if canManage}
                <form method="POST" action={map.granted ? '?/ungrant' : '?/grant'} use:enhance>
                  <input type="hidden" name="mapId" value={map.id} />
                  <button type="submit" class="compact-button">{map.granted ? 'Unshare' : 'Share'}</button>
                </form>
              {/if}
            </div>

            {#if form?.mapId === map.id}
              {#if form.error}
                <p class="form-error ow-row-note">{form.error}</p>
              {:else if form.done}
                <p class="muted ow-row-note">{DONE[form.done] ?? 'Done.'}</p>
              {/if}
            {/if}

            {#if canManage}
              <details class="ow-settings">
                <summary>Settings</summary>
                <form method="POST" action="?/updateMap" use:enhance>
                  <input type="hidden" name="mapId" value={map.id} />
                  <label>
                    Name
                    <input name="name" maxlength="80" value={map.name} required />
                  </label>
                  <label>
                    Miles across the width
                    <input name="milesAcross" inputmode="decimal" value={map.milesAcross ?? ''} placeholder="no scale" />
                  </label>
                  <button type="submit" class="compact-button">Save</button>
                </form>
                <h3>Replace image</h3>
                <MapUploadForm
                  action="?/replaceImage"
                  mapId={map.id}
                  submitLabel="Replace image"
                  current={{ width: map.imageWidth, height: map.imageHeight }}
                />
                <form
                  method="POST"
                  action="?/archive"
                  use:enhance={confirmFirst("Hide this map from everyone? Its pins and routes are kept but there's no undo button.")}
                >
                  <input type="hidden" name="mapId" value={map.id} />
                  <button type="submit" class="compact-button danger">Hide map</button>
                </form>
              </details>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

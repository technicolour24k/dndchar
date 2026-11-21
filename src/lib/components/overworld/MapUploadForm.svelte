<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { Snippet } from 'svelte';
  import type { PreparedImage } from '$lib/overworld/downscale';
  import MapImagePicker from './MapImagePicker.svelte';

  // A form that uploads a map image: new map (`?/create`) or replace image (`?/replaceImage` + mapId).
  // Extra fields (name, scale) come in as children. The picked image is downscaled in the browser and
  // the prepared copy replaces the raw file in the submitted data.
  let {
    action,
    mapId = null,
    submitLabel,
    current = null,
    children
  }: {
    action: string;
    mapId?: string | null;
    submitLabel: string;
    // The map's current size, for the "different shape" warning when replacing an image.
    current?: { width: number; height: number } | null;
    children?: Snippet;
  } = $props();

  let prepared = $state<PreparedImage | null>(null);
  let busy = $state(false);
  let uploading = $state(false);
  // Bumped after a successful upload so the picker (and its file input) starts fresh.
  let pickerKey = $state(0);
  // Shown when the form is submitted (button or Enter) before an image is ready.
  let notice = $state('');
  // The notice goes away as soon as an image is ready.
  $effect(() => {
    if (prepared) notice = '';
  });

  const extOf = (type: string) => (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg');

  const submit: SubmitFunction = ({ formData, cancel }) => {
    if (!prepared) {
      notice = busy ? 'Still resizing...' : 'Choose an image first.';
      cancel();
      return;
    }
    if (current) {
      const was = current.width / current.height;
      const now = prepared.width / prepared.height;
      if (Math.abs(now - was) / was > 0.01 && !confirm("This image is a different shape. Pins and routes keep their relative position, so they may land in the wrong places. Replace it anyway?")) {
        cancel();
        return;
      }
    }
    formData.set('image', prepared.blob, `map.${extOf(prepared.type)}`);
    uploading = true;
    return async ({ result, update }) => {
      uploading = false;
      if (result.type === 'success') {
        prepared = null;
        pickerKey += 1;
      }
      await update({ reset: result.type === 'success' });
    };
  };
</script>

<form method="POST" {action} enctype="multipart/form-data" use:enhance={submit}>
  {#if mapId}<input type="hidden" name="mapId" value={mapId} />{/if}
  {@render children?.()}
  {#key pickerKey}
    <MapImagePicker bind:prepared bind:busy />
  {/key}
  {#if notice}<p class="form-error full-row">{notice}</p>{/if}
  <button type="submit" class="compact-button" disabled={uploading}>
    {uploading ? 'Uploading...' : submitLabel}
  </button>
</form>

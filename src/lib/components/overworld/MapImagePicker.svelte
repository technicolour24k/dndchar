<script lang="ts">
  import { prepareMapImage, type PreparedImage } from '$lib/overworld/downscale';

  // A file picker that downscales the chosen image in the browser before anything is uploaded.
  // The picked File is NOT part of the form (the input has no name): the parent form swaps in
  // `prepared.blob` when it submits, so the server only ever sees the already-resized copy.
  let { prepared = $bindable(null), busy = $bindable(false) }: { prepared: PreparedImage | null; busy: boolean } = $props();

  let error = $state('');

  async function onchange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    prepared = null;
    error = '';
    if (!file) return;
    busy = true;
    try {
      prepared = await prepareMapImage(file);
    } catch (err) {
      error = err instanceof Error ? err.message : 'That image could not be read.';
      input.value = '';
    } finally {
      busy = false;
    }
  }

  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const info = $derived.by(() => {
    if (!prepared) return '';
    const from = `${prepared.originalWidth} x ${prepared.originalHeight}`;
    const to = `${prepared.width} x ${prepared.height}`;
    return from === to ? `${to}, ${mb(prepared.blob.size)}` : `${from} -> ${to}, ${mb(prepared.blob.size)}`;
  });
</script>

<label class="full-row">
  Map image (JPEG, PNG or WebP)
  <input type="file" accept="image/jpeg,image/png,image/webp" {onchange} />
</label>
{#if busy}
  <p class="ow-pick-info full-row">Resizing...</p>
{:else if error}
  <p class="form-error full-row">{error}</p>
{:else if prepared}
  <p class="ow-pick-info full-row">{info}</p>
{/if}

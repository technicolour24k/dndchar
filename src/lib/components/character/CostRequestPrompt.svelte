<script lang="ts">
  import { backdropPress } from '$lib/ui/backdropPress';
  import { WAITING_TEXT, bannerText, promptSpec, shortfallLines } from '../../../../static/vtt-app/shared/costApproval.js';

  // The "you can't afford that" prompt (cost-engine plan, unit 6): the mode decides the wording. The
  // safe choice is always the focused one, and Escape or a click outside picks it (for the no-DM
  // prompt that is "No - cancel"): going ahead is always a deliberate click on the other button.
  type Prompt = {
    stage: 'prompt' | 'waiting' | 'banner';
    mode: string;
    shortfalls: Array<{ label: string; needed: number; available: number }>;
    label: string;
    busy: boolean;
    error: string;
    banner?: { activationLabel?: string; waive?: boolean } | null;
  };
  let { prompt, onChoose }: { prompt: Prompt; onChoose: (id: string) => void } = $props();

  const spec = $derived(promptSpec(prompt.mode));
  const lines = $derived(shortfallLines(prompt.shortfalls));

  function focusMe(node: HTMLElement) {
    node.focus();
  }
</script>

<div class="modal-backdrop" role="presentation" onpointerdown={backdropPress(() => { if (prompt.stage === 'prompt' && !prompt.busy) onChoose(spec.escape); })}>
  <div class="panel compact-modal cost-request" role="alertdialog" aria-modal="true" aria-labelledby="cost-request-title" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
    {#if prompt.stage === 'prompt'}
      <h2 id="cost-request-title">{prompt.label}</h2>
      <p>{spec.question}</p>
      <ul class="cast-lines">{#each lines as line}<li class="short">{line}</li>{/each}</ul>
      {#if prompt.error}<p class="form-error">{prompt.error}</p>{/if}
      <div class="actions">
        <button type="button" use:focusMe disabled={prompt.busy} onclick={() => onChoose(spec.primary.id)}>{spec.primary.label}</button>
        <button type="button" class="text-button" disabled={prompt.busy} onclick={() => onChoose(spec.secondary.id)}>{spec.secondary.label}</button>
      </div>
      {#if spec.note}<p class="muted cost-note">{spec.note}</p>{/if}
    {:else if prompt.stage === 'waiting'}
      <h2 id="cost-request-title">{prompt.label}</h2>
      <p>{WAITING_TEXT}</p>
      <ul class="cast-lines">{#each lines as line}<li class="short">{line}</li>{/each}</ul>
      {#if prompt.error}<p class="form-error">{prompt.error}</p>{/if}
      <div class="actions"><button type="button" use:focusMe disabled={prompt.busy} onclick={() => onChoose('withdraw')}>Withdraw</button></div>
    {:else}
      <h2 id="cost-request-title">{prompt.label}</h2>
      <p>{bannerText(prompt.banner)}</p>
      {#if prompt.error}<p class="form-error">{prompt.error}</p>{/if}
      <div class="actions">
        <button type="button" use:focusMe disabled={prompt.busy} onclick={() => onChoose('use_now')}>Use now</button>
        <button type="button" class="text-button" disabled={prompt.busy} onclick={() => onChoose('dismiss')}>Dismiss</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .cost-request p { margin: 0.4rem 0; }
  .cost-note { font-size: 0.8rem; }
</style>

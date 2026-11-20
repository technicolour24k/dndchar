<script lang="ts">
  import { untrack } from 'svelte';
  import { backdropPress } from '$lib/ui/backdropPress';
  import { advantageSourceLabel, type AdvantageSource } from '$lib/rules/attackRoll';
  import { FORAGE_SELF_SKILLS, SKILL_CHECKS } from '$lib/rules/skills';
  import type { ForageCheck, ForageMine } from '$lib/types/forage';
  import {
    canShareRecent, canSubmitSelf, defaultSelfPicks, dmResult, errorText, forageAdvReadout, forageBlocker, forageUnavailableReason,
    forageUnavailableText, LAST_PICKS_KEY, lastDmFor, natBadgeText, parseSavedPicks, recentFindItemsText, recentFindStatusText,
    resultHeadline, selfAreas, selfCategories, selfResult, tagLabel
  } from '../../../../static/vtt-app/shared/forageView.js';

  // The character sheet's Forage popup (vtt-forage plan, unit E). Same behaviour as the VTT player
  // popup (static/vtt-app/forage.js), built on RollOptionsModal's chrome and classes.
  //
  // Rev 4 rules: with a DM present the player sees ONLY the adv/dis counters and a Forage button (the
  // DM calls the check). Self-serve shows a short skill list plus plain-label area and category, with
  // no table names or counts. The server decides the mode at submit time, and does every roll.
  //
  // The sheet owns the forage state (`mine`, refreshed by a detail-free ping or when this opens) so the
  // badge stays right while this is closed. Closing never cancels anything.
  let {
    characterId,
    mine,
    haulWaiting,
    onRefresh,
    onHaul,
    onClose
  }: {
    characterId: string;
    mine: ForageMine | null;
    // True when a find landed but the sheet has unsaved edits, so the rows will show on Save.
    haulWaiting: boolean;
    onRefresh: () => Promise<void>;
    // A self-serve haul went in: the sheet decides whether to reload now or wait for Save.
    onHaul: (key: string) => void;
    onClose: () => void;
  } = $props();

  type Check = ForageCheck;
  type ResultView = {
    outcome: string; check: Check | null; lines: Array<{ name: string; qty: number }>; findId: string | null;
    mode: string; shared?: boolean; requestId?: string;
  };
  type Recent = {
    id: string; createdAt: string; status: 'found' | 'reverted'; mode: string; shared: boolean;
    items: Array<{ name: string; qty: number }>; revertNote: string;
  };

  const API = '/vtt/api/forage';

  async function api(method: string, url: string, body?: unknown) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  }

  // The self-serve skill list comes from the shared constant (names from the sheet's own skill list).
  const selfSkills = SKILL_CHECKS.filter((skill) => FORAGE_SELF_SKILLS.includes(skill.key)).map((skill) => ({ key: skill.key, name: skill.name }));

  let loading = $state(true);
  let busy = $state(false);
  let message = $state('');
  // The DM left between the popup's hint and Forage (server answered skill_not_allowed): use self-serve.
  let forceSelf = $state(false);
  let showForm = $state(false); // "Forage again" from a result
  let localResult = $state<ResultView | null>(null);
  let selfCheck = $state<{ findId: string; check: Check } | null>(null);

  // Self-serve pickers (area + category pairs that have something to find, no tables).
  // Self-serve picker tags: two separate lists, never pairs, so they don't hint at which combinations have a table.
  let options = $state<{ areas: string[]; categories: string[] } | null>(null);
  let optionsLoading = false;
  let optionsFailed = $state(false);
  let picks = $state({ skillKey: selfSkills[0]?.key ?? '', areaType: '', category: '' });

  // Advantage panel.
  let sources = $state<AdvantageSource[]>([]);
  let disabled = $state<string[]>([]);
  let advCount = $state(0);
  let disCount = $state(0);
  let advStatus = $state<'loading' | 'ready' | 'failed'>('loading');
  let previewSeq = 0;
  let primaryButton = $state<HTMLButtonElement | null>(null);

  // Recent finds (collapsible, fetched only when opened).
  let recentOpen = $state(false);
  let recentStatus = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  let recentFinds = $state<Recent[]>([]);
  let recentMessage = $state('');

  const dm = $derived(mine?.dmPresent === true && !forceSelf);
  // Can't forage right now (no campaign, wrong room, no tables)? Empty when something in flight can still be finished.
  const off = $derived(forageUnavailableReason(mine, characterId));
  const pending = $derived(mine?.pending ?? null);
  const markTarget = $derived(
    selfCheck
      ? { ...selfCheck, characterId }
      : mine?.unmarkedSelf ? { findId: mine.unmarkedSelf.findId, check: mine.unmarkedSelf.check, characterId: mine.unmarkedSelf.characterId } : null
  );
  // One forage in flight per USER: if it belongs to a different character, say so by name. The
  // waiting and mark steps still work for it (they act on the user's request, not this sheet's).
  const blocker = $derived(forageBlocker(mine, characterId));
  const otherBlocker = $derived(blocker && !blocker.isThisCharacter ? blocker : null);
  const serverResult = $derived(lastDmFor(mine, characterId));
  const result = $derived<ResultView | null>(localResult ?? (serverResult ? (dmResult(serverResult) as ResultView) : null));
  const phase = $derived(
    loading ? 'loading' : pending ? 'waiting' : markTarget ? 'mark' : result && !showForm ? 'result' : 'form'
  );
  const readout = $derived(forageAdvReadout({ sources, disabled, adv: advCount, dis: disCount }));
  const canForage = $derived(!off && !busy && advStatus !== 'loading' && (dm || canSubmitSelf(options, picks)));
  // Withdraw follows the server's canWithdraw: stage 'requested', or no live DM (never while approving).
  const canWithdraw = $derived(!!pending && pending.stage !== 'approving' && (pending.stage === 'requested' || mine?.dmPresent === false));

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  // Open: refresh `mine` once (a 409 resume, a reload mid-flow or a missed DM result all land on the
  // right step because the phase is derived from it), then load whatever the current mode needs.
  $effect(() => {
    untrack(() => void start());
  });
  async function start() {
    await onRefresh();
    loading = false;
  }

  // Self-serve needs the pickers' options; DM mode needs only the generic sources preview.
  $effect(() => {
    if (loading || dm || off || options || optionsLoading) return;
    untrack(() => void loadOptions());
  });
  async function loadOptions() {
    optionsLoading = true;
    optionsFailed = false;
    message = '';
    const res = await api('GET', `${API}/tables?characterId=${encodeURIComponent(characterId)}`);
    optionsLoading = false;
    if (!res.ok) { message = errorText(res.data); optionsFailed = true; return; }
    options = { areas: res.data.areas ?? [], categories: res.data.categories ?? [] };
    picks = defaultSelfPicks(selfSkills, options, readPicks());
    void loadPreview();
  }

  // Remembered self-serve picks, shared with the VTT popup. Never throws.
  function readPicks() {
    try { return parseSavedPicks(localStorage.getItem(LAST_PICKS_KEY)); } catch { return {}; }
  }
  function writePicks() {
    try {
      localStorage.setItem(LAST_PICKS_KEY, JSON.stringify({ skillKey: picks.skillKey, areaType: picks.areaType, category: picks.category }));
    } catch { /* storage blocked: the picks just aren't remembered */ }
  }

  // Sources for the advantage panel, without rolling. The server uses the user's active room (so token
  // conditions are included). DM mode sends no skill. Stale responses are dropped.
  async function loadPreview() {
    const seq = ++previewSeq;
    advStatus = 'loading';
    const res = await api('POST', API, {
      action: 'preview', characterId, ...(dm ? {} : { skillKey: picks.skillKey }),
      advantage: { disabled, situationalAdvantage: advCount, situationalDisadvantage: disCount }
    });
    if (seq !== previewSeq) return;
    advStatus = res.ok ? 'ready' : 'failed';
    sources = res.ok ? ((res.data.sources || []) as AdvantageSource[]).filter((source) => source.origin !== 'situational') : [];
  }

  // Load the preview when the form first shows in DM mode (self-serve loads it after its options).
  $effect(() => {
    if (phase === 'form' && dm && advStatus === 'loading' && previewSeq === 0) untrack(() => void loadPreview());
  });

  function onSkillChange() {
    disabled = [];
    void loadPreview();
  }

  function toggleSource(id: string, ticked: boolean) {
    disabled = ticked ? disabled.filter((entry) => entry !== id) : [...disabled, id];
  }

  // Focus the primary button when the step changes (Roll-options behaviour). On the form the Forage
  // button is only focused once it is ENABLED (focusing a disabled button does nothing), and only
  // once per visit, so later enable/disable flips never steal focus from what the user is doing.
  let formFocused = false;
  $effect(() => {
    if (phase !== 'form') {
      formFocused = false;
      primaryButton?.focus();
    } else if (canForage && !formFocused && primaryButton) {
      formFocused = true;
      primaryButton.focus();
    }
  });

  async function submit() {
    if (!canForage) return;
    busy = true;
    message = '';
    if (!dm) writePicks();
    // DM mode sends only the counters. Self-serve sends skill, area and category, never a table.
    const res = await api('POST', API, {
      action: 'start', characterId,
      ...(dm ? {} : { skillKey: picks.skillKey, areaType: picks.areaType, category: picks.category }),
      advantage: { disabled, situationalAdvantage: advCount, situationalDisadvantage: disCount }
    });
    if (res.ok) {
      localResult = null;
      showForm = false;
      if (res.data.mode === 'self') selfCheck = { findId: res.data.findId, check: res.data.check };
      await onRefresh();
    } else if (res.status === 409 && res.data.error === 'resume') {
      // Something is already in flight (here or on the VTT): reopen it instead of erroring.
      if (res.data.unmarkedSelf) selfCheck = { findId: res.data.unmarkedSelf.findId, check: res.data.unmarkedSelf.check };
      message = 'You already had a forage in progress, so here it is.';
      await onRefresh();
    } else if (res.data.error === 'skill_not_allowed' && dm) {
      // The DM left after the hint: the server wants self-serve picks. Switch over.
      forceSelf = true;
      sources = []; disabled = []; previewSeq = 0; advStatus = 'loading';
      message = "The DM isn't here after all. Choose what you're looking for.";
      await onRefresh();
    } else {
      message = errorText(res.data);
      // Forage became unavailable since the popup opened: refresh so the popup shows the reason.
      if (res.data.error === 'forage_unavailable') await onRefresh();
    }
    busy = false;
  }

  async function mark(passed: boolean) {
    const target = markTarget;
    if (busy || !target) return;
    busy = true;
    message = '';
    const res = await api('POST', API, { action: 'self_mark', findId: target.findId, passed });
    if (res.ok) {
      const view = selfResult(res.data, target.findId, target.characterId) as ResultView;
      // Refresh first so the stale unmarked check is gone when the result step shows.
      await onRefresh();
      selfCheck = null;
      localResult = view;
      showForm = false;
      recentStatus = 'idle';
      // Only this sheet's own haul is worth a reload (a stranded check for another character isn't).
      if (res.data.status === 'found' && view.lines.length && target.characterId === characterId) onHaul(target.findId);
    } else {
      if (res.data.error === 'stale') { selfCheck = null; await onRefresh(); }
      message = errorText(res.data);
    }
    busy = false;
  }

  async function withdraw() {
    if (!pending || busy) return;
    busy = true;
    const res = await api('POST', API, { action: 'withdraw', requestId: pending.id });
    if (res.ok || res.data.error === 'stale_request') {
      message = '';
      await onRefresh();
      busy = false;
      return;
    }
    message = errorText(res.data);
    await onRefresh(); // the DM may have just reconnected
    busy = false;
  }

  // The finder isn't pushed "the DM left", so this button (and a recheck when the tab comes back to the
  // front) asks again. The button always says something, so a press never looks like a no-op.
  async function recheck(fromButton: boolean) {
    if (busy) return;
    await onRefresh();
    if (fromButton) message = mine?.dmPresent ? 'The DM is still connected, so it is in their hands.' : '';
  }
  function onVisibility() {
    if (document.visibilityState === 'visible' && phase === 'waiting') void recheck(false);
  }

  async function dismiss() {
    const last = result;
    if (last && last.mode === 'dm' && last.requestId) {
      await api('POST', API, { action: 'dismiss', requestId: last.requestId });
      await onRefresh();
    }
    localResult = null;
    onClose();
  }

  // Share the haul with the party (one way). Item names go public only through this explicit action.
  async function share(findId: string | null | undefined, markDone: () => void) {
    if (busy || !findId) return;
    busy = true;
    message = '';
    recentMessage = '';
    const res = await api('POST', `/vtt/api/finds/${encodeURIComponent(findId)}/share`);
    busy = false;
    if (res.ok) markDone();
    else { message = errorText(res.data); recentMessage = message; }
  }
  const shareResult = () => share(result?.findId, () => {
    if (localResult) localResult.shared = true;
    else void onRefresh(); // the room's copy is marked shared by the server
    const row = recentFinds.find((find) => find.id === result?.findId);
    if (row) row.shared = true;
  });
  const shareRecent = (find: Recent) => share(find.id, () => { find.shared = true; });

  async function loadRecent() {
    if (recentStatus === 'loading') return;
    recentStatus = 'loading';
    const res = await api('GET', `${API}/recent?characterId=${encodeURIComponent(characterId)}`);
    if (res.ok) { recentFinds = res.data.finds || []; recentStatus = 'ready'; recentMessage = ''; }
    else { recentStatus = 'failed'; recentMessage = errorText(res.data); }
  }
  function onRecentToggle(event: Event) {
    recentOpen = (event.currentTarget as HTMLDetailsElement).open;
    if (recentOpen && recentStatus === 'idle') void loadRecent();
  }
  // Re-fetch when it is open and went stale (a new forage resolved).
  $effect(() => {
    if (recentOpen && recentStatus === 'idle') untrack(() => void loadRecent());
  });

  const areas = $derived(selfAreas(options));
  const categories = $derived(selfCategories(options));
  const natText = (check: Check | null) => (check ? natBadgeText(check) : '');
</script>

<svelte:document onvisibilitychange={onVisibility} />

<div class="modal-backdrop" role="presentation" onpointerdown={backdropPress(onClose)}>
  <div
    class="panel compact-modal roll-options forage-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="forage-title"
    tabindex="-1"
    onpointerdown={(event) => event.stopPropagation()}
  >
    <div class="panel-head">
      <h2 id="forage-title">Forage</h2>
      <button type="button" class="text-button" onclick={onClose}>Close</button>
    </div>

    {#snippet checkCard(check: Check | null)}
      {#if check}
        <section class="roll-options-section forage-check">
          <p>{check.skillLabel} <strong>{check.total}</strong>
            {#if natText(check)}<span class="forage-badge" class:good={check.nat20}>{natText(check)}</span>{/if}</p>
          <p class="muted">d20: {check.natural}{check.poolSummary ? ` · ${check.poolSummary}` : ''}</p>
          <details><summary>How it was rolled</summary><pre class="forage-audit">{check.text}</pre></details>
        </section>
      {/if}
    {/snippet}

    {#snippet advPanel()}
      <section class="roll-options-section">
        <h3>Advantage</h3>
        {#if advStatus === 'loading'}
          <p class="muted">Checking advantage...</p>
        {:else if advStatus === 'failed'}
          <p class="muted">Couldn't check modifiers, the roll will still apply them.</p>
        {/if}
        {#each sources as source (source.id)}
          <label class="roll-options-source">
            <input type="checkbox" checked={!disabled.includes(source.id)} onchange={(event) => toggleSource(source.id, event.currentTarget.checked)} />
            <span>{advantageSourceLabel(source)}</span>
          </label>
        {/each}
        <div class="roll-options-row">
          <span>Advantage</span>
          <button type="button" aria-label="Fewer advantage" onclick={() => (advCount = clamp(advCount - 1, 0, 5))}>-</button>
          <strong aria-live="polite">{advCount}</strong>
          <button type="button" aria-label="More advantage" onclick={() => (advCount = clamp(advCount + 1, 0, 5))}>+</button>
        </div>
        <div class="roll-options-row">
          <span>Disadvantage</span>
          <button type="button" aria-label="Fewer disadvantage" onclick={() => (disCount = clamp(disCount - 1, 0, 5))}>-</button>
          <strong aria-live="polite">{disCount}</strong>
          <button type="button" aria-label="More disadvantage" onclick={() => (disCount = clamp(disCount + 1, 0, 5))}>+</button>
        </div>
        <p class="muted">Each point counts as one source. Advantage and disadvantage cancel one for one.</p>
        <p class="roll-options-readout">{readout}</p>
      </section>
    {/snippet}

    {#if phase === 'loading'}
      <p class="muted">Loading...</p>
    {:else if phase === 'waiting' && pending}
      {#if otherBlocker}<p class="forage-warn">Finish {otherBlocker.characterName}'s forage first.</p>{/if}
      {@render checkCard(pending.check)}
      <p>
        {#if pending.stage === 'requested'}Sent to the DM. Waiting...
        {:else if pending.stage === 'checked'}The DM has your check and is deciding if it counts...
        {:else}The DM is working out what you find...{/if}
      </p>
      {#if mine?.dmPresent === false}
        <p class="forage-warn">The DM has disconnected. You can withdraw and forage on your own.</p>
      {/if}
      {#if message}<p class="forage-error" role="alert">{message}</p>{/if}
      <div class="roll-options-actions forage-actions">
        <button type="button" class="secondary" onclick={onClose}>Close</button>
        {#if pending.stage !== 'requested' && pending.stage !== 'approving'}
          <button type="button" class="secondary" disabled={busy} onclick={() => recheck(true)}>Is the DM still here?</button>
        {/if}
        {#if canWithdraw}
          <button type="button" class="secondary" disabled={busy} onclick={withdraw}>Withdraw</button>
        {/if}
      </div>
    {:else if phase === 'mark' && markTarget}
      {#if otherBlocker}<p class="forage-warn">Finish {otherBlocker.characterName}'s forage first. Mark its check here.</p>{/if}
      {@render checkCard(markTarget.check)}
      <p>Did you beat the DM's DC?</p>
      {#if markTarget.check.nat1}<p class="muted">A natural 1 always fails.</p>{/if}
      {#if message}<p class="forage-error" role="alert">{message}</p>{/if}
      <div class="roll-options-actions forage-actions">
        <button type="button" class="secondary" onclick={onClose}>Later</button>
        <button type="button" class="secondary" disabled={busy} onclick={() => mark(false)}>Fail</button>
        <button type="button" class="roll-options-roll" bind:this={primaryButton} disabled={busy || markTarget.check.nat1} onclick={() => mark(true)}>Pass</button>
      </div>
    {:else if phase === 'result' && result}
      <p><strong>{resultHeadline(result)}</strong></p>
      {@render checkCard(result.check)}
      {#if result.lines && result.lines.length}
        <ul class="forage-lines">
          {#each result.lines as line}<li><strong>{line.qty}x</strong> {line.name}</li>{/each}
        </ul>
        <p class="muted">
          {haulWaiting ? "Your find will appear when you save." : 'Added to your inventory.'}
        </p>
      {/if}
      {#if message}<p class="forage-error" role="alert">{message}</p>{/if}
      <div class="roll-options-actions forage-actions">
        {#if result.lines && result.lines.length && result.findId}
          {#if result.shared}
            <button type="button" class="secondary" disabled>Shared with the party</button>
          {:else}
            <button type="button" class="secondary" disabled={busy} onclick={shareResult}>Share with party</button>
          {/if}
        {/if}
        <button type="button" class="secondary" onclick={() => { showForm = true; message = ''; }}>Forage again</button>
        <button type="button" class="roll-options-roll" bind:this={primaryButton} onclick={dismiss}>Dismiss</button>
      </div>
    {:else}
      {#if off}
        <p class="forage-warn">{forageUnavailableText(off)}</p>
      {:else if dm}
        <p>The DM will call the check.</p>
        {@render advPanel()}
      {:else if options && picks}
        <p class="muted">No DM connected, you will mark the check yourself.</p>
        <section class="roll-options-section">
          <label class="forage-field">Skill
            <select bind:value={picks.skillKey} onchange={onSkillChange}>
              {#each selfSkills as skill (skill.key)}<option value={skill.key}>{skill.name}</option>{/each}
            </select>
          </label>
          <label class="forage-field">Where
            <select bind:value={picks.areaType}>
              {#each areas as area (area)}<option value={area}>{tagLabel(area)}</option>{/each}
            </select>
          </label>
          <label class="forage-field">Looking for
            <select bind:value={picks.category}>
              {#each categories as category (category)}<option value={category}>{tagLabel(category)}</option>{/each}
            </select>
          </label>
        </section>
        {@render advPanel()}
      {/if}
      {#if message}<p class="forage-error" role="alert">{message}</p>{/if}
      {#if !off && !dm && !options && optionsFailed}
        <div class="roll-options-actions forage-actions">
          <button type="button" class="secondary" onclick={() => void loadOptions()}>Retry</button>
        </div>
      {/if}

      <details class="forage-recent" open={recentOpen} ontoggle={onRecentToggle}>
        <summary>Recent finds</summary>
        {#if recentStatus === 'idle' || recentStatus === 'loading'}
          <p class="muted">Loading...</p>
        {:else if recentStatus === 'failed'}
          <p class="forage-error">{recentMessage}</p>
        {:else}
          {#if recentMessage}<p class="forage-error">{recentMessage}</p>{/if}
          {#if !recentFinds.length}
            <p class="muted">Nothing found yet.</p>
          {:else}
            <ul class="forage-recent-list">
              {#each recentFinds as find (find.id)}
                <li>
                  <div>
                    <strong>{recentFindItemsText(find)}</strong>
                    <div class="muted">{new Date(find.createdAt).toLocaleString()} · {recentFindStatusText(find)}</div>
                  </div>
                  {#if canShareRecent(find)}
                    <button type="button" class="secondary" disabled={busy} onclick={() => shareRecent(find)}>Share</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </details>

      <div class="roll-options-actions forage-actions">
        <button type="button" class="secondary" onclick={onClose}>Close</button>
        {#if !off && (dm || (options && picks))}
          <button type="button" class="roll-options-roll" bind:this={primaryButton} disabled={!canForage} onclick={submit}>Forage</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

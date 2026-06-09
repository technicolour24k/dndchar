<script lang="ts">
  let { data, form } = $props();

  const user = $derived(data.user);

  let displayName = $state('');
  let backgroundColor = $state('#f1f1f1');
  let panelColor = $state('#292929');
  let textColor = $state('#f4f4f4');

  $effect(() => {
    displayName = user.displayName;
    backgroundColor = user.themeBackgroundColor;
    panelColor = user.themePanelColor;
    textColor = user.themeTextColor;
  });
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Account</p>
    <h1>Profile</h1>
  </div>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

{#if data.saved}
  <p class="form-success">Profile saved.</p>
{/if}

<div class="content-grid">
  <section class="panel stack">
    <h2>Theme</h2>
    <form method="POST" action="?/save" class="stack">
      <label>
        Display Name
        <input name="displayName" value={displayName} oninput={(event) => (displayName = event.currentTarget.value)} />
      </label>
      <div class="mini-grid">
        <label>
          Background
          <input name="backgroundColor" type="color" value={backgroundColor} oninput={(event) => (backgroundColor = event.currentTarget.value)} />
        </label>
        <label>
          Container
          <input name="panelColor" type="color" value={panelColor} oninput={(event) => (panelColor = event.currentTarget.value)} />
        </label>
        <label>
          Text
          <input name="textColor" type="color" value={textColor} oninput={(event) => (textColor = event.currentTarget.value)} />
        </label>
      </div>
      <button type="submit">Save Profile</button>
    </form>
  </section>

  <aside
    class="theme-preview"
    style={`--preview-bg: ${backgroundColor}; --preview-panel: ${panelColor}; --preview-text: ${textColor};`}
  >
    <div class="theme-preview-card">
      <p class="eyebrow">Preview</p>
      <h2>{displayName || 'Player'}</h2>
      <p>Containers use your chosen panel colour. Muted text, fields, borders, and darker panels are derived automatically.</p>
    </div>
  </aside>
</div>

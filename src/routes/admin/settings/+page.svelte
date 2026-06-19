<script lang="ts">
  let { data, form } = $props();
  const registrationEnabled = $derived(form?.registrationEnabled ?? data.registrationEnabled);
</script>

<section class="page-head">
  <div>
    <p class="eyebrow">Administration</p>
    <h1>Site Settings</h1>
  </div>
</section>

{#if form?.error}
  <p class="form-error">{form.error}</p>
{/if}

{#if form?.saved}
  <p class="form-success">Settings saved.</p>
{/if}

<section class="panel stack settings-panel">
  <div>
    <h2>Registration</h2>
    <p class="muted">Allow new users to create accounts from the public registration page.</p>
  </div>

  <form method="POST" action="?/updateRegistration" class="settings-row">
    <label class="inline compact-check">
      <input name="registrationEnabled" type="checkbox" checked={registrationEnabled} />
      Registrations enabled
    </label>
    <button type="submit">Save Settings</button>
  </form>

  <p class="muted">
    Current state: <strong>{registrationEnabled ? 'Enabled' : 'Disabled'}</strong>
  </p>
</section>

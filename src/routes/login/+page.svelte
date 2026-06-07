<script lang="ts">
  let { form } = $props();
</script>

<section class="auth-card">
  <div>
    <p class="eyebrow">TavernSheet</p>
    <h1>Log in</h1>
    <p>Manage D&D 5E characters, saves, resources, and version history.</p>
  </div>

  <form method="POST" class="stack">
    {#if form?.error}
      <p class="form-error">{form.error}</p>
    {/if}
    <label>
      Email
      <input name="email" type="email" autocomplete="email" value={form?.email ?? ''} required />
    </label>
    <label>
      Password
      <input name="password" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit">Log in</button>
  </form>
</section>

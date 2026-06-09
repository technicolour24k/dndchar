<script lang="ts">
  let { data, form } = $props();
  const registrationEnabled = $derived(form?.registrationEnabled ?? data.registrationEnabled);
</script>

<section class="auth-card">
  <div>
    <p class="eyebrow">TavernSheet</p>
    <h1>Create Account</h1>
    <p>Register to test character sheets while the app is in development.</p>
  </div>

  <form method="POST" class="stack">
    {#if form?.error}
      <p class="form-error">{form.error}</p>
    {/if}

    {#if !registrationEnabled}
      <p class="form-error">Registration is currently disabled.</p>
      <a class="button-link" href="/login">Back to Log In</a>
    {:else}
      <label>
        Display Name
        <input name="displayName" autocomplete="name" value={form?.displayName ?? ''} />
      </label>
      <label>
        Email
        <input name="email" type="email" autocomplete="email" value={form?.email ?? ''} required />
      </label>
      <label>
        Password
        <input name="password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label>
        Confirm Password
        <input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <button type="submit">Create Account</button>
      <a class="text-button" href="/login">Already have an account?</a>
    {/if}
  </form>
</section>

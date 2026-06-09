<script lang="ts">
  import '../styles.css';
  import { env } from '$env/dynamic/public';

  let { data, children } = $props();
  const appName = env.PUBLIC_APP_NAME || 'D&D Character Manager';
  const themeStyle = $derived(data.user
    ? `--app-bg: ${data.user.themeBackgroundColor}; --app-panel: ${data.user.themePanelColor}; --app-text: ${data.user.themeTextColor};`
    : '');
</script>

<svelte:head>
  <title>{appName}</title>
</svelte:head>

<div class="app-frame" style={themeStyle}>
  {#if data.user}
    <header class="topbar">
      <a class="brand" href="/dashboard">
        <span class="brand-mark">d20</span>
        <span>{appName}</span>
      </a>
      <nav class="topnav" aria-label="Primary">
        <a href="/dashboard">Dashboard</a>
        <a href="/characters">Characters</a>
        <a href="/campaigns">Campaigns</a>
        <a href="/encounters">Encounters</a>
        <a href="/admin/modifiers">Admin</a>
        <a href="/admin/settings">Settings</a>
      </nav>
      <div class="user-menu">
        <a class="profile-link" href="/profile">{data.user.displayName}</a>
        <form method="POST" action="/logout">
          <button type="submit">Log out</button>
        </form>
      </div>
    </header>
  {/if}

  <main class="page-shell">
    {@render children()}
  </main>
</div>

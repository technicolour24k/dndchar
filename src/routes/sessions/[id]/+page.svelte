<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import SessionNotesModal from '$lib/components/SessionNotesModal.svelte';
</script>

<!-- Kept as a thin, directly-linkable route (bookmarks, the VTT's "open the
     full log" link) - it's the same SessionNotesModal used everywhere else in
     the app, just opened by default with nothing behind it, rather than a
     separate page-specific implementation. Closing it goes back to the list. -->
<SessionNotesModal gameSessionId={page.params.id ?? null} open={true} onClose={() => goto('/sessions')} />

<script lang="ts">
  let { title, body }: { title: string; body: string } = $props();
</script>

<section class="panel">
  <p class="eyebrow">Placeholder</p>
  <h1>{title}</h1>
  <p class="muted">{body}</p>
</section>

<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Spell Library" description="Create and manage spells, casting details, effects, and actions." createType="spell" allowedTypes={['spell']}/>

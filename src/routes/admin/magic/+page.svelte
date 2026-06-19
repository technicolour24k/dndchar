<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Magic Settings" description="Manage spells, spell metadata, and mechanical modifiers." createType="spell" allowedTypes={['spell']}/>

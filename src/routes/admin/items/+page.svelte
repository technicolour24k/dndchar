<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Item Settings" description="Manage item templates, equipment statistics, and their modifiers." createType="item" allowedTypes={['item']}/>

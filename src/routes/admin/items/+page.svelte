<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Item Library" description="Create and manage items, equipment, and consumables with reusable rules." createType="item" allowedTypes={['item']}/>

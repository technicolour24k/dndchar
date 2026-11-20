<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Feats & Features" description="Create and manage feats and class features with reusable rules." createType="feat" allowedTypes={['feat','class_feature']}/>

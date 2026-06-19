<script lang="ts">import ContentTypeAdmin from '$lib/components/admin/ContentTypeAdmin.svelte';let{data,form}=$props();</script>
<ContentTypeAdmin {data} {form} title="Feat Settings" description="Manage feats and class features with their attached modifiers." createType="feat" allowedTypes={['feat','class_feature']}/>

import { createContentAdminPage } from '$lib/server/services/content-admin-page';
const page=createContentAdminPage(['feat','class_feature'],'feat');
export const load=page.load;
export const actions=page.actions;

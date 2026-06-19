import { createContentAdminPage } from '$lib/server/services/content-admin-page';
const page=createContentAdminPage(['item'],'item');
export const load=page.load;
export const actions=page.actions;

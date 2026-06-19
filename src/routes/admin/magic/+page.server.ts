import { createContentAdminPage } from '$lib/server/services/content-admin-page';
const page=createContentAdminPage(['spell'],'spell');
export const load=page.load;
export const actions=page.actions;

import { writable } from 'svelte/store';

export const encounterStore = writable({ activeEncounterId: '', roundNumber: 1 });

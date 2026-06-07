import { writable } from 'svelte/store';
import type { CharacterDetail } from '$lib/types/character';

export const characterStore = writable<CharacterDetail | null>(null);

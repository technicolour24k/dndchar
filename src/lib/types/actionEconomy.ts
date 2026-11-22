// Action economy types (docs: plans/dndchar/action-economy). A campaign picks a built-in profile;
// every turn cost line carries a timing and a category, and the profile maps those onto its pools.

export type TurnTiming = 'action' | 'bonus_action' | 'reaction' | 'movement' | 'free';
export type TurnCategory = 'attack' | 'spell' | 'general';

export const TURN_TIMINGS: readonly TurnTiming[] = ['action', 'bonus_action', 'reaction', 'movement', 'free'];
export const TURN_CATEGORIES: readonly TurnCategory[] = ['attack', 'spell', 'general'];

// category is missing only on normalised legacy lines; withCategory() fills it in from the container.
export type TurnLine = { pool: 'turn'; amount: number; timing: TurnTiming; category?: TurnCategory; actionPool?: string };

export type ProfileKey = 'dnd5e' | 'attack_utility';
export const PROFILE_KEYS: readonly ProfileKey[] = ['dnd5e', 'attack_utility'];

// Every per-turn pool key any profile has. A line's actionPool must be one of these; whether the
// ACTIVE profile has it is decided at resolve time.
export const ACTION_POOL_KEYS: readonly string[] = ['action', 'bonus_action', 'reaction', 'attack', 'utility'];

export type ActionPoolDef = { key: string; label: string; costLabel: (n: number) => string; base: number };

export type ActionEconomyProfile = {
  key: ProfileKey;
  label: string;
  description: string;
  pools: ActionPoolDef[];
  // The pool key a line draws from, or null when it costs nothing.
  mapLine(line: { timing: TurnTiming; category: TurnCategory }): string | null;
};

// A follow-up is a free repeat of the SAME action (same weapon or spell), keyed by attack type and
// granted by followup.<type>.count modifiers. Extra Attack grants melee and ranged; a later
// doublecast grants spell or cantrip. It waives only the action cost, never slots or other pools.
export type FollowupClass = 'melee' | 'ranged' | 'spell' | 'cantrip' | 'other';
export const FOLLOWUP_CLASSES: readonly FollowupClass[] = ['melee', 'ranged', 'spell', 'cantrip', 'other'];

export type TurnView = {
  profileKey: ProfileKey;
  profileLabel: string;
  turnSeq: number;
  pools: Array<{ key: string; label: string; current: number; max: number; spent: number; breakdown: { label: string; value: number }[] }>;
  followups: Array<{ cls: FollowupClass; label: string; remaining: number; perAction: number }>;
  log: Array<{ label: string; pool: string; amount: number; via: string; at: string }>;
};

// One entry of this turn's audit trail (stored in character_turn_state.log_json).
export type TurnLogEntry = { pool: string; label: string; amount: number; via: string; source: string; at: string };
export type FollowupState = { remaining: number; sources: string[]; perAction: number };

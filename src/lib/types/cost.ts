// Cost engine types (docs: plans/dndchar/cost-engine). A Container's cost is a structured list,
// never a scalar, so one activation can spend an action, a spell slot and a resource pool at once.

import type { FollowupClass, ProfileKey, TurnLine } from './actionEconomy';

export type CostEntry =
  | { pool: 'spell_slot'; amount: number; level: number } // level = minimum slot level; the player may upcast
  | { pool: 'charges'; amount: number; key?: string } // the activated Container's own counter
  | { pool: 'item'; amount: number } // the activated item's quantity
  | TurnLine // the turn's action economy; the campaign's profile decides which pool pays
  | { pool: string; amount: number }; // a resource_pool_definitions key

export type ActionEconomyPool = 'action' | 'bonus_action' | 'reaction';
export const ACTION_ECONOMY_POOLS: readonly string[] = ['action', 'bonus_action', 'reaction'];

export type SlotType = 'standard' | 'pact';

// Whether an activation spends a waiting follow-up ('use': Extra Attack, a spell echo) or pays
// normally ('skip'). Weapon attacks default to 'use'. Spells default to 'skip': an echo must be
// chosen, or a normal L5 Fireball would silently become a free L3 echo.
export type FollowupChoice = 'use' | 'skip';

export type Activation =
  | { kind: 'spell'; instanceId: string; slotType?: SlotType; slotLevel?: number; followup?: FollowupChoice }
  | { kind: 'spell_access'; spellAccessId: string; inventoryItemId: string; slotType?: SlotType; slotLevel?: number; followup?: FollowupChoice }
  | { kind: 'item'; inventoryId: string }
  | { kind: 'content'; instanceId: string }
  | { kind: 'weapon_attack'; inventoryId: string | null; label?: string; timing?: 'action' | 'bonus_action' | 'reaction'; followup?: FollowupChoice }
  | { kind: 'dash'; count: number };

export type CostShortfall = { label: string; needed: number; available: number };

// What the player can pay with, as loaded by the (later) cost engine service.
export type CostAvailability = {
  slots: Array<{ type: SlotType; level: number; current: number }>;
  // The activated Container's own counters (content or inventory resources).
  counters: Array<{ key: string; label: string; current: number }>;
  // The activated item's quantity, or null when the activation isn't an item.
  itemQuantity: number | null;
  // Active character pools by key. A key that is missing (no definition, or archived) is a shortfall.
  pools: Record<string, { label: string; current: number }>;
  // Per-turn pools and follow-ups. Absent means turn lines stay display-only (chips, old previews).
  turn?: { profile: ProfileKey; pools: Record<string, { label: string; current: number }>; followups: Record<string, number> };
};

export type CostChoices = { slotType?: SlotType; slotLevel?: number; followupClass?: FollowupClass };

export type PayFrom =
  | { pool: 'spell_slot'; slotType: SlotType; slotLevel: number }
  | { pool: 'charges'; key: string }
  | { pool: 'item' }
  | { pool: 'pool'; key: string }
  | { pool: 'turn'; key: string }
  | { pool: 'followup'; cls: FollowupClass };

export type PlannedCostLine = {
  entry: CostEntry;
  label: string;
  needed: number;
  available: number;
  // Where the cost would be paid from. Absent for display-only lines and for lines with no source.
  payFrom?: PayFrom;
  displayOnly: boolean;
};

// castAtLevel is set only for a spell echo: the free repeat always resolves at the spell's base level.
export type PlannedCost = { lines: PlannedCostLine[]; shortfalls: CostShortfall[]; castAtLevel?: number };

export type OverrideRequest = 'dm' | 'self';
export type OverrideDecision = 'dm_approved' | 'dm_self' | 'self_override' | 'ask_dm' | 'forbidden';
export type ShortfallMode = 'dm_self' | 'ask_dm' | 'no_dm';

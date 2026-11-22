// Cost engine types (docs: plans/dndchar/cost-engine). A Container's cost is a structured list,
// never a scalar, so one activation can spend an action, a spell slot and a resource pool at once.

export type CostEntry =
  | { pool: 'spell_slot'; amount: number; level: number } // level = minimum slot level; the player may upcast
  | { pool: 'charges'; amount: number; key?: string } // the activated Container's own counter
  | { pool: 'item'; amount: number } // the activated item's quantity
  | { pool: 'action' | 'bonus_action' | 'reaction'; amount: number } // display-only in v1
  | { pool: string; amount: number }; // a resource_pool_definitions key

export type ActionEconomyPool = 'action' | 'bonus_action' | 'reaction';
export const ACTION_ECONOMY_POOLS: readonly string[] = ['action', 'bonus_action', 'reaction'];

export type SlotType = 'standard' | 'pact';

export type Activation =
  | { kind: 'spell'; instanceId: string; slotType?: SlotType; slotLevel?: number }
  | { kind: 'spell_access'; spellAccessId: string; inventoryItemId: string; slotType?: SlotType; slotLevel?: number }
  | { kind: 'item'; inventoryId: string }
  | { kind: 'content'; instanceId: string };

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
};

export type CostChoices = { slotType?: SlotType; slotLevel?: number };

export type PayFrom =
  | { pool: 'spell_slot'; slotType: SlotType; slotLevel: number }
  | { pool: 'charges'; key: string }
  | { pool: 'item' }
  | { pool: 'pool'; key: string };

export type PlannedCostLine = {
  entry: CostEntry;
  label: string;
  needed: number;
  available: number;
  // Where the cost would be paid from. Absent for display-only lines and for lines with no source.
  payFrom?: PayFrom;
  displayOnly: boolean;
};

export type PlannedCost = { lines: PlannedCostLine[]; shortfalls: CostShortfall[] };

export type OverrideRequest = 'dm' | 'self';
export type OverrideDecision = 'dm_approved' | 'dm_self' | 'self_override' | 'ask_dm' | 'forbidden';
export type ShortfallMode = 'dm_self' | 'ask_dm' | 'no_dm';

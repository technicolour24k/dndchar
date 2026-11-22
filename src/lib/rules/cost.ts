import type { ActiveCharacterEffect } from '$lib/types/character';
import {
  ACTION_ECONOMY_POOLS,
  type Activation,
  type CostAvailability,
  type CostChoices,
  type CostEntry,
  type CostShortfall,
  type OverrideDecision,
  type OverrideRequest,
  type PayFrom,
  type PlannedCost,
  type PlannedCostLine,
  type ShortfallMode,
  type SlotType
} from '$lib/types/cost';
import { resolveResourceMaximum, resolvedAdditiveModifiers, type ModifierContext } from './dnd5e';

const MAX_AMOUNT = 99;

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

// Validates a cost_json value. null/undefined means "use the content type's default" and passes
// through as entries: null. Anything else must be an array of well-formed lines. Unknown pool
// strings pass here; they're checked against the pool definitions when an admin saves.
export function parseCostJson(value: unknown): { entries: CostEntry[] | null; errors: string[] } {
  if (value === null || value === undefined) return { entries: null, errors: [] };
  if (!Array.isArray(value)) return { entries: null, errors: ['Cost must be a list of cost lines.'] };
  const errors: string[] = [];
  const entries: CostEntry[] = [];
  value.forEach((raw, index) => {
    const where = `Cost line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where} isn't an object.`);
      return;
    }
    const line = raw as Record<string, unknown>;
    if (typeof line.pool !== 'string' || !line.pool.trim()) {
      errors.push(`${where} needs a pool.`);
      return;
    }
    const pool = line.pool.trim();
    if (!isInt(line.amount) || line.amount < 1 || line.amount > MAX_AMOUNT) {
      errors.push(`${where}: amount must be a whole number from 1 to ${MAX_AMOUNT}.`);
      return;
    }
    const amount = line.amount;
    if (pool === 'spell_slot') {
      if (!isInt(line.level) || line.level < 1 || line.level > 9) {
        errors.push(`${where}: a spell slot cost needs a level from 1 to 9.`);
        return;
      }
      entries.push({ pool, amount, level: line.level });
      return;
    }
    if (pool === 'charges') {
      if (line.key !== undefined && line.key !== null && (typeof line.key !== 'string' || !line.key.trim())) {
        errors.push(`${where}: the counter key must be text.`);
        return;
      }
      const key = typeof line.key === 'string' ? line.key.trim() : '';
      entries.push(key ? { pool, amount, key } : { pool, amount });
      return;
    }
    entries.push({ pool, amount });
  });
  return errors.length ? { entries: null, errors } : { entries, errors };
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

// '1 action' / '1 bonus action' / '1 reaction' become a display-only action-economy line.
// Anything else ('1 minute', 'Special', '1 action, which you take when...') gives none.
export function castingTimeActionLine(text: string | null | undefined): CostEntry | null {
  const match = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').match(/^1 (action|bonus action|reaction)$/);
  if (!match) return null;
  return { pool: match[1].replace(' ', '_') as 'action' | 'bonus_action' | 'reaction', amount: 1 };
}

export type DefaultCostInput = {
  contentType: string;
  spellLevel?: number | null;
  castingTime?: string | null;
  hasSpendItemStep?: boolean;
  isItemUse?: boolean;
};

// The cost a Container has while cost_json is NULL. Mirrors the procedural behaviour from before
// the cost engine, so nothing changes until a DM sets an explicit cost.
export function defaultCostFor(input: DefaultCostInput): CostEntry[] {
  if (input.contentType === 'spell') {
    const entries: CostEntry[] = [];
    const level = input.spellLevel ?? 0;
    if (level >= 1) entries.push({ pool: 'spell_slot', amount: 1, level: Math.min(9, level) });
    const action = castingTimeActionLine(input.castingTime);
    if (action) entries.push(action);
    return entries;
  }
  if (input.contentType === 'item' && input.isItemUse) {
    // An on_use spend_item step already pays the quantity, as it always has.
    return input.hasSpendItemStep ? [] : [{ pool: 'item', amount: 1 }];
  }
  return [];
}

// An explicit list (even an empty one, meaning free) beats the default.
export function effectiveCost(explicit: CostEntry[] | null | undefined, defaults: CostEntry[]): CostEntry[] {
  return explicit ?? defaults;
}

export type SpellAccessCostInput = {
  accessType: 'charges' | 'limited_free' | 'at_will' | 'character_slots';
  resourceKey?: string | null;
  resourceCostExpression?: string | null;
};

// An item-granted spell keeps its access row as the slot rule: the access cost replaces the
// spell's spell_slot lines and keeps the rest (e.g. Vowfire).
export function applySpellAccessCost(entries: CostEntry[], access: SpellAccessCostInput): CostEntry[] {
  if (access.accessType === 'character_slots') return entries;
  const rest = entries.filter((entry) => entry.pool !== 'spell_slot');
  if (access.accessType === 'at_will') return rest;
  // charges / limited_free: pay the granting item's counter. Same maths as the legacy
  // castCharacterSpell: truncate, and anything blank, junk, 0 or negative charges 1 (2.5 -> 2).
  const amount = Math.max(1, Math.min(MAX_AMOUNT, Math.trunc(Number((access.resourceCostExpression ?? '').trim())) || 1));
  const key = (access.resourceKey ?? '').trim();
  return [key ? { pool: 'charges', amount, key } : { pool: 'charges', amount }, ...rest];
}

// ---------------------------------------------------------------------------------------------
// Pool maxima
// ---------------------------------------------------------------------------------------------

export type PoolDefinitionLite = { key: string; baseMaxExpression: string };
export type PoolMaxContext = {
  level?: number;
  proficiencyBonus?: number;
  abilityModifier?: number;
  modifierContext?: ModifierContext;
};
export type PoolMaximum = { max: number; lines: Array<{ label: string; value: number }> };

// The live maximum of each pool: the base expression plus every bonus and minus every penalty on
// resource.<key>.max (conditions respected), floored at 0. Sources sum by count. `lines` is the
// source-attributed breakdown for the "?" help.
export function poolMaxima(
  definitions: PoolDefinitionLite[],
  modifierSources: ActiveCharacterEffect[],
  ctx: PoolMaxContext = {}
): Record<string, PoolMaximum> {
  const result: Record<string, PoolMaximum> = {};
  for (const definition of definitions) {
    const base = resolveResourceMaximum(definition.baseMaxExpression, ctx);
    const grants = resolvedAdditiveModifiers(modifierSources, [`resource.${definition.key}.max`], ctx.modifierContext ?? {});
    const lines = [{ label: 'Base', value: base }, ...grants.map((grant) => ({ label: grant.label, value: grant.value }))];
    const total = lines.reduce((sum, line) => sum + line.value, 0);
    result[definition.key] = { max: Math.max(0, total), lines };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = { action: 'Action', bonus_action: 'Bonus action', reaction: 'Reaction' };

function slotLabel(level: number) {
  return `Level ${level} Spell Slot`;
}

// Picks the slot a spell_slot line pays from: the requested type/level if it's at least the
// line's minimum level, else the lowest level with a slot, standard before pact (mirrors
// spendAvailableSlot). Returns the slot to pay from and how many it has, or null for none.
function chooseSlot(
  entry: { amount: number; level: number },
  slots: CostAvailability['slots'],
  choices: CostChoices,
  used: Map<string, number>
): { type: SlotType; level: number; current: number } | null {
  const left = (slot: { type: SlotType; level: number; current: number }) => slot.current - (used.get(`slot:${slot.type}:${slot.level}`) ?? 0);
  const order = (a: { type: SlotType; level: number }, b: { type: SlotType; level: number }) =>
    a.level - b.level || (a.type === b.type ? 0 : a.type === 'standard' ? -1 : 1);
  // A slot type on its own (no level) narrows the pool of slots, as the legacy path did.
  const eligible = slots.filter((slot) => slot.level >= entry.level && (!choices.slotType || slot.type === choices.slotType)).sort(order);
  const requested = choices.slotLevel;
  // A requested level below the line's minimum is a shortfall (legacy errored), not a fallback.
  if (requested !== undefined && requested < entry.level) return null;
  if (requested !== undefined) {
    const matches = eligible.filter((slot) => slot.level === requested && (!choices.slotType || slot.type === choices.slotType));
    // Prefer one that can pay; otherwise report against the requested slot (or none if it doesn't exist).
    return matches.find((slot) => left(slot) >= entry.amount) ?? matches[0] ?? null;
  }
  return eligible.find((slot) => left(slot) >= entry.amount) ?? null;
}

// Works out what each cost line would draw from, and what's short. Pure: it never mutates the
// availability. Two lines drawing on the same source are checked against the running total.
export function planCost(entries: CostEntry[], availability: CostAvailability, choices: CostChoices = {}): PlannedCost {
  const used = new Map<string, number>();
  const lines: PlannedCostLine[] = [];
  const shortfalls: CostShortfall[] = [];

  const settle = (line: PlannedCostLine, sourceKey: string | null, current: number) => {
    const already = sourceKey ? used.get(sourceKey) ?? 0 : 0;
    const available = Math.max(0, (Number.isFinite(current) ? current : 0) - already);
    line.available = available;
    if (sourceKey) used.set(sourceKey, already + line.needed);
    lines.push(line);
    if (available < line.needed) shortfalls.push({ label: line.label, needed: line.needed, available });
  };

  for (const entry of entries) {
    const needed = entry.amount;
    if (ACTION_ECONOMY_POOLS.includes(entry.pool)) {
      // Shown, never tracked, never short.
      lines.push({ entry, label: ACTION_LABELS[entry.pool], needed, available: needed, displayOnly: true });
      continue;
    }
    if (entry.pool === 'spell_slot') {
      const slotEntry = entry as { pool: 'spell_slot'; amount: number; level: number };
      const slot = chooseSlot(slotEntry, availability.slots, choices, used);
      if (!slot) {
        const level = choices.slotLevel !== undefined ? choices.slotLevel : slotEntry.level;
        settle({ entry, label: slotLabel(level), needed, available: 0, displayOnly: false }, null, 0);
        continue;
      }
      const payFrom: PayFrom = { pool: 'spell_slot', slotType: slot.type, slotLevel: slot.level };
      settle({ entry, label: slotLabel(slot.level), needed, available: 0, payFrom, displayOnly: false }, `slot:${slot.type}:${slot.level}`, slot.current);
      continue;
    }
    if (entry.pool === 'charges') {
      const key = (entry as { key?: string }).key;
      const counter = key
        ? availability.counters.find((row) => row.key === key)
        : availability.counters.length === 1 ? availability.counters[0] : undefined;
      if (!counter) {
        settle({ entry, label: key ? `Unknown counter (${key})` : 'Unknown counter', needed, available: 0, displayOnly: false }, null, 0);
        continue;
      }
      settle({ entry, label: counter.label || counter.key, needed, available: 0, payFrom: { pool: 'charges', key: counter.key }, displayOnly: false }, `charges:${counter.key}`, counter.current);
      continue;
    }
    if (entry.pool === 'item') {
      const quantity = availability.itemQuantity;
      settle({ entry, label: 'Item quantity', needed, available: 0, payFrom: quantity === null ? undefined : { pool: 'item' }, displayOnly: false }, quantity === null ? null : 'item', quantity ?? 0);
      continue;
    }
    // A character pool. No active definition means a shortfall labelled with the raw key, so a
    // typo shows up instead of becoming a silent free cast.
    const pool = Object.hasOwn(availability.pools, entry.pool) ? availability.pools[entry.pool] : undefined;
    if (!pool) {
      settle({ entry, label: entry.pool, needed, available: 0, displayOnly: false }, null, 0);
      continue;
    }
    settle({ entry, label: pool.label || entry.pool, needed, available: 0, payFrom: { pool: 'pool', key: entry.pool }, displayOnly: false }, `pool:${entry.pool}`, pool.current);
  }
  return { lines, shortfalls };
}

// ---------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------

// "L2 slot + 1 Vowfire + 1 action". `labels` maps a character pool key to its label.
export function costSummary(entries: CostEntry[], labels: Record<string, string> = {}): string {
  if (!entries.length) return 'Free';
  return entries
    .map((entry) => {
      const n = entry.amount;
      if (entry.pool === 'spell_slot') {
        const level = (entry as { level: number }).level;
        return n === 1 ? `L${level} slot` : `${n} x L${level} slots`;
      }
      if (entry.pool === 'charges') return `${n} ${n === 1 ? 'charge' : 'charges'}`;
      if (entry.pool === 'item') return n === 1 ? '1 item' : `${n} items`;
      if (entry.pool === 'action') return `${n} ${n === 1 ? 'action' : 'actions'}`;
      if (entry.pool === 'bonus_action') return `${n} bonus ${n === 1 ? 'action' : 'actions'}`;
      if (entry.pool === 'reaction') return `${n} ${n === 1 ? 'reaction' : 'reactions'}`;
      return `${n} ${labels[entry.pool] ?? entry.pool}`;
    })
    .join(' + ');
}

// ---------------------------------------------------------------------------------------------
// Overrides and signatures
// ---------------------------------------------------------------------------------------------

// What a short activation may do. A valid approval always wins. 'dm' needs the actor to really be
// the DM/co-DM (else forbidden). 'self' only works with no DM present; a present DM must be asked
// properly (ask_dm). With no approval and no request, ask_dm means "no override granted".
export function overrideDecision(input: {
  hasValidApproval: boolean;
  actorIsDm: boolean;
  dmPresent: boolean;
  requested?: OverrideRequest | null;
}): OverrideDecision {
  if (input.hasValidApproval) return 'dm_approved';
  if (input.requested === 'dm') return input.actorIsDm ? 'dm_self' : 'forbidden';
  if (input.requested === 'self' && input.actorIsDm) return 'dm_self';
  if (input.requested === 'self') return input.dmPresent ? 'ask_dm' : 'self_override';
  return 'ask_dm';
}

// Which prompt a 409 insufficient response asks the client to show.
export function shortfallMode(input: { actorIsDm: boolean; dmPresent: boolean }): ShortfallMode {
  if (input.actorIsDm) return 'dm_self';
  return input.dmPresent ? 'ask_dm' : 'no_dm';
}

// Stable string for an activation (kind, ids, slot choice). An approval only unlocks an
// activation with the same signature.
export function activationSignature(activation: Activation): string {
  const slot = `${activation.kind === 'item' || activation.kind === 'content' ? '' : `${activation.slotType ?? ''}:${activation.slotLevel ?? ''}`}`;
  switch (activation.kind) {
    case 'spell':
      return `spell|${activation.instanceId}|${slot}`;
    case 'spell_access':
      return `spell_access|${activation.spellAccessId}|${activation.inventoryItemId}|${slot}`;
    case 'item':
      return `item|${activation.inventoryId}`;
    case 'content':
      return `content|${activation.instanceId}`;
  }
}

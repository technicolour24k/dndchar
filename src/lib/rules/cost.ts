import type { ActiveCharacterEffect } from '$lib/types/character';
import { ACTION_POOL_KEYS, TURN_CATEGORIES, TURN_TIMINGS, type TurnCategory, type TurnLine, type TurnTiming } from '$lib/types/actionEconomy';
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
import { resolveResourceMaximum, type ModifierContext } from './dnd5e';
import { sumTargetGrants } from './modifierGrants';
import { profileFor, resolveTurnPool, turnCostLabel } from './actionEconomy';

const MAX_AMOUNT = 99;

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

// A turn line as itself, a legacy line ({pool:'action'|'bonus_action'|'reaction'}) as a turn line
// with no category (withCategory fills it in from the container), anything else null.
export function asTurnLine(entry: CostEntry): TurnLine | null {
  if (entry.pool === 'turn') return entry as TurnLine;
  if (ACTION_ECONOMY_POOLS.includes(entry.pool)) return { pool: 'turn', amount: entry.amount, timing: entry.pool as TurnTiming };
  return null;
}

// Validates a cost_json value. null/undefined means "use the content type's default" and passes
// through as entries: null. Anything else must be an array of well-formed lines. Unknown pool
// strings pass here; they're checked against the pool definitions when an admin saves. Legacy
// action lines come out as turn lines. Stored costs ({ stored: true }) keep only the first turn
// line and ignore the rest, so old data never breaks a cast; "one turn line" is enforced for
// authors by validateCostEntries.
export function parseCostJson(value: unknown, options: { stored?: boolean } = {}): { entries: CostEntry[] | null; errors: string[] } {
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
    if (pool === 'turn') {
      if (typeof line.timing !== 'string' || !(TURN_TIMINGS as readonly string[]).includes(line.timing)) {
        errors.push(`${where}: the action timing must be one of ${TURN_TIMINGS.join(', ')}.`);
        return;
      }
      if (line.category !== undefined && line.category !== null && !(TURN_CATEGORIES as readonly unknown[]).includes(line.category)) {
        errors.push(`${where}: the action category must be one of ${TURN_CATEGORIES.join(', ')}.`);
        return;
      }
      if (line.actionPool !== undefined && line.actionPool !== null && !ACTION_POOL_KEYS.includes(line.actionPool as string)) {
        errors.push(`${where}: the specific action pool must be one of ${ACTION_POOL_KEYS.join(', ')}.`);
        return;
      }
      const turn: TurnLine = { pool: 'turn', amount, timing: line.timing as TurnTiming };
      if (line.category) turn.category = line.category as TurnCategory;
      if (line.actionPool) turn.actionPool = line.actionPool as string;
      entries.push(turn);
      return;
    }
    if (ACTION_ECONOMY_POOLS.includes(pool)) {
      entries.push({ pool: 'turn', amount, timing: pool as TurnTiming });
      return;
    }
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
  if (errors.length) return { entries: null, errors };
  if (options.stored) {
    const firstTurn = entries.findIndex((entry) => entry.pool === 'turn');
    return { entries: entries.filter((entry, index) => entry.pool !== 'turn' || index === firstTurn), errors };
  }
  return { entries, errors };
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

// A casting time that starts '1 action' / '1 bonus action' / '1 reaction' (so '1 reaction, which you
// take when...' counts) becomes a spell turn line. Anything else ('1 minute', 'Special') gives none.
export function castingTimeActionLine(text: string | null | undefined): TurnLine | null {
  const match = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').match(/^1 (action|bonus action|reaction)\b/);
  if (!match) return null;
  return { pool: 'turn', amount: 1, timing: match[1].replace(' ', '_') as TurnTiming, category: 'spell' };
}

export type DefaultCostInput = {
  contentType: string;
  spellLevel?: number | null;
  castingTime?: string | null;
  hasSpendItemStep?: boolean;
  isItemUse?: boolean;
  // The new activation kinds. weapon_attack takes weaponTiming (default action); dash takes dashCount.
  activationKind?: 'weapon_attack' | 'dash';
  dashCount?: number;
  weaponTiming?: 'action' | 'bonus_action' | 'reaction';
  // Item use takes a general action only once turn costs are charged (action economy Unit 3 sets
  // this); until then the default stays the item quantity alone, so chips are unchanged.
  includeUseAction?: boolean;
};

// The cost a Container has while cost_json is NULL. Mirrors the procedural behaviour from before
// the cost engine, so nothing changes until a DM sets an explicit cost.
export function defaultCostFor(input: DefaultCostInput): CostEntry[] {
  if (input.activationKind === 'weapon_attack') {
    return [{ pool: 'turn', amount: 1, timing: input.weaponTiming ?? 'action', category: 'attack' }];
  }
  if (input.activationKind === 'dash') {
    // A general action: 1 Action in 5e, 1 Utility in homebrew, with no special casing.
    return [{ pool: 'turn', amount: Math.max(1, input.dashCount ?? 1), timing: 'action', category: 'general' }];
  }
  if (input.contentType === 'spell') {
    const entries: CostEntry[] = [];
    const level = input.spellLevel ?? 0;
    if (level >= 1) entries.push({ pool: 'spell_slot', amount: 1, level: Math.min(9, level) });
    const action = castingTimeActionLine(input.castingTime);
    if (action) entries.push(action);
    return entries;
  }
  if (input.contentType === 'item' && input.isItemUse) {
    // An on_use spend_item step already pays the quantity, as it always has. Using an object
    // still takes an action (5e "Use an Object").
    const use: TurnLine = { pool: 'turn', amount: 1, timing: 'action', category: 'general' };
    const base: CostEntry[] = input.hasSpendItemStep ? [] : [{ pool: 'item', amount: 1 }];
    return input.includeUseAction ? [...base, use] : base;
  }
  return [];
}

// An explicit list beats the default for resource lines (an empty one means "no resources"), but
// turn lines are inherited separately: an explicit list WITHOUT a turn line keeps its own lines and
// takes the default's turn line. An explicit turn line (timing 'free' for no action) wins.
export function effectiveCost(explicit: CostEntry[] | null | undefined, defaults: CostEntry[]): CostEntry[] {
  if (!explicit) return defaults;
  if (explicit.some((entry) => asTurnLine(entry))) return explicit;
  const inherited = defaults.filter((entry) => asTurnLine(entry));
  return inherited.length ? [...explicit, ...inherited] : explicit;
}

// True for lines that are only shown, never paid from a pool until the turn state is loaded:
// turn lines and the legacy action lines. The cast dialog uses it to decide what needs a prompt.
export function isDisplayOnlyCost(entry: { pool: string }): boolean {
  return entry.pool === 'turn' || ACTION_ECONOMY_POOLS.includes(entry.pool);
}

// Fills in a missing category on turn lines (normalised legacy lines) from the container.
export function withCategory(entries: CostEntry[], fallback: TurnCategory): CostEntry[] {
  return entries.map((entry) => {
    const turn = asTurnLine(entry);
    return turn ? { ...turn, category: turn.category ?? fallback } : entry;
  });
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
// Authoring validation
// ---------------------------------------------------------------------------------------------

// Checks a parsed cost against the world it will be saved into: every character pool key must be an
// active definition, a charges line must name one of THIS entry's counters (or be unambiguous),
// and item quantity only makes sense on an item. Returns human messages; empty means fine.
export function validateCostEntries(
  entries: CostEntry[],
  ctx: { contentType: string; poolKeys: string[]; counterKeys: string[] }
): string[] {
  const errors: string[] = [];
  if (entries.filter((entry) => asTurnLine(entry)).length > 1) {
    errors.push('A cost can have only one action economy line. For two actions, set its amount to 2.');
  }
  for (const entry of entries) {
    if (asTurnLine(entry) || entry.pool === 'spell_slot') continue; // turn lines are valid once parsed
    if (entry.pool === 'item') {
      if (ctx.contentType !== 'item') errors.push('Item quantity can only be a cost on an item.');
      continue;
    }
    if (entry.pool === 'charges') {
      const key = (entry as { key?: string }).key;
      if (key && !ctx.counterKeys.includes(key)) errors.push(`This entry has no counter "${key}". Add it under Resources first.`);
      else if (!key && ctx.counterKeys.length === 0) errors.push('A counter cost needs a counter. Add one under Resources first.');
      else if (!key && ctx.counterKeys.length > 1) errors.push('This entry has several counters, so choose which one the cost uses.');
      continue;
    }
    if (!ctx.poolKeys.includes(entry.pool)) errors.push(`"${entry.pool}" isn't an active resource pool.`);
  }
  return errors;
}

// True when an item would pay its quantity twice: an explicit item line AND an on_use spend_item step.
// The engine drops the item line (the step keeps paying), so this is only a heads-up for authors.
export function itemCostConflictsWithStep(entries: CostEntry[] | null, hasSpendItemStep: boolean): boolean {
  return hasSpendItemStep && Boolean(entries?.some((entry) => entry.pool === 'item'));
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
    const grants = sumTargetGrants(modifierSources, `resource.${definition.key}.max`, ctx.modifierContext ?? {});
    const lines = [{ label: 'Base', value: base }, ...grants];
    const total = lines.reduce((sum, line) => sum + line.value, 0);
    result[definition.key] = { max: Math.max(0, total), lines };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

const TIMING_LABELS: Record<TurnTiming, string> = { action: 'Action', bonus_action: 'Bonus action', reaction: 'Reaction', movement: 'Movement', free: 'Free' };

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

// A spell or cantrip follow-up ("echo") is completely free: no action, no slot, no other
// resources, so the plan has just the follow-up line. It always resolves at the spell's base level
// (the lowest spell_slot line), whatever level the original was cast at. Needs a waiting follow-up
// and a turn line that actually draws from a pool; otherwise the spell is planned normally.
function planSpellEcho(entries: CostEntry[], availability: CostAvailability, choices: CostChoices): PlannedCost | null {
  const cls = choices.followupClass;
  const turn = availability.turn;
  if ((cls !== 'spell' && cls !== 'cantrip') || !turn) return null;
  const entry = entries.find((e) => asTurnLine(e));
  const line = entry && asTurnLine(entry);
  if (!entry || !line || resolveTurnPool(profileFor(turn.profile), line) === null) return null;
  const waiting = turn.followups[cls] ?? 0;
  if (waiting < line.amount) return null;
  const levels = entries.flatMap((e) => (e.pool === 'spell_slot' ? [(e as { level: number }).level] : []));
  return {
    lines: [{ entry, label: 'Extra Attack', needed: line.amount, available: waiting, payFrom: { pool: 'followup', cls }, displayOnly: false }],
    shortfalls: [],
    ...(levels.length ? { castAtLevel: Math.min(...levels) } : {})
  };
}

// Works out what each cost line would draw from, and what's short. Pure: it never mutates the
// availability. Two lines drawing on the same source are checked against the running total.
export function planCost(entries: CostEntry[], availability: CostAvailability, choices: CostChoices = {}): PlannedCost {
  const echo = planSpellEcho(entries, availability, choices);
  if (echo) return echo;
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
    const turnLine = asTurnLine(entry);
    if (turnLine) {
      const turn = availability.turn;
      if (!turn) {
        // No turn state loaded (chips, old previews): shown, never tracked, never short.
        lines.push({ entry, label: TIMING_LABELS[turnLine.timing], needed, available: needed, displayOnly: true });
        continue;
      }
      const profile = profileFor(turn.profile);
      const key = resolveTurnPool(profile, turnLine);
      if (key === null) {
        lines.push({ entry, label: 'Free', needed, available: needed, displayOnly: true });
        continue;
      }
      // Extra Attack and friends: a waiting follow-up covers the whole turn line, and only that.
      const waiting = choices.followupClass ? turn.followups[choices.followupClass] ?? 0 : 0;
      if (choices.followupClass && waiting >= needed) {
        lines.push({ entry, label: 'Extra Attack', needed, available: waiting, payFrom: { pool: 'followup', cls: choices.followupClass }, displayOnly: false });
        continue;
      }
      const row = Object.hasOwn(turn.pools, key) ? turn.pools[key] : undefined;
      const label = row?.label || profile.pools.find((p) => p.key === key)?.label || key;
      settle({ entry, label, needed, available: 0, payFrom: { pool: 'turn', key }, displayOnly: false }, `turn:${key}`, row?.current ?? 0);
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

const TIMING_WORDS: Record<'action' | 'bonus_action' | 'reaction', [string, string]> = {
  action: ['action', 'actions'], bonus_action: ['bonus action', 'bonus actions'], reaction: ['reaction', 'reactions']
};

// "L2 slot + 1 Vowfire + 1 Action". `labels` maps a character pool key to its label. With a profile
// a turn line reads in its pool's words ("1 Attack action"); without one it reads neutrally
// ("1 action", as before). Free and movement lines cost nothing, so they add no part.
export function costSummary(entries: CostEntry[], labels: Record<string, string> = {}, profileKey?: string | null): string {
  const parts = entries
    .map((entry) => {
      const n = entry.amount;
      const turn = asTurnLine(entry);
      if (turn) {
        if (turn.timing === 'free' || turn.timing === 'movement') return null;
        if (profileKey) {
          const profile = profileFor(profileKey);
          const key = resolveTurnPool(profile, turn);
          return key === null ? null : turnCostLabel(profile, key, n);
        }
        const [one, many] = TIMING_WORDS[turn.timing];
        return `${n} ${n === 1 ? one : many}`;
      }
      if (entry.pool === 'spell_slot') {
        const level = (entry as { level: number }).level;
        return n === 1 ? `L${level} slot` : `${n} x L${level} slots`;
      }
      if (entry.pool === 'charges') return `${n} ${n === 1 ? 'charge' : 'charges'}`;
      if (entry.pool === 'item') return n === 1 ? '1 item' : `${n} items`;
      return `${n} ${labels[entry.pool] ?? entry.pool}`;
    })
    .filter((part): part is string => part !== null);
  return parts.length ? parts.join(' + ') : 'Free';
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
  if (activation.kind === 'weapon_attack') {
    // An id names the weapon; without one (Unarmed Strike, a GM-added action) the label does.
    return `weapon_attack|${activation.inventoryId ?? 'none'}|${activation.inventoryId ? '' : activation.label ?? ''}|${activation.timing ?? 'action'}`;
  }
  if (activation.kind === 'dash') return `dash|${activation.count}`;
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

// ---------------------------------------------------------------------------------------------
// Ledger views and override review (Unit 7)
// ---------------------------------------------------------------------------------------------

export type LedgerBadgeInput = { overrideKind: string | null; reviewOutcome: 'ok' | 'undone' | null; reason?: string };

// The badge the Activity Log shows beside an override's rows. Null for a normal spend.
export function ledgerBadge(row: LedgerBadgeInput): string | null {
  if (row.reason === 'refund') return 'Refund';
  if (row.overrideKind === 'dm_approved') return 'DM approved';
  if (row.overrideKind === 'dm_self') return "DM's call";
  if (row.overrideKind === 'self_override') {
    if (row.reviewOutcome === 'undone') return 'Undone by DM';
    if (row.reviewOutcome === 'ok') return "Player said DM OK'd it - DM marked OK";
    return "Player said DM OK'd - not yet reviewed";
  }
  return null;
}

// What an undo did, as one note for the DM. `refunded` are "1 Level 2 Spell Slot" style phrases and
// `problems` explain lines that couldn't be fully refunded (removed item, pool already full).
export function undoMessage(refunded: string[], problems: string[]): string {
  const head = refunded.length ? `Refunded ${refunded.join(', ')}.` : 'Nothing needed refunding.';
  return [head, ...problems.map((p) => (p.endsWith('.') ? p : `${p}.`)), 'Anything it did (damage, conditions) needs fixing by hand.'].join(' ');
}

export function undoLogMessage(characterName: string, label: string, refunded: string[]): string {
  return `The DM undid ${characterName}'s over-budget ${label} - ${refunded.length ? `refunded ${refunded.join(', ')}` : 'nothing to refund'}.`;
}

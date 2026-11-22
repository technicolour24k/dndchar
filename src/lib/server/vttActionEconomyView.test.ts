import { describe, expect, it } from 'vitest';
import { ATTACK_TIMINGS, attackCostText, attackFollowup, attackPoolKey, paidText, poolCostText } from '../../../static/vtt-app/shared/actionEconomy.js';
import { formForActivation } from '../../../static/vtt-app/shared/costApproval.js';
import { activationFromCastForm, parseActivation } from './vttCostApproval';

const homebrew = { profileKey: 'attack_utility', pools: [{ key: 'attack', label: 'Attack', current: 1, max: 2 }, { key: 'utility', label: 'Utility', current: 2, max: 2 }], followups: [] as any[] };
const fiveE = { profileKey: 'dnd5e', pools: [{ key: 'action', label: 'Action', current: 1, max: 1 }, { key: 'bonus_action', label: 'Bonus action', current: 0, max: 1 }, { key: 'reaction', label: 'Reaction', current: 1, max: 1 }], followups: [] as any[] };
const withExtra = (view: any, remaining = 1) => ({ ...view, followups: [{ cls: 'melee', label: 'Extra Attack', remaining }] });

describe('attack cost wording', () => {
  it('names the pool by profile: 5e by timing, homebrew always Attack', () => {
    expect(attackPoolKey(fiveE, 'bonus_action')).toBe('bonus_action');
    expect(attackPoolKey(homebrew, 'reaction')).toBe('attack');
    expect(attackPoolKey(null, 'action')).toBeNull();
    expect(ATTACK_TIMINGS.map((t) => t.value)).toEqual(['action', 'bonus_action', 'reaction']);
  });
  it('words costs like the server: "1 Action" in 5e, "1 Attack action" in homebrew', () => {
    expect(poolCostText(fiveE, 'action')).toBe('1 Action');
    expect(poolCostText(fiveE, 'bonus_action', 2)).toBe('2 Bonus actions');
    expect(poolCostText(homebrew, 'attack')).toBe('1 Attack action');
    expect(poolCostText(homebrew, 'utility', 2)).toBe('2 Utility actions');
  });
  it('shows the pool cost and what is left when no follow-up waits', () => {
    expect(attackCostText(homebrew, 'action', 'use')).toBe('1 Attack action (1 left)');
    expect(attackCostText(fiveE, 'reaction', 'use')).toBe('1 Reaction (1 left)');
    expect(attackCostText(null, 'action', 'use')).toBe('');
  });
  it('offers Extra Attack only for an Action-timed attack while follow-ups wait, and words the choice', () => {
    const view = withExtra(homebrew, 2);
    expect(attackFollowup(view, 'action')).toEqual({ label: 'Extra Attack', remaining: 2 });
    expect(attackFollowup(view, 'bonus_action')).toBeNull();
    expect(attackFollowup(view, 'reaction')).toBeNull();
    expect(attackFollowup(withExtra(homebrew, 0), 'action')).toBeNull();
    expect(attackFollowup({ ...homebrew, followups: [{ cls: 'spell', label: 'Echo', remaining: 1 }] }, 'action')).toBeNull();
    expect(attackCostText(view, 'action', 'use')).toBe('Free - Extra Attack (2 left)');
    expect(attackCostText(view, 'action', 'skip')).toBe('1 Attack action (1 left)');
    expect(attackCostText(view, 'bonus_action', 'use')).toBe('1 Attack action (1 left)');
  });
  it('takes the label from the granting feature', () => {
    expect(attackCostText({ ...homebrew, followups: [{ cls: 'melee', label: 'Flurry of Blows', remaining: 1 }] }, 'action', 'use')).toBe('Free - Flurry of Blows (1 left)');
  });
  it('words what was paid on the finished roll', () => {
    expect(paidText(null)).toBe('');
    expect(paidText({ paid: [{ label: 'Attack', delta: -1 }] })).toBe('Paid: 1 Attack');
    expect(paidText({ usedFollowup: true, followupsLeft: [{ cls: 'melee', remaining: 0 }] })).toBe('Extra Attack (0 left)');
    expect(paidText({ paid: [] })).toBe('');
  });
});

describe('re-running an approved attack or echo from the sheet banner', () => {
  const WEAPON = '22222222-2222-4222-8222-222222222222';
  it('a weapon attack with an id becomes the payTurn form, which parses back to the same activation', () => {
    const activation = { kind: 'weapon_attack', inventoryId: WEAPON, timing: 'reaction', followup: 'skip' } as const;
    const built = formForActivation(activation)!;
    expect(built.action).toBe('payTurn');
    const fields = Object.fromEntries(built.entries);
    expect(parseActivation({ kind: fields.kind, inventoryId: fields.inventoryId, timing: fields.timing, followup: fields.followup })).toEqual(activation);
  });
  it('an id-less attack and a dash have no sheet form', () => {
    expect(formForActivation({ kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike' })).toBeNull();
    expect(formForActivation({ kind: 'dash', count: 1 })).toBeNull();
  });
  it('a spell echo choice survives the round trip', () => {
    const activation = { kind: 'spell', instanceId: WEAPON, slotType: 'standard', slotLevel: 3, followup: 'use' } as const;
    const built = formForActivation(activation)!;
    const form = new FormData();
    for (const [key, value] of built.entries) form.set(key, value);
    expect(activationFromCastForm(form)).toEqual(activation);
  });
});

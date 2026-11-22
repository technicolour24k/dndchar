import { describe, expect, it } from 'vitest';
import { ATTACK_TIMINGS, attackCostText, attackFollowup, attackPoolKey, dashNeeded, dashPoolKey, dashPromptText, paidText, poolCostText, resetAllNote, trimTurnView, turnChips } from '../../../static/vtt-app/shared/actionEconomy.js';
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

describe('dash and token turn display (Unit 5)', () => {
  it('dashNeeded: one dash per speed beyond what is left', () => {
    expect(dashNeeded(25, 10, 30)).toEqual({ over: 15, count: 1 });
    expect(dashNeeded(55, 10, 30)).toEqual({ over: 45, count: 2 });
    expect(dashNeeded(40, 40, 30)).toEqual({ over: 0, count: 0 }); // exactly within movement is free
    expect(dashNeeded(10, 30, 30)).toEqual({ over: 0, count: 0 });
    expect(dashNeeded(60, 30, 30)).toEqual({ over: 30, count: 1 });
    expect(dashNeeded(60, 30, 0)).toEqual({ over: 30, count: 0 }); // speed 0: no dash on offer
    expect(dashNeeded(35, 0, 30)).toEqual({ over: 35, count: 2 });
  });
  it('a dash draws from the general pool of the profile, worded by its labels', () => {
    expect(dashPoolKey(homebrew)).toBe('utility');
    expect(dashPoolKey(fiveE)).toBe('action');
    expect(dashPromptText(homebrew, 1, 15, 30)).toBe('That move is 15 ft past your movement. Dash? Costs 1 Utility action (you have 2). Adds 30 ft of movement.');
    expect(dashPromptText(fiveE, 2, null, 30)).toBe('Dash? Costs 2 Actions (you have 1). Adds 60 ft of movement.');
  });
  it('trims a full view to the small copy tokens carry, and refuses junk', () => {
    const full = { ...withExtra(homebrew), profileLabel: 'x', turnSeq: 3, log: [{}], pools: homebrew.pools.map((p) => ({ ...p, spent: 1, breakdown: [] })) };
    expect(trimTurnView(full)).toEqual({
      profileKey: 'attack_utility', turnSeq: 3,
      pools: [{ key: 'attack', label: 'Attack', current: 1, max: 2 }, { key: 'utility', label: 'Utility', current: 2, max: 2 }],
      followups: [{ cls: 'melee', label: 'Extra Attack', remaining: 1 }]
    });
    expect(trimTurnView(null)).toBeNull();
    expect(trimTurnView({ profileKey: 5, pools: [] })).toBeNull();
    expect(trimTurnView({ profileKey: 'dnd5e', pools: [{ key: 'a', label: 'A', current: 500, max: -2 }] })!.pools[0]).toEqual({ key: 'a', label: 'A', current: 99, max: 0 });
  });
  it('chips use the profile labels and only show follow-ups that are waiting', () => {
    expect(turnChips(withExtra(homebrew))).toEqual(['Attack 1/2', 'Utility 2/2', 'Extra Attack: 1 left']);
    expect(turnChips(withExtra(fiveE, 0))).toEqual(['Action 1/1', 'Bonus action 0/1', 'Reaction 1/1']);
    expect(turnChips(null)).toEqual([]);
  });
  it('the Reset all note only appears when some characters were skipped', () => {
    expect(resetAllNote({ reset: 3, skipped: 1 })).toBe('Actions reset for 3 characters (1 skipped)');
    expect(resetAllNote({ reset: 1, skipped: 2 })).toBe('Actions reset for 1 character (2 skipped)');
    expect(resetAllNote({ reset: 3, skipped: 0 })).toBe('');
  });
});

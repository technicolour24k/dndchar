import { describe, expect, it } from 'vitest';
import { collectAdvantageSources } from './attackRoll';

// The player's DM-mode popup previews with the generic candidate 'ability_check.any' (no skill is
// known yet). This pins down what that does and doesn't catch.
const effect = (target: string, modifierType: 'advantage' | 'disadvantage' = 'advantage') => ({
  id: `e-${target}`, name: `Test ${target}`,
  modifiers: [{ target, modifierType, label: '', conditionExpression: '' }]
}) as any;

describe('generic ability-check preview candidate', () => {
  const candidates = ['ability_check.any'];

  it('picks up an advantage on all ability checks', () => {
    expect(collectAdvantageSources([effect('ability_check.all')], candidates, {}, 'attacker')).toHaveLength(1);
  });

  it('does not pick up one tied to a single ability or skill', () => {
    expect(collectAdvantageSources([effect('ability_check.str')], candidates, {}, 'attacker')).toHaveLength(0);
    expect(collectAdvantageSources([effect('ability_check.perception')], candidates, {}, 'attacker')).toHaveLength(0);
  });
});

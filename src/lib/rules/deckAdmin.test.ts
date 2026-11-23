import { describe, expect, it } from 'vitest';
import { parseDeckRules } from './decks';
import { MYSTICAL_FATE_RULES } from './decks.fixture';
import { collectConditionKeys, stepText, summariseDeck } from './deckAdmin';

const rules = parseDeckRules(MYSTICAL_FATE_RULES).rules!;

describe('deckAdmin', () => {
  it('collects every condition key, including the inverse swap', () => {
    expect(collectConditionKeys(rules)).toEqual([
      'condition:deck_fate_ac', 'condition:deck_fate_adv_next', 'condition:deck_fate_dis_next', 'condition:deck_fate_hit'
    ]);
    expect(collectConditionKeys({ outcomes: [] })).toEqual([]);
  });
  it('summarises the seeded deck', () => {
    const summary = summariseDeck(rules);
    expect(summary.cardCount).toBe(108);
    expect(summary.byBack.map((entry) => entry.back).sort()).toEqual(['black', 'gold']);
    expect(summary.success).toEqual(['back: gold, colour: red = success', 'back: black, colour: silver = success', 'anything else = failure']);
    expect(summary.outcomes.length).toBe(rules.outcomes.length);
    expect(summary.outcomes[0].steps[0]).toMatch(/^DM prompt/);
  });
  it('words steps', () => {
    expect(stepText({ type: 'currency', coin: 'gp', amount: '10 + {party_roll}', target: 'each_party_member' })).toBe('gp 10 + {party_roll} to each party member');
    expect(stepText({ type: 'condition', conditionKey: 'condition:x', params: { value: '2' }, durationRounds: 10, target: 'drawer' })).toBe('condition:x (value=2, 10 rounds) on the drawer');
  });
});

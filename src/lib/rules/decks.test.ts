import { describe, expect, it } from 'vitest';
import {
  applyCoin, applyHp, applyTempHp, cardSuccess, cardValue, drawSummary, evaluateAmount, findOutcome, matchesTags,
  needsValueChoice, parseDeckRules, planDraw
} from './decks';
import { MYSTICAL_FATE_RULES } from './decks.fixture';
import type { DeckCard, ExpandedDeckRules } from '$lib/types/decks';

const parsed = parseDeckRules(MYSTICAL_FATE_RULES);
const rules = parsed.rules as ExpandedDeckRules;
const card = (id: string): DeckCard => {
  const found = rules.cards.find((c) => c.id === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};

// Party ids sort a < b < c < d.
const PARTY = ['a', 'b', 'c'];
const names = { a: 'Aria', b: 'Brom', c: 'Cass', d: 'Dax' };

/** A die that returns the given values in order. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++];
};

function draw(id: string, opts: { drawer?: string; party?: string[]; chosen?: number | null; rollDie?: (s: number) => number } = {}) {
  const c = card(id);
  const success = cardSuccess(rules, c);
  return planDraw({
    rules, card: c, success, chosenValue: opts.chosen, drawerId: opts.drawer ?? 'a',
    partyIds: opts.party ?? PARTY, rollDie: opts.rollDie ?? (() => 1)
  });
}

describe('the seed fixture', () => {
  it('parses with 108 cards, no errors, and every card finds an outcome', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(rules.cards).toHaveLength(108);
    for (const c of rules.cards) expect(findOutcome(rules, c), c.id).not.toBeNull();
  });

  it('uses deterministic ids', () => {
    expect(card('gold:clubs:3').label).toBe('3 of Clubs');
    expect(card('gold:diamonds:J').tags).toMatchObject({ back: 'gold', suit: 'diamonds', colour: 'red', kind: 'royal', rank: 'j' });
    expect(card('black:joker_silver').tags).toMatchObject({ back: 'black', kind: 'joker', colour: 'silver' });
  });
});

describe('matchesTags', () => {
  it('is case-insensitive, needs every tag, and {} matches all', () => {
    expect(matchesTags({ Back: 'GOLD' }, { back: 'gold', suit: 'hearts' })).toBe(true);
    expect(matchesTags({ back: 'gold', suit: 'clubs' }, { back: 'gold', suit: 'hearts' })).toBe(false);
    expect(matchesTags({}, { back: 'gold' })).toBe(true);
  });
});

describe('cardSuccess', () => {
  it('covers the four back/colour combinations', () => {
    expect(cardSuccess(rules, card('gold:hearts:5'))).toBe(true);     // red on gold
    expect(cardSuccess(rules, card('gold:spades:5'))).toBe(false);    // black on gold
    expect(cardSuccess(rules, card('black:clubs:5'))).toBe(true);     // silver on black
    expect(cardSuccess(rules, card('black:diamonds:5'))).toBe(false); // red on black
  });

  it('applies the colour rule to jokers', () => {
    expect(cardSuccess(rules, card('gold:joker_red'))).toBe(true);
    expect(cardSuccess(rules, card('black:joker_red'))).toBe(false);
    expect(cardSuccess(rules, card('gold:joker_black'))).toBe(false);
    expect(cardSuccess(rules, card('black:joker_silver'))).toBe(true);
  });

  it('takes the first matching rule', () => {
    const when = (tags: Record<string, string>) => tags;
    const custom = { success: { rules: [{ when: when({ suit: 'hearts' }), result: 'failure' as const }, { when: when({}), result: 'success' as const }], otherwise: 'failure' as const } };
    expect(cardSuccess(custom, { tags: { suit: 'hearts' } })).toBe(false);
    expect(cardSuccess(custom, { tags: { suit: 'spades' } })).toBe(true);
  });
});

describe('Ace value choice', () => {
  it('needs a choice of 1 or 11, and throws otherwise', () => {
    const ace = card('gold:hearts:A');
    expect(needsValueChoice(ace)).toBe(true);
    expect(cardValue(ace, 1)).toBe(1);
    expect(cardValue(ace, 11)).toBe(11);
    expect(() => cardValue(ace, 5)).toThrow();
    expect(() => cardValue(ace, null)).toThrow();
    expect(() => draw('gold:hearts:A')).toThrow();
  });

  it('ignores a choice on a plain card', () => {
    expect(needsValueChoice(card('gold:hearts:7'))).toBe(false);
    expect(cardValue(card('gold:hearts:7'), 99)).toBe(7);
    expect(cardValue(card('gold:hearts:K'))).toBe(13);
  });

  it('feeds the chosen value into the outcome', () => {
    const one = draw('gold:diamonds:A', { chosen: 1 });
    const eleven = draw('gold:diamonds:A', { chosen: 11 });
    expect(one.lines.map((l) => l.amount)).toEqual([1, 1, 1]);
    expect(eleven.lines.map((l) => l.amount)).toEqual([11, 11, 11]);
  });
});

describe('evaluateAmount', () => {
  it('rolls dice with a breakdown and substitutes placeholders', () => {
    expect(evaluateAmount('2d10+5', {}, seq(7, 3))).toEqual({ total: 15, text: '2d10[7,3] + 5 = 15' });
    expect(evaluateAmount('10 + {party_roll}', { party_roll: 13 })).toEqual({ total: 23, text: '10 + 13 = 23' });
    expect(evaluateAmount('{value}', { value: 4 })).toEqual({ total: 4, text: '4' });
  });

  it('floors at 0 unless told not to', () => {
    expect(evaluateAmount('2-5', {}).total).toBe(0);
    expect(evaluateAmount('2-5', {}, undefined, { floor: false }).total).toBe(-3);
  });

  it('throws on bad expressions and unknown placeholders', () => {
    expect(() => evaluateAmount('2*3', {})).toThrow();
    expect(() => evaluateAmount('{nope}', {})).toThrow();
  });
});

describe('planDraw: success and inversion of each step type', () => {
  it('4 of diamonds success = 4 gold each', () => {
    const plan = draw('gold:diamonds:4');
    expect(plan.lines).toHaveLength(3);
    expect(plan.lines.every((l) => l.kind === 'coin' && l.coin === 'gp' && l.amount === 4)).toBe(true);
    expect(plan.lines.map((l) => l.characterId)).toEqual(['a', 'b', 'c']);
  });

  it('4 of diamonds failure = 4 gold lost each', () => {
    const plan = draw('black:diamonds:4');
    expect(plan.lines.map((l) => l.amount)).toEqual([-4, -4, -4]);
    expect(plan.lines[0].sourceLabel).toBe('4 of Diamonds, failed');
  });

  it('3 of clubs failure = drawer -3 AC for 10 rounds, only the drawer', () => {
    const plan = draw('gold:clubs:3', { drawer: 'b' });
    expect(plan.lines).toEqual([{
      characterId: 'b', kind: 'condition', amount: 0, conditionKey: 'condition:deck_fate_ac',
      params: { value: -3 }, durationRounds: 10, sourceLabel: '3 of Clubs, failed'
    }]);
  });

  it('3 of clubs success (silver on black) = +3 AC', () => {
    const plan = draw('black:clubs:3');
    expect(plan.lines[0].params).toEqual({ value: 3 });
  });

  it('hearts: temp HP gain, and loss on failure', () => {
    expect(draw('gold:hearts:7').lines.map((l) => [l.kind, l.amount])).toEqual([['temp_hp', 7], ['temp_hp', 7], ['temp_hp', 7]]);
    expect(draw('black:hearts:9').lines.map((l) => [l.kind, l.amount])).toEqual([['temp_hp', -9], ['temp_hp', -9], ['temp_hp', -9]]); // red on black fails
  });

  it('heal inverts to damage (Gift of Vitality, 1d10+5)', () => {
    const win = draw('gold:hearts:J', { rollDie: seq(4, 6, 10) });
    expect(win.lines.map((l) => [l.kind, l.amount])).toEqual([['hp', 9], ['hp', 11], ['hp', 15]]);
    const lose = draw('black:hearts:J', { rollDie: seq(4, 6, 10) });
    expect(lose.lines.map((l) => [l.kind, l.amount])).toEqual([['hp', -9], ['hp', -11], ['hp', -15]]);
  });

  it('every step type inverts (custom deck)', () => {
    const custom = parseDeckRules({
      version: 1,
      cards: [{ id: 'x', label: 'X', tags: { k: 'x' }, value: 5 }],
      success: { rules: [], otherwise: 'success' },
      outcomes: [{
        id: 'o', when: {}, name: 'All', text: 'Good', inverseText: 'Bad', steps: [
          { type: 'currency', coin: 'sp', amount: '{value}', target: 'drawer' },
          { type: 'heal', amount: '3', target: 'drawer' },
          { type: 'damage', amount: '2', target: 'drawer' },
          { type: 'temp_hp', amount: '4', target: 'drawer' },
          { type: 'condition', conditionKey: 'c:one', params: { value: '2' }, target: 'drawer', inverse: { conditionKey: 'c:two' } },
          { type: 'condition', conditionKey: 'c:keep', params: { value: '2' }, target: 'drawer', inverse: { negateParams: false } },
          { type: 'dm_prompt', text: 'Do it', inverseText: 'Undo it' },
          { type: 'dm_prompt', text: 'Plain' }
        ]
      }]
    }).rules as ExpandedDeckRules;
    const run = (success: boolean) => planDraw({ rules: custom, card: custom.cards[0], success, drawerId: 'a', partyIds: ['a'] });
    const good = run(true);
    expect(good.lines.map((l) => [l.kind, l.amount, l.conditionKey, l.params])).toEqual([
      ['coin', 5, undefined, undefined], ['hp', 3, undefined, undefined], ['hp', -2, undefined, undefined],
      ['temp_hp', 4, undefined, undefined], ['condition', 0, 'c:one', { value: 2 }], ['condition', 0, 'c:keep', { value: 2 }]
    ]);
    expect(good.tasks.map((t) => t.text)).toEqual(['Do it', 'Plain']);
    expect(good.outcome.text).toBe('Good');

    const bad = run(false);
    expect(bad.lines.map((l) => [l.kind, l.amount, l.conditionKey, l.params])).toEqual([
      ['coin', -5, undefined, undefined], ['hp', -3, undefined, undefined], ['hp', 2, undefined, undefined],
      ['temp_hp', -4, undefined, undefined], ['condition', 0, 'c:two', { value: -2 }], ['condition', 0, 'c:keep', { value: 2 }]
    ]);
    expect(bad.tasks.map((t) => t.text)).toEqual(['Undo it', 'Inverted: Plain']);
    expect(bad.outcome.text).toBe('Bad');
  });

  it('King\'s Strike failure swaps advantage for disadvantage and negates the to-hit', () => {
    const plan = draw('gold:spades:K');
    expect(plan.lines.filter((l) => l.characterId === 'a').map((l) => [l.conditionKey, l.params])).toEqual([
      ['condition:deck_fate_hit', { value: -6 }], ['condition:deck_fate_dis_next', {}]
    ]);
    const win = draw('black:spades:K');
    expect(win.lines.filter((l) => l.characterId === 'a').map((l) => l.conditionKey)).toEqual(['condition:deck_fate_hit', 'condition:deck_fate_adv_next']);
  });

  it('a card with no outcome becomes a DM prompt', () => {
    const plan = planDraw({ rules: { outcomes: [] }, card: card('gold:hearts:2'), success: true, drawerId: 'a', partyIds: ['a'] });
    expect(plan.lines).toEqual([]);
    expect(plan.tasks[0].text).toBe('No outcome for 2 of Hearts');
  });
});

describe('Bounty of Fortune (jack of diamonds)', () => {
  it('3 members rolling 4, 7, 2 = 13, each gets 23', () => {
    const plan = draw('gold:diamonds:J', { rollDie: seq(4, 7, 2) });
    expect(plan.outcome.name).toBe('Bounty of Fortune');
    expect(plan.outcome.rolls).toEqual([{ name: 'party_roll', total: 13, text: '4 + 7 + 2 = 13' }]);
    expect(plan.lines.map((l) => l.amount)).toEqual([23, 23, 23]);
    expect(plan.lines[0].detail).toBe('10 + 13 = 23');
  });

  it('4 members totalling 21 each get 31', () => {
    const plan = draw('gold:diamonds:J', { party: ['a', 'b', 'c', 'd'], rollDie: seq(5, 6, 4, 6) });
    expect(plan.outcome.rolls[0].total).toBe(21);
    expect(plan.lines.map((l) => l.amount)).toEqual([31, 31, 31, 31]);
  });

  it('failure takes the same amount away from everyone', () => {
    const plan = draw('black:diamonds:J', { rollDie: seq(4, 7, 2) });
    expect(plan.lines.map((l) => l.amount)).toEqual([-23, -23, -23]);
  });

  it('includes the drawer even when they are not in the party list', () => {
    const plan = draw('gold:diamonds:J', { drawer: 'z', party: ['a', 'b'], rollDie: seq(1, 1, 1) });
    expect(plan.lines.map((l) => l.characterId)).toEqual(['a', 'b', 'z']);
  });
});

describe('party_split (Queen of Diamonds)', () => {
  // 10 + 2d10 with dice 8 and 7 = 25, between 3 members.
  it('gives the remainder to the drawer: 25 between 3 = 9/8/8', () => {
    const plan = draw('gold:diamonds:Q', { drawer: 'a', rollDie: seq(8, 7) });
    expect(plan.lines.map((l) => [l.characterId, l.amount])).toEqual([['a', 9], ['b', 8], ['c', 8]]);
    expect(plan.tasks.map((t) => t.text)).toEqual(['A minor magical item for the party']);
  });

  it('a drawer who is not first still gets the remainder', () => {
    const plan = draw('gold:diamonds:Q', { drawer: 'c', rollDie: seq(8, 7) });
    expect(plan.lines.map((l) => [l.characterId, l.amount])).toEqual([['a', 8], ['b', 8], ['c', 9]]);
  });

  it('failure splits the loss the same way, with the inverse prompt', () => {
    const plan = draw('black:diamonds:Q', { rollDie: seq(8, 7) });
    expect(plan.lines.map((l) => l.amount)).toEqual([-9, -8, -8]);
    expect(plan.tasks.map((t) => t.text)).toEqual(['The party loses a minor magical item']);
  });

  it('drops zero shares', () => {
    const custom = { outcomes: [{ id: 'o', when: {}, name: 'n', text: 't', steps: [{ type: 'currency' as const, coin: 'gp' as const, amount: '2', target: 'party_split' as const }] }] };
    const plan = planDraw({ rules: custom, card: card('gold:hearts:2'), success: true, drawerId: 'b', partyIds: PARTY });
    expect(plan.lines.map((l) => [l.characterId, l.amount])).toEqual([['b', 2]]);
  });
});

describe('jokers', () => {
  const task = (id: string) => draw(id).tasks.map((t) => t.text);
  it('red on gold: high-powered item (success)', () => {
    expect(task('gold:joker_red')).toEqual(['The party gains a high-powered magic item']);
    expect(draw('gold:joker_red').lines).toEqual([]);
  });
  it('red on black: cursed item (failure)', () => expect(task('black:joker_red')).toEqual(['The party finds a cursed item']));
  it('black on gold: powerful enemy (failure)', () => expect(task('gold:joker_black')).toEqual(['The party encounters a powerful enemy']));
  it('black (silver) on black: powerful ally (success)', () => expect(task('black:joker_silver')).toEqual(['The party gains a powerful ally']));
  it('a drawer-targeted prompt only names the drawer', () => {
    const custom = { outcomes: [{ id: 'o', when: {}, name: 'n', text: 't', steps: [{ type: 'dm_prompt' as const, text: 'p', target: 'drawer' as const }] }] };
    expect(planDraw({ rules: custom, card: card('gold:hearts:2'), success: true, drawerId: 'b', partyIds: PARTY }).tasks[0].characterIds).toEqual(['b']);
  });
});

describe('appliers', () => {
  it('applyCoin clamps at 0 and reports the shortfall', () => {
    expect(applyCoin(10, 11)).toEqual({ after: 21, shortfall: 0 });
    expect(applyCoin(8, -3)).toEqual({ after: 5, shortfall: 0 });
    expect(applyCoin(3, -8)).toEqual({ after: 0, shortfall: 5 });
    expect(applyCoin(0, -4)).toEqual({ after: 0, shortfall: 4 });
  });

  it('temp HP stacks, and a loss floors at 0 with a note', () => {
    expect(applyTempHp(4, 7)).toEqual({ temp: 11 });
    expect(applyTempHp(4, -9)).toEqual({ temp: 0, note: 'Only had 4 temp HP (5 short).' });
    expect(applyTempHp(9, -4)).toEqual({ temp: 5 });
  });

  it('healing caps at max HP and never lowers an over-max value', () => {
    expect(applyHp({ hp: 10, max: 20, temp: 3 }, 5)).toEqual({ hp: 15, temp: 3, absorbed: 0 });
    expect(applyHp({ hp: 18, max: 20, temp: 0 }, 9).hp).toBe(20);
    expect(applyHp({ hp: 25, max: 20, temp: 0 }, 4).hp).toBe(25);
  });

  it('damage is absorbed by temp HP first', () => {
    expect(applyHp({ hp: 10, max: 20, temp: 4 }, -3)).toEqual({ hp: 10, temp: 1, absorbed: 3 });
    expect(applyHp({ hp: 10, max: 20, temp: 4 }, -9)).toEqual({ hp: 5, temp: 0, absorbed: 4 });
  });

  it('damage past all HP floors at 0 and notes it', () => {
    // Failed Queen of Hearts on 5 HP + 3 temp: 2d10+5 = 15 damage.
    expect(applyHp({ hp: 5, max: 20, temp: 3 }, -15)).toEqual({ hp: 0, temp: 0, absorbed: 3, note: 'Dropped to 0 HP.' });
    expect(applyHp({ hp: 0, max: 20, temp: 0 }, -2)).toEqual({ hp: 0, temp: 0, absorbed: 0 });
  });
});

describe('drawSummary', () => {
  it('writes the roll-log line for a failed 3 of Clubs', () => {
    const c = card('gold:clubs:3');
    const plan = draw('gold:clubs:3');
    const text = drawSummary({ drawerId: 'a', card: c, success: false, lines: plan.lines, tasks: plan.tasks }, names);
    expect(text).toBe('Aria drew the 3 of Clubs (gold back): failure. Aria loses 3 AC for 1 minute.');
  });

  it('mentions an Ace choice, gold and DM tasks', () => {
    const ace = card('gold:diamonds:A');
    const plan = draw('gold:diamonds:A', { chosen: 11 });
    expect(drawSummary({ drawerId: 'b', card: ace, success: true, chosenValue: 11, lines: plan.lines, tasks: [] }, names))
      .toBe('Brom drew the Ace of Diamonds (gold back), counted as 11: success. Aria gains 11 gp. Brom gains 11 gp. Cass gains 11 gp.');
    const joker = draw('black:joker_silver');
    expect(drawSummary({ drawerId: 'a', card: card('black:joker_silver'), success: true, lines: [], tasks: joker.tasks }, names))
      .toBe('Aria drew the Black (silver) Joker (black back): success. Waiting on the DM: The party gains a powerful ally.');
  });
});

describe('parseDeckRules rejects bad input', () => {
  const base = () => ({
    version: 1,
    cards: [{ id: 'x', label: 'X', tags: { k: 'x' }, value: 1 }],
    success: { rules: [], otherwise: 'success' },
    outcomes: [{ id: 'o', when: {}, name: 'n', text: 't', steps: [{ type: 'currency', coin: 'gp', amount: '1', target: 'drawer' }] }]
  });
  const withStep = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const rules = base();
    rules.outcomes[0] = { ...rules.outcomes[0], ...extra, steps: [step] } as never;
    return parseDeckRules(rules);
  };

  it('accepts the base shape', () => {
    expect(parseDeckRules(base()).errors).toEqual([]);
  });

  it('rejects a bad expression', () => {
    const res = withStep({ type: 'heal', amount: '2*3', target: 'drawer' });
    expect(res.rules).toBeNull();
    expect(res.errors[0]).toContain('outcomes[0].steps[0].amount');
  });

  it('rejects an unknown placeholder, including in condition params', () => {
    expect(withStep({ type: 'heal', amount: '{nope}', target: 'drawer' }).errors[0]).toContain('unknown placeholder {nope}');
    expect(withStep({ type: 'condition', conditionKey: 'c', params: { value: '{nope}' }, target: 'drawer' }).errors[0]).toContain('unknown placeholder');
  });

  it('allows declared roll names and {value}', () => {
    const rolls = [{ name: 'r', dice: '1d6', per: 'once' }];
    expect(withStep({ type: 'heal', amount: '{r}+{value}', target: 'drawer' }, { rolls }).errors).toEqual([]);
    expect(withStep({ type: 'heal', amount: '{r}', target: 'drawer' }).errors).not.toEqual([]);
  });

  it('rejects duplicate card and outcome ids', () => {
    const dupCard = base();
    dupCard.cards.push({ ...dupCard.cards[0] });
    expect(parseDeckRules(dupCard).errors).toEqual(['Duplicate card id "x".']);
    const dupOutcome = base();
    dupOutcome.outcomes.push({ ...dupOutcome.outcomes[0] });
    expect(parseDeckRules(dupOutcome).errors).toEqual(['Duplicate outcome id "o".']);
  });

  it('rejects over-limit sizes', () => {
    const many = base();
    many.cards = Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, label: 'c', tags: { k: 'x' }, value: 1 }));
    expect(parseDeckRules(many).errors[0]).toContain('501 cards');

    const outcomes = base();
    outcomes.outcomes = Array.from({ length: 101 }, (_, i) => ({ ...base().outcomes[0], id: `o${i}` }));
    expect(parseDeckRules(outcomes).errors.join(' ')).toContain('more than 100');

    const steps = base();
    steps.outcomes[0].steps = Array.from({ length: 21 }, () => ({ type: 'currency', coin: 'gp', amount: '1', target: 'drawer' }));
    expect(parseDeckRules(steps).errors.join(' ')).toContain('more than 20');

    const copies = base();
    (copies.cards[0] as Record<string, unknown>).copies = 11;
    expect(parseDeckRules(copies).errors.join(' ')).toContain('copies');

    expect(withStep({ type: 'currency', coin: 'gp', amount: '1000', target: 'drawer' }).errors[0]).toContain('999');
    expect(withStep({ type: 'currency', coin: 'gp', amount: '10d100', target: 'drawer' }).errors[0]).toContain('999');
    expect(withStep({ type: 'condition', conditionKey: 'c', durationRounds: 601, target: 'drawer' }).errors[0]).toContain('durationRounds');
    expect(withStep({ type: 'condition', conditionKey: 'c', durationRounds: 0, target: 'drawer' }).errors[0]).toContain('durationRounds');
    expect(withStep({ type: 'dm_prompt', text: 'x'.repeat(501) }).errors[0]).toContain('over 500');
  });

  it('rejects structural problems', () => {
    expect(parseDeckRules(null).errors).toHaveLength(1);
    expect(parseDeckRules({ ...base(), version: 2 }).errors[0]).toContain('version');
    expect(parseDeckRules({ ...base(), success: undefined }).errors[0]).toContain('success');
    expect(withStep({ type: 'teleport' }).errors[0]).toContain('unknown step type');
    expect(withStep({ type: 'currency', coin: 'zz', amount: '1', target: 'drawer' }).errors[0]).toContain('coin');
  });

  it('warns, without refusing, about cards that match no outcome', () => {
    const rules = base();
    rules.outcomes[0].when = { k: 'other' } as never;
    const res = parseDeckRules(rules);
    expect(res.rules).not.toBeNull();
    expect(res.warnings[0]).toContain('1 card(s) match no outcome (x)');
  });
});

describe('parseDeckRules hardening', () => {
  const outcome = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'o', when: {}, name: 'n', text: 't', ...extra, steps });
  const deck = (outcomes: unknown[], extra: Record<string, unknown> = {}) => ({
    version: 1, cards: [{ id: 'x', label: 'X', tags: { k: 'x' }, value: 1 }],
    success: { rules: [], otherwise: 'success' }, outcomes, ...extra
  });
  const heal = (amount: string, extra: Record<string, unknown> = {}) => parseDeckRules(deck([outcome([{ type: 'heal', amount, target: 'drawer' }], extra)]));

  it('refuses oversized card sets before expanding them', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ suit: `s${i}`, colour: 'red', label: 'S' }));
    const ranks = Array.from({ length: 30 }, (_, i) => ({ rank: `r${i}`, kind: 'number', label: 'R', value: 1 }));
    const res = parseDeckRules(deck([], { cardSets: [{ tags: { back: 'x' }, suits: big, ranks }] }));
    expect(res.rules).toBeNull();
    expect(res.errors).toEqual(['The deck would have 901 cards (limit 500).']);
  });

  it('refuses over-long arrays without iterating them', () => {
    const res = parseDeckRules(deck(Array.from({ length: 101 }, () => ({ bad: true }))));
    expect(res.errors).toEqual(['outcomes: more than 100']);
    expect(parseDeckRules(deck([], { cards: Array.from({ length: 501 }, () => 1) })).errors).toEqual(['The deck would have 501 cards (limit 500).']);
  });

  it('caps the error list', () => {
    const res = parseDeckRules(deck(Array.from({ length: 100 }, (_, i) => ({ bad: i }))));
    expect(res.errors).toHaveLength(51);
    expect(res.errors[50]).toMatch(/^\.\.\. and \d+ more$/);
  });

  it('applies amount limits even with a placeholder', () => {
    expect(heal('{value}+5000').errors[0]).toContain('over 999');
    expect(heal('{value}+50d100').errors[0]).toContain('out of range');
    expect(heal('99999999999999999999').errors[0]).toContain('over 999');
    expect(heal(`1${'+1'.repeat(11)}`).errors[0]).toContain('more than 10 terms');
    expect(heal(`1+${'0'.repeat(120)}`).errors[0]).toContain('longer than 100');
  });

  it('caps card values and options at +-999', () => {
    const withCard = (card: Record<string, unknown>) => parseDeckRules({ ...deck([outcome([])]), cards: [{ id: 'x', label: 'X', tags: {}, ...card }] });
    expect(withCard({ value: 1000 }).errors[0]).toContain('cards[0].value');
    expect(withCard({ value: -1000 }).errors).not.toEqual([]);
    expect(withCard({ value: 1, valueOptions: [1, 5000] }).errors).not.toEqual([]);
    expect(withCard({ value: 999 }).errors).toEqual([]);
  });

  it('clamps evaluated totals and never produces NaN', () => {
    expect(evaluateAmount('{a}+{b}', { a: 999, b: 999 }).total).toBe(999);
    expect(evaluateAmount('{a}', { a: Number.NaN }).total).toBe(0);
    expect(evaluateAmount('{a}', { a: Infinity }).total).toBe(0);
    expect(evaluateAmount('{a}-{b}', { a: -999, b: 999 }, undefined, { floor: false }).total).toBe(-999);
  });

  it('rejects prototype-ish names for tags, rolls and params', () => {
    const proto = JSON.parse('{"__proto__": "x"}');
    expect(parseDeckRules(deck([outcome([])], { cards: [{ id: 'x', label: 'X', tags: proto, value: 1 }] })).errors[0]).toContain('not allowed as a tag name');
    expect(parseDeckRules(deck([outcome([], { when: JSON.parse('{"constructor": "x"}') })])).errors[0]).toContain('not allowed as a tag name');
    expect(parseDeckRules(deck([outcome([])], { success: { rules: [{ when: JSON.parse('{"prototype": "x"}'), result: 'success' }], otherwise: 'failure' } })).errors[0]).toContain('not allowed');
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(heal('1', { rolls: [{ name, dice: '1d6', per: 'once' }] }).errors[0]).toContain('.rolls[0].name');
      const step = { type: 'condition', conditionKey: 'c', params: JSON.parse(`{"${name}": "1"}`), target: 'drawer' };
      expect(parseDeckRules(deck([outcome([step])])).errors[0]).toContain('bad parameter name');
    }
  });

  it('a forbidden-key when never matches everything', () => {
    expect(matchesTags(JSON.parse('{"__proto__": "x"}'), { suit: 'hearts' })).toBe(false);
    expect(matchesTags({ constructor: 'x' }, { constructor: 'x' })).toBe(false);
    // Inherited properties on the card's tags are not matches either.
    expect(matchesTags({ toString: 'x' }, { suit: 'hearts' })).toBe(false);
  });
});

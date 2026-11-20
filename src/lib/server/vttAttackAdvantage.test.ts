import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCharacterEffect } from '$lib/types/character';
import { sessions } from '../../../vtt/server/store.js';

const targetSheet = vi.fn();
const conditionEffects = vi.fn();

vi.mock('$lib/server/services/rule-engine', () => ({ resolveCharacterModifierSources: (id: string) => targetSheet(id) }));
vi.mock('$lib/server/services/vttConditions', () => ({ loadVttConditionEffects: () => conditionEffects() }));

import { gatherVttAdvantageSources, parseAttackOptions } from './vttAttackAdvantage';

function effect(id: string, name: string, containerKey: string, modifiers: Array<{ target: string; type: string; condition?: string }>): ActiveCharacterEffect {
  return {
    id, effectId: id, effectKey: containerKey, containerKey, name, sourceType: 'condition', sourceName: name, description: '',
    durationType: 'while_applicable', requiresConcentration: false, isCondition: true, isSelectable: false, remainingRounds: null,
    modifiers: modifiers.map((entry) => ({
      target: entry.target, modifierType: entry.type, label: '', valueExpression: '', defaultValueExpression: '',
      valueOverrideExpression: '', conditionExpression: entry.condition ?? '', priority: 0
    }))
  };
}

const prone = effect('vtt-condition:prone', 'Prone', 'condition:condition_prone', [
  { target: 'attack_roll.all', type: 'disadvantage' },
  { target: 'attacks_against.all', type: 'advantage', condition: 'within:5' },
  { target: 'attacks_against.all', type: 'disadvantage', condition: 'beyond:5' }
]);
const poisoned = effect('vtt-condition:poisoned', 'Poisoned', 'condition:condition_poisoned', [{ target: 'attack_roll.all', type: 'disadvantage' }]);

const base = {
  attackerCandidates: ['attack_roll.weapon'],
  targetCandidates: ['attacks_against.weapon'],
  context: {},
  choices: { situationalAdvantage: 0, situationalDisadvantage: 0 }
};

function setSession(attackerConditions: string[], targetConditions: string[], targetX = 100, extra: Record<string, unknown> = {}) {
  sessions.set('ROOM', {
    id: 'ROOM',
    map: { gridSizePx: 50 },
    tokens: {
      a: { x: 0, y: 0, conditions: attackerConditions, characterId: 'char-a' },
      t: { x: targetX, y: 0, conditions: targetConditions, ...extra }
    }
  } as any);
}
const vtt = { sessionId: 'ROOM', sourceTokenId: 'a', targetTokenId: 't' };

beforeEach(() => {
  sessions.clear();
  targetSheet.mockReset();
  conditionEffects.mockReset();
  conditionEffects.mockResolvedValue(new Map([['prone', prone], ['poisoned', poisoned]]));
  targetSheet.mockResolvedValue({ sources: [], audit: [] });
});

describe('parseAttackOptions', () => {
  it('keeps in-range values', () => {
    const parsed = parseAttackOptions({ advantage: { situationalAdvantage: 3, situationalDisadvantage: 2 } });
    expect(parsed.situationalAdvantage).toBe(3);
    expect(parsed.situationalDisadvantage).toBe(2);
  });

  it('clamps each counter independently', () => {
    const parsed = parseAttackOptions({ advantage: { situationalAdvantage: 9, situationalDisadvantage: -1 }, manualDamageDice: 12 });
    expect(parsed.situationalAdvantage).toBe(5);
    expect(parsed.situationalDisadvantage).toBe(0);
    expect(parsed.manualDamageDice).toBe(5);
  });

  it('survives bad types and a missing vtt', () => {
    const parsed = parseAttackOptions({ vtt: 'nope', preview: 'yes', advantage: { disabled: [1, 'ok', 'x'.repeat(201)] }, manualDamageDice: 'abc' });
    expect(parsed.vtt).toBeNull();
    expect(parsed.preview).toBe(false);
    expect(parsed.disabledSourceIds).toEqual(['ok']);
    expect(parsed.manualDamageDice).toBe(0);
    expect(parseAttackOptions(null).vtt).toBeNull();
    expect(parseAttackOptions(undefined).situationalAdvantage).toBe(0);
  });

  it('caps disabled ids at 50 and reads a valid vtt block', () => {
    const parsed = parseAttackOptions({ vtt: { sessionId: 'S', sourceTokenId: 'a', targetTokenId: 't' }, advantage: { disabled: Array.from({ length: 80 }, (_, i) => `id${i}`) } });
    expect(parsed.disabledSourceIds).toHaveLength(50);
    expect(parsed.vtt).toEqual({ sessionId: 'S', sourceTokenId: 'a', targetTokenId: 't' });
  });
});

describe('gatherVttAdvantageSources', () => {
  it('gives the situational sources only when there is no session', async () => {
    const result = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [], choices: { situationalAdvantage: 1, situationalDisadvantage: 0 } });
    expect(result.extraSources.map((source) => source.origin)).toEqual(['situational']);
    expect(result.distanceFt).toBeUndefined();
    const noVtt = await gatherVttAdvantageSources({ ...base, vtt: null, attackerSources: [] });
    expect(noVtt.extraSources).toEqual([]);
  });

  it('gives a prone target advantage at 5 ft', async () => {
    setSession([], ['prone'], 50);
    const result = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [] });
    expect(result.distanceFt).toBe(5);
    expect(result.extraSources.map((source) => `${source.origin}:${source.kind}`)).toEqual(['target_condition:advantage']);
  });

  it('gives a prone target disadvantage at 10 ft', async () => {
    setSession([], ['prone'], 100);
    const result = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [] });
    expect(result.distanceFt).toBe(10);
    expect(result.extraSources.map((source) => `${source.origin}:${source.kind}`)).toEqual(['target_condition:disadvantage']);
  });

  it('counts Poisoned once when it is on both the sheet and the token', async () => {
    setSession(['poisoned'], []);
    const sheetPoisoned = effect('sheet-poisoned', 'Poisoned', 'condition:condition_poisoned', [{ target: 'attack_roll.all', type: 'disadvantage' }]);
    const deduped = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [sheetPoisoned] });
    expect(deduped.extraSources).toEqual([]);
    const tokenOnly = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [] });
    expect(tokenOnly.extraSources.map((source) => source.origin)).toEqual(['attacker_condition']);
  });

  it('gives a Dodging target a target-origin disadvantage', async () => {
    setSession([], [], 100, { characterId: 'char-t' });
    targetSheet.mockResolvedValue({
      sources: [effect('dodge-active', 'Dodge', 'condition:dodge', [{ target: 'attacks_against.all', type: 'disadvantage' }])],
      audit: []
    });
    const result = await gatherVttAdvantageSources({ ...base, vtt, attackerSources: [] });
    expect(targetSheet).toHaveBeenCalledWith('char-t');
    expect(result.extraSources.map((source) => `${source.origin}:${source.kind}:${source.label}`)).toEqual(['target:disadvantage:Dodge']);
  });
});

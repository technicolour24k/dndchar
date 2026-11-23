import { beforeEach, describe, expect, it, vi } from 'vitest';

// roll-attack (action economy Unit 4): a real roll pays the weapon attack's action, a preview never
// does, and someone who cannot act for the character rolls unpaid. Dice, rules and database mocked.

const pay = vi.fn();
const gateFn = vi.fn();
const consume = vi.fn();
let access: any = { canAct: true };
const view = { profileKey: 'attack_utility', pools: [{ key: 'attack', label: 'Attack', current: 2, max: 2 }], followups: [{ cls: 'melee', label: 'Extra Attack', remaining: 1 }] };

class FakeShortfall extends Error { shortfalls = [{ label: 'Attack', needed: 1, available: 0 }]; }

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: async (run: any) => run({}) }));
vi.mock('$lib/server/services/effects', () => ({ consumeNextAttackEffects: (...args: unknown[]) => consume(...args) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/access', () => ({ getCharacterAccess: async () => access }));
vi.mock('$lib/server/services/catalogue', () => ({ payTurnActivation: (...args: unknown[]) => pay(...args) }));
vi.mock('$lib/server/services/cost-engine', () => ({ CostShortfallError: FakeShortfall }));
vi.mock('$lib/server/vttCostGate', () => ({
  openCostGate: (...args: unknown[]) => gateFn(...args),
  runWithGate: async (_gate: unknown, run: any) => run(null),
  costShortfallBody: (gate: any, error: any) => ({ error: 'insufficient', shortfalls: error.shortfalls, activation: gate.activation })
}));
vi.mock('$lib/server/services/characters', () => ({
  getCharacterForRoll: async () => ({ classes: [], modifierSources: [], abilities: [], inventory: [], turn: view })
}));
vi.mock('$lib/rules/dnd5e', () => ({ abilityMap: () => ({}), equippedAttackItems: () => [{ id: '22222222-2222-4222-8222-222222222222', name: 'Longsword', attackAbility: 'str', damageRolls: '1d8' }] }));
vi.mock('$lib/rules/characterStats', () => ({ characterStatsFor: () => ({ proficiency: { value: 2 } }) }));
vi.mock('$lib/rules/attackRoll', () => ({
  attackAgainstCandidatesFor: () => [], attackCandidatesFor: () => [], previewAdvantage: () => ({ sources: [] }), rollAttack: () => ({ title: 'Longsword', attack: 'rolled', attackTotal: 15, advantageSources: [] }), appliedEffectRowIds: () => ['row-1']
}));
vi.mock('$lib/server/vttAttackAdvantage', () => ({
  gatherVttAdvantageSources: async () => ({ extraSources: [] }),
  parseAttackOptions: (body: any) => ({ preview: Boolean(body.preview), disabledSourceIds: [], manualDamageDice: 0, vtt: undefined })
}));

const route = await import('../../routes/vtt/api/characters/[id]/roll-attack/+server');
const ID = '11111111-1111-4111-8111-111111111111';
const WEAPON = '22222222-2222-4222-8222-222222222222';
const post = (body: Record<string, unknown>) => route.POST({ locals: { user: { id: 'u1' } }, params: { id: ID }, request: { json: async () => ({ itemName: 'Longsword', ...body }) } } as any);

beforeEach(() => {
  pay.mockReset().mockResolvedValue({ paid: [{ label: 'Extra Attack', pool: 'followup', delta: -1 }], turn: { followups: [{ cls: 'melee', label: 'Extra Attack', remaining: 0 }] }, results: [] });
  gateFn.mockReset().mockImplementation(async (input: any) => ({ ok: true, mode: 'ask_dm', activation: input.activation, override: null }));
  access = { canAct: true };
  consume.mockReset().mockResolvedValue([]);
});

describe('roll-attack and the action economy', () => {
  it('uses up a counted next-attack effect after the paid roll and says so', async () => {
    consume.mockResolvedValue(["King's Strike"]);
    const body = await (await post({})).json();
    expect(consume.mock.calls[0][1]).toBe(ID);
    expect(consume.mock.calls[0][2]).toEqual(['row-1']);
    expect(body).toMatchObject({ consumedEffects: ["King's Strike"], attack: "rolled - Advantage used up: King's Strike" });
  });
  it('a failing consume never turns a paid roll into an error', async () => {
    consume.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attackTotal: 15 });
    spy.mockRestore();
  });
  it('does not consume anything for a preview or an unpaid roll', async () => {
    await post({ preview: true });
    access = { canAct: false };
    await post({});
    expect(consume).not.toHaveBeenCalled();
  });
  it('a preview never pays, and carries the live turn view for the confirm card', async () => {
    const res = await post({ preview: true });
    expect(await res.json()).toMatchObject({ usesAttackRoll: true, turn: view });
    expect(pay).not.toHaveBeenCalled();
    expect(gateFn).not.toHaveBeenCalled();
  });
  it('a real roll pays the weapon attack: Action timing and the Extra Attack follow-up by default', async () => {
    const body = await (await post({})).json();
    expect(gateFn.mock.calls[0][0].activation).toEqual({ kind: 'weapon_attack', inventoryId: WEAPON, timing: 'action', followup: 'use' });
    expect(pay.mock.calls[0][2]).toEqual({ kind: 'weapon_attack', inventoryId: WEAPON, timing: 'action', followup: 'use' });
    expect(body).toMatchObject({ title: 'Longsword', attackTotal: 15, turn: { usedFollowup: true, followupsLeft: [{ cls: 'melee', remaining: 0 }] } });
  });
  it('passes the explicit choices through: bonus-action timing and skipping the follow-up', async () => {
    await post({ timing: 'bonus_action', followup: 'skip' });
    expect(pay.mock.calls[0][2]).toEqual({ kind: 'weapon_attack', inventoryId: WEAPON, timing: 'bonus_action', followup: 'skip' });
    await post({ timing: 'sometime', followup: 'maybe' }); // junk falls back to the defaults
    expect(pay.mock.calls[1][2]).toEqual({ kind: 'weapon_attack', inventoryId: WEAPON, timing: 'action', followup: 'use' });
  });
  it('someone who cannot act for the character rolls unpaid, with turn null', async () => {
    access = { canAct: false };
    const body = await (await post({})).json();
    expect(body).toMatchObject({ attackTotal: 15, turn: null });
    expect(pay).not.toHaveBeenCalled();
  });
  it('a shortfall is a 409 insufficient carrying the activation (no roll is returned)', async () => {
    pay.mockRejectedValue(new FakeShortfall());
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'insufficient', activation: { kind: 'weapon_attack', inventoryId: WEAPON } });
  });
  it('a refused gate is passed straight through', async () => {
    gateFn.mockResolvedValue({ ok: false, status: 409, body: { error: 'approval_invalid' } });
    const res = await post({ approvalId: 'x' });
    expect(res.status).toBe(409);
    expect(pay).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// roll-spell and spell echoes (VTT feedback Unit 7): the follow-up choice reaches the cast, an echo
// resolves its damage at the spell's BASE level (not the slot that was asked for), the response says
// which follow-up class is left, and a 'require' with nothing waiting is a 409 with no roll.
// Database, cost gate and sheet mocked; the damage rules are the real ones.

const castFn = vi.fn();
let turnView: any;

class FakeShortfall extends Error { shortfalls = []; }
class FakeGone extends Error { constructor() { super('That free repeat is no longer available.'); } }

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: async (run: any) => run({}) }));
vi.mock('$lib/server/services/effects', () => ({ consumeNextAttackEffects: async () => [] }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/access', () => ({ getCharacterAccess: async () => ({ canAct: true }) }));
vi.mock('$lib/server/services/characters', () => ({
  getCharacter: async () => ({ classes: [{ level: 5 }], modifierSources: [], metadata: {}, turn: turnView })
}));
vi.mock('$lib/server/services/catalogue', () => ({
  castCharacterSpellDetailed: (...args: unknown[]) => castFn(...args),
  getPreparedSpellDamageSource: async () => ({
    name: 'Fireball', spellLevel: 3, resolutionType: 'auto', damageType: 'fire', baseDice: '8d6',
    saveAbility: 'dex', saveEffect: 'half', scaling: { kind: 'leveled', extraDicePerSlotLevel: '1d6' }
  })
}));
vi.mock('$lib/server/services/cost-engine', () => ({ CostShortfallError: FakeShortfall, FollowupGoneError: FakeGone }));
vi.mock('$lib/server/vttCostGate', () => ({
  openCostGate: async (input: any) => ({ ok: true, mode: 'ask_dm', activation: input.activation, override: null }),
  runWithGate: async (_gate: unknown, run: any) => run(null),
  costShortfallBody: () => ({ error: 'insufficient' })
}));
vi.mock('$lib/server/vttCostApproval', () => ({
  activationFromCastForm: (form: FormData) => ({ kind: 'spell', instanceId: String(form.get('instanceId')), followup: form.get('followup') ?? undefined })
}));
vi.mock('$lib/rules/characterStats', () => ({
  characterStatsFor: () => ({ spellSaveDc: { value: 15 }, spellAttackBonus: { value: 7 } }),
  resolveSpellcastingAbility: () => 'int'
}));
vi.mock('$lib/server/vttAttackAdvantage', () => ({
  gatherVttAdvantageSources: async () => ({ extraSources: [] }),
  parseAttackOptions: (body: any) => ({ preview: Boolean(body.preview), disabledSourceIds: [], manualDamageDice: 0, vtt: undefined })
}));

const route = await import('../../routes/vtt/api/characters/[id]/roll-spell/+server');
const ID = '11111111-1111-4111-8111-111111111111';
const post = (body: Record<string, unknown>) => route.POST({ locals: { user: { id: 'u1' } }, params: { id: ID }, request: { json: async () => ({ instanceId: 'inst-1', slotLevel: 5, ...body }) } } as any);

beforeEach(() => {
  turnView = { followups: [{ cls: 'spell', label: 'Doublecast', remaining: 1 }] };
  castFn.mockReset().mockResolvedValue({ results: [], spent: { slotType: 'standard', slotLevel: 5 }, usedFollowup: false, followupCls: 'spell' });
});

describe('roll-spell and echoes', () => {
  it('a normal cast resolves at the slot level, sends no echo choice, and reports the waiting echo', async () => {
    const body = await (await post({})).json();
    expect((castFn.mock.calls[0][2] as FormData).get('followup')).toBeNull();
    expect(body.damage.join(' ')).toContain('cast at level 5');
    expect(body.turn).toEqual({ usedFollowup: false, followupCls: 'spell', followupsLeft: [{ cls: 'spell', label: 'Doublecast', remaining: 1 }] });
  });
  it("an echo ('require') passes the choice through and rolls damage at the base level, whatever slot was asked for", async () => {
    castFn.mockResolvedValue({ results: [], spent: null, castAtLevel: 3, usedFollowup: true, followupCls: 'spell' });
    turnView = { followups: [] };
    const body = await (await post({ followup: 'require' })).json();
    expect((castFn.mock.calls[0][2] as FormData).get('followup')).toBe('require');
    expect(body.damage.join(' ')).not.toContain('cast at level');
    expect(body.damageTotal).toBeGreaterThan(0);
    expect(body.spent).toBeNull();
    expect(body.turn).toMatchObject({ usedFollowup: true, followupCls: 'spell', followupsLeft: [], castAtLevel: 3 });
  });
  it('junk follow-up values are not forwarded', async () => {
    await post({ followup: 'maybe' });
    expect((castFn.mock.calls[0][2] as FormData).get('followup')).toBeNull();
  });
  it("a 'require' with no echo waiting is a 409 followup_gone and rolls nothing", async () => {
    castFn.mockRejectedValue(new FakeGone());
    const res = await post({ followup: 'require' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'followup_gone', message: 'That free repeat is no longer available.' });
  });
  it('a preview carries the live turn view and never casts', async () => {
    const body = await (await post({ preview: true })).json();
    expect(castFn).not.toHaveBeenCalled();
    expect(body.turn).toEqual(turnView);
  });
});

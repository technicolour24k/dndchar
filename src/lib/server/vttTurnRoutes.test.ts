import { beforeEach, describe, expect, it, vi } from 'vitest';

// The VTT's turn routes (action economy Unit 4), driven with the database, the cost gate and the dice
// mocked out: what they pay, what they refuse, and who may do what.

const pay = vi.fn();
const gateFn = vi.fn();
const adjust = vi.fn();
const reset = vi.fn();
let access: any = { canAct: true, canEdit: true };

class FakeShortfall extends Error { shortfalls = [{ label: 'Attack', needed: 1, available: 0 }]; }
class FakeGone extends Error { constructor() { super('That free repeat is no longer available.'); } }

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: async (fn: any) => fn({}) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/access', () => ({ getCharacterAccess: async () => access }));
vi.mock('$lib/server/services/catalogue', () => ({ payTurnActivation: (...args: unknown[]) => pay(...args) }));
vi.mock('$lib/server/services/turn-state', () => ({
  adjustTurnPool: (...args: unknown[]) => adjust(...args), getTurnView: async () => ({ pools: [] }),
  resetTurnState: (...args: unknown[]) => reset(...args), lockTurnState: async () => {}
}));
vi.mock('$lib/server/services/cost-engine', () => ({ CostShortfallError: FakeShortfall, FollowupGoneError: FakeGone }));
vi.mock('$lib/server/vttCostGate', () => ({
  openCostGate: (...args: unknown[]) => gateFn(...args),
  runWithGate: async (_gate: unknown, run: any) => run(null),
  costShortfallBody: (gate: any, error: any) => ({ error: 'insufficient', mode: gate.mode, shortfalls: error.shortfalls, activation: gate.activation })
}));

const turn = await import('../../routes/vtt/api/characters/[id]/turn/+server');
const ID = '11111111-1111-4111-8111-111111111111';
const WEAPON = '22222222-2222-4222-8222-222222222222';

function post(body: Record<string, unknown>) {
  return turn.POST({ locals: { user: { id: 'u1' } }, params: { id: ID }, request: { json: async () => body } } as any);
}

beforeEach(() => {
  pay.mockReset().mockResolvedValue({ paid: [{ label: 'Attack', delta: -1 }], turn: { pools: [] }, results: [] });
  gateFn.mockReset().mockImplementation(async (input: any) => ({ ok: true, mode: 'ask_dm', activation: input.activation, override: null }));
  adjust.mockReset().mockResolvedValue({ pools: [] });
  reset.mockReset();
  access = { canAct: true, canEdit: true };
});

describe('turn route: pay', () => {
  it('pays an id-less weapon attack and a dash, through the gate', async () => {
    const attack = await post({ action: 'pay', activation: { kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike', timing: 'reaction' } });
    expect(attack.status).toBe(200);
    expect(pay.mock.calls[0][2]).toEqual({ kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike', timing: 'reaction' });
    expect(gateFn).toHaveBeenCalledTimes(1);
    const dash = await post({ action: 'pay', activation: { kind: 'dash', count: 2 } });
    expect(dash.status).toBe(200);
    expect(pay.mock.calls[1][2]).toEqual({ kind: 'dash', count: 2 });
  });
  it('an id-less attack answers with the follow-up fields, so the client can word it and offer the repeat', async () => {
    pay.mockResolvedValue({ paid: [{ label: 'Extra Attack', pool: 'followup', delta: -1 }], turn: { pools: [], followups: [{ cls: 'melee', label: 'Extra Attack', remaining: 1 }] }, results: [] });
    const res = await post({ action: 'pay', activation: { kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike' } });
    expect(await res.json()).toMatchObject({ usedFollowup: true, followupCls: 'melee', followupsLeft: [{ cls: 'melee', remaining: 1 }] });
    const dash = await post({ action: 'pay', activation: { kind: 'dash', count: 1 } });
    expect((await dash.json()).followupCls).toBeNull();
  });
  it("accepts followup 'require' and turns a missing follow-up into a 409 followup_gone", async () => {
    const activation = { kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike', followup: 'require' };
    await post({ action: 'pay', activation });
    expect(pay.mock.calls[0][2]).toEqual(activation);
    pay.mockRejectedValue(new FakeGone());
    const res = await post({ action: 'pay', activation });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'followup_gone' });
  });
  it('refuses every other kind, including a weapon attack the sheet can pay itself', async () => {
    for (const activation of [
      { kind: 'spell', instanceId: ID }, { kind: 'item', inventoryId: ID }, { kind: 'content', instanceId: ID },
      { kind: 'weapon_attack', inventoryId: WEAPON }, { kind: 'dash', count: 0 }, null, 'x'
    ]) {
      const res = await post({ action: 'pay', activation });
      expect(res.status, JSON.stringify(activation)).toBe(400);
    }
    expect(pay).not.toHaveBeenCalled();
  });
  it('someone who cannot act for the character gets a 404 and nothing is paid', async () => {
    access = { canAct: false, canEdit: true };
    expect((await post({ action: 'pay', activation: { kind: 'dash', count: 1 } })).status).toBe(404);
    expect(pay).not.toHaveBeenCalled();
  });
  it('a shortfall is a 409 insufficient with the activation, ready for the ask-the-DM prompt', async () => {
    pay.mockRejectedValue(new FakeShortfall());
    const res = await post({ action: 'pay', activation: { kind: 'dash', count: 1 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'insufficient', shortfalls: [{ label: 'Attack' }], activation: { kind: 'dash', count: 1 } });
  });
  it('a refused gate is passed straight through', async () => {
    gateFn.mockResolvedValue({ ok: false, status: 403, body: { error: 'forbidden' } });
    const res = await post({ action: 'pay', activation: { kind: 'dash', count: 1 } });
    expect(res.status).toBe(403);
    expect(pay).not.toHaveBeenCalled();
  });
});

describe('turn route: reset and adjust are bookkeeping', () => {
  it('need edit access', async () => {
    access = { canAct: true, canEdit: false };
    expect((await post({ action: 'reset' })).status).toBe(404);
    expect((await post({ action: 'adjust', key: 'attack', delta: -1 })).status).toBe(404);
    expect(reset).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
  });
  it('work for an editor, and an unknown action is a 400', async () => {
    expect((await post({ action: 'reset' })).status).toBe(200);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0][2]).toBe('Turn reset from the VTT'); // the new turn's log says who reset it
    expect((await post({ action: 'adjust', key: 'attack', delta: -1 })).status).toBe(200);
    expect(adjust).toHaveBeenCalledWith('u1', ID, 'attack', -1);
    expect((await post({ action: 'bogus' })).status).toBe(400);
  });
  it('a character that does not exist or is not visible is a 404', async () => {
    access = null;
    expect((await post({ action: 'reset' })).status).toBe(404);
  });
});

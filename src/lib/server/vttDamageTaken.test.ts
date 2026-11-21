import { describe, expect, it } from 'vitest';
// Relative imports: the VTT server code lives outside src/ (same as vttTokenMove.test.ts).
import handleTokenEvent, { damageTypeOfMessage, formatDamageTakenText } from '../../../vtt/server/handlers/token.js';
import { resolveDamageTaken } from '../rules/damageTaken';

type Meta = Record<string, any>;
const sent: any[] = [];
const gm: Meta = { role: 'gm', playerId: null, sessionId: 's1', ws: { send: (data: string) => sent.push(JSON.parse(data)) } };

function mod(target: string, modifierType: string, valueExpression = '', conditionExpression = ''): any {
  return { target, modifierType, valueExpression, conditionExpression, priority: 0 };
}
// Characters by id: the same damage_taken data the loopback route would load.
const characters: Record<string, any[]> = {
  bob: [
    { id: 'plate', effectId: 'plate', effectKey: 'plate', name: 'Plate', modifiers: [mod('damage_taken.all', 'penalty', '2', 'flag:half_cover')] },
    { id: 'cover', effectId: 'cover', effectKey: 'half_cover', name: 'Half Cover', modifiers: [] },
    { id: 'rage', effectId: 'rage', effectKey: 'rage', name: 'Rage', modifiers: ['slashing', 'piercing', 'bludgeoning'].map((t) => mod(`damage_taken.${t}`, 'resistance')) }
  ],
  plain: []
};

function makeSession() {
  return {
    map: { gridSizePx: 50, revealed: true },
    tokens: {
      att: { id: 'att', name: 'Goblin', type: 'enemy', hidden: false },
      bob: { id: 'bob', name: 'Bob', type: 'pc', characterId: 'bob', ownerId: 'p1', ac: 10, stats: { hp: 20, maxHp: 20 } },
      plain: { id: 'plain', name: 'Plain', type: 'pc', characterId: 'plain', ownerId: 'p2', ac: 10, stats: { hp: 20, maxHp: 20 } },
      orc: { id: 'orc', name: 'Orc', type: 'enemy', ac: 10, stats: { hp: 20, maxHp: 20 }, characterId: 'bob' },
      npc: { id: 'npc', name: 'Npc', type: 'npc', ac: 10, stats: { hp: 20, maxHp: 20 } }
    } as Record<string, any>
  };
}

async function run(session: any, msg: Record<string, unknown>) {
  sent.length = 0;
  const logs: string[] = [];
  const lookups: any[] = [];
  const context = {
    sessions: new Map([['s1', session]]),
    broadcast: () => {},
    internalApiBaseUrl: () => 'http://localhost:0',
    // Stands in for POST /vtt/api/damage-taken, using the real pure function.
    resolveDamageTaken: async (characterId: string, amount: number, damageType: string | null) => {
      lookups.push({ characterId, amount, damageType });
      return resolveDamageTaken(characters[characterId] ?? [], { amount, damageType });
    }
  };
  // Combat log lines go through fetch(); capture them instead of touching the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => { logs.push(JSON.parse(init.body).message); return { ok: true }; }) as any;
  session.encounterId = 'e1';
  try {
    await handleTokenEvent(gm, msg, context);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { logs, lookups, result: sent[0] };
}

const attack = (target: string, damage: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'attack:resolve', targetTokenId: target, sourceTokenId: 'att', toHit: 15, damage, outcome: null, damageType: 'slashing', damageLabel: null, ...extra });

describe('attack:resolve damage taken', () => {
  it('applies flat reduction (flag) then Rage resistance to a PC and reports the audit trail', async () => {
    const s = makeSession();
    const { result, logs, lookups } = await run(s, attack('bob', 7));
    // 7 - 2 (Half Cover gates Plate) = 5, halved = 2.
    expect(s.tokens.bob.stats.hp).toBe(18);
    expect(lookups[0]).toEqual({ characterId: 'bob', amount: 7, damageType: 'slashing' });
    expect(result.damage).toBe(2);
    expect(result.damageRolled).toBe(7);
    expect(result.breakdown).toBe('7 - 2 (Plate) = 5; halved (Rage: resistance to slashing) = 2');
    expect(logs[0]).toContain('for 2 ');
    expect(logs[0]).toContain('(rolled 7; 7 - 2 (Plate) = 5; halved (Rage: resistance to slashing) = 2)');
  });

  it('leaves a PC with no damage_taken modifiers unchanged and adds no breakdown', async () => {
    const s = makeSession();
    const { result, logs } = await run(s, attack('plain', 7));
    expect(s.tokens.plain.stats.hp).toBe(13);
    expect(result.damage).toBe(7);
    expect(result.breakdown).toBeUndefined();
    expect(logs[0]).not.toContain('rolled');
  });

  it('does not touch enemy/npc tokens, even one carrying a characterId', async () => {
    const s = makeSession();
    const orc = await run(s, attack('orc', 7));
    expect(orc.lookups).toEqual([]);
    expect(s.tokens.orc.stats.hp).toBe(13);
    expect(orc.result.breakdown).toBeUndefined();
    const npc = await run(s, attack('npc', 7));
    expect(npc.lookups).toEqual([]);
    expect(s.tokens.npc.stats.hp).toBe(13);
  });

  it('applies the unreduced damage if the lookup fails', async () => {
    const s = makeSession();
    const context = {
      sessions: new Map([['s1', s]]), broadcast: () => {}, internalApiBaseUrl: () => 'http://localhost:0',
      resolveDamageTaken: async () => { throw new Error('boom'); }
    };
    sent.length = 0;
    const realError = console.error;
    console.error = () => {};
    try { await handleTokenEvent(gm, attack('bob', 7), context); } finally { console.error = realError; }
    expect(s.tokens.bob.stats.hp).toBe(13);
  });

  it('a miss never looks anything up', async () => {
    const s = makeSession();
    const { lookups } = await run(s, attack('bob', 7, { toHit: 2 }));
    expect(lookups).toEqual([]);
    expect(s.tokens.bob.stats.hp).toBe(20);
  });
});

describe('spell:resolve damage taken', () => {
  const spell = (target: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'spell:resolve', targetTokenId: target, sourceTokenId: 'att', damage: 8, resolution: 'auto', damageType: 'magic', damageLabel: 'Fire', ...extra });

  it('uses the spell damage type: fire is not slashing, so Rage does nothing and Plate needs cover', async () => {
    const s = makeSession();
    const { result, lookups } = await run(s, spell('bob'));
    expect(lookups[0].damageType).toBe('fire');
    expect(s.tokens.bob.stats.hp).toBe(14); // 8 - 2 = 6
    expect(result.damageApplied).toBe(6);
    expect(result.breakdown).toBe('8 - 2 (Plate) = 6');
  });

  it('applies the save halving first, then the damage_taken steps', async () => {
    const s = makeSession();
    const { result } = await run(s, spell('bob', { resolution: 'save', saveSuccess: true, saveEffect: 'half', damageLabel: 'Slashing' }));
    // 8 halved by the save = 4, then 4 - 2 = 2, then Rage halves = 1.
    expect(s.tokens.bob.stats.hp).toBe(19);
    expect(result.damageApplied).toBe(1);
  });

  it('reports the damage dealt (previously a ReferenceError) for a plain target', async () => {
    const s = makeSession();
    const { result } = await run(s, spell('npc'));
    expect(result.damageApplied).toBe(8);
    expect(s.tokens.npc.stats.hp).toBe(12);
  });
});

describe('damage type and text helpers', () => {
  it('prefers the real type, falls back to the guessed physical bucket, never magic', () => {
    expect(damageTypeOfMessage({ damageLabel: 'Fire', damageType: 'magic' })).toBe('fire');
    expect(damageTypeOfMessage({ damageLabel: null, damageType: 'piercing' })).toBe('piercing');
    expect(damageTypeOfMessage({ damageLabel: null, damageType: 'magic' })).toBeNull();
    expect(damageTypeOfMessage({})).toBeNull();
  });

  it('formats the log tail only when there is a breakdown', () => {
    expect(formatDamageTakenText(7, '')).toBe('');
    expect(formatDamageTakenText(7, '7 - 2 (A) = 5')).toBe(' (rolled 7; 7 - 2 (A) = 5)');
  });
});

describe('damage taken: lookup edge cases', () => {
  // A lookup the test resolves by hand, so awaits can be interleaved on purpose.
  function deferredContext(session: any) {
    const pending: Array<(value: any) => void> = [];
    const context = {
      sessions: new Map([['s1', session]]), broadcast: () => {}, internalApiBaseUrl: () => 'http://localhost:0',
      resolveDamageTaken: (_id: string, amount: number) => new Promise((resolve) => {
        pending.push(() => resolve({ final: amount - 1, steps: [], breakdown: `${amount} - 1 (Test) = ${amount - 1}` }));
      })
    };
    return { context, pending };
  }

  it('falls back to unreduced damage when the loopback lookup times out (and sends a timeout signal)', async () => {
    const s = makeSession();
    let signal: AbortSignal | undefined;
    const realFetch = globalThis.fetch;
    const realError = console.error;
    console.error = () => {};
    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).endsWith('/vtt/api/damage-taken')) {
        signal = init.signal;
        throw new DOMException('timed out', 'TimeoutError');
      }
      return { ok: true };
    }) as any;
    sent.length = 0;
    try {
      await handleTokenEvent(gm, attack('bob', 7), { sessions: new Map([['s1', s]]), broadcast: () => {}, internalApiBaseUrl: () => 'http://localhost:0' });
    } finally {
      globalThis.fetch = realFetch;
      console.error = realError;
    }
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(s.tokens.bob.stats.hp).toBe(13);
    expect(sent[0].damage).toBe(7);
  });

  it('does nothing if the token is removed while the lookup is in flight', async () => {
    const s = makeSession();
    const { context, pending } = deferredContext(s);
    sent.length = 0;
    const done = handleTokenEvent(gm, attack('plain', 7), context);
    delete s.tokens.plain;
    pending[0](undefined);
    await done;
    expect(sent).toEqual([]);
  });

  it('two interleaved attacks on one PC token both land', async () => {
    const s = makeSession();
    const { context, pending } = deferredContext(s);
    sent.length = 0;
    const first = handleTokenEvent(gm, attack('plain', 7), context);
    const second = handleTokenEvent(gm, attack('plain', 5), context);
    pending[1](undefined);
    pending[0](undefined);
    await Promise.all([first, second]);
    expect(s.tokens.plain.stats.hp).toBe(20 - 6 - 4);
    expect(sent.length).toBe(2);
  });
});

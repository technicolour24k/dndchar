import { describe, expect, it, vi } from 'vitest';

// The cost engine reads only through the client it is given, so a fake client that records every
// query shows exactly what a turn-only cost touches. The db module is mocked out (no database).
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn(), getPool: vi.fn() }));

import { previewActivationCost, payActivationCost } from '$lib/server/services/cost-engine';
import { RESERVED_POOL_KEYS } from '$lib/server/services/resource-pools';

function fakeClient(costJson: unknown) {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (/FROM character_content_instances/.test(text)) return { rows: [{ id: 'c1', name: 'Second Wind', cost_json: costJson }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
  return { client: client as never, sql };
}
const activation = { kind: 'content', instanceId: 'i1' } as const;

describe('turn-only costs take no locks and load no pool maxima', () => {
  for (const [name, cost] of [
    ['a turn line', [{ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'general' }]],
    ['a legacy action line', [{ pool: 'action', amount: 1 }]],
    ['a free turn line', [{ pool: 'turn', amount: 1, timing: 'free' }]]
  ] as const) {
    it(`paying ${name} returns at once after reading the content row`, async () => {
      const { client, sql } = fakeClient(cost);
      expect(await payActivationCost(client, 'char', activation, { actorUserId: 'u' })).toEqual([]);
      expect(sql).toHaveLength(1);
    });
    it(`previewing ${name} reads no pools, slots or counters`, async () => {
      const { client, sql } = fakeClient(cost);
      const plan = await previewActivationCost(client, 'char', activation);
      expect(plan.shortfalls).toEqual([]);
      expect(plan.lines.every((line) => line.displayOnly)).toBe(true);
      expect(sql).toHaveLength(1);
      expect(sql.some((text) => /FOR UPDATE|character_resources|resource_pool_definitions/.test(text))).toBe(false);
    });
  }
  it('a stored cost with several turn lines still plays, using the first', async () => {
    const { client } = fakeClient([{ pool: 'action', amount: 1 }, { pool: 'turn', amount: 1, timing: 'reaction' }]);
    const plan = await previewActivationCost(client, 'char', activation);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].label).toBe('Action');
  });
});

describe('reserved pool keys', () => {
  it('include the action economy names so a pool can never shadow them', () => {
    for (const key of ['action', 'bonus_action', 'reaction', 'turn', 'followup']) expect(RESERVED_POOL_KEYS).toContain(key);
  });
});

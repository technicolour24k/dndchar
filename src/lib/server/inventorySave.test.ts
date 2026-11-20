import { describe, expect, it } from 'vitest';
import type { InventoryItem } from '$lib/types/character';

// characters.ts pulls in the DB pool and the service layer, none of which this test touches.
import { vi } from 'vitest';
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('$lib/server/services/catalogue', () => ({}));
vi.mock('$lib/server/services/rule-engine', () => ({}));
vi.mock('$lib/server/services/effects', () => ({}));
vi.mock('$lib/server/services/encounters', () => ({}));
vi.mock('$lib/server/services/combatLog', () => ({}));
vi.mock('$lib/server/cache/referenceData', () => ({ cachedReference: vi.fn() }));

const { saveInventoryChanges } = await import('./services/characters');

// A tiny in-memory stand-in for character_inventory_items that understands just the four statements
// saveInventoryChanges issues (delete by ids, max sort order, column update, upsert). It lets the
// tests assert on the resulting rows rather than on SQL text.
type Row = Record<string, unknown>;
function fakeClient(initial: Row[]) {
  const rows = new Map<string, Row>(initial.map((row) => [row.id as string, { ...row }]));
  let inserted = 0;
  const client = {
    rows,
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('DELETE FROM character_inventory_items')) {
        for (const id of params[1] as string[]) rows.delete(id);
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('SELECT COALESCE(MAX(sort_order)')) {
        return { rows: [{ next: rows.size }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE character_inventory_items SET')) {
        const row = rows.get(params[0] as string);
        if (!row) return { rows: [], rowCount: 0 };
        const columns = [...text.matchAll(/(\w+) = \$(\d+)/g)];
        for (const [, column, n] of columns) if (Number(n) >= 3) row[column] = params[Number(n) - 1];
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO character_inventory_items')) {
        const id = (params[0] as string | null) ?? `new-${++inserted}`;
        rows.set(id, { id, name: params[2], quantity: params[5], sort_order: params[22] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${text.slice(0, 60)}`);
    }
  };
  return client;
}

function item(id: string | undefined, name: string, quantity: number, extra: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id, name, category: 'consumable', location: 'backpack', quantity, equipped: false, isEquipment: false,
    acBonus: 0, toHitBonus: 0, damageBonus: 0, attackAbility: 'str', proficient: true, sourceContentId: null,
    attuned: false, damageRolls: '', effects: '', abilityBonuses: {}, notes: '', ...extra
  };
}

// The sheet loaded Moonleaf x3 and Rope x1. Then a forage haul stacked Moonleaf to 5 behind its back.
const baseline = [item('moon', 'Moonleaf', 3), item('rope', 'Rope', 1)];
const dbNow = () => [
  { id: 'moon', name: 'Moonleaf', quantity: 5, notes: '' },
  { id: 'rope', name: 'Rope', quantity: 1, notes: '' },
  { id: 'iron', name: 'Iron Ore', quantity: 2, notes: '' }
];

describe('sheet inventory Save writes only what the user changed', () => {
  it('leaves an untouched row alone, and a row the sheet never saw', async () => {
    const client = fakeClient(dbNow());
    // Posted exactly as loaded (Moonleaf still shows 3), nothing edited.
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 3), item('rope', 'Rope', 1)], baseline);
    expect(client.rows.get('moon')!.quantity).toBe(5);
    expect(client.rows.has('iron')).toBe(true);
    expect(client.rows.get('iron')!.quantity).toBe(2);
  });

  it('lets an edited row win, changing only the edited field', async () => {
    const client = fakeClient(dbNow());
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 7), item('rope', 'Rope', 1)], baseline);
    expect(client.rows.get('moon')!.quantity).toBe(7);
    // Editing only the notes must not drag the quantity back to the stale 3.
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 7, { notes: 'dried' }), item('rope', 'Rope', 1)], [item('moon', 'Moonleaf', 7), item('rope', 'Rope', 1)]);
    expect(client.rows.get('moon')).toMatchObject({ quantity: 7, notes: 'dried' });
  });

  it('keeps a newer DB quantity when the user edits a different field of that row', async () => {
    const client = fakeClient(dbNow());
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 3, { notes: 'dried' }), item('rope', 'Rope', 1)], baseline);
    expect(client.rows.get('moon')).toMatchObject({ quantity: 5, notes: 'dried' });
  });

  it('deletes only rows the user removed', async () => {
    const client = fakeClient(dbNow());
    // Rope removed (posted with quantity 0 is dropped by parseInventory, so it is simply absent).
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 3)], baseline);
    expect(client.rows.has('rope')).toBe(false);
    expect(client.rows.has('moon')).toBe(true);
    expect(client.rows.has('iron')).toBe(true);
  });

  it('inserts a new row', async () => {
    const client = fakeClient(dbNow());
    await saveInventoryChanges(client as any, 'char', [item('moon', 'Moonleaf', 3), item('rope', 'Rope', 1), item(undefined, 'Torch', 4)], baseline);
    const torch = [...client.rows.values()].find((row) => row.name === 'Torch');
    expect(torch).toMatchObject({ quantity: 4 });
    expect(client.rows.get('moon')!.quantity).toBe(5);
  });
});

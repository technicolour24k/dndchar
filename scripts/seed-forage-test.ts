import pg from 'pg';
import './load-env';

// Local-only seed for the forage / loot finder. Creates plant and ore item Containers (empty
// grants, no mechanics) and three find tables to test with. Idempotent: items are upserted by
// content_key, tables are matched by (area_type, category, name), entries are upserted.
//
// It refuses to run against anything but a local database. Never point it at Neon.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed with NODE_ENV=production.');

const parsedUrl = new URL(databaseUrl);
// A ?host= query param can point pg at a different server than the URL's hostname suggests.
if (parsedUrl.searchParams.has('host')) throw new Error('Refusing to seed: DATABASE_URL has a "host" query parameter.');
const host = parsedUrl.hostname.replace(/^\[|\]$/g, '');
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  throw new Error(`Refusing to seed: database host "${host}" is not local.`);
}
console.log(`seeding forage test data into host: ${host}`);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

type SeedItem = { slug: string; name: string; category: 'consumable' | 'gear'; archived?: boolean };
const items: SeedItem[] = [
  { slug: 'moonleaf', name: 'Moonleaf', category: 'consumable' },
  { slug: 'silverthorn-berry', name: 'Silverthorn Berry', category: 'consumable' },
  { slug: 'bitterroot', name: 'Bitterroot', category: 'consumable' },
  { slug: 'glowcap-mushroom', name: 'Glowcap Mushroom', category: 'consumable' },
  { slug: 'healers-moss', name: "Healer's Moss", category: 'consumable' },
  { slug: 'withered-stalk', name: 'Withered Stalk', category: 'consumable', archived: true },
  { slug: 'iron-ore', name: 'Iron Ore', category: 'gear' },
  { slug: 'copper-ore', name: 'Copper Ore', category: 'gear' },
  { slug: 'silver-ore', name: 'Silver Ore', category: 'gear' },
  { slug: 'mithral-fleck', name: 'Mithral Fleck', category: 'gear' }
];

type SeedTable = {
  name: string; areaType: string; category: string; typeDie: number; suggestedCheck: string;
  entries: { slug: string; weight: number; qtyDie: number }[];
};
const tables: SeedTable[] = [
  {
    name: 'Meadow - plants', areaType: 'meadow', category: 'plant', typeDie: 6, suggestedCheck: 'Nature DC 12',
    entries: [
      { slug: 'moonleaf', weight: 5, qtyDie: 4 }, { slug: 'silverthorn-berry', weight: 3, qtyDie: 6 },
      { slug: 'bitterroot', weight: 2, qtyDie: 2 }, { slug: 'glowcap-mushroom', weight: 1, qtyDie: 1 },
      { slug: 'healers-moss', weight: 0, qtyDie: 3 }, { slug: 'withered-stalk', weight: 4, qtyDie: 2 }
    ]
  },
  {
    name: 'Cave - ores', areaType: 'cave', category: 'ore', typeDie: 3, suggestedCheck: 'Athletics DC 13',
    entries: [
      { slug: 'iron-ore', weight: 6, qtyDie: 6 }, { slug: 'copper-ore', weight: 4, qtyDie: 4 },
      { slug: 'silver-ore', weight: 2, qtyDie: 2 }, { slug: 'mithral-fleck', weight: 1, qtyDie: 1 }
    ]
  },
  { name: 'Swamp - gems', areaType: 'swamp', category: 'gem', typeDie: 2, suggestedCheck: '', entries: [] }
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = new Map<string, string>();

    for (const item of items) {
      const content = await client.query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, is_archived)
         VALUES ($1, 'item', $2, 'Forage test fixture.', 'homebrew', $3)
         ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO UPDATE
         SET name = EXCLUDED.name, is_archived = EXCLUDED.is_archived
         RETURNING id`,
        [`test:forage:${item.slug}`, item.name, !!item.archived]
      );
      ids.set(item.slug, content.rows[0].id);
      await client.query(
        `INSERT INTO item_definitions (content_id, category) VALUES ($1, $2)
         ON CONFLICT (content_id) DO UPDATE SET category = EXCLUDED.category`,
        [content.rows[0].id, item.category]
      );
    }

    for (const table of tables) {
      // Match an existing table by name so re-runs don't duplicate. The unique index on the
      // active area + category would reject a second copy anyway.
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM find_tables WHERE name = $1 AND area_type = $2 AND category = $3',
        [table.name, table.areaType, table.category]
      );
      let tableId = existing.rows[0]?.id;
      if (!tableId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO find_tables (name, area_type, category, type_die, suggested_check, owner_user_id)
           VALUES ($1, $2, $3, $4, $5, NULL) RETURNING id`,
          [table.name, table.areaType, table.category, table.typeDie, table.suggestedCheck]
        );
        tableId = created.rows[0].id;
      }
      for (const [index, entry] of table.entries.entries()) {
        await client.query(
          `INSERT INTO find_table_entries (find_table_id, item_id, weight, qty_die, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (find_table_id, item_id) DO UPDATE
           SET weight = EXCLUDED.weight, qty_die = EXCLUDED.qty_die, sort_order = EXCLUDED.sort_order`,
          [tableId, ids.get(entry.slug), entry.weight, entry.qtyDie, index]
        );
      }
    }

    await client.query('COMMIT');

    const summary = await client.query(`
      SELECT t.name, COUNT(e.item_id)::int AS entries,
             COUNT(e.item_id) FILTER (WHERE e.weight > 0 AND NOT c.is_archived)::int AS pickable
      FROM find_tables t
      LEFT JOIN find_table_entries e ON e.find_table_id = t.id
      LEFT JOIN content_definitions c ON c.id = e.item_id
      WHERE t.name IN ('Meadow - plants', 'Cave - ores', 'Swamp - gems') GROUP BY t.name ORDER BY t.name`);
    console.log(`items upserted: ${items.length}`);
    for (const row of summary.rows) console.log(`table "${row.name}": ${row.entries} entries, ${row.pickable} pickable`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

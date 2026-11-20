import pg from 'pg';
import './load-env';

import crypto from 'node:crypto';

// Local-only seed for the forage / loot finder. Creates plant and ore item Containers (empty
// grants, no mechanics) and three find tables to test with. Find tables belong to a campaign, so the
// tables go into a local "Forage Test Campaign" (created if missing, with no members: join it with
// the invite code this script prints, or make yourself its DM as admin). Idempotent: items are
// upserted by content_key, the campaign by name, tables are matched by (campaign, area_type,
// category, name), entries are upserted.
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

const CAMPAIGN_NAME = 'Forage Test Campaign';
// Same alphabet as the campaign codes (no I, O, 0, 1).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = (length: number) => Array.from({ length }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

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
  name: string; areaType: string; category: string; suggestedCheck: string;
  // chance is a percent from the editor's list: 100, 50, 30, 20, 10, 5, 1, or 0 (Off).
  entries: { slug: string; chance: number; qtyDie: number }[];
};
const tables: SeedTable[] = [
  {
    name: 'Meadow - plants', areaType: 'meadow', category: 'plant', suggestedCheck: 'Nature DC 12',
    entries: [
      { slug: 'moonleaf', chance: 50, qtyDie: 4 }, { slug: 'silverthorn-berry', chance: 30, qtyDie: 6 },
      { slug: 'bitterroot', chance: 20, qtyDie: 2 }, { slug: 'glowcap-mushroom', chance: 5, qtyDie: 1 },
      { slug: 'healers-moss', chance: 0, qtyDie: 3 }, { slug: 'withered-stalk', chance: 30, qtyDie: 2 }
    ]
  },
  {
    name: 'Cave - ores', areaType: 'cave', category: 'ore', suggestedCheck: 'Athletics DC 13',
    entries: [
      { slug: 'iron-ore', chance: 100, qtyDie: 6 }, { slug: 'copper-ore', chance: 30, qtyDie: 4 },
      { slug: 'silver-ore', chance: 10, qtyDie: 2 }, { slug: 'mithral-fleck', chance: 1, qtyDie: 1 }
    ]
  },
  { name: 'Swamp - gems', areaType: 'swamp', category: 'gem', suggestedCheck: '', entries: [] }
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = new Map<string, string>();

    // The test campaign: reused by name, else created with fresh codes. No members, so no DM.
    let campaign = (await client.query<{ id: string; invite_code: string }>('SELECT id, invite_code FROM campaigns WHERE name = $1 AND NOT is_archived LIMIT 1', [CAMPAIGN_NAME])).rows[0];
    if (!campaign) {
      campaign = (await client.query<{ id: string; invite_code: string }>(
        'INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id, invite_code', [CAMPAIGN_NAME, makeCode(10), makeCode(8)]
      )).rows[0];
    }

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
        'SELECT id FROM find_tables WHERE campaign_id = $1 AND name = $2 AND area_type = $3 AND category = $4',
        [campaign.id, table.name, table.areaType, table.category]
      );
      let tableId = existing.rows[0]?.id;
      if (!tableId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO find_tables (name, area_type, category, suggested_check, owner_user_id, campaign_id)
           VALUES ($1, $2, $3, $4, NULL, $5) RETURNING id`,
          [table.name, table.areaType, table.category, table.suggestedCheck, campaign.id]
        );
        tableId = created.rows[0].id;
      }
      for (const [index, entry] of table.entries.entries()) {
        await client.query(
          `INSERT INTO find_table_entries (find_table_id, item_id, chance, qty_die, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (find_table_id, item_id) DO UPDATE
           SET chance = EXCLUDED.chance, qty_die = EXCLUDED.qty_die, sort_order = EXCLUDED.sort_order`,
          [tableId, ids.get(entry.slug), entry.chance, entry.qtyDie, index]
        );
      }
    }

    await client.query('COMMIT');

    const summary = await client.query(`
      SELECT t.name, COUNT(e.item_id)::int AS entries,
             COUNT(e.item_id) FILTER (WHERE e.chance > 0 AND NOT c.is_archived)::int AS pickable
      FROM find_tables t
      LEFT JOIN find_table_entries e ON e.find_table_id = t.id
      LEFT JOIN content_definitions c ON c.id = e.item_id
      WHERE t.campaign_id = $1 AND t.name IN ('Meadow - plants', 'Cave - ores', 'Swamp - gems') GROUP BY t.name ORDER BY t.name`, [campaign.id]);
    console.log(`campaign "${CAMPAIGN_NAME}" (invite code ${campaign.invite_code}, join it from /campaigns)`);
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

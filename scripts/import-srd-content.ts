import pg from 'pg';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
const api = 'https://www.dnd5eapi.co/api/2014';

async function fetchJson(path: string, attempt = 0): Promise<any> {
  const response = await fetch(`${api}${path}`);
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    return fetchJson(path, attempt + 1);
  }
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function upsertContent(type: string, entry: any): Promise<string> {
  const sourceRef = `${type}.${entry.index}`;
  const description = Array.isArray(entry.desc) ? entry.desc.join('\n\n') : String(entry.desc || entry.description || '');
  const result = await pool.query<{ id: string }>(`INSERT INTO content_definitions
    (content_key, content_type, name, description, source_kind, source_ref, metadata_json)
    VALUES ($1,$2,$3,$4,'srd',$5,$6)
    ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO UPDATE SET name=EXCLUDED.name,
      description=EXCLUDED.description, source_ref=EXCLUDED.source_ref, updated_at=now() RETURNING id`,
    [`srd:${type}:${entry.index}`, type, entry.name, description, sourceRef, JSON.stringify({ apiIndex: entry.index })]);
  const contentId = result.rows[0].id;
  await pool.query(`INSERT INTO content_effect_links (content_id,effect_id,activation_type)
    SELECT $1,id,'manual' FROM effect_definitions WHERE source_ref=$2
    ON CONFLICT (content_id,effect_id,activation_type) DO NOTHING`, [contentId, sourceRef]);
  return contentId;
}

async function importSpells() {
  const index = await fetchJson('/spells');
  for (const summary of index.results || []) {
    const spell = await fetchJson(summary.url.replace('/api/2014', ''));
    const id = await upsertContent('spell', spell);
    await pool.query(`INSERT INTO spell_definitions
      (content_id,spell_level,school,casting_time,spell_range,components,duration,ritual,concentration,classes,higher_level)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (content_id) DO UPDATE SET
      spell_level=EXCLUDED.spell_level,school=EXCLUDED.school,casting_time=EXCLUDED.casting_time,
      spell_range=EXCLUDED.spell_range,components=EXCLUDED.components,duration=EXCLUDED.duration,
      ritual=EXCLUDED.ritual,concentration=EXCLUDED.concentration,classes=EXCLUDED.classes,higher_level=EXCLUDED.higher_level`,
      [id, spell.level || 0, spell.school?.name || '', spell.casting_time || '', spell.range || '',
        (spell.components || []).join(', '), spell.duration || '', Boolean(spell.ritual), Boolean(spell.concentration),
        (spell.classes || []).map((value: any) => value.name), (spell.higher_level || []).join('\n\n')]);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log(`imported ${index.results?.length || 0} spells`);
}

async function importItems() {
  const index = await fetchJson('/equipment');
  for (const summary of index.results || []) {
    const item = await fetchJson(summary.url.replace('/api/2014', ''));
    const id = await upsertContent('item', item);
    const damage = item.damage?.damage_dice || '';
    await pool.query(`INSERT INTO item_definitions
      (content_id,category,equipment_type,requires_attunement,damage_rolls)
      VALUES ($1,$2,$3,false,$4) ON CONFLICT (content_id) DO UPDATE SET category=EXCLUDED.category,
      equipment_type=EXCLUDED.equipment_type,damage_rolls=EXCLUDED.damage_rolls`,
      [id, String(item.equipment_category?.index || 'gear').replace('adventuring-gear','gear'), item.gear_category?.index || item.weapon_category || 'item', damage]);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log(`imported ${index.results?.length || 0} items`);
}

async function importSimple(endpoint: string, type: 'feat' | 'class_feature') {
  const index = await fetchJson(endpoint);
  for (const summary of index.results || []) {
    const entry = await fetchJson(summary.url.replace('/api/2014', ''));
    await upsertContent(type, entry);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log(`imported ${index.results?.length || 0} ${type} records`);
}

async function main() {
  await importSpells();
  await importItems();
  await importSimple('/features', 'class_feature');
  await importSimple('/feats', 'feat');
}

main().finally(() => pool.end()).catch((error) => { console.error(error); process.exit(1); });

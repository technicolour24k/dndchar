import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the sheet Save baseline (decks unit 6). SKIPPED unless DECK_DB_TEST=1. Local DB only.
const enabled = process.env.DECK_DB_TEST === '1';
const form = (fields: Record<string, string>) => new URLSearchParams(fields) as unknown as FormData;

describe.skipIf(!enabled)('sheet Save baseline', () => {
  it('keeps outside changes to HP, temp HP and coin unless the user edited them', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const { query } = await import('$lib/server/db');
    const characters = await import('./services/characters');
    const tag = `zzbase${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Base', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    try {
      const id = await characters.createCharacter(userId, 'Baseline');
      const setDb = async (hp: number, temp: number, gp: number) => {
        await query(`UPDATE character_resources SET current_value=$2, max_value=30 WHERE character_id=$1 AND resource_key='hp'`, [id, hp]);
        await query(`UPDATE character_resources SET current_value=$2, max_value=$2 WHERE character_id=$1 AND resource_key='temp_hp'`, [id, temp]);
        await query(`UPDATE characters SET metadata_json = jsonb_set(metadata_json, '{currencyGp}', to_jsonb($2::int)) WHERE id=$1`, [id, gp]);
      };
      const read = async () => ({
        hp: (await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='hp'`, [id])).rows[0].current_value as number,
        temp: (await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='temp_hp'`, [id])).rows[0].current_value as number,
        gp: Number((await query<any>('SELECT metadata_json FROM characters WHERE id=$1', [id])).rows[0].metadata_json.currencyGp)
      });
      // The sheet loaded hp 20, temp 4, gp 10 ...
      const baseline = JSON.stringify({ hp: 20, tempHp: 4, currencyGp: '10' });
      const save = (fields: Record<string, string>) => characters.updateCharacter(userId, id,
        form({ name: 'Baseline', hpMax: '30', resourceBaseline: baseline, ...fields }), 'IT');
      await setDb(20, 4, 10);
      // ... then a deck changed them to 12 / 11 / 21 while it was open. A Save of the stale, unedited values keeps them.
      await setDb(12, 11, 21);
      await save({ hpCurrent: '20', tempHp: '4', currencyGp: '10' });
      expect(await read()).toEqual({ hp: 12, temp: 11, gp: 21 });
      // Each edited field is written, the others are kept.
      await save({ hpCurrent: '25', tempHp: '4', currencyGp: '10' });
      expect(await read()).toEqual({ hp: 25, temp: 11, gp: 21 });
      await save({ hpCurrent: '20', tempHp: '2', currencyGp: '10' });
      expect(await read()).toEqual({ hp: 25, temp: 2, gp: 21 });
      await save({ hpCurrent: '20', tempHp: '4', currencyGp: '15' });
      expect(await read()).toEqual({ hp: 25, temp: 2, gp: 15 });
      // No baseline posted (an old tab): everything posted is written, as before.
      await characters.updateCharacter(userId, id, form({ name: 'Baseline', hpMax: '30', hpCurrent: '9', tempHp: '1', currencyGp: '3' }), 'IT');
      expect(await read()).toEqual({ hp: 9, temp: 1, gp: 3 });
    } finally {
      await query('DELETE FROM users WHERE email = $1', [`${tag}@example.invalid`]);
    }
  });
});

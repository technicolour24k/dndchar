import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the action economy's turn state (action economy Unit 2). SKIPPED unless
// COST_DB_TEST=1. Local DB only (guarded below). Creates throwaway users, a campaign, a character
// and content, and removes them at the end.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   COST_DB_TEST=1 npx vitest run src/lib/server/actionEconomy.integration.test.ts
const enabled = process.env.COST_DB_TEST === '1';

describe.skipIf(!enabled)('action economy turn state', () => {
  it('reads the campaign profile, sums pool maxima, resets on turn/round/battle/rest and survives Save', async () => {
    // Guard FIRST, before any query: local database only, and no ?host= override.
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter, getCharacter, updateCharacter } = await import('./services/characters');
    const { createCampaign, addCharacterToCampaign, setCampaignActionEconomy } = await import('./services/campaigns');
    const { advanceCharacterRound, advanceCharacterTurn, newBattle, restCharacter } = await import('./services/catalogue');
    const { adjustTurnPool } = await import('./services/turn-state');
    const tag = `zzturn${crypto.randomBytes(4).toString('hex')}`;
    const user = async (role: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${role}${Math.random()}@example.invalid`, `IT ${role}`, role])).rows[0].id;
    const dmId = await user('user');
    const strangerId = await user('user');
    const adminId = await user('admin');
    const contentIds: string[] = [];
    let campaignId = '';
    try {
      const characterId = await createCharacter(dmId, 'Turns');
      const view = async () => (await getCharacter(dmId, characterId))!;
      const pools = async () => Object.fromEntries((await view()).turn.pools.map((p) => [p.key, `${p.current}/${p.max}`]));

      // A campaign-less character plays 5e: Action, Bonus action, Reaction at 1 each.
      expect((await view()).actionEconomy).toBe('dnd5e');
      expect(await pools()).toEqual({ action: '1/1', bonus_action: '1/1', reaction: '1/1' });

      // Every campaign starts on 5e; the DM switches it.
      campaignId = await createCampaign(dmId, `IT ${tag}`);
      await addCharacterToCampaign(dmId, characterId, campaignId);
      expect((await query<any>('SELECT action_economy FROM campaigns WHERE id=$1', [campaignId])).rows[0].action_economy).toBe('dnd5e');
      await expect(setCampaignActionEconomy(strangerId, campaignId, 'attack_utility')).rejects.toThrow();
      await expect(setCampaignActionEconomy(dmId, campaignId, 'nonsense')).rejects.toThrow('Unknown action economy.');
      expect(await setCampaignActionEconomy(dmId, campaignId, 'attack_utility')).toEqual([characterId]);
      expect((await view()).actionEconomy).toBe('attack_utility');
      expect(await pools()).toEqual({ attack: '2/2', utility: '2/2' });

      // An equipped item linking "Extra Attack action (per turn)" makes it 3; unequipping drops it to 2.
      const modifierId = (await query<{ id: string }>(
        `SELECT id FROM modifier_definitions WHERE target='action_pool.attack.max' AND modifier_type='bonus' AND NOT is_archived LIMIT 1`)).rows[0]?.id;
      expect(modifierId, 'migration 045 seeds the Extra Attack action modifier').toBeTruthy();
      const ring = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1,'item','IT Haste Ring') RETURNING id`, [`item:${tag}ring`])).rows[0].id;
      contentIds.push(ring);
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,'equipped','1')`, [ring, modifierId]);
      const itemId = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, equipped) VALUES ($1,'IT Haste Ring',$2,true) RETURNING id`, [characterId, ring])).rows[0].id;
      expect((await pools()).attack).toBe('3/3');
      expect((await view()).turn.pools[0].breakdown.map((l) => l.label)).toEqual(['Base', 'IT Haste Ring']);
      await query(`UPDATE character_inventory_items SET equipped=false WHERE id=$1`, [itemId]);
      expect((await pools()).attack).toBe('2/2');

      // Extra Attack is seeded as melee and ranged follow-up modifiers.
      for (const key of ['followup.melee.count', 'followup.ranged.count']) {
        expect((await query<any>(`SELECT 1 FROM modifier_definitions WHERE target=$1 AND NOT is_archived`, [key])).rowCount, key).toBeGreaterThan(0);
      }

      // Manual -1, then Next Turn: full again and turn_seq + 1.
      await adjustTurnPool(dmId, characterId, 'attack', -1);
      expect((await pools()).attack).toBe('1/2');
      const before = (await view()).turn.turnSeq;
      await advanceCharacterTurn(dmId, characterId);
      expect((await pools()).attack).toBe('2/2');
      expect((await view()).turn.turnSeq).toBe(before + 1);
      // Clamped at 0..max, and an unknown pool for the profile is refused.
      await adjustTurnPool(dmId, characterId, 'utility', -9);
      expect((await pools()).utility).toBe('0/2');
      await adjustTurnPool(dmId, characterId, 'utility', 9);
      expect((await pools()).utility).toBe('2/2');
      await expect(adjustTurnPool(dmId, characterId, 'action', -1)).rejects.toThrow('has no action');
      await expect(adjustTurnPool(strangerId, characterId, 'attack', -1)).rejects.toThrow();

      // New Battle, Next Round and rests all reset.
      for (const reset of [
        () => newBattle(dmId, characterId),
        () => advanceCharacterRound(dmId, characterId),
        () => restCharacter(dmId, characterId, 'short_rest'),
        () => restCharacter(dmId, characterId, 'long_rest')
      ]) {
        await adjustTurnPool(dmId, characterId, 'attack', -2);
        expect((await pools()).attack).toBe('0/2');
        await reset();
        expect((await pools()).attack).toBe('2/2');
      }

      // A whole-sheet Save leaves the turn row alone.
      await adjustTurnPool(dmId, characterId, 'attack', -1);
      const form = new FormData();
      form.set('name', 'Turns');
      await updateCharacter(dmId, characterId, form, 'IT save');
      expect((await pools()).attack).toBe('1/2');

      // A profile switch reads as a fresh turn under the new profile (and back again).
      await setCampaignActionEconomy(adminId, campaignId, 'dnd5e'); // a site admin may
      expect(await pools()).toEqual({ action: '1/1', bonus_action: '1/1', reaction: '1/1' });
      expect((await view()).turn.log).toEqual([]);
      await setCampaignActionEconomy(dmId, campaignId, 'attack_utility');
      expect((await pools()).attack).toBe('1/2'); // the row still says attack_utility, spent 1, until something overwrites it
      await adjustTurnPool(dmId, characterId, 'attack', 1);

      // The log keeps what was done by hand.
      expect((await view()).turn.log.at(-1)).toMatchObject({ pool: 'attack', via: 'manual' });
    } finally {
      if (campaignId) await query('DELETE FROM campaigns WHERE id=$1', [campaignId]);
      await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[dmId, strangerId, adminId]]); // cascades the character and its turn row
      if (contentIds.length) await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
    }
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the deck service (decks unit 4). SKIPPED unless DECK_DB_TEST=1. Local DB only (guarded
// below). Creates a throwaway campaign, users and characters, and removes them at the end. The seeded
// Deck of Mystical Fate (migration 048) must already be applied (npm run db:migrate).
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   DECK_DB_TEST=1 npx vitest run src/lib/server/decks.integration.test.ts
const enabled = process.env.DECK_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
/** A die that returns the given values in order (then 1s). */
const seq = (...values: number[]) => { let i = 0; return () => values[i++] ?? 1; };

describe.skipIf(!enabled)('decks', () => {
  it('draws, applies, undoes, and seeds', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter, getCharacterForRoll } = await import('./services/characters');
    const { characterStatsFor } = await import('$lib/rules/characterStats');
    const { advanceCharacterRound, listCatalogue } = await import('./services/catalogue');
    const decks = await import('./services/decks');
    const tag = `zzdeck${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dmId = await newUser('-dm', 'IT DM');
    const p1 = await newUser('-p1', 'IT P1');
    const p2 = await newUser('-p2', 'IT P2');
    let campaignId = '';
    try {
      campaignId = (await query<{ id: string }>(
        'INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} deck`, code(10), code(8)])).rows[0].id;
      for (const [uid, role] of [[dmId, 'dm'], [p1, 'player'], [p2, 'player']] as const) {
        await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [campaignId, uid, role]);
      }
      const mk = async (owner: string, name: string, partyActive: boolean) => {
        const id = await createCharacter(owner, name);
        await query('UPDATE characters SET campaign_id = $2, party_active = $3 WHERE id = $1', [id, campaignId, partyActive]);
        return id;
      };
      const A = await mk(p1, 'Aria', true);
      const B = await mk(p2, 'Brom', true);
      const C = await mk(p1, 'Cass', true);
      const I = await mk(p2, 'Idle', false);
      const active = [A, B, C];
      const deckId = (await query<{ id: string }>(`SELECT id FROM content_definitions WHERE content_key = 'deck:mystical_fate' AND owner_user_id IS NULL`)).rows[0]?.id;
      expect(deckId, 'run npm run db:migrate (048 seeds the deck)').toBeTruthy();

      const setStats = (id: string, hp: number, max: number, temp: number, gp: number) => Promise.all([
        query(`UPDATE character_resources SET current_value=$2, max_value=$3 WHERE character_id=$1 AND resource_key='hp'`, [id, hp, max]),
        query(`UPDATE character_resources SET current_value=$2 WHERE character_id=$1 AND resource_key='temp_hp'`, [id, temp]),
        query(`UPDATE characters SET metadata_json = jsonb_set(metadata_json, '{currencyGp}', to_jsonb($2::int)) WHERE id=$1`, [id, gp])
      ]);
      const resetAll = () => Promise.all([A, B, C, I].map((id) => setStats(id, 20, 20, 0, 10)));
      const gold = async (id: string) => Number((await query<any>('SELECT metadata_json FROM characters WHERE id=$1', [id])).rows[0].metadata_json.currencyGp) || 0;
      const res = async (id: string, key: string) => (await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key=$2`, [id, key])).rows[0].current_value as number;
      const ac = async (id: string) => characterStatsFor((await getCharacterForRoll(id))!).armorClass.value;
      const draw = (characterId: string, userId: string, cardId: string, rollDie?: (s: number) => number) =>
        decks.drawCard({ userId, characterId, deckId, deps: { cardId, rollDie } });
      await resetAll();

      // Not enabled yet, then enabled by the DM only.
      await expect(draw(A, p1, 'gold:diamonds:4')).rejects.toMatchObject({ code: 'not_enabled' });
      await expect(decks.setCampaignDeck({ userId: p1, campaignId, deckId, enabled: true })).rejects.toMatchObject({ code: 'forbidden' });
      await decks.setCampaignDeck({ userId: dmId, campaignId, deckId, enabled: true });
      expect((await decks.listCampaignDecks(campaignId)).map((d) => d.name)).toEqual(['The Deck of Mystical Fate']);
      // A stranger cannot draw for someone else's character.
      const stranger = await newUser('-x', 'IT Stranger');
      await expect(draw(A, stranger, 'gold:diamonds:4')).rejects.toMatchObject({ code: 'forbidden' });

      // 4 of diamonds on a gold back (success): 4 gp each, the inactive member excluded; ledger matches.
      const four = await draw(A, p1, 'gold:diamonds:4');
      expect(four.status).toBe('resolved');
      expect(four.draw.success).toBe(true);
      for (const id of active) expect(await gold(id)).toBe(14);
      expect(await gold(I)).toBe(10);
      expect(four.draw.results.map((r) => [r.characterId, r.before, r.after]).sort()).toEqual(active.map((id) => [id, 10, 14]).sort());

      // Bounty of Fortune: three members rolling 4, 7, 2 = 13, each gets 23.
      await resetAll();
      const bounty = await draw(A, p1, 'gold:diamonds:J', seq(4, 7, 2));
      for (const id of active) expect(await gold(id)).toBe(33);
      expect(await gold(I)).toBe(10);
      expect(bounty.draw.outcome.rolls?.[0].total).toBe(13);

      // Failed 3 of clubs (black on gold): the drawer only gets -3 AC for 10 rounds, sourced from the drawer.
      await resetAll();
      const acBefore = await Promise.all(active.map(ac));
      const clubs = await draw(B, p2, 'gold:clubs:3');
      expect(clubs.draw.success).toBe(false);
      expect(await ac(B)).toBe(acBefore[1] - 3);
      expect(await ac(A)).toBe(acBefore[0]);
      const effect = (await query<any>(`SELECT * FROM active_character_effects WHERE id = $1`, [clubs.draw.results[0].effectRowId])).rows[0];
      expect(effect.source_character_id).toBe(B);
      expect(effect.remaining_rounds).toBe(10);
      expect(effect.metadata_json).toMatchObject({ params: { value: -3 }, sourceLabel: '3 of Clubs, failed', deckDrawId: clubs.draw.id });
      // The condition caps at 10 rounds.
      for (let i = 0; i < 10; i += 1) await advanceCharacterRound(p2, B);
      expect(await ac(B)).toBe(acBefore[1]);

      // Temp HP stacks (4 + 7 = 11); a failed 9 of hearts takes 9 off 4 temp HP (floored at 0, noted).
      await resetAll();
      await setStats(A, 20, 20, 4, 10);
      await draw(A, p1, 'gold:hearts:7');
      expect(await res(A, 'temp_hp')).toBe(11);
      await setStats(A, 20, 20, 4, 10);
      const sad = await draw(A, p1, 'black:hearts:9');
      expect(await res(A, 'temp_hp')).toBe(0);
      expect(sad.draw.results.find((r) => r.characterId === A)?.note).toContain('short');

      // A failed Queen of Hearts (2d10 + 5 = 15 damage) on 5 HP and 3 temp HP: temp first, then HP to 0, noted.
      await resetAll();
      await setStats(A, 5, 20, 3, 10);
      const queen = await draw(A, p1, 'black:hearts:Q', () => 5);
      expect(await res(A, 'hp')).toBe(0);
      expect(await res(A, 'temp_hp')).toBe(0);
      expect(queen.draw.results.find((r) => r.characterId === A)?.note).toBe('Dropped to 0 HP.');

      // An Ace asks first, refuses a second draw, and resolves when the value is chosen.
      await resetAll();
      const ace = await draw(A, p1, 'gold:diamonds:A');
      expect(ace.status).toBe('choosing');
      expect(ace.draw.previews).toBeTruthy();
      expect(Object.keys(ace.draw.previews!).sort()).toEqual(['1', '11']);
      await expect(draw(A, p1, 'gold:diamonds:4')).rejects.toMatchObject({ code: 'choosing' });
      await expect(decks.chooseValue({ userId: p1, drawId: ace.draw.id, value: 5 })).rejects.toMatchObject({ code: 'bad_input' });
      expect(await gold(A)).toBe(10);
      const chosen = await decks.chooseValue({ userId: p1, drawId: ace.draw.id, value: 11 });
      expect(chosen.status).toBe('resolved');
      for (const id of active) expect(await gold(id)).toBe(21);
      await expect(decks.chooseValue({ userId: p1, drawId: ace.draw.id, value: 11 })).rejects.toMatchObject({ code: 'not_choosing' });

      // The views the sheet and campaign page read.
      const view = await decks.listDecksForCharacter(p1, A);
      expect(view.decks).toHaveLength(1);
      expect(view.choosing).toBeNull();
      expect(view.recent[0].id).toBe(chosen.id);

      // Undo: a player cannot, the DM can, and a second undo is refused. Gold and conditions come back.
      await resetAll();
      const gift = await draw(A, p1, 'gold:diamonds:K', seq(1, 1, 1)); // King's Ransom: 20 + 3d10 split, plus a DM prompt
      expect(gift.draw.dmTasks).toHaveLength(1);
      const shield = await draw(C, p1, 'gold:clubs:3'); // failed: -3 AC on Cass
      expect(await ac(C)).toBe(acBefore[2] - 3);
      await expect(decks.revertDraw({ userId: p1, drawId: shield.draw.id })).rejects.toMatchObject({ code: 'forbidden' });
      const undone = await decks.revertDraw({ userId: dmId, drawId: shield.draw.id });
      expect(undone.status).toBe('reverted');
      expect(await ac(C)).toBe(acBefore[2]);
      await expect(decks.revertDraw({ userId: dmId, drawId: shield.draw.id })).rejects.toMatchObject({ code: 'already_undone' });
      const goldBefore = await Promise.all(active.map(gold));
      expect(goldBefore.reduce((a, b) => a + b, 0)).toBe(30 + 23); // 20 + 3 = 23 split among three, on top of 10 each
      const giftUndone = await decks.revertDraw({ userId: dmId, drawId: gift.draw.id });
      expect(giftUndone.dmTasks.every((task) => task.done)).toBe(true);
      for (const id of active) expect(await gold(id)).toBe(10);
      expect((await decks.listOpenDmTasks(dmId, campaignId)).filter((t) => t.drawId === gift.draw.id)).toEqual([]);

      // Undo clamps: spend the gold first, and the undo takes back only what is there, and says so.
      await resetAll();
      const four2 = await draw(A, p1, 'gold:diamonds:4');
      await query(`UPDATE characters SET metadata_json = jsonb_set(metadata_json, '{currencyGp}', '1'::jsonb) WHERE id = $1`, [A]);
      const clamped = await decks.revertDraw({ userId: dmId, drawId: four2.draw.id });
      expect(await gold(A)).toBe(0);
      expect(clamped.revertNote).toContain('Aria');

      // A DM task can be ticked, and shows in the open list until then.
      const joker = await draw(A, p1, 'gold:joker_red');
      expect(joker.draw.dmTasks[0].text).toBe('The party gains a high-powered magic item');
      expect((await decks.listOpenDmTasks(dmId, campaignId)).some((t) => t.drawId === joker.draw.id)).toBe(true);
      // Draw lists are for campaign members; open DM tasks for the DM only.
      await expect(decks.listOpenDmTasks(p1, campaignId)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(decks.listDrawsForCampaign(stranger, campaignId)).rejects.toMatchObject({ code: 'forbidden' });
      expect((await decks.listDrawsForCampaign(p1, campaignId)).length).toBeGreaterThan(0);
      await expect(decks.setDrawTaskDone({ userId: p1, drawId: joker.draw.id, taskId: joker.draw.dmTasks[0].id, done: true })).rejects.toMatchObject({ code: 'forbidden' });
      await decks.setDrawTaskDone({ userId: dmId, drawId: joker.draw.id, taskId: joker.draw.dmTasks[0].id, done: true });
      expect((await decks.listOpenDmTasks(dmId, campaignId)).some((t) => t.drawId === joker.draw.id)).toBe(false);

      // Two drawers on the same party at once: no deadlock, both sets of changes land.
      await resetAll();
      const both = await Promise.all([draw(A, p1, 'gold:diamonds:4'), draw(B, p2, 'gold:diamonds:5')]);
      expect(both.every((r) => r.status === 'resolved')).toBe(true);
      for (const id of active) expect(await gold(id)).toBe(19);

      // The seed: 108 cards, every card has an outcome, and rerunning 048 changes nothing.
      const deck = await decks.loadDeck(deckId);
      expect(deck!.rules.cards).toHaveLength(108);
      const counts = async () => (await query<any>(`SELECT
        (SELECT count(*) FROM content_definitions WHERE content_key LIKE 'condition:deck_fate_%' OR content_key = 'deck:mystical_fate') AS content,
        (SELECT count(*) FROM content_modifier_links l JOIN content_definitions c ON c.id = l.content_id WHERE c.content_key LIKE 'condition:deck_fate_%') AS links,
        (SELECT count(*) FROM deck_definitions) AS decks`)).rows[0];
      const beforeSeed = await counts();
      const seedSql = fs.readFileSync(path.resolve('src/lib/server/db/migrations/048_seed_deck_of_mystical_fate.sql'), 'utf8');
      await query(seedSql);
      await query(seedSql);
      expect(await counts()).toEqual(beforeSeed);
      expect(beforeSeed).toMatchObject({ content: '5', links: '4' });

      // The seeded conditions are hidden from the player's apply list and stack.
      const conditions = (await query<any>(`SELECT stack_behavior, metadata_json FROM content_definitions WHERE content_key LIKE 'condition:deck_fate_%'`)).rows;
      expect(conditions).toHaveLength(4);
      for (const row of conditions) {
        expect(row.stack_behavior).toBe('stack');
        expect(row.metadata_json).toMatchObject({ isCondition: false, isSelectable: false });
      }

      // A hidden deck condition applied by hand with no params: {value} resolves to 0, nothing throws, AC is unchanged.
      await resetAll();
      const { applyCharacterEffect } = await import('./services/effects');
      const { withTransaction } = await import('$lib/server/db');
      const acConditionId = (await query<{ id: string }>(`SELECT id FROM content_definitions WHERE content_key = 'condition:deck_fate_ac' AND owner_user_id IS NULL`)).rows[0].id;
      const acNow = await ac(A);
      await withTransaction((client) => applyCharacterEffect(client, A, acConditionId));
      expect(await ac(A)).toBe(acNow);
      await query('DELETE FROM active_character_effects WHERE character_id = $1', [A]);

      // A deck is not character content.
      const { addContentToCharacter } = await import('./services/catalogue');
      await expect(addContentToCharacter(p1, A, deckId)).rejects.toThrow('Decks cannot be added');

      // Decks never show in the catalogue browse.
      expect((await listCatalogue(p1)).some((entry) => entry.type === 'deck')).toBe(false);
    } finally {
      await query('DELETE FROM deck_draws WHERE campaign_id = $1', [campaignId || '00000000-0000-0000-0000-000000000000']);
      await query('DELETE FROM campaign_decks WHERE campaign_id = $1', [campaignId || '00000000-0000-0000-0000-000000000000']);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
      if (campaignId) await query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    }
  });
});

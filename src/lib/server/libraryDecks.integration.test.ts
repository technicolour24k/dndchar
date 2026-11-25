import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for decks in the homebrew library (unit E): personal decks (create, edit, archive, ownership walls,
// DM-tier only), "Save to my library", and library decks being REFERENCED by a campaign (enable gating, edits
// propagate, switching the library off keeps drawing, a library deck is never copied in).
// SKIPPED unless LIBRARY_DB_TEST=1. Local DB only (guarded below). Calls the services directly with throwaway users.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryDecks.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');

describe.skipIf(!enabled)('decks in the library', () => {
  it('authors personal decks, saves to the library, and enables them by reference', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const library = await import('./services/library');
    const decks = await import('./services/decks');
    const tag = `zzldeck${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dm1 = await newUser('-dm1', 'Lib DM One'); // DM of C1, and a player in C2 and C3
    const dm2 = await newUser('-dm2', 'Lib DM Two'); // DM of C2
    const dm3 = await newUser('-dm3', 'Lib DM Three'); // DM of C3
    const player = await newUser('-p', 'Lib Player'); // plays in C2
    const nobody = await newUser('-n', 'Lib Nobody'); // DMs nothing: no mechanics rights
    const campaigns: string[] = [];
    const newCampaign = async (name: string, members: Array<[string, string]>) => {
      const id = (await query<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} ${name}`, code(10), code(8)])).rows[0].id;
      campaigns.push(id);
      for (const [userId, role] of members) await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, role]);
      return id;
    };
    try {
      const c1 = await newCampaign('one', [[dm1, 'dm']]);
      const c2 = await newCampaign('two', [[dm2, 'dm'], [dm1, 'player'], [player, 'player']]);
      const c3 = await newCampaign('three', [[dm3, 'dm'], [dm1, 'player']]);
      const hero = await createCharacter(player, 'Hero');
      await query('UPDATE characters SET campaign_id = $2, party_active = true WHERE id = $1', [hero, c2]);
      const gold = async () => Number((await query<any>('SELECT metadata_json FROM characters WHERE id = $1', [hero])).rows[0].metadata_json.currencyGp) || 0;
      await query(`UPDATE characters SET metadata_json = jsonb_set(metadata_json, '{currencyGp}', '0'::jsonb) WHERE id = $1`, [hero]);

      const rulesFor = (gp: string) => JSON.stringify({
        version: 1, cards: [{ id: 'c1', label: 'Coin', tags: { kind: 'x' }, value: 3 }], success: { rules: [], otherwise: 'success' },
        outcomes: [{ id: 'o', when: {}, name: 'Payday', text: 'Coin.', steps: [{ type: 'currency', coin: 'gp', amount: gp, target: 'drawer' }] }]
      });

      // ---- E2: personal decks are DM-tier, owned, and personal-scoped
      await expect(decks.createPersonalDeck({ userId: nobody, name: 'Nope', description: '' })).rejects.toMatchObject({ code: 'forbidden' });
      const personal = await decks.createPersonalDeck({ userId: dm1, name: `${tag} personal`, description: 'mine' });
      const row = (await query<any>(
        `SELECT c.scope, c.owner_user_id, c.campaign_id, c.content_key, d.campaign_id AS mirror FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id WHERE c.id = $1`, [personal])).rows[0];
      expect(row).toMatchObject({ scope: 'personal', owner_user_id: dm1, campaign_id: null, mirror: null });
      expect(row.content_key.startsWith(`library:${dm1}:deck:`)).toBe(true);
      expect((await decks.listPersonalDecks(dm1)).map((d) => d.id)).toEqual([personal]);
      expect(await decks.listPersonalDecks(dm2)).toEqual([]);

      // Another user can't read, edit, archive or test it, and a non-DM can't write rules even on their own.
      expect(await decks.getPersonalDeck(dm2, personal)).toBeNull();
      expect(await decks.updatePersonalDeck({ userId: dm2, id: personal, name: 'hijack', description: '', rulesText: rulesFor('1') })).toMatchObject({ ok: false });
      expect(await decks.togglePersonalDeckArchived({ userId: dm2, id: personal, archived: true })).toBe(false);
      expect((await decks.dryRunPersonalDraw({ userId: dm2, id: personal, cardId: 'c1', success: 'auto' })).error).toBeTruthy();
      await expect(decks.updatePersonalDeck({ userId: nobody, id: personal, name: 'x', description: '', rulesText: rulesFor('1') })).rejects.toMatchObject({ code: 'forbidden' });
      expect((await decks.getPersonalDeck(dm1, personal))?.name).toBe(`${tag} personal`);

      // Edit, test draw, archive and restore. A bad condition key is refused (global conditions only for now).
      expect((await decks.updatePersonalDeck({ userId: dm1, id: personal, name: `${tag} personal`, description: 'mine', rulesText: rulesFor('5') })).ok).toBe(true);
      expect((await decks.dryRunPersonalDraw({ userId: dm1, id: personal, cardId: 'c1', success: 'auto' })).lines.join('\n')).toMatch(/Aria gains 5 gp/);
      const badKey = rulesFor('5').replace('"steps":[', '"steps":[{"type":"condition","conditionKey":"condition:nope_zz","params":{},"target":"drawer"},');
      expect((await decks.updatePersonalDeck({ userId: dm1, id: personal, name: 'n', description: '', rulesText: badKey })).ok).toBe(false);
      expect(await decks.togglePersonalDeckArchived({ userId: dm1, id: personal, archived: true })).toBe(true);
      expect((await decks.listPersonalDecks(dm1))[0].archived).toBe(true);
      expect(await decks.togglePersonalDeckArchived({ userId: dm1, id: personal, archived: false })).toBe(true);

      // Not global, not a campaign deck, not copyable, and invisible to a campaign whose DM has not switched the library on.
      const mgmtC2 = await decks.listDecksForManagement(dm2, c2);
      expect(mgmtC2.global.map((d) => d.id)).not.toContain(personal);
      expect(mgmtC2.library).toEqual([]); // dm1's library is off in C2
      expect((await decks.listAvailableDecks(c2)).map((d) => d.id)).not.toContain(personal);
      await expect(decks.setCampaignDeck({ userId: dm2, campaignId: c2, deckId: personal, enabled: true })).rejects.toMatchObject({ code: 'not_found' });
      await expect(decks.copyDeckToCampaign({ userId: dm2, campaignId: c2, sourceId: personal })).rejects.toMatchObject({ code: 'not_found' });

      // ---- E3: Save to my library
      const campaignDeck = await decks.createDeck({ userId: dm1, campaignId: c1, name: `${tag} table deck`, description: 'from c1' });
      expect((await decks.updateDeck({ userId: dm1, campaignId: c1, id: campaignDeck, name: `${tag} table deck`, description: 'from c1', rulesText: rulesFor('5') })).ok).toBe(true);
      await expect(decks.saveDeckToLibrary({ userId: dm2, campaignId: c1, deckId: campaignDeck })).rejects.toMatchObject({ code: 'forbidden' }); // not a manager of C1
      await expect(decks.saveDeckToLibrary({ userId: dm1, campaignId: c1, deckId: personal })).rejects.toMatchObject({ code: 'not_found' }); // only the campaign's own decks
      expect((await decks.listDecksForManagement(dm1, c1)).canSaveToLibrary).toBe(true);
      const saved = await decks.saveDeckToLibrary({ userId: dm1, campaignId: c1, deckId: campaignDeck });
      expect(saved).not.toBe(campaignDeck);
      expect((await query<any>('SELECT scope, owner_user_id, campaign_id, name, description FROM content_definitions WHERE id = $1', [saved])).rows[0])
        .toMatchObject({ scope: 'personal', owner_user_id: dm1, campaign_id: null, name: `${tag} table deck`, description: 'from c1' });
      expect(JSON.parse((await decks.getPersonalDeck(dm1, saved))!.rulesText)).toEqual(JSON.parse((await decks.getOwnDeck(dm1, c1, campaignDeck))!.rulesText));
      // The campaign deck is unchanged, and the two are independent afterwards.
      expect((await query<any>('SELECT scope, campaign_id FROM content_definitions WHERE id = $1', [campaignDeck])).rows[0]).toMatchObject({ scope: 'campaign', campaign_id: c1 });
      expect((await decks.updatePersonalDeck({ userId: dm1, id: saved, name: `${tag} table deck`, description: '', rulesText: rulesFor('7') })).ok).toBe(true);
      expect(JSON.parse((await decks.getOwnDeck(dm1, c1, campaignDeck))!.rulesText).outcomes[0].steps[0].amount).toBe('5');

      // ---- E3: C2 uses the library deck by reference
      await library.setCampaignLibrary(dm2, c2, dm1, true);
      const listed = (await decks.listDecksForManagement(dm2, c2)).library.find((d) => d.id === saved);
      expect(listed).toMatchObject({ ownerName: 'Lib DM One', libraryOn: true, enabled: false, mine: false });
      expect((await decks.listAvailableDecks(c2)).map((d) => d.id)).toContain(saved);
      await expect(decks.setCampaignDeck({ userId: player, campaignId: c2, deckId: saved, enabled: true })).rejects.toMatchObject({ code: 'forbidden' });
      await decks.setCampaignDeck({ userId: dm2, campaignId: c2, deckId: saved, enabled: true });
      // Another campaign whose DM has not switched dm1's library on can't enable it.
      await expect(decks.setCampaignDeck({ userId: dm3, campaignId: c3, deckId: saved, enabled: true })).rejects.toMatchObject({ code: 'not_found' });

      await decks.drawCard({ userId: player, characterId: hero, deckId: saved, deps: { cardId: 'c1' } });
      expect(await gold()).toBe(7); // the personal deck's current rules (7), not the campaign deck's (5)

      // Editing the personal deck changes the very next C2 draw: it is referenced, not copied.
      expect((await decks.updatePersonalDeck({ userId: dm1, id: saved, name: `${tag} table deck`, description: '', rulesText: rulesFor('20') })).ok).toBe(true);
      await decks.drawCard({ userId: player, characterId: hero, deckId: saved, deps: { cardId: 'c1' } });
      expect(await gold()).toBe(27);

      // Switching the library off pulls nothing: it still draws, is still listed (labelled), and can be turned off but not on.
      await library.setCampaignLibrary(dm2, c2, dm1, false);
      await decks.drawCard({ userId: player, characterId: hero, deckId: saved, deps: { cardId: 'c1' } });
      expect(await gold()).toBe(47);
      const offList = (await decks.listDecksForManagement(dm2, c2)).library.find((d) => d.id === saved);
      expect(offList).toMatchObject({ libraryOn: false, enabled: true });
      expect((await decks.listCampaignDecks(c2)).map((d) => d.id)).toContain(saved);
      await decks.setCampaignDeck({ userId: dm2, campaignId: c2, deckId: saved, enabled: false });
      await expect(decks.setCampaignDeck({ userId: dm2, campaignId: c2, deckId: saved, enabled: true })).rejects.toMatchObject({ code: 'not_found' });

      // Archiving the library deck stops draws where it is enabled (the existing rule), and a restore brings it back.
      await library.setCampaignLibrary(dm2, c2, dm1, true);
      await decks.setCampaignDeck({ userId: dm2, campaignId: c2, deckId: saved, enabled: true });
      expect(await decks.togglePersonalDeckArchived({ userId: dm1, id: saved, archived: true })).toBe(true);
      await expect(decks.drawCard({ userId: player, characterId: hero, deckId: saved, deps: { cardId: 'c1' } })).rejects.toMatchObject({ code: 'not_enabled' });
      expect((await decks.listDecksForManagement(dm2, c2)).library.find((d) => d.id === saved)?.archived).toBe(true); // attached, so still listed
      expect(await decks.togglePersonalDeckArchived({ userId: dm1, id: saved, archived: false })).toBe(true);
      await decks.drawCard({ userId: player, characterId: hero, deckId: saved, deps: { cardId: 'c1' } });
      expect(await gold()).toBe(67);

      // Another campaign DM can never edit it from the campaign page (not an owned campaign deck).
      expect(await decks.getOwnDeck(dm2, c2, saved)).toBeNull();
      expect((await decks.updateDeck({ userId: dm2, campaignId: c2, id: saved, name: 'hijack', description: '', rulesText: rulesFor('1') })).ok).toBe(false);
      expect(await decks.toggleDeckArchived({ userId: dm2, campaignId: c2, id: saved, archived: true })).toBe(false);
    } finally {
      const ids = campaigns.length ? campaigns : ['00000000-0000-0000-0000-000000000000'];
      await query('DELETE FROM deck_draws WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaign_decks WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM characters WHERE campaign_id = ANY($1::uuid[]) OR owner_user_id IN (SELECT id FROM users WHERE email LIKE $2)', [ids, `${tag}%`]);
      await query(`DELETE FROM deck_definitions WHERE content_id IN (SELECT id FROM content_definitions WHERE content_type = 'deck' AND name LIKE '%' || $1 || '%')`, [tag]);
      await query(`DELETE FROM content_definitions WHERE content_type = 'deck' AND name LIKE '%' || $1 || '%'`, [tag]);
      await query('DELETE FROM campaign_members WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

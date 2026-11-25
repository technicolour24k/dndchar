import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks that a personal library entry (or a campaign entry) does not leak out of its scope
// (homebrew library unit B). SKIPPED unless LIBRARY_DB_TEST=1. Local DB only (guarded below). Calls the services and
// the search route handler directly with throwaway users; it never forges a session.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryLeaks.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe.skipIf(!enabled)('library leak paths', () => {
  it('keeps personal and campaign entries inside their scope on every read and add path', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { invalidateReferenceData } = await import('$lib/server/cache/referenceData');
    const { createCharacter } = await import('./services/characters');
    const library = await import('./services/library');
    const catalogue = await import('./services/catalogue');
    const admin = await import('./services/content-admin');
    const decks = await import('./services/decks');
    const { GET } = await import('../../routes/api/catalogue/search/+server');
    const tag = `zzleak${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dmId = await newUser('-dm', 'Leak DM');
    const playerId = await newUser('-player', 'Leak Player');
    const outsiderId = await newUser('-out', 'Leak Outsider');
    let c1 = '';
    let c2 = '';
    let characterId = '';
    try {
      const newCampaign = async (name: string) => (await query<{ id: string }>(
        'INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} ${name}`, code(10), code(8)])).rows[0].id;
      c1 = await newCampaign('c1');
      c2 = await newCampaign('c2');
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [c1, dmId, 'dm', playerId, 'player']);
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [c2, dmId, 'dm']);
      characterId = await createCharacter(playerId, 'Aria');
      await query('UPDATE characters SET campaign_id = $2 WHERE id = $1', [characterId, c1]);

      const insert = async (name: string, type: string, over: { scope?: string; owner?: string | null; campaign?: string | null; key?: string } = {}) => (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, source_kind, owner_user_id, scope, campaign_id)
         VALUES ($1, $2, $3, 'homebrew', $4, $5, $6) RETURNING id`,
        [over.key ?? `library:${tag}:${name}:${crypto.randomBytes(3).toString('hex')}`, type, `${tag} ${name}`, over.owner ?? null, over.scope ?? 'personal', over.campaign ?? null])).rows[0].id;
      const globalItem = await insert('global-item', 'item', { scope: 'global', key: `leaktest:${tag}:global-item` });
      const dmItem = await insert('dm-item', 'item', { owner: dmId });
      const dmItemB = await insert('dm-item-b', 'item', { owner: dmId });
      const dmFeat = await insert('dm-feat', 'feat', { owner: dmId });
      const dmSpell = await insert('dm-spell', 'spell', { owner: dmId });
      const dmCondition = await insert('dm-condition', 'condition', { owner: dmId });
      const outsiderItem = await insert('outsider-item', 'item', { owner: outsiderId });
      const c1Entry = await insert('c1-entry', 'item', { scope: 'campaign', campaign: c1 });
      invalidateReferenceData('leak test'); // the search index is cached, so make it reload our rows

      // ---- B1: the search endpoint
      const search = async (userId: string, params: Record<string, string>) => {
        const url = new URL(`http://x/api/catalogue/search?${new URLSearchParams({ type: 'item', q: tag, ...params })}`);
        const response = await GET({ url, locals: { user: { id: userId } } } as any);
        return { status: response.status, body: await response.json() as { entries: Array<{ id: string; sourceLabel: string }>; error?: string } };
      };
      const ids = (result: Awaited<ReturnType<typeof search>>) => result.body.entries.map((entry) => entry.id);

      expect((await search(playerId, { characterId, campaignId: c1 })).status).toBe(400);
      expect(await search(outsiderId, { characterId })).toMatchObject({ status: 403, body: { entries: [], error: 'not_allowed' } });
      expect((await search(outsiderId, { campaignId: c1 })).status).toBe(403);
      const off = await search(playerId, { characterId });
      expect(ids(off)).toContain(globalItem);
      expect(ids(off)).toContain(c1Entry); // a campaign entry of C1 is offered to C1 characters
      expect(ids(off)).not.toContain(dmItem); // the DM's library is off
      expect(ids(off)).not.toContain(outsiderItem);
      expect(off.body.entries.find((entry) => entry.id === c1Entry)?.sourceLabel).toBe('Campaign');
      // Another campaign's character-less viewer (the Outsider on their own pages) sees only their own library.
      const own = await search(outsiderId, {});
      expect(ids(own)).toContain(outsiderItem);
      expect(ids(own)).not.toContain(dmItem);
      expect(ids(own)).not.toContain(c1Entry);

      // ---- B3: the authoritative add check (uncached)
      await expect(catalogue.addContentToCharacter(playerId, characterId, dmItem)).rejects.toThrow('Catalogue entry not found.');
      await expect(catalogue.addContentToCharacter(playerId, characterId, outsiderItem)).rejects.toThrow('Catalogue entry not found.');
      await catalogue.addContentToCharacter(playerId, characterId, c1Entry);
      await catalogue.addContentToCharacter(playerId, characterId, globalItem);
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      await catalogue.addContentToCharacter(playerId, characterId, dmItem); // now it can be added
      await expect(catalogue.addContentToCharacter(playerId, characterId, outsiderItem)).rejects.toThrow('Catalogue entry not found.');
      await expect(catalogue.addContentToCharacter(playerId, characterId, dmCondition)).rejects.toThrow('Catalogue entry not found.'); // wrong type
      const on = await search(playerId, { characterId });
      expect(ids(on)).toContain(dmItem);
      expect(on.body.entries.find((entry) => entry.id === dmItem)?.sourceLabel).toBe("Leak DM's homebrew");
      // Switching it off pulls nothing that is already held (visibility gates new use only).
      await library.setCampaignLibrary(dmId, c1, dmId, false);
      const held = (await query<{ n: number }>('SELECT count(*)::int AS n FROM character_inventory_items WHERE character_id = $1 AND source_content_id = $2', [characterId, dmItem])).rows[0].n;
      expect(held).toBe(1);
      await expect(catalogue.addContentToCharacter(playerId, characterId, dmItemB)).rejects.toThrow('Catalogue entry not found.');

      // ---- B1: the browse list defaults to global plus your own library
      const browse = async (userId: string) => (await catalogue.listCatalogue(userId, 'item', tag)).map((entry) => entry.id);
      expect(await browse(dmId)).toEqual(expect.arrayContaining([globalItem, dmItem]));
      expect(await browse(dmId)).not.toContain(outsiderItem);
      expect(await browse(playerId)).toContain(globalItem);
      expect(await browse(playerId)).not.toContain(dmItem);

      // ---- B4: references, candidates and action containers
      await expect(catalogue.grantContentFromContent(form({ sourceContentId: globalItem, grantedContentId: dmFeat, activationType: 'equipped' }))).rejects.toThrow('cannot be used');
      await catalogue.grantContentFromContent(form({ sourceContentId: dmItem, grantedContentId: dmFeat, activationType: 'equipped' }));
      expect((await query('SELECT 1 FROM content_grants WHERE source_content_id = $1 AND granted_content_id = $2', [dmItem, dmFeat])).rows).toHaveLength(1);
      await expect(admin.attachEffectToAdminContent(form({ contentId: globalItem, effectId: dmCondition, activationType: 'equipped' }))).rejects.toThrow('cannot be used');
      await expect(admin.addSpellAccess(form({ contentId: globalItem, spellContentId: dmSpell }))).rejects.toThrow('cannot be used');
      const globalAction = await insert('global-action', 'action', { scope: 'global', key: `leaktest:${tag}:global-action` });
      const personalAction = await insert('dm-action', 'action', { owner: dmId });
      await expect(admin.attachActionToContent(form({ contentId: globalItem, actionId: personalAction }))).rejects.toThrow('cannot be used');
      await admin.attachActionToContent(form({ contentId: dmItem, actionId: personalAction }));
      await admin.attachActionToContent(form({ contentId: globalItem, actionId: globalAction }));
      // Candidate lists: the selected personal item may reference its owner's entries, a global item may not.
      const forPersonal = await admin.loadContentAdmin(['item'], dmItem);
      expect(forPersonal.grantCandidates.map((row: any) => row.id)).toContain(dmFeat);
      expect(forPersonal.actionCandidates.map((row: any) => row.id)).toContain(personalAction);
      const forGlobal = await admin.loadContentAdmin(['item'], globalItem);
      expect(forGlobal.grantCandidates.map((row: any) => row.id)).not.toContain(dmFeat);
      expect(forGlobal.spellCandidates.map((row: any) => row.id)).not.toContain(dmSpell);
      expect(forGlobal.effects.map((row: any) => row.id)).not.toContain(dmCondition);
      expect(forGlobal.actionCandidates.map((row: any) => row.id)).not.toContain(personalAction);
      // An action container made for a personal item is personal, with the same owner and no campaign.
      await admin.addContentResourceAction(form({ contentId: dmItemB, activationType: 'on_use', stepType: 'roll_output', valueExpression: '1', actionLabel: 'Zap' }));
      const container = (await query<any>(
        `SELECT a.scope, a.owner_user_id, a.campaign_id FROM content_action_links l JOIN content_definitions a ON a.id = l.action_container_id WHERE l.content_id = $1`, [dmItemB])).rows[0];
      expect(container).toEqual({ scope: 'personal', owner_user_id: dmId, campaign_id: null });
      // A forged step delete (right step id, wrong content) removes nothing; the right content removes it.
      const step = (await query<{ id: string }>(
        `SELECT s.id FROM action_steps s JOIN content_action_links l ON l.action_container_id = s.container_id WHERE l.content_id = $1`, [dmItemB])).rows[0].id;
      await admin.removeContentResourceAction(form({ contentId: dmItem, actionId: step }));
      expect((await query('SELECT 1 FROM action_steps WHERE id = $1', [step])).rows).toHaveLength(1);
      await admin.removeContentResourceAction(form({ contentId: dmItemB, actionId: step }));
      expect((await query('SELECT 1 FROM action_steps WHERE id = $1', [step])).rows).toHaveLength(0);

      // ---- B5: deck predicates
      const personalDeck = await insert('dm-deck', 'deck', { owner: dmId });
      await query(`INSERT INTO deck_definitions (content_id, rules_json) VALUES ($1, '{}'::jsonb)`, [personalDeck]);
      expect((await decks.listAvailableDecks(c1)).map((row) => row.id)).not.toContain(personalDeck); // library off
      await expect(decks.setCampaignDeck({ userId: dmId, campaignId: c1, deckId: personalDeck, enabled: true })).rejects.toMatchObject({ code: 'not_found' });
      await expect(decks.copyDeckToCampaign({ userId: dmId, campaignId: c1, sourceId: personalDeck })).rejects.toMatchObject({ code: 'not_found' });
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      expect((await decks.listAvailableDecks(c1)).map((row) => row.id)).toContain(personalDeck);
      expect((await decks.listAvailableDecks(c2)).map((row) => row.id)).not.toContain(personalDeck); // c2's library is still off
      await decks.setCampaignDeck({ userId: dmId, campaignId: c1, deckId: personalDeck, enabled: true });
      await library.setCampaignLibrary(dmId, c1, dmId, false);
      // In use: it still lists as enabled, and can be switched off, but not back on while the library is off.
      expect((await decks.listCampaignDecks(c1)).map((row) => row.id)).toContain(personalDeck);
      await decks.setCampaignDeck({ userId: dmId, campaignId: c1, deckId: personalDeck, enabled: false });
      await expect(decks.setCampaignDeck({ userId: dmId, campaignId: c1, deckId: personalDeck, enabled: true })).rejects.toMatchObject({ code: 'not_found' });
      // The seeded global deck is still listed and copyable.
      const seed = (await query<{ id: string }>(`SELECT id FROM content_definitions WHERE content_key = 'deck:mystical_fate' AND owner_user_id IS NULL`)).rows[0]?.id;
      if (seed) expect((await decks.listDecksForManagement(dmId, c1)).global.map((row) => row.id)).toContain(seed);

      // ---- countHolders: condition keys are matched whole, so condition:x does not count condition:x2
      const condX = await insert('cond-x', 'condition', { owner: dmId, key: `condition:${tag}-x` });
      const condX2 = await insert('cond-x2', 'condition', { owner: dmId, key: `condition:${tag}-x2` });
      const deckWithX2 = await insert('deck-x2', 'deck', { owner: dmId });
      await query(`INSERT INTO deck_definitions (content_id, rules_json) VALUES ($1, $2::jsonb)`, [deckWithX2, JSON.stringify({ cards: [{ conditionKey: `condition:${tag}-x2` }] })]);
      expect((await library.countHolders({ query }, condX)).decks).toBe(0);
      expect((await library.countHolders({ query }, condX2)).decks).toBe(1);
    } finally {
      await query('DELETE FROM campaign_decks WHERE campaign_id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM character_inventory_items WHERE character_id = $1', [characterId]);
      await query('DELETE FROM character_content_instances WHERE character_id = $1', [characterId]);
      await query('DELETE FROM characters WHERE id = $1', [characterId]);
      const ours = `SELECT id FROM content_definitions WHERE name LIKE '%' || $1 || '%'`;
      await query(`DELETE FROM content_action_links WHERE content_id IN (${ours}) OR action_container_id IN (${ours})`, [tag]);
      await query(`DELETE FROM deck_definitions WHERE content_id IN (${ours})`, [tag]);
      await query(`DELETE FROM content_definitions WHERE name LIKE '%' || $1 || '%'`, [tag]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM campaign_members WHERE campaign_id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

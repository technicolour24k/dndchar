import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the homebrew library scope helpers (library unit A). SKIPPED unless LIBRARY_DB_TEST=1.
// Local DB only (guarded below). Creates throwaway users, campaigns and content, and removes them at the end.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryDb.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');

describe.skipIf(!enabled)('library scope helpers', () => {
  it('scopes by campaign, opt-in libraries, membership and role', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const library = await import('./services/library');
    const { isVisibleForNewUse } = await import('$lib/library/rules');
    const tag = `zzlib${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dmId = await newUser('-dm', 'IT DM');
    const playerId = await newUser('-player', 'IT Player');
    const outsiderId = await newUser('-out', 'IT Outsider');
    let c1 = '';
    let c2 = '';
    const characters: string[] = [];
    try {
      const newCampaign = async (name: string) => (await query<{ id: string }>(
        'INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} ${name}`, code(10), code(8)])).rows[0].id;
      c1 = await newCampaign('c1');
      c2 = await newCampaign('c2');
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [c1, dmId, 'dm', playerId, 'player']);
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [c2, dmId, 'dm']);
      const characterId = await createCharacter(playerId, 'Aria');
      characters.push(characterId);
      await query('UPDATE characters SET campaign_id = $2 WHERE id = $1', [characterId, c1]);

      // One personal item each, a hidden one for the DM, and a campaign entry for each campaign.
      const insert = async (name: string, over: { scope: string; owner?: string | null; campaign?: string | null; hidden?: boolean }) => (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, source_kind, owner_user_id, scope, campaign_id, hidden_from_players)
         VALUES ($1, 'item', $2, 'homebrew', $3, $4, $5, $6) RETURNING id`,
        [`library:${tag}:${name}:${crypto.randomBytes(3).toString('hex')}`, `${tag} ${name}`, over.owner ?? null, over.scope, over.campaign ?? null, over.hidden ?? false])).rows[0].id;
      const dmItem = await insert('dm-item', { scope: 'personal', owner: dmId });
      const dmHidden = await insert('dm-hidden', { scope: 'personal', owner: dmId, hidden: true });
      const playerItem = await insert('player-item', { scope: 'personal', owner: playerId });
      const outsiderItem = await insert('outsider-item', { scope: 'personal', owner: outsiderId });
      const c1Entry = await insert('c1-entry', { scope: 'campaign', campaign: c1 });
      const c2Entry = await insert('c2-entry', { scope: 'campaign', campaign: c2 });
      const facts = async (id: string) => {
        const row = (await query<any>('SELECT * FROM content_definitions WHERE id = $1', [id])).rows[0];
        return { scope: row.scope, ownerUserId: row.owner_user_id, campaignId: row.campaign_id, hiddenFromPlayers: row.hidden_from_players, isArchived: row.is_archived, type: row.content_type };
      };
      const sees = async (scope: Awaited<ReturnType<typeof library.resolveVisibleScope>>, id: string) => isVisibleForNewUse(await facts(id), scope);

      // No settings row: the DM's library is off for the Player's character. Their own library is a member library too, so also off.
      const before = await library.resolveVisibleScope({ query }, playerId, { characterId });
      expect(before.campaignId).toBe(c1);
      expect(before.ownerIds).toEqual([]);
      expect(await sees(before, dmItem)).toBe(false);
      expect(await sees(before, outsiderItem)).toBe(false);
      // A campaign entry is visible to its own campaign only.
      expect(await sees(before, c1Entry)).toBe(true);
      expect(await sees(before, c2Entry)).toBe(false);

      // The DM switches their library on: the Player's character now sees it, but not the hidden entry.
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      const after = await library.resolveVisibleScope({ query }, playerId, { characterId });
      expect(after.ownerIds).toEqual([dmId]);
      expect(await sees(after, dmItem)).toBe(true);
      expect(await sees(after, dmHidden)).toBe(false);
      expect(await sees(after, playerItem)).toBe(false); // the Player's own library is still off
      expect(await sees(after, outsiderItem)).toBe(false); // the Outsider is never included
      // The DM sees their own hidden entry (managers see every enabled owner's hidden entries).
      const dmScope = await library.resolveVisibleScope({ query }, dmId, { campaignId: c1 });
      expect(await sees(dmScope, dmHidden)).toBe(true);
      // The uncached assert agrees.
      await expect(library.assertVisibleForNewUse({ query }, dmItem, after, ['item'])).resolves.toMatchObject({ type: 'item' });
      await expect(library.assertVisibleForNewUse({ query }, dmItem, after, ['spell'])).rejects.toThrow('not found');
      await expect(library.assertVisibleForNewUse({ query }, outsiderItem, after)).rejects.toThrow('not found');

      // Switching it off again removes it from the set (new use only; nothing is deleted).
      await library.setCampaignLibrary(dmId, c1, dmId, false);
      expect((await library.resolveVisibleScope({ query }, playerId, { characterId })).ownerIds).toEqual([]);
      expect((await query('SELECT 1 FROM content_definitions WHERE id = $1', [dmItem])).rows).toHaveLength(1);

      // A campaign-less viewer gets global plus their own library.
      const own = await library.resolveVisibleScope({ query }, playerId);
      expect(own.campaignId).toBeNull();
      expect(await sees(own, playerItem)).toBe(true);
      expect(await sees(own, dmItem)).toBe(false);

      // The Outsider cannot use the Player's character id or campaign id.
      await expect(library.resolveVisibleScope({ query }, outsiderId, { characterId })).rejects.toThrow('Character not found.');
      await expect(library.resolveVisibleScope({ query }, outsiderId, { campaignId: c1 })).rejects.toThrow('Campaign not found.');
      await expect(library.resolveVisibleScope({ query }, playerId, { characterId, campaignId: c1 })).rejects.toThrow('not both');

      // setCampaignLibrary is refused for the Player, for a non-member owner, and for an archived campaign.
      await expect(library.setCampaignLibrary(playerId, c1, dmId, true)).rejects.toThrow('Campaign not found.');
      await expect(library.setCampaignLibrary(dmId, c1, outsiderId, true)).rejects.toThrow('not a member');
      const rows = (await query<any>('SELECT owner_user_id, is_enabled FROM campaign_library_settings WHERE campaign_id = $1', [c1])).rows;
      expect(rows).toEqual([{ owner_user_id: dmId, is_enabled: false }]);

      // Ownership checks.
      await expect(library.assertOwnedLibraryEntry({ query }, { userId: playerId }, playerItem)).resolves.toMatchObject({ scope: 'personal' });
      await expect(library.assertOwnedLibraryEntry({ query }, { userId: playerId }, dmItem)).rejects.toThrow('not found');
      await expect(library.assertCampaignEntry({ query }, dmId, c1, c1Entry)).resolves.toMatchObject({ scope: 'campaign' });
      await expect(library.assertCampaignEntry({ query }, dmId, c1, c2Entry)).rejects.toThrow('not found');
      await expect(library.assertCampaignEntry({ query }, playerId, c1, c1Entry)).rejects.toThrow('Campaign not found.');

      // Reference check: a personal entry may point at the same owner's, not another's; a global one never at a personal one.
      await expect(library.assertReferenceAllowed({ query }, dmItem, dmHidden)).resolves.toBeUndefined();
      await expect(library.assertReferenceAllowed({ query }, dmItem, playerItem)).rejects.toThrow('cannot be used');

      // Holders: an item held by a character is counted.
      await query(`INSERT INTO character_inventory_items (character_id, name, source_content_id) VALUES ($1, 'Held', $2)`, [characterId, dmItem]);
      expect(await library.countHolders({ query }, dmItem)).toEqual({ characters: 1, findTables: 0, campaigns: 0, decks: 0 });

      // Roles: a DM of a live campaign can author mechanics, a Player cannot.
      expect(await library.loadLibraryActor({ query }, dmId)).toMatchObject({ canAuthorMechanics: true, dmCampaignCount: 2 });
      expect(await library.loadLibraryActor({ query }, playerId)).toMatchObject({ canAuthorMechanics: false, dmCampaignCount: 0 });
      // An archived campaign no longer counts toward the DM tier.
      await query('UPDATE campaigns SET is_archived = true WHERE id = ANY($1::uuid[])', [[c1, c2]]);
      expect(await library.loadLibraryActor({ query }, dmId)).toMatchObject({ canAuthorMechanics: false, dmCampaignCount: 0 });
      await expect(library.setCampaignLibrary(dmId, c1, dmId, true)).rejects.toThrow('Campaign not found.'); // DM loses canManage on archive
    } finally {
      for (const id of characters) {
        await query('DELETE FROM character_inventory_items WHERE character_id = $1', [id]);
        await query('DELETE FROM characters WHERE id = $1', [id]);
      }
      await query('DELETE FROM content_definitions WHERE content_key LIKE $1', [`library:${tag}:%`]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM campaign_members WHERE campaign_id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [[c1, c2]]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

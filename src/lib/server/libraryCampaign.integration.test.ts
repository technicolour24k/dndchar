import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for the campaign side of the homebrew library (unit D): the member libraries page data, the
// read-only /catalogue browse, and the forage item picker rules and labels. SKIPPED unless LIBRARY_DB_TEST=1.
// Local DB only (guarded below). Calls the services and load functions directly with throwaway users.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryCampaign.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe.skipIf(!enabled)('campaign library pages and forage picker', () => {
  it('lists libraries, browses read-only by scope, and gates and labels forage items', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { invalidateReferenceData } = await import('$lib/server/cache/referenceData');
    const library = await import('./services/library');
    const forage = await import('./services/forage');
    const browse = await import('../../routes/catalogue/+page.server');
    const tag = `zzcamp${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string, role = 'user') => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${suffix}@example.invalid`, name, role])).rows[0].id;
    const dmId = await newUser('-dm', 'Camp DM');
    const playerId = await newUser('-player', 'Camp Player');
    const outsiderId = await newUser('-out', 'Camp Outsider');
    const adminId = await newUser('-admin', 'Camp Admin', 'admin');
    let c1 = '';
    let tableId = '';
    try {
      c1 = (await query<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} c1`, code(10), code(8)])).rows[0].id;
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [c1, dmId, 'dm', playerId, 'player']);
      const insert = async (name: string, over: { owner?: string; hidden?: boolean } = {}) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name, source_kind, owner_user_id, scope, hidden_from_players)
           VALUES ($1, 'item', $2, 'homebrew', $3, 'personal', $4) RETURNING id`,
          [`library:${tag}:${name}:${crypto.randomBytes(3).toString('hex')}`, `${tag} ${name}`, over.owner, over.hidden ?? false])).rows[0].id;
        await query('INSERT INTO item_definitions (content_id) VALUES ($1)', [id]);
        return id;
      };
      const dmItem = await insert('dm-item', { owner: dmId });
      const dmHidden = await insert('dm-hidden', { owner: dmId, hidden: true });
      const dmItemB = await insert('dm-item-b', { owner: dmId });
      const outsiderItem = await insert('outsider-item', { owner: outsiderId });
      invalidateReferenceData('campaign test');

      // ---- D1: the page data
      const asPlayer = (await library.loadCampaignLibraryPage({ query }, playerId, c1))!;
      expect(asPlayer.canManage).toBe(false);
      expect(asPlayer.members.map((m) => m.userId)).toEqual([dmId, playerId]); // the DM first
      const dmRow = (viewer: typeof asPlayer) => viewer.members.find((m) => m.userId === dmId)!;
      expect(dmRow(asPlayer)).toMatchObject({ enabled: false, role: 'dm', counts: null }); // an off library's contents stay private to players
      expect(asPlayer.members.find((m) => m.userId === playerId)!.counts).not.toBeNull(); // your own are always shown
      const asDm = (await library.loadCampaignLibraryPage({ query }, dmId, c1))!;
      expect(asDm.canManage).toBe(true);
      expect(dmRow(asDm).counts?.item).toBe(3); // the DM sees all of their own
      expect(await library.loadCampaignLibraryPage({ query }, outsiderId, c1)).toBeNull();
      expect(await library.loadCampaignLibraryPage({ query }, dmId, 'not-a-uuid')).toBeNull();
      expect((await library.loadCampaignLibraryPage({ query }, adminId, c1))?.canManage).toBe(true); // site admin override

      // Only a manager can switch; only members' libraries; off by default.
      await expect(library.setCampaignLibrary(playerId, c1, dmId, true)).rejects.toThrow('Campaign not found.');
      await expect(library.setCampaignLibrary(dmId, c1, outsiderId, true)).rejects.toThrow('not a member');

      // ---- D2: the read-only browse
      const run = (userId: string, search: string) => (browse.load as any)({ locals: { user: { id: userId } }, url: new URL(`http://x/catalogue?${search}`) });
      const names = (result: any) => result.content.map((entry: any) => entry.id);
      const status = async (promise: Promise<unknown>) => { try { await promise; return 200; } catch (err: any) { return err.status as number; } };
      expect(await status(run(outsiderId, `campaign=${c1}`))).toBe(404); // a stranger
      expect(await status(run(playerId, 'campaign=nope'))).toBe(404);
      expect(names(await run(playerId, `campaign=${c1}&search=${tag}`))).not.toContain(dmItem); // library off
      expect(await status(run(playerId, `campaign=${c1}&owner=${dmId}`))).toBe(404); // players cannot browse an off library
      expect(await status(run(playerId, `campaign=${c1}&owner=${outsiderId}`))).toBe(404); // not a member
      const peek = await run(dmId, `campaign=${c1}&owner=${dmId}&search=${tag}`); // the DM can preview it
      expect(peek.owner).toMatchObject({ enabled: false });
      expect(names(peek)).toEqual(expect.arrayContaining([dmItem, dmHidden]));
      expect(names(await run(outsiderId, `search=${tag}`))).toEqual([outsiderItem]); // own pages: only your own library
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      const player = await run(playerId, `campaign=${c1}&search=${tag}`);
      expect(names(player)).toContain(dmItem);
      expect(names(player)).not.toContain(dmHidden); // hidden from players
      expect(names(player)).not.toContain(outsiderItem);
      expect(names(await run(playerId, `campaign=${c1}&owner=${dmId}&search=${tag}`))).toEqual(expect.arrayContaining([dmItem]));
      expect(names(await run(dmId, `campaign=${c1}&search=${tag}`))).toContain(dmHidden); // the DM sees hidden ones
      expect(dmRow((await library.loadCampaignLibraryPage({ query }, playerId, c1))!).counts).toMatchObject({ item: 2, total: 2 }); // on: a player sees it, minus hidden
      // The owner filter runs in SQL: with the row cap crowded by SRD rows the member's entries still come back.
      const catalogue = await import('./services/catalogue');
      const ownerOnly = await catalogue.listCatalogue(dmId, 'item', '', { campaignId: null, ownerIds: [dmId], hiddenOkOwnerIds: [dmId], hiddenOkCampaign: false }, dmId);
      expect(ownerOnly.map((e) => e.id).sort()).toEqual([dmItem, dmHidden, dmItemB].sort());
      // Homebrew sorts ahead of SRD rows, so the cap cuts SRD first.
      const mixed = await catalogue.listCatalogue(dmId, 'item', '');
      const firstSrd = mixed.findIndex((e) => e.sourceKind === 'srd');
      expect(firstSrd === -1 || mixed.slice(firstSrd).every((e) => e.sourceKind === 'srd')).toBe(true);

      // ---- D3: forage picker rules and labels
      const actor = await forage.loadForageActor({ id: dmId, role: 'user' });
      await library.setCampaignLibrary(dmId, c1, dmId, false);
      tableId = await forage.createFindTable(actor, form({ name: `${tag} table`, areaType: `${tag}area`, category: 'plant', campaignId: c1 }));
      await expect(forage.addFindTableEntry(actor, form({ tableId, itemId: dmItem }))).rejects.toThrow('Catalogue entry not found.'); // off
      await expect(forage.addFindTableEntry(actor, form({ tableId, itemId: outsiderItem }))).rejects.toThrow('Catalogue entry not found.');
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      await forage.addFindTableEntry(actor, form({ tableId, itemId: dmItem }));
      expect((await forage.getFindTableEntries(tableId)).find((e) => e.itemId === dmItem)?.sourceLabel).toBe("From Camp DM's library");
      // Switching the library off afterwards pulls nothing: the entry is still on the table, still pickable, relabelled.
      await library.setCampaignLibrary(dmId, c1, dmId, false);
      const after = await forage.getFindTableEntries(tableId);
      expect(after.find((e) => e.itemId === dmItem)?.sourceLabel).toBe('From a library not enabled here');
      invalidateReferenceData('campaign test');
      const catalogueTable = await forage.getActiveTable(tableId);
      expect(catalogueTable?.entries.map((e) => e.itemId)).toContain(dmItem);
      await expect(forage.addFindTableEntry(actor, form({ tableId, itemId: dmItemB }))).rejects.toThrow('Catalogue entry not found.');
    } finally {
      if (tableId) await query('DELETE FROM find_table_entries WHERE find_table_id = $1', [tableId]);
      await query('DELETE FROM find_tables WHERE campaign_id = $1', [c1]);
      await query(`DELETE FROM item_definitions WHERE content_id IN (SELECT id FROM content_definitions WHERE name LIKE '%' || $1 || '%')`, [tag]);
      await query(`DELETE FROM content_definitions WHERE name LIKE '%' || $1 || '%'`, [tag]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = $1', [c1]);
      await query('DELETE FROM campaign_members WHERE campaign_id = $1', [c1]);
      await query('DELETE FROM campaigns WHERE id = $1', [c1]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

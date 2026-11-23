import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for admin oversight (homebrew library unit I): the /admin scope filter and promote to global.
// SKIPPED unless LIBRARY_DB_TEST=1. Local DB only (guarded below). Calls services directly with throwaway users.
//
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryOversight.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';
const form = (fields: Record<string, string>) => { const data = new FormData(); for (const [k, v] of Object.entries(fields)) data.append(k, v); return data; };

function assertLocal() {
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
}

describe.skipIf(!enabled)('library admin oversight', () => {
  it('filters /admin by scope and promotes a personal entry to global, one way', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const { query } = await import('$lib/server/db');
    const authoring = await import('./services/library-authoring');
    const admin = await import('./services/content-admin');
    const tag = `zzover${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string, role = 'user') => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${suffix}@example.invalid`, name, role])).rows[0].id;
    const adminId = await newUser('-admin', 'Over Admin', 'admin');
    const ownerId = await newUser('-owner', 'Over Owner');
    const ids: string[] = [];
    try {
      const item = await authoring.createLibraryEntry(ownerId, form({ contentType: 'item', name: `${tag} Item`, description: 'x' }));
      const feat = await authoring.createLibraryEntry(ownerId, form({ contentType: 'feat', name: `${tag} Feat`, description: 'x' }));
      ids.push(item, feat);

      // Scope filter: personal shows both with the owner's name, global never includes them.
      const personal = await admin.loadContentAdmin(['item', 'feat'], '', { scope: 'personal' });
      expect(personal.scopeFilter).toBe('personal');
      expect(personal.content.find((row) => row.id === item)).toMatchObject({ scope: 'personal', ownerName: 'Over Owner' });
      expect((await admin.loadContentAdmin(['item', 'feat'], '', { scope: 'global' })).content.some((row) => row.id === item)).toBe(false);
      expect((await admin.loadContentAdmin(['item', 'feat'], '', { scope: 'bogus' })).scopeFilter).toBe('');

      // Not an admin, and a global entry: both refused.
      await expect(admin.promoteContentToGlobal(ownerId, form({ contentId: item }))).rejects.toThrow('Only admins');
      // An item that grants a personal feat can't be promoted until that is sorted out.
      await query(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type) VALUES ($1, $2, 'carried')`, [item, feat]);
      await expect(admin.promoteContentToGlobal(adminId, form({ contentId: item }))).rejects.toThrow('references personal entries');
      await query('DELETE FROM content_grants WHERE source_content_id = $1', [item]);

      await admin.promoteContentToGlobal(adminId, form({ contentId: item }));
      const row = (await query<any>('SELECT scope, owner_user_id, hidden_from_players, metadata_json FROM content_definitions WHERE id = $1', [item])).rows[0];
      expect(row).toMatchObject({ scope: 'global', owner_user_id: null, hidden_from_players: false });
      expect(row.metadata_json.promoted.fromOwnerUserId).toBe(ownerId);
      // One way: a second promote finds a global entry.
      await expect(admin.promoteContentToGlobal(adminId, form({ contentId: item }))).rejects.toThrow('Only personal');
    } finally {
      if (ids.length) {
        await query('DELETE FROM content_action_links WHERE content_id = ANY($1::uuid[])', [ids]);
        await query('DELETE FROM item_definitions WHERE content_id = ANY($1::uuid[])', [ids]);
        await query('DELETE FROM content_definitions WHERE id = ANY($1::uuid[])', [ids]);
      }
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adminId, ownerId]]);
    }
  });
  it('moves the entry own action containers to global, and refuses a link to one it does not own', async () => {
    assertLocal();
    const { query } = await import('$lib/server/db');
    const authoring = await import('./services/library-authoring');
    const admin = await import('./services/content-admin');
    const tag = `zzover${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string, role = 'user') => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${suffix}@example.invalid`, name, role])).rows[0].id;
    const adminId = await newUser('-admin', 'Over Admin', 'admin');
    const ownerId = await newUser('-owner', 'Over Owner');
    const ids: string[] = [];
    try {
      const item = await authoring.createLibraryEntry(ownerId, form({ contentType: 'item', name: `${tag} Item`, description: 'x' }));
      const other = await authoring.createLibraryEntry(ownerId, form({ contentType: 'item', name: `${tag} Other`, description: 'x' }));
      const mine = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, source_kind, owner_user_id, scope)
         VALUES ($1, 'action', $2, 'homebrew', $3, 'personal') RETURNING id`, [`action:content:${item}:on_use`, `${tag} Own action`, ownerId])).rows[0].id;
      const foreign = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, source_kind, owner_user_id, scope)
         VALUES ($1, 'action', $2, 'homebrew', $3, 'personal') RETURNING id`, [`action:content:${other}:on_use`, `${tag} Other action`, ownerId])).rows[0].id;
      ids.push(item, other, mine, foreign);
      // The foreign container is linked by a second entry too, so it is not "owned" by the promoted one in any sense.
      await query(`INSERT INTO content_action_links (content_id, action_container_id, trigger_type) VALUES ($1, $2, 'on_use')`, [item, foreign]);
      // A link to a personal action container that belongs to the same owner still counts as its own (same owner, personal),
      // so to test the refusal the foreign container must belong to someone else.
      const strangerId = await newUser('-stranger', 'Over Stranger');
      await query('UPDATE content_definitions SET owner_user_id = $2 WHERE id = $1', [foreign, strangerId]);
      try {
        await expect(admin.promoteContentToGlobal(adminId, form({ contentId: item }))).rejects.toThrow('references personal entries');
        await query('DELETE FROM content_action_links WHERE content_id = $1', [item]);
        await query(`INSERT INTO content_action_links (content_id, action_container_id, trigger_type) VALUES ($1, $2, 'on_use')`, [item, mine]);
        await admin.promoteContentToGlobal(adminId, form({ contentId: item }));
        const rows = (await query<any>('SELECT id, scope, owner_user_id FROM content_definitions WHERE id = ANY($1::uuid[])', [[item, mine, foreign]])).rows;
        const by = (id: string) => rows.find((row) => row.id === id);
        expect(by(item)).toMatchObject({ scope: 'global', owner_user_id: null });
        expect(by(mine)).toMatchObject({ scope: 'global', owner_user_id: null });
        expect(by(foreign)).toMatchObject({ scope: 'personal', owner_user_id: strangerId });
      } finally {
        await query('DELETE FROM content_action_links WHERE content_id = ANY($1::uuid[]) OR action_container_id = ANY($1::uuid[])', [ids]);
        await query('DELETE FROM item_definitions WHERE content_id = ANY($1::uuid[])', [ids]);
        await query('DELETE FROM content_definitions WHERE id = ANY($1::uuid[])', [ids]);
        await query('DELETE FROM users WHERE id = $1', [strangerId]);
      }
    } finally {
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adminId, ownerId]]);
    }
  });

  it('keeps a held item and a campaign fork of it resolving after promotion', async () => {
    assertLocal();
    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const authoring = await import('./services/library-authoring');
    const admin = await import('./services/content-admin');
    const tag = `zzover${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string, role = 'user') => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${suffix}@example.invalid`, name, role])).rows[0].id;
    const adminId = await newUser('-admin', 'Over Admin', 'admin');
    const ownerId = await newUser('-owner', 'Over Owner');
    const holderId = await newUser('-holder', 'Over Holder');
    let campaignId = '';
    let characterId = '';
    let copyId = '';
    let item = '';
    try {
      item = await authoring.createLibraryEntry(ownerId, form({ contentType: 'item', name: `${tag} Item`, description: 'x' }));
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = (n: number) => Array.from({ length: n }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
      campaignId = (await query<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} c`, code(10), code(8)])).rows[0].id;
      characterId = await createCharacter(holderId, 'Holder');
      await query('UPDATE characters SET campaign_id = $2 WHERE id = $1', [characterId, campaignId]);
      copyId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, source_kind, scope, campaign_id, forked_from_content_id)
         VALUES ($1, 'item', $2, 'homebrew', 'campaign', $3, $4) RETURNING id`, [`fork:${campaignId}:${item}`, `${tag} Item`, campaignId, item])).rows[0].id;
      const held = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, equipped, location, quantity) VALUES ($1, 'Held', $2, true, 'equipped', 1) RETURNING id`, [characterId, item])).rows[0].id;
      const heldCopy = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, equipped, location, quantity) VALUES ($1, 'Held copy', $2, true, 'equipped', 1) RETURNING id`, [characterId, copyId])).rows[0].id;

      await admin.promoteContentToGlobal(adminId, form({ contentId: item }));

      const rows = (await query<any>('SELECT id, source_content_id FROM character_inventory_items WHERE id = ANY($1::uuid[])', [[held, heldCopy]])).rows;
      expect(rows.find((row) => row.id === held).source_content_id).toBe(item);
      expect(rows.find((row) => row.id === heldCopy).source_content_id).toBe(copyId);
      const copy = (await query<any>('SELECT scope, campaign_id, forked_from_content_id FROM content_definitions WHERE id = $1', [copyId])).rows[0];
      expect(copy).toMatchObject({ scope: 'campaign', campaign_id: campaignId, forked_from_content_id: item });
      expect((await query<any>('SELECT scope FROM content_definitions WHERE id = $1', [item])).rows[0].scope).toBe('global');
    } finally {
      if (characterId) {
        await query('DELETE FROM character_inventory_items WHERE character_id = $1', [characterId]);
        await query('DELETE FROM characters WHERE id = $1', [characterId]).catch(() => undefined);
      }
      if (copyId) await query('DELETE FROM content_definitions WHERE id = $1', [copyId]);
      if (item) {
        await query('DELETE FROM item_definitions WHERE content_id = $1', [item]);
        await query('DELETE FROM content_definitions WHERE id = $1', [item]);
      }
      if (campaignId) await query('DELETE FROM campaigns WHERE id = $1', [campaignId]).catch(() => undefined);
      await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adminId, ownerId, holderId]]);
    }
  });
});

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for the /library authoring service (homebrew library unit C). SKIPPED unless LIBRARY_DB_TEST=1.
// Local DB only (guarded below). Calls the services directly with throwaway users; it never forges a session.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryAuthoring.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  return data;
};

describe.skipIf(!enabled)('library authoring', () => {
  it('lets anyone write descriptive entries, keeps rules for DMs, and keeps archived entries working', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter, restoreCharacterVersion } = await import('./services/characters');
    const library = await import('./services/library');
    const authoring = await import('./services/library-authoring');
    const catalogue = await import('./services/catalogue');
    const { resolveCharacterModifierSources } = await import('./services/rule-engine');
    const tag = `zzauth${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dmId = await newUser('-dm', 'Auth DM');
    const playerId = await newUser('-player', 'Auth Player');
    let c1 = '';
    let characterId = '';
    try {
      c1 = (await query<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} c1`, code(10), code(8)])).rows[0].id;
      await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3), ($1, $4, $5)', [c1, dmId, 'dm', playerId, 'player']);
      characterId = await createCharacter(playerId, 'Aria');
      await query('UPDATE characters SET campaign_id = $2 WHERE id = $1', [characterId, c1]);

      // ---- a player (not a DM of anything): descriptive only
      expect((await library.loadLibraryActor({ query }, playerId)).canAuthorMechanics).toBe(false);
      const playerItem = await authoring.createLibraryEntry(playerId, form({
        contentType: 'item', name: `${tag} Lucky Pebble`, description: 'Smooth.', category: 'gear', acBonus: '5', toHitBonus: '3', costJson: '[{"pool":"action","amount":1}]'
      }));
      const entry = (await query<any>(
        `SELECT c.scope, c.owner_user_id, c.source_kind, c.content_key, c.cost_json, i.ac_bonus, i.to_hit_bonus FROM content_definitions c
         JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1`, [playerItem])).rows[0];
      expect(entry).toMatchObject({ scope: 'personal', owner_user_id: playerId, source_kind: 'homebrew', cost_json: null, ac_bonus: 0, to_hit_bonus: 0 });
      expect(entry.content_key).toMatch(new RegExp(`^library:${playerId}:item:`));
      // A crafted update carrying mechanics fields leaves them at 0 and NULL, while the descriptive part changes.
      await authoring.updateLibraryEntry(playerId, form({
        contentId: playerItem, name: `${tag} Lucky Pebble 2`, description: 'Smoother.', category: 'treasure', hiddenFromPlayers: 'on',
        acBonus: '9', damageBonus: '4', damageRolls: '9d9', costJson: '[{"pool":"action","amount":2}]'
      }));
      const after = (await query<any>(
        `SELECT c.name, c.hidden_from_players, c.cost_json, i.category, i.ac_bonus, i.damage_bonus, i.damage_rolls FROM content_definitions c
         JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1`, [playerItem])).rows[0];
      expect(after).toMatchObject({ name: `${tag} Lucky Pebble 2`, hidden_from_players: true, category: 'treasure', ac_bonus: 0, damage_bonus: 0, damage_rolls: '', cost_json: null });
      // Spells: descriptive fields land, mechanics ones do not.
      const playerSpell = await authoring.createLibraryEntry(playerId, form({
        contentType: 'spell', name: `${tag} Hush`, school: 'Illusion', spellLevel: '2', classes: ['Bard', 'Wizard'], ritual: 'on', baseDice: '8d6', resolutionType: 'save', scalingKind: 'leveled', scalingExtraDicePerSlotLevel: '1d6'
      }));
      const spell = (await query<any>('SELECT * FROM spell_definitions WHERE content_id = $1', [playerSpell])).rows[0];
      expect(spell).toMatchObject({ spell_level: 2, school: 'Illusion', ritual: true, classes: ['Bard', 'Wizard'], base_dice: '', resolution_type: 'attack' });
      expect(spell.scaling_json).toEqual({});

      // Every rules write is refused for the player, on their own entry.
      const modifierId = (await query<{ id: string }>(
        `SELECT m.id FROM modifier_definitions m JOIN modifier_targets t ON t.target_key = m.target
         WHERE t.runtime_supported AND NOT m.is_archived ORDER BY m.id LIMIT 1`)).rows[0].id;
      const tier = 'for DMs and admins';
      await expect(authoring.libraryAttachModifier(playerId, form({ contentId: playerItem, modifierId, activationType: 'carried' }))).rejects.toThrow(tier);
      await expect(authoring.libraryAddResource(playerId, form({ contentId: playerItem, resourceKey: 'c', resourceLabel: 'C', maxValueExpression: '1', rechargePeriod: 'manual' }))).rejects.toThrow(tier);
      await expect(authoring.libraryAddAction(playerId, form({ contentId: playerItem, stepType: 'roll_output', valueExpression: '1' }))).rejects.toThrow(tier);
      expect((await query('SELECT 1 FROM content_modifier_links WHERE content_id = $1', [playerItem])).rows).toHaveLength(0);

      // Nobody edits someone else's entry (not even a DM), and an unknown id is "not found".
      await expect(authoring.updateLibraryEntry(dmId, form({ contentId: playerItem, name: 'Mine now' }))).rejects.toThrow('Library entry not found.');
      await expect(authoring.toggleLibraryArchive(dmId, form({ contentId: playerItem }))).rejects.toThrow('Library entry not found.');
      await expect(authoring.libraryDetachModifier(dmId, form({ contentId: playerItem, linkId: crypto.randomUUID() }))).rejects.toThrow('Library entry not found.');
      await expect(authoring.createLibraryEntry(playerId, form({ contentType: 'deck', name: 'x' }))).rejects.toThrow('Choose an item');

      // The page load only lists the user's own entries of the tab, with the descriptive-only flag.
      const playerPage = await authoring.loadLibraryPage(playerId, 'item', '', '');
      expect(playerPage.content.map((row: any) => row.id)).toEqual([playerItem]);
      expect(playerPage.canAuthorMechanics).toBe(false);
      expect(playerPage.hidden[playerItem]).toBe(true);
      expect((await authoring.loadLibraryPage(dmId, 'item', '', '')).content).toHaveLength(0);

      // ---- the DM: mechanics allowed
      expect((await library.loadLibraryActor({ query }, dmId)).canAuthorMechanics).toBe(true);
      const dmItem = await authoring.createLibraryEntry(dmId, form({
        contentType: 'item', name: `${tag} Ring of Might`, acBonus: '2', toHitBonus: '1', attackAbility: 'dex', costJson: '[{"pool":"action","amount":1}]'
      }));
      expect((await query<any>('SELECT c.cost_json, i.ac_bonus, i.to_hit_bonus, i.attack_ability FROM content_definitions c JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1', [dmItem])).rows[0])
        .toMatchObject({ cost_json: [expect.objectContaining({ amount: 1 })], ac_bonus: 2, to_hit_bonus: 1, attack_ability: 'dex' });
      // A form without the Cost block leaves the stored cost alone.
      await authoring.updateLibraryEntry(dmId, form({ contentId: dmItem, name: `${tag} Ring of Might`, acBonus: '3' }));
      expect((await query<any>('SELECT c.cost_json, i.ac_bonus FROM content_definitions c JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1', [dmItem])).rows[0])
        .toMatchObject({ cost_json: [expect.objectContaining({ amount: 1 })], ac_bonus: 3 });
      await authoring.libraryAttachModifier(dmId, form({ contentId: dmItem, modifierId, activationType: 'carried' }));
      expect((await query('SELECT 1 FROM content_modifier_links WHERE content_id = $1', [dmItem])).rows).toHaveLength(1);
      // Attachments respect the references rule and the entry's own pieces.
      const dmFeat = await authoring.createLibraryEntry(dmId, form({ contentType: 'feat', name: `${tag} Might Feat` }));
      await authoring.libraryGrantContent(dmId, form({ sourceContentId: dmItem, grantedContentId: dmFeat, activationType: 'equipped' }));
      const playerFeat = await authoring.createLibraryEntry(playerId, form({ contentType: 'class_feature', name: `${tag} Player Feature` }));
      await expect(authoring.libraryGrantContent(dmId, form({ sourceContentId: dmItem, grantedContentId: playerFeat, activationType: 'equipped' }))).rejects.toThrow('cannot be used');
      await expect(authoring.libraryGrantContent(dmId, form({ sourceContentId: dmItem, grantedContentId: dmItem, activationType: 'equipped' }))).rejects.toThrow('feat or class feature');
      await authoring.libraryAddResource(dmId, form({ contentId: dmItem, resourceKey: 'charges', resourceLabel: 'Charges', maxValueExpression: '3', rechargePeriod: 'dawn' }));
      await expect(authoring.libraryAddResource(dmId, form({ contentId: dmItem, resourceKey: 'bad', resourceLabel: 'Bad', maxValueExpression: 'drop table', rechargePeriod: 'dawn' }))).rejects.toThrow('Choose a maximum');
      await authoring.libraryAddAction(dmId, form({ contentId: dmItem, activationType: 'on_use', stepType: 'roll_output', valueExpression: '1', actionLabel: 'Zap' }));
      const dmItem2 = await authoring.createLibraryEntry(dmId, form({ contentType: 'item', name: `${tag} Other Ring` }));
      const otherCharge = (await query<{ id: string }>('SELECT id FROM content_resource_definitions WHERE content_id = $1', [dmItem])).rows[0].id;
      const spellForDm = await authoring.createLibraryEntry(dmId, form({ contentType: 'spell', name: `${tag} DM Bolt` }));
      // A spell grant may not use another entry's counter.
      await expect(authoring.libraryAddSpellAccess(dmId, form({ contentId: dmItem2, spellContentId: spellForDm, resourceDefinitionId: otherCharge }))).rejects.toThrow('own counters');
      await authoring.libraryAddSpellAccess(dmId, form({ contentId: dmItem, spellContentId: spellForDm, resourceDefinitionId: otherCharge, accessType: 'charges' }));
      await expect(authoring.libraryAddSpellAccess(dmId, form({ contentId: dmItem, spellContentId: dmItem2 }))).rejects.toThrow('Choose a spell');
      // The holders note counts what depends on an entry.
      expect((await authoring.loadLibraryPage(dmId, 'item', dmItem, '')).holders).toEqual({ characters: 0, findTables: 0, campaigns: 0, decks: 0 });

      // ---- the DM's item resolves on a C1 character once the DM's library is on
      await expect(catalogue.addContentToCharacter(playerId, characterId, dmItem)).rejects.toThrow('Catalogue entry not found.');
      await library.setCampaignLibrary(dmId, c1, dmId, true);
      await catalogue.addContentToCharacter(playerId, characterId, dmItem);
      const auditHas = async (name: string) => (await resolveCharacterModifierSources(characterId)).audit.some((row: any) => JSON.stringify(row).includes(name));
      expect(await auditHas(`${tag} Ring of Might`)).toBe(true);
      expect((await authoring.loadLibraryPage(dmId, 'item', dmItem, '')).holders?.characters).toBe(1);

      // ---- archived entries: not offered, but still held, still resolving, still restorable
      await catalogue.addContentToCharacter(playerId, characterId, spellForDm);
      const firstVersion = (await query<{ id: string }>('SELECT id FROM character_versions WHERE character_id = $1 ORDER BY created_at LIMIT 1', [characterId])).rows[0].id;
      await authoring.toggleLibraryArchive(dmId, form({ contentId: dmItem }));
      await authoring.toggleLibraryArchive(dmId, form({ contentId: spellForDm }));
      expect((await query<{ is_archived: boolean }>('SELECT is_archived FROM content_definitions WHERE id = $1', [dmItem])).rows[0].is_archived).toBe(true);
      expect((await catalogue.listCatalogue(dmId, 'item', tag)).map((row) => row.id)).not.toContain(dmItem);
      await expect(catalogue.addContentToCharacter(playerId, characterId, dmItem)).rejects.toThrow('Catalogue entry not found.');
      expect(await auditHas(`${tag} Ring of Might`)).toBe(true); // still resolves
      const heldSpell = async () => (await query('SELECT 1 FROM character_content_instances WHERE character_id = $1 AND content_id = $2', [characterId, spellForDm])).rows.length;
      expect(await heldSpell()).toBe(1);
      await restoreCharacterVersion(playerId, characterId, firstVersion); // the early version has no spell
      expect(await heldSpell()).toBe(0);
      const before = (await query<{ id: string }>(`SELECT id FROM character_versions WHERE character_id = $1 AND change_summary = 'Before restore' ORDER BY created_at DESC LIMIT 1`, [characterId])).rows[0].id;
      await restoreCharacterVersion(playerId, characterId, before); // brings the archived spell back
      expect(await heldSpell()).toBe(1);
      // The owner can restore it to the picker.
      await authoring.toggleLibraryArchive(dmId, form({ contentId: dmItem }));
      expect((await catalogue.listCatalogue(dmId, 'item', tag)).map((row) => row.id)).toContain(dmItem);
    } finally {
      await query('DELETE FROM character_inventory_items WHERE character_id = $1', [characterId]);
      await query('DELETE FROM character_content_instances WHERE character_id = $1', [characterId]);
      await query('DELETE FROM characters WHERE id = $1', [characterId]);
      const ours = `SELECT id FROM content_definitions WHERE name LIKE '%' || $1 || '%'`;
      for (const sql of [
        `DELETE FROM content_spell_access WHERE owner_content_id IN (${ours}) OR spell_content_id IN (${ours})`,
        `DELETE FROM content_grants WHERE source_content_id IN (${ours}) OR granted_content_id IN (${ours})`,
        `DELETE FROM content_modifier_links WHERE content_id IN (${ours})`,
        `DELETE FROM content_resource_definitions WHERE content_id IN (${ours})`
      ]) await query(sql, [tag]);
      await query(`DELETE FROM content_action_links WHERE content_id IN (${ours}) OR action_container_id IN (${ours})`, [tag]);
      await query(`DELETE FROM action_steps WHERE container_id IN (SELECT id FROM content_definitions WHERE content_type = 'action' AND owner_user_id IN (SELECT id FROM users WHERE email LIKE $1))`, [`${tag}%`]);
      await query(`DELETE FROM content_definitions WHERE content_type = 'action' AND owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${tag}%`]);
      await query(`DELETE FROM content_definitions WHERE name LIKE '%' || $1 || '%'`, [tag]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = $1', [c1]);
      await query('DELETE FROM campaign_members WHERE campaign_id = $1', [c1]);
      await query('DELETE FROM campaigns WHERE id = $1', [c1]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

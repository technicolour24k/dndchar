import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for personal conditions (homebrew library unit F): DM-tier authoring and ownership, decks naming
// library conditions (editor check and draw-time apply agree), "already referenced" surviving a library switch-off,
// and the sheet's apply list and Save only offering a character's visible set.
// SKIPPED unless LIBRARY_DB_TEST=1. Local DB only (guarded below). Calls the services directly with throwaway users.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryConditions.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const fd = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe.skipIf(!enabled)('personal conditions', () => {
  it('authors DM-tier conditions and resolves them for decks and sheets by the visible-set rule', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter, getCharacter, updateCharacter } = await import('./services/characters');
    const library = await import('./services/library');
    const conditions = await import('./services/library-conditions');
    const decks = await import('./services/decks');
    const tag = `zzlcond${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${suffix}@example.invalid`, name])).rows[0].id;
    const dm = await newUser('-dm', 'Cond DM'); // DM of C1
    const player = await newUser('-p', 'Cond Player'); // plays in C1
    const outsider = await newUser('-o', 'Cond Outsider'); // DM of C2, not in C1
    const nobody = await newUser('-n', 'Cond Nobody'); // DMs nothing
    const campaigns: string[] = [];
    const newCampaign = async (name: string, members: Array<[string, string]>) => {
      const id = (await query<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} ${name}`, code(10), code(8)])).rows[0].id;
      campaigns.push(id);
      for (const [userId, role] of members) await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, role]);
      return id;
    };
    try {
      const c1 = await newCampaign('one', [[dm, 'dm'], [player, 'player']]);
      await newCampaign('two', [[outsider, 'dm']]);
      const hero = await createCharacter(player, 'Hero');
      await query('UPDATE characters SET campaign_id = $2, party_active = true WHERE id = $1', [hero, c1]);
      const loner = await createCharacter(player, 'Loner'); // no campaign: sees global plus its OWNER's library only
      const modifierId = (await query<{ id: string }>('SELECT id FROM modifier_definitions WHERE NOT is_archived ORDER BY id LIMIT 1')).rows[0].id;

      // ---- authoring: DM-tier, owned, personal-scoped, condition: key prefix
      await expect(conditions.createLibraryCondition(nobody, fd({ name: `${tag} nope` }))).rejects.toThrow('DMs and admins');
      const dazzled = await conditions.createLibraryCondition(dm, fd({ name: `${tag} Dazzled`, description: 'Bright.', durationType: 'timed', durationRounds: '3', stackBehavior: 'stack', sourceType: 'homebrew' }));
      const row = (await query<any>('SELECT scope, owner_user_id, campaign_id, content_key, duration_rounds, stack_behavior FROM content_definitions WHERE id = $1', [dazzled])).rows[0];
      expect(row).toMatchObject({ scope: 'personal', owner_user_id: dm, campaign_id: null, duration_rounds: 3, stack_behavior: 'stack' });
      expect(row.content_key.startsWith(`condition:library:${dm}:`)).toBe(true);
      const key = row.content_key as string;
      await conditions.attachLibraryConditionModifier(dm, fd({ effectId: dazzled, modifierId }));
      expect((await conditions.loadLibraryConditions(dm, dazzled)).links).toHaveLength(1);
      const outsiderCond = await conditions.createLibraryCondition(outsider, fd({ name: `${tag} Outsider cond` }));
      const outsiderKey = (await query<{ content_key: string }>('SELECT content_key FROM content_definitions WHERE id = $1', [outsiderCond])).rows[0].content_key;

      // Ownership walls: nobody else can edit, archive, or touch its modifiers.
      await expect(conditions.saveLibraryCondition(outsider, fd({ effectId: dazzled, name: 'hijack' }))).rejects.toThrow('not found');
      await expect(conditions.archiveLibraryCondition(outsider, dazzled)).rejects.toThrow('not found');
      await expect(conditions.attachLibraryConditionModifier(outsider, fd({ effectId: dazzled, modifierId }))).rejects.toThrow('not found');
      await expect(conditions.detachLibraryConditionModifier(outsider, fd({ effectId: dazzled, linkId: (await conditions.loadLibraryConditions(dm, dazzled)).links[0].id }))).rejects.toThrow('not found');
      expect((await conditions.loadLibraryConditions(outsider, dazzled)).selected).toBeNull();
      expect((await query<any>('SELECT name FROM content_definitions WHERE id = $1', [dazzled])).rows[0].name).toBe(`${tag} Dazzled`);

      // ---- decks: the editor check follows the deck
      const rulesWith = (conditionKey: string) => JSON.stringify({
        version: 1, cards: [{ id: 'c1', label: 'Flash', tags: { kind: 'x' }, value: 3 }], success: { rules: [], otherwise: 'success' },
        outcomes: [{ id: 'o', when: {}, name: 'O', text: 't', steps: [{ type: 'condition', conditionKey, params: {}, durationRounds: 5, target: 'drawer' }] }]
      });
      const campaignDeck = await decks.createDeck({ userId: dm, campaignId: c1, name: `${tag} cdeck`, description: '' });
      const saveCampaign = (rulesText: string) => decks.updateDeck({ userId: dm, campaignId: c1, id: campaignDeck, name: `${tag} cdeck`, description: '', rulesText });
      expect((await saveCampaign(rulesWith(key))).ok).toBe(false); // the DM's library is off in C1
      await library.setCampaignLibrary(dm, c1, dm, true);
      expect((await saveCampaign(rulesWith(key))).ok).toBe(true);
      const outsiderRefused = await saveCampaign(rulesWith(outsiderKey));
      expect(outsiderRefused.ok).toBe(false); // someone else's library never works
      expect(JSON.stringify(outsiderRefused)).toContain('not available to this deck');
      expect((await saveCampaign(rulesWith('condition:deck_fate_ac'))).ok).toBe(true); // global still fine
      await saveCampaign(rulesWith(key));

      // A personal deck names its author's own conditions only.
      const personalDeck = await decks.createPersonalDeck({ userId: dm, name: `${tag} pdeck`, description: '' });
      const savePersonal = (rulesText: string) => decks.updatePersonalDeck({ userId: dm, id: personalDeck, name: `${tag} pdeck`, description: '', rulesText });
      expect((await savePersonal(rulesWith(key))).ok).toBe(true);
      expect((await savePersonal(rulesWith(outsiderKey))).ok).toBe(false);

      // ---- draw: applies the personal condition; with the library switched off it still does (already referenced)
      await decks.setCampaignDeck({ userId: dm, campaignId: c1, deckId: campaignDeck, enabled: true });
      const effectCount = async () => Number((await query<any>('SELECT count(*) FROM active_character_effects WHERE character_id = $1 AND container_id = $2', [hero, dazzled])).rows[0].count);
      const draw = (deckId: string) => decks.drawCard({ userId: player, characterId: hero, deckId, deps: { cardId: 'c1' } });
      const first = await draw(campaignDeck);
      expect(first.draw.dmTasks).toEqual([]);
      expect(await effectCount()).toBe(1);
      await query('DELETE FROM active_character_effects WHERE character_id = $1', [hero]);
      await library.setCampaignLibrary(dm, c1, dm, false);
      await draw(campaignDeck);
      expect(await effectCount()).toBe(1);

      // The personal deck, enabled in C1 by reference (library back on), applies its author's condition too.
      await query('DELETE FROM active_character_effects WHERE character_id = $1', [hero]);
      await library.setCampaignLibrary(dm, c1, dm, true);
      await decks.setCampaignDeck({ userId: dm, campaignId: c1, deckId: personalDeck, enabled: true });
      await draw(personalDeck);
      expect(await effectCount()).toBe(1);

      // Archiving the condition turns the next draw into the existing "apply by hand" DM task.
      await query('DELETE FROM active_character_effects WHERE character_id = $1', [hero]);
      await conditions.archiveLibraryCondition(dm, dazzled);
      const archivedDraw = await draw(campaignDeck);
      expect(await effectCount()).toBe(0);
      expect(archivedDraw.draw.dmTasks[0]?.text).toMatch(/^Apply .* to Hero by hand/);
      expect(archivedDraw.draw.dmTasks[0]?.text).not.toContain(dm); // no ids in the label
      await conditions.archiveLibraryCondition(dm, dazzled); // restore

      // ---- sheet: the apply list and Save follow the character's visible set
      const offered = async (characterId: string) => (await getCharacter(player, characterId))!.availableEffects.map((effect) => effect.id);
      expect(await offered(hero)).toContain(dazzled); // C1 has the DM's library on
      expect(await offered(hero)).not.toContain(outsiderCond);
      expect(await offered(loner)).not.toContain(dazzled); // campaign-less: the owner's own library only
      await library.setCampaignLibrary(dm, c1, dm, false);
      expect(await offered(hero)).not.toContain(dazzled);
      const keyOf = (k: string) => k.replace(/^condition:/, '');
      const save = (characterId: string, keys: string[]) => {
        const form = new FormData();
        form.set('name', 'Hero');
        for (const k of keys) form.append('activeEffectKey', keyOf(k));
        return updateCharacter(player, characterId, form, 'IT save');
      };
      const heldBy = async (characterId: string, id: string) => Number((await query<any>('SELECT count(*) FROM active_character_effects WHERE character_id = $1 AND container_id = $2', [characterId, id])).rows[0].count);
      await save(hero, [key, outsiderKey]); // library off: a new application of either is skipped
      expect(await heldBy(hero, dazzled)).toBe(0);
      expect(await heldBy(hero, outsiderCond)).toBe(0);
      await library.setCampaignLibrary(dm, c1, dm, true);
      await save(hero, [key, outsiderKey]); // on: the DM's applies, the outsider's never does
      expect(await heldBy(hero, dazzled)).toBe(1);
      expect(await heldBy(hero, outsiderCond)).toBe(0);
      await library.setCampaignLibrary(dm, c1, dm, false);
      expect(await offered(hero)).toContain(dazzled); // held, so still listed after the switch-off
      await save(hero, [key]); // and a Save keeps it
      expect(await heldBy(hero, dazzled)).toBe(1);

      // A name containing "condition" must not mangle the key the sheet round-trips (only the prefix is stripped).
      const burning = await conditions.createLibraryCondition(dm, fd({ name: `${tag} X condition`, sourceType: 'homebrew' }));
      const burningKey = (await query<{ content_key: string }>('SELECT content_key FROM content_definitions WHERE id = $1', [burning])).rows[0].content_key;
      await library.setCampaignLibrary(dm, c1, dm, true);
      await save(hero, [key, burningKey]);
      expect(await heldBy(hero, burning)).toBe(1);
      const sheet = (await getCharacter(player, hero))!;
      expect(sheet.activeEffects.find((effect) => effect.effectId === burning)?.effectKey).toBe(burningKey.replace(/^condition:/, ''));
      const keysOnSheet = sheet.activeEffects.map((effect) => effect.effectKey);
      await save(hero, keysOnSheet.map((k) => `condition:${k}`)); // a normal Save posts exactly what the sheet showed
      expect(await heldBy(hero, burning)).toBe(1);
      expect(await heldBy(hero, dazzled)).toBe(1);
    } finally {
      const ids = campaigns.length ? campaigns : ['00000000-0000-0000-0000-000000000000'];
      await query('DELETE FROM deck_draws WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaign_decks WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaign_library_settings WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM active_character_effects WHERE character_id IN (SELECT id FROM characters WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1))', [`${tag}%`]);
      await query('DELETE FROM character_versions WHERE character_id IN (SELECT id FROM characters WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1))', [`${tag}%`]);
      await query('DELETE FROM characters WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)', [`${tag}%`]);
      await query(`DELETE FROM deck_definitions WHERE content_id IN (SELECT id FROM content_definitions WHERE content_type = 'deck' AND name LIKE '%' || $1 || '%')`, [tag]);
      await query(`DELETE FROM content_modifier_links WHERE content_id IN (SELECT id FROM content_definitions WHERE name LIKE '%' || $1 || '%')`, [tag]);
      await query(`DELETE FROM content_definitions WHERE name LIKE '%' || $1 || '%'`, [tag]);
      await query('DELETE FROM campaign_members WHERE campaign_id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [ids]);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
    }
  });
});

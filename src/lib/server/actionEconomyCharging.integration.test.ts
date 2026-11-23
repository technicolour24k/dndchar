import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check that the cost engine charges per-turn actions (action economy Unit 3): turn lines
// paid from the profile's pools, Extra Attack follow-ups, spell echoes, overrides and undo. SKIPPED
// unless COST_DB_TEST=1. Local DB only (guarded below). Creates throwaway users, a campaign, characters
// and content, and removes them at the end.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   COST_DB_TEST=1 npx vitest run src/lib/server/actionEconomyCharging.integration.test.ts
const enabled = process.env.COST_DB_TEST === '1';

describe.skipIf(!enabled)('the cost engine charges the turn', () => {
  it('pays turn lines under both profiles, grants and uses follow-ups, echoes spells, and refunds overrides', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query, withTransaction } = await import('$lib/server/db');
    const { createCharacter, getCharacter } = await import('./services/characters');
    const { createCampaign, addCharacterToCampaign, setCampaignActionEconomy } = await import('./services/campaigns');
    const { castCharacterSpell, castCharacterSpellDetailed, useInventoryCatalogueItem, advanceCharacterTurn, restCharacter, newBattle } = await import('./services/catalogue');
    const { CostShortfallError, FollowupGoneError, payActivationCost } = await import('./services/cost-engine');
    const { reviewOverride } = await import('./services/resource-pools');
    const tag = `zzchg${crypto.randomBytes(4).toString('hex')}`;
    const user = async (name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${name}@example.invalid`, `IT ${name}`])).rows[0].id;
    const userId = await user('player');
    const dmId = await user('dm');
    const contentIds: string[] = [];
    let campaignId = '';
    try {
      // ---- helpers ----------------------------------------------------------------------------
      let n = 0;
      const content = async (type: string, name: string, cost: unknown = null) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name, cost_json) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
          [`${type}:${tag}${n++}`, type, name, cost === null ? null : JSON.stringify(cost)])).rows[0].id;
        contentIds.push(id);
        return id;
      };
      const mkCharacter = async (name: string) => createCharacter(userId, name);
      const spell = async (characterId: string, name: string, level: number, castingTime = '1 action', cost: unknown = null) => {
        const id = await content('spell', name, cost);
        await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time, resolution_type) VALUES ($1,$2,$3,'auto')`, [id, level, castingTime]);
        return (await query<{ id: string }>(
          `INSERT INTO character_content_instances (character_id, content_id, is_known, is_prepared) VALUES ($1,$2,true,true) RETURNING id`, [characterId, id])).rows[0].id;
      };
      // A feat linking a modifier target at a value ("known" = always on).
      const grant = async (characterId: string, targetKey: string, value: string, name = `grant ${targetKey}`) => {
        const modifierId = (await query<{ id: string }>(
          `SELECT id FROM modifier_definitions WHERE target=$1 AND modifier_type='bonus' AND NOT is_archived LIMIT 1`, [targetKey])).rows[0]?.id
          ?? (await query<{ id: string }>(`INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label) VALUES ($1,'bonus','1',$2) RETURNING id`, [targetKey, name])).rows[0].id;
        const feat = await content('feat', name);
        await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,'known',$3)`, [feat, modifierId, value]);
        await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      };
      const setSlots = async (characterId: string, rows: Array<[number, number]>) => {
        await query(`DELETE FROM character_spell_slots WHERE character_id=$1`, [characterId]);
        for (const [level, count] of rows) await query(`INSERT INTO character_spell_slots (character_id, slot_type, slot_level, current_slots, max_slots) VALUES ($1,'standard',$2,$3,9)`, [characterId, level, count]);
      };
      const slot = async (characterId: string, level: number) => (await query<any>(`SELECT current_slots FROM character_spell_slots WHERE character_id=$1 AND slot_level=$2`, [characterId, level])).rows[0].current_slots;
      const cast = (characterId: string, instanceId: string, extra: Record<string, string> = {}, override?: any) => {
        const form = new FormData();
        form.set('instanceId', instanceId);
        for (const [k, v] of Object.entries(extra)) form.set(k, v);
        return castCharacterSpell(userId, characterId, form, override);
      };
      const castDetailed = (characterId: string, instanceId: string, extra: Record<string, string> = {}) => {
        const form = new FormData();
        form.set('instanceId', instanceId);
        for (const [k, v] of Object.entries(extra)) form.set(k, v);
        return castCharacterSpellDetailed(userId, characterId, form);
      };
      const attack = (characterId: string, timing?: 'action' | 'bonus_action' | 'reaction', override?: any, followup?: 'use' | 'skip' | 'require') =>
        withTransaction((client) => payActivationCost(client, characterId, { kind: 'weapon_attack', inventoryId: null, label: 'Longsword', ...(timing ? { timing } : {}), ...(followup ? { followup } : {}) }, { actorUserId: userId, override }));
      const newBattleJob = (characterId: string) => newBattle(userId, characterId);
      const turn = async (characterId: string) => (await getCharacter(userId, characterId))!.turn;
      const left = async (characterId: string) => Object.fromEntries((await turn(characterId)).pools.map((p) => [p.key, p.current]));
      const followupsLeft = async (characterId: string) => (await turn(characterId)).followups.map((f) => [f.cls, f.remaining]);

      // ---- 5e (a campaign-less character) ------------------------------------------------------
      const wizard = await mkCharacter('Wizard');
      await setSlots(wizard, [[1, 3]]);
      const bolt = await spell(wizard, 'Fire Bolt', 0);
      const bolt2 = await spell(wizard, 'Ray of Frost', 0);
      const first = await cast(wizard, bolt);
      expect(first[0]).toMatchObject({ label: 'Cost', target: 'Action', before: 1, after: 0 });
      expect(await left(wizard)).toEqual({ action: 0, bonus_action: 1, reaction: 1 });
      // A second cantrip: nothing spent, the shortfall names the pool.
      await expect(cast(wizard, bolt2)).rejects.toMatchObject({ shortfalls: [{ label: 'Action', needed: 1, available: 0 }] });
      await expect(cast(wizard, bolt2)).rejects.toBeInstanceOf(CostShortfallError);
      expect((await turn(wizard)).log).toHaveLength(1);
      expect((await query<any>(`SELECT 1 FROM character_resource_ledger WHERE character_id=$1`, [wizard])).rowCount).toBe(0); // a normal turn spend is not ledgered
      // Next Turn: full again.
      await advanceCharacterTurn(userId, wizard);
      expect(await left(wizard)).toEqual({ action: 1, bonus_action: 1, reaction: 1 });

      // A reaction spell (Shield, with its trigger text) spends the Reaction, not the Action.
      const shield = await spell(wizard, 'Shield', 1, '1 reaction, which you take when you are hit by an attack');
      await cast(wizard, shield);
      expect(await left(wizard)).toEqual({ action: 1, bonus_action: 1, reaction: 0 });
      expect(await slot(wizard, 1)).toBe(2);

      // An explicit [] spell still takes its action; an explicit free turn line takes none.
      const empty = await spell(wizard, 'Empty cost', 0, '1 action', []);
      const free = await spell(wizard, 'Free cost', 0, '1 action', [{ pool: 'turn', amount: 1, timing: 'free' }]);
      await cast(wizard, free);
      expect((await left(wizard)).action).toBe(1);
      await cast(wizard, empty);
      expect((await left(wizard)).action).toBe(0);

      // Using an item takes an Action as well as the item.
      await advanceCharacterTurn(userId, wizard);
      const potion = await content('item', 'Potion');
      const potionRow = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Potion',$2,3) RETURNING id`, [wizard, potion])).rows[0].id;
      await useInventoryCatalogueItem(userId, wizard, potionRow);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [potionRow])).rows[0].quantity).toBe(2);
      expect((await left(wizard)).action).toBe(0);
      await expect(useInventoryCatalogueItem(userId, wizard, potionRow)).rejects.toBeInstanceOf(CostShortfallError);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [potionRow])).rows[0].quantity).toBe(2); // nothing spent

      // 5e weapon attacks: Action by default, Reaction for an opportunity attack, and no follow-ups without Extra Attack.
      await advanceCharacterTurn(userId, wizard);
      await attack(wizard);
      expect((await left(wizard)).action).toBe(0);
      expect(await followupsLeft(wizard)).toEqual([]);
      await attack(wizard, 'reaction');
      expect(await left(wizard)).toEqual({ action: 0, bonus_action: 1, reaction: 0 });
      await expect(attack(wizard)).rejects.toBeInstanceOf(CostShortfallError);

      // ---- homebrew (a campaign on attack_utility) ---------------------------------------------
      campaignId = await createCampaign(dmId, `IT ${tag}`);
      await query(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1,$2,'player')`, [campaignId, userId]);
      await setCampaignActionEconomy(dmId, campaignId, 'attack_utility');
      const hero = await mkCharacter('Hero');
      await addCharacterToCampaign(userId, hero, campaignId);
      await setSlots(hero, [[3, 2], [5, 1]]);
      expect(await left(hero)).toEqual({ attack: 2, utility: 2 });

      // Fireball (L3, "1 action") spends the slot and 1 Attack; Shield (a reaction) also spends Attack; a potion spends Utility.
      const fireball = await spell(hero, 'Fireball', 3, '1 action', [{ pool: 'spell_slot', amount: 1, level: 3 }]);
      const heroShield = await spell(hero, 'Shield', 1, '1 reaction, which you take when you are hit', []);
      await cast(hero, fireball);
      expect(await slot(hero, 3)).toBe(1);
      expect(await left(hero)).toEqual({ attack: 1, utility: 2 });
      await cast(hero, heroShield);
      expect(await left(hero)).toEqual({ attack: 0, utility: 2 });
      const heroPotion = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Potion',$2,2) RETURNING id`, [hero, potion])).rows[0].id;
      await useInventoryCatalogueItem(userId, hero, heroPotion);
      expect(await left(hero)).toEqual({ attack: 0, utility: 1 });

      // A dash is a general action: 1 Utility here.
      await withTransaction((client) => payActivationCost(client, hero, { kind: 'dash', count: 1 }, { actorUserId: userId }));
      expect(await left(hero)).toEqual({ attack: 0, utility: 0 });
      await expect(withTransaction((client) => payActivationCost(client, hero, { kind: 'dash', count: 10 }, { actorUserId: userId }))).rejects.toThrow('1 to 9');

      // Over budget with an override: pays 0 of the missing Attack, ledgers the turn line, and undo refunds it the same turn.
      await advanceCharacterTurn(userId, hero);
      await attack(hero);
      await attack(hero); // Attack 0 now (no Extra Attack yet)
      expect((await left(hero)).attack).toBe(0);
      await cast(hero, heroShield, {}, { kind: 'self_override', roomId: null });
      let ledger = (await query<any>(`SELECT * FROM character_resource_ledger WHERE character_id=$1 AND pool LIKE 'turn:%'`, [hero])).rows;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ pool: 'turn:attack', delta: 0, shortfall: 1, override_kind: 'self_override' });
      expect((await left(hero)).attack).toBe(0);

      // Same-turn undo refunds what was actually paid (here a Reaction-timed spell paid nothing) and
      // a second override that DID pay refunds it.
      await advanceCharacterTurn(userId, hero);
      await attack(hero);
      await attack(hero);
      const sheetBefore = await left(hero);
      expect(sheetBefore.attack).toBe(0);
      await query(`DELETE FROM character_resource_ledger WHERE character_id=$1`, [hero]);
      // One more attack with a pool that is affordable-but-short: spend 1 of 2, then ask for 2.
      await advanceCharacterTurn(userId, hero);
      await attack(hero);
      const twoActions = await spell(hero, 'Two actions', 0, '1 action', [{ pool: 'turn', amount: 2, timing: 'action', category: 'spell' }]);
      await cast(hero, twoActions, {}, { kind: 'self_override', roomId: null });
      ledger = (await query<any>(`SELECT * FROM character_resource_ledger WHERE character_id=$1 AND pool LIKE 'turn:%'`, [hero])).rows;
      expect(ledger[0]).toMatchObject({ pool: 'turn:attack', delta: -1, shortfall: 1, before_value: 1, after_value: 0 });
      const activationId = ledger[0].activation_id;
      const undone = await reviewOverride(dmId, campaignId, activationId, 'undo');
      expect(undone.status).toBe('undone');
      expect(undone.refunded).toContain('1 Attack action');
      expect((await left(hero)).attack).toBe(1);
      // Undo after the turn moved on: noted, not refunded.
      await advanceCharacterTurn(userId, hero);
      await attack(hero);
      await cast(hero, twoActions, {}, { kind: 'self_override', roomId: null });
      const later = (await query<any>(`SELECT activation_id FROM character_resource_ledger WHERE character_id=$1 AND pool='turn:attack' AND reviewed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [hero])).rows[0].activation_id;
      await advanceCharacterTurn(userId, hero);
      const stale = await reviewOverride(dmId, campaignId, later, 'undo');
      expect(stale.message).toContain('not refunded - the turn has been reset since');
      expect((await left(hero)).attack).toBe(2);

      // Two parallel casts on the last Attack: one succeeds, one is short, and only one is spent.
      await advanceCharacterTurn(userId, hero);
      await attack(hero);
      const racers = await Promise.allSettled([cast(hero, heroShield), cast(hero, heroShield)]);
      expect(racers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(racers.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect((racers.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(CostShortfallError);
      expect((await left(hero)).attack).toBe(0);

      // ---- Extra Attack: free follow-up weapon attacks --------------------------------------------
      const fighter = await mkCharacter('Fighter');
      await addCharacterToCampaign(userId, fighter, campaignId);
      await grant(fighter, 'followup.melee.count', '1', 'Extra Attack');
      await advanceCharacterTurn(userId, fighter);
      await attack(fighter); // pays Attack (1 left) and grants 1 follow-up
      expect(await left(fighter)).toEqual({ attack: 1, utility: 2 });
      expect(await followupsLeft(fighter)).toEqual([['melee', 1]]);
      await attack(fighter); // uses the follow-up: no Attack spent
      expect(await left(fighter)).toEqual({ attack: 1, utility: 2 });
      expect(await followupsLeft(fighter)).toEqual([]);
      await attack(fighter); // pays the last Attack and grants 1
      expect(await left(fighter)).toEqual({ attack: 0, utility: 2 });
      await attack(fighter); // follow-up again
      expect(await followupsLeft(fighter)).toEqual([]);
      await expect(attack(fighter)).rejects.toBeInstanceOf(CostShortfallError); // attack 5: short
      expect((await turn(fighter)).log.map((l) => l.via)).toEqual(['pool', 'followup', 'pool', 'followup']);
      // Next Turn clears anything unused.
      await attack(fighter, undefined, { kind: 'self_override', roomId: null }); // over budget: pays 0, still grants (accumulates)
      expect((await followupsLeft(fighter)).length).toBe(1);
      await advanceCharacterTurn(userId, fighter);
      expect(await followupsLeft(fighter)).toEqual([]);

      // Fighter 20: three links grant 3 per Attack action.
      await grant(fighter, 'followup.melee.count', '1', 'Extra Attack II');
      await grant(fighter, 'followup.melee.count', '1', 'Extra Attack III');
      await attack(fighter);
      expect(await followupsLeft(fighter)).toEqual([['melee', 3]]);
      expect((await turn(fighter)).followups[0]).toMatchObject({ perAction: 3, label: 'Extra Attack' });

      // A bonus-action (off-hand) or reaction attack never grants follow-ups (Extra Attack is part of the Attack action).
      await advanceCharacterTurn(userId, fighter);
      await attack(fighter, 'bonus_action');
      await attack(fighter, 'reaction');
      expect(await followupsLeft(fighter)).toEqual([]);

      // 5e: an Action-timed attack pays Action and grants follow-ups; a reaction one pays Reaction and leaves them alone.
      const knight = await mkCharacter('Knight');
      await grant(knight, 'followup.melee.count', '2', 'Extra Attack');
      await attack(knight);
      expect(await left(knight)).toEqual({ action: 0, bonus_action: 1, reaction: 1 });
      expect(await followupsLeft(knight)).toEqual([['melee', 2]]);
      await attack(knight, 'reaction');
      expect((await left(knight)).reaction).toBe(0);
      expect(await followupsLeft(knight)).toEqual([['melee', 2]]); // an opportunity attack neither uses nor earns a follow-up

      // ---- spell echoes (a doublecast-style grant) --------------------------------------------------
      const mage = await mkCharacter('Mage');
      await addCharacterToCampaign(userId, mage, campaignId);
      await grant(mage, 'followup.spell.count', '1', 'Doublecast');
      await setSlots(mage, [[3, 2], [5, 2]]);
      const mageBall = await spell(mage, 'Fireball', 3, '1 action', [{ pool: 'spell_slot', amount: 1, level: 3 }]);
      const mageBolt = await spell(mage, 'Fire Bolt', 0);
      // Cast at level 5: pays the L5 slot and 1 Attack, and earns one spell echo.
      const original = await castDetailed(mage, mageBall, { slotLevel: '5' });
      expect(original.spent).toEqual({ slotType: 'standard', slotLevel: 5 });
      expect(original.castAtLevel).toBeUndefined();
      expect(await slot(mage, 5)).toBe(1);
      expect(await left(mage)).toEqual({ attack: 1, utility: 2 });
      expect(await followupsLeft(mage)).toEqual([['spell', 1]]);
      // The echo is completely free (no slot, no Attack) and resolves at the BASE level, not level 5.
      // Without the explicit choice a second Fireball is just a normal cast (it never silently becomes a free L3 echo).
      // (Checked on a copy of the state below; here we choose the echo.)
      const echo = await castDetailed(mage, mageBall, { slotLevel: '5', followup: 'use' });
      expect(echo.spent).toBeNull();
      expect(echo.castAtLevel).toBe(3);
      expect(await slot(mage, 5)).toBe(1);
      expect(await slot(mage, 3)).toBe(2);
      expect(await left(mage)).toEqual({ attack: 1, utility: 2 });
      expect(await followupsLeft(mage)).toEqual([]);
      // An echo does not re-grant, and cantrips are their own class: Fire Bolt earns nothing here.
      await cast(mage, mageBolt);
      expect(await followupsLeft(mage)).toEqual([]);
      expect(await left(mage)).toEqual({ attack: 0, utility: 2 });
      const mageLog = (await turn(mage)).log.map((l) => l.via);
      expect(mageLog).toEqual(['pool', 'followup', 'pool']);

      // Default 'skip': a waiting echo is NOT spent by a plain cast. It pays the slot and the Attack again.
      await advanceCharacterTurn(userId, mage);
      await castDetailed(mage, mageBall, { slotLevel: '3' });
      expect(await followupsLeft(mage)).toEqual([['spell', 1]]);
      const plain = await castDetailed(mage, mageBall, { slotLevel: '3' });
      expect(plain.spent).toEqual({ slotType: 'standard', slotLevel: 3 });
      expect(plain.castAtLevel).toBeUndefined();
      expect(await left(mage)).toEqual({ attack: 0, utility: 2 });
      expect(await followupsLeft(mage)).toEqual([['spell', 2]]); // the second action-timed cast earned another

      // Only Action-timed spells earn or spend an echo: a bonus-action spell does neither.
      await advanceCharacterTurn(userId, mage);
      const quick = await spell(mage, 'Misty Step', 2, '1 bonus action', []);
      await cast(mage, quick);
      expect(await followupsLeft(mage)).toEqual([]);

      // ---- weapon follow-ups: explicit skip, single-action lines, undo, and lock order ----------------
      const duelist = await mkCharacter('Duelist');
      await addCharacterToCampaign(userId, duelist, campaignId);
      await grant(duelist, 'followup.melee.count', '1', 'Extra Attack');
      await advanceCharacterTurn(userId, duelist);
      await attack(duelist);
      expect(await followupsLeft(duelist)).toEqual([['melee', 1]]);
      await attack(duelist, undefined, undefined, 'skip'); // chosen NOT to use the follow-up: pays the second Attack
      expect(await left(duelist)).toEqual({ attack: 0, utility: 2 });
      expect(await followupsLeft(duelist)).toEqual([['melee', 2]]);
      // An override attack that earns a follow-up is unwound by an undo in the same turn.
      await attack(duelist, undefined, { kind: 'self_override', roomId: null }, 'skip'); // Attack is 0: pays nothing, still earns
      expect(await followupsLeft(duelist)).toEqual([['melee', 3]]);
      const earned = (await query<any>(`SELECT * FROM character_resource_ledger WHERE character_id=$1 AND pool='turn:attack' AND reviewed_at IS NULL`, [duelist])).rows[0];
      expect(earned.pool_detail).toMatchObject({ grantedCls: 'melee', grantedCount: 1 });
      const unwound = await reviewOverride(dmId, campaignId, earned.activation_id, 'undo');
      expect(unwound.status).toBe('undone');
      expect(await followupsLeft(duelist)).toEqual([['melee', 2]]);
      // After the turn moves on there is nothing left to unwind (and nothing breaks).
      await attack(duelist, undefined, { kind: 'self_override', roomId: null }, 'skip');
      const staleEarned = (await query<any>(`SELECT activation_id FROM character_resource_ledger WHERE character_id=$1 AND pool='turn:attack' AND reviewed_at IS NULL`, [duelist])).rows[0].activation_id;
      await advanceCharacterTurn(userId, duelist);
      await attack(duelist);
      await reviewOverride(dmId, campaignId, staleEarned, 'undo');
      expect(await followupsLeft(duelist)).toEqual([['melee', 1]]);

      // payTurnActivation (what the sheet's payTurn action and the VTT roll-attack call) returns what was paid and the fresh view.
      const { payTurnActivation } = await import('./services/catalogue');
      await advanceCharacterTurn(userId, duelist);
      const payOne = await payTurnActivation(userId, duelist, { kind: 'weapon_attack', inventoryId: null, label: 'Longsword' });
      expect(payOne.paid.map((l) => l.pool)).toEqual(['turn:attack']);
      expect(payOne.turn.followups).toMatchObject([{ cls: 'melee', label: 'Extra Attack', remaining: 1 }]);
      const payTwo = await payTurnActivation(userId, duelist, { kind: 'weapon_attack', inventoryId: null, label: 'Longsword' }); // default: use the follow-up
      expect(payTwo.paid.map((l) => l.pool)).toEqual(['followup']);
      expect(payTwo.turn.followups).toEqual([]);
      expect(payTwo.results[0]).toMatchObject({ label: 'Cost', target: 'Extra Attack', before: 1, after: 0 });
      // A cantrip echo needs the explicit choice and resolves with no cost lines at all (cantrip class).
      await grant(duelist, 'followup.cantrip.count', '1', 'Cantrip echo');
      const cantrip = await spell(duelist, 'Echo bolt', 0);
      await advanceCharacterTurn(userId, duelist);
      await cast(duelist, cantrip);
      expect(await followupsLeft(duelist)).toEqual([['cantrip', 1]]);
      await cast(duelist, cantrip, { followup: 'use' });
      expect(await followupsLeft(duelist)).toEqual([]);
      expect((await left(duelist)).attack).toBe(1); // only the first cast paid

      // ---- followup 'require': a free repeat or nothing, never a paid action ---------------------------
      const monk = await mkCharacter('Monk');
      await addCharacterToCampaign(userId, monk, campaignId);
      await grant(monk, 'followup.melee.count', '1', 'Extra Attack');
      await advanceCharacterTurn(userId, monk);
      // None waiting: it fails, with nothing spent (also under an override, which must not let it pay).
      await expect(attack(monk, undefined, undefined, 'require')).rejects.toBeInstanceOf(FollowupGoneError);
      await expect(attack(monk, undefined, { kind: 'self_override', roomId: null }, 'require')).rejects.toBeInstanceOf(FollowupGoneError);
      expect(await left(monk)).toEqual({ attack: 2, utility: 2 });
      expect(await followupsLeft(monk)).toEqual([]);
      expect((await turn(monk)).log).toHaveLength(0);
      // An Unarmed Strike (id-less, paid through payTurnActivation as the VTT turn route does) with no choice
      // sent uses the waiting follow-up on the second attack, so the counter never climbs.
      const { payTurnActivation: payTurn } = await import('./services/catalogue');
      const strike = (followup?: 'use' | 'skip' | 'require') => payTurn(userId, monk, { kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike', ...(followup ? { followup } : {}) });
      expect((await strike()).paid.map((l) => l.pool)).toEqual(['turn:attack']);
      expect(await followupsLeft(monk)).toEqual([['melee', 1]]);
      expect((await strike()).paid.map((l) => l.pool)).toEqual(['followup']);
      expect(await followupsLeft(monk)).toEqual([]);
      expect(await left(monk)).toEqual({ attack: 1, utility: 2 });
      // A repeat with 'require' uses a waiting follow-up; the next one fails and the pool stays put.
      await strike(); // pays the last Attack, grants 1
      expect((await strike('require')).paid.map((l) => l.pool)).toEqual(['followup']);
      await expect(strike('require')).rejects.toBeInstanceOf(FollowupGoneError);
      expect(await left(monk)).toEqual({ attack: 0, utility: 2 });
      expect(await followupsLeft(monk)).toEqual([]);

      // Spell echo through 'require': free, at the base level, and a second one fails with nothing spent.
      await advanceCharacterTurn(userId, mage);
      await setSlots(mage, [[3, 2], [5, 2]]);
      await expect(castDetailed(mage, mageBall, { slotLevel: '5', followup: 'require' })).rejects.toBeInstanceOf(FollowupGoneError);
      expect(await slot(mage, 5)).toBe(2);
      expect(await left(mage)).toEqual({ attack: 2, utility: 2 });
      const original2 = await castDetailed(mage, mageBall, { slotLevel: '5' });
      expect(original2.followupCls).toBe('spell');
      expect(original2.usedFollowup).toBe(false);
      const required = await castDetailed(mage, mageBall, { slotLevel: '5', followup: 'require' });
      expect(required).toMatchObject({ spent: null, castAtLevel: 3, usedFollowup: true });
      expect(await slot(mage, 5)).toBe(1);
      expect(await slot(mage, 3)).toBe(2);
      await expect(castDetailed(mage, mageBall, { slotLevel: '5', followup: 'require' })).rejects.toBeInstanceOf(FollowupGoneError);
      expect(await slot(mage, 5)).toBe(1);
      expect(await left(mage)).toEqual({ attack: 1, utility: 2 });

      // The turn row is the first lock: casts racing long rests never deadlock.
      const racer = await mkCharacter('Racer');
      await addCharacterToCampaign(userId, racer, campaignId);
      await setSlots(racer, [[3, 9]]);
      const racerBall = await spell(racer, 'Fireball', 3, '1 action', [{ pool: 'spell_slot', amount: 1, level: 3 }]);
      for (let round = 0; round < 3; round++) {
        await advanceCharacterTurn(userId, racer);
        const jobs = [cast(racer, racerBall), restCharacter(userId, racer, 'long_rest'), cast(racer, racerBall), advanceCharacterTurn(userId, racer), newBattleJob(racer)];
        const results = await Promise.allSettled(jobs);
        for (const result of results) {
          if (result.status === 'rejected') expect(result.reason, String(result.reason)).toBeInstanceOf(CostShortfallError);
        }
      }
    } finally {
      if (campaignId) await query('DELETE FROM campaigns WHERE id=$1', [campaignId]);
      await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userId, dmId]]);
      if (contentIds.length) await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
    }
  });
});

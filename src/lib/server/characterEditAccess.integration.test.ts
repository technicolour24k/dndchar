import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed tests for campaign Unit C: who may EDIT a character (owner, campaign DM / co-DM, site
// admin), who may ACT for it (not admin), and the stale-save guard. SKIPPED unless
// CAMPAIGN_DB_TEST=1, so the normal suite never touches a database. Local dev DB only: the host
// guard runs before any query. Creates throwaway users (inserted into `users` only, never
// `sessions`), characters and campaigns, and deletes them all in afterAll.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   $env:CAMPAIGN_DB_TEST='1'; npx vitest run src/lib/server/characterEditAccess.integration.test.ts
const enabled = process.env.CAMPAIGN_DB_TEST === '1';

const { query } = await import('$lib/server/db');
const campaigns = await import('./services/campaigns');
const characters = await import('./services/characters');
const catalogue = await import('./services/catalogue');
const pageRoute = await import('../../routes/characters/[id]/+page.server');
const rollItemRoute = await import('../../routes/vtt/api/characters/[id]/roll-item/+server');
const rollSpellRoute = await import('../../routes/vtt/api/characters/[id]/roll-spell/+server');

const tag = `zzedit${crypto.randomBytes(4).toString('hex')}`;
const ROOM = `ITEDIT${tag.slice(-4).toUpperCase()}`;
const userIds: Record<string, string> = {};
const charIds: Record<string, string> = {};
const campaignIds: string[] = [];
const u = (key: string) => userIds[key];

async function makeUser(key: string, role: 'user' | 'admin' = 'user') {
  const result = await query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, role, active_vtt_session_id) VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [`${tag}-${key}@example.invalid`, `IT ${key}`, role, ROOM]
  );
  userIds[key] = result.rows[0].id;
}
async function makeCharacter(key: string, ownerKey: string) {
  const result = await query<{ id: string }>(`INSERT INTO characters (owner_user_id, name) VALUES ($1, $2) RETURNING id`, [u(ownerKey), `IT char ${key}`]);
  charIds[key] = result.rows[0].id;
}

// True when the call was refused by the access check (and so changed nothing). Any other outcome
// (success, or "allowed but the row does not exist") counts as allowed.
async function refused(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof Error && error.message === 'Character not found.';
  }
}

const form = (fields: Record<string, string> = {}) => new URLSearchParams(fields) as unknown as FormData;
const FAKE = '99999999-9999-4999-8999-999999999999';

// Every switched service write, as (userKey, characterKey) -> a call.
const serviceCalls: Record<string, (user: string, char: string) => Promise<unknown>> = {
  updateCharacter: (k, c) => characters.updateCharacter(u(k), charIds[c], form({ name: 'Edited' }), 'IT save'),
  spendHitDice: (k, c) => characters.spendHitDice(u(k), charIds[c], 0, 1, 1, 0),
  restCharacter: (k, c) => catalogue.restCharacter(u(k), charIds[c], 'short_rest'),
  newBattle: (k, c) => catalogue.newBattle(u(k), charIds[c]),
  advanceCharacterRound: (k, c) => catalogue.advanceCharacterRound(u(k), charIds[c]),
  advanceCharacterTurn: (k, c) => catalogue.advanceCharacterTurn(u(k), charIds[c]),
  syncCharacterSpellSlots: (k, c) => catalogue.syncCharacterSpellSlots(u(k), charIds[c]),
  addContentToCharacter: (k, c) => catalogue.addContentToCharacter(u(k), charIds[c], FAKE),
  castCharacterSpell: (k, c) => catalogue.castCharacterSpell(u(k), charIds[c], form({ instanceId: FAKE })),
  useInventoryCatalogueItem: (k, c) => catalogue.useInventoryCatalogueItem(u(k), charIds[c], FAKE),
  triggerCharacterContentActions: (k, c) => catalogue.triggerCharacterContentActions(u(k), charIds[c], FAKE),
  removeContentFromCharacter: (k, c) => catalogue.removeContentFromCharacter(u(k), charIds[c], FAKE),
  setCharacterContentState: (k, c) => catalogue.setCharacterContentState(u(k), charIds[c], FAKE, form()),
  useContentResource: (k, c) => catalogue.useContentResource(u(k), charIds[c], FAKE, -1),
  useInventoryResource: (k, c) => catalogue.useInventoryResource(u(k), charIds[c], FAKE, -1),
  spendSpellSlot: (k, c) => catalogue.spendSpellSlot(u(k), charIds[c], 'standard', 1, -1),
  restoreCharacterVersion: (k, c) => characters.restoreCharacterVersion(u(k), charIds[c], FAKE)
};

// Who may edit which character. cInCampaign belongs to `owner` and sits in campaign A;
// cLoose belongs to `owner` and has no campaign.
const editMatrix: Record<string, { cInCampaign: boolean; cLoose: boolean }> = {
  owner: { cInCampaign: true, cLoose: true },
  dm: { cInCampaign: true, cLoose: false },
  codm: { cInCampaign: true, cLoose: false },
  admin: { cInCampaign: true, cLoose: true },
  player: { cInCampaign: false, cLoose: false },
  outsider: { cInCampaign: false, cLoose: false },
  otherDm: { cInCampaign: false, cLoose: false } // a DM of a DIFFERENT campaign
};
// The services that PLAY the character (spend slots and items). Edit access is not enough for them:
// a pure admin is refused, everyone else follows the edit matrix.
const actCalls = ['castCharacterSpell', 'useInventoryCatalogueItem', 'triggerCharacterContentActions'];
const actors = ['owner', 'dm', 'codm']; // who may ACT (roll) for cInCampaign: never admin, never a plain member

beforeAll(async () => {
  if (!enabled) return;
  // Guard FIRST, before any query: local database only, and no ?host= override.
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
  for (const key of ['owner', 'dm', 'codm', 'player', 'outsider', 'otherDm']) await makeUser(key);
  await makeUser('admin', 'admin');
  await makeUser('adminOwner', 'admin'); // an admin who OWNS a character
  await makeUser('adminDm', 'admin'); // an admin who is also a campaign's DM member
  await makeCharacter('cAdminOwn', 'adminOwner');
  await makeCharacter('cInAdminDm', 'player');
  await makeCharacter('cInCampaign', 'owner');
  await makeCharacter('cLoose', 'owner');

  // Campaign A: dm is the primary DM, codm the co-DM, owner and player are players.
  const A = await campaigns.createCampaign(u('dm'), `${tag} A`, '');
  campaignIds.push(A);
  const code = (await query<{ invite_code: string }>('SELECT invite_code FROM campaigns WHERE id = $1', [A])).rows[0].invite_code;
  for (const key of ['codm', 'owner', 'player']) await campaigns.joinCampaignByInviteCode(u(key), code);
  await campaigns.setMemberRole(u('dm'), A, u('codm'), 'co_dm');
  await campaigns.addCharacterToCampaign(u('owner'), charIds.cInCampaign, A);
  // Campaign C: adminDm is its DM (as a real member); player's character sits in it.
  const C = await campaigns.createCampaign(u('adminDm'), `${tag} C`, '');
  campaignIds.push(C);
  const codeC = (await query<{ invite_code: string }>('SELECT invite_code FROM campaigns WHERE id = $1', [C])).rows[0].invite_code;
  await campaigns.joinCampaignByInviteCode(u('player'), codeC);
  await campaigns.addCharacterToCampaign(u('player'), charIds.cInAdminDm, C);
  // Campaign B: otherDm runs it; nobody from A is in it.
  campaignIds.push(await campaigns.createCampaign(u('otherDm'), `${tag} B`, ''));
  console.info('[character edit integration] database host', target.hostname);
});

afterAll(async () => {
  if (!enabled || !u('owner')) return;
  await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(userIds)]);
  if (campaignIds.length) await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [campaignIds]);
});

describe.skipIf(!enabled)('character edit access (Unit C) against the local dev DB', () => {
  it('sanity: the target is local', () => {
    expect(['localhost', '127.0.0.1', '::1']).toContain(new URL(env.DATABASE_URL!).hostname);
  });

  for (const callName of Object.keys(serviceCalls)) {
    it(`${callName}: owner, DM, co-DM, admin allowed; member, outsider and another campaign's DM refused`, async () => {
      for (const [who, expected] of Object.entries(editMatrix)) {
        for (const charKey of ['cInCampaign', 'cLoose'] as const) {
          const wasRefused = await refused(() => serviceCalls[callName](who, charKey));
          // Act calls also refuse a pure admin (edit-only override); every other row is as the matrix says.
          const mayDo = expected[charKey] && !(actCalls.includes(callName) && who === 'admin');
          expect(wasRefused, `${callName} by ${who} on ${charKey}`).toBe(!mayDo);
        }
      }
    });
  }

  it('getCharacter and listVersions follow edit access (members get nothing until Unit D)', async () => {
    for (const [who, expected] of Object.entries(editMatrix)) {
      expect(Boolean(await characters.getCharacter(u(who), charIds.cInCampaign)), `getCharacter ${who}`).toBe(expected.cInCampaign);
      expect(Boolean(await characters.getCharacter(u(who), charIds.cLoose)), `getCharacter loose ${who}`).toBe(expected.cLoose);
    }
    // The saves above left versions behind; a plain member sees none of them.
    expect((await characters.listVersions(u('dm'), charIds.cInCampaign)).length).toBeGreaterThan(0);
    expect(await characters.listVersions(u('player'), charIds.cInCampaign)).toEqual([]);
  });

  it('a DM or admin save is attributed to them in version history; restore works for a DM', async () => {
    await characters.updateCharacter(u('dm'), charIds.cInCampaign, form({ name: 'By DM' }), 'DM save');
    await characters.updateCharacter(u('admin'), charIds.cInCampaign, form({ name: 'By admin' }), 'Admin save');
    const rows = await query<{ change_summary: string; created_by_user_id: string; id: string }>(
      `SELECT id, change_summary, created_by_user_id FROM character_versions WHERE character_id = $1 AND change_summary IN ('DM save', 'Admin save')`,
      [charIds.cInCampaign]
    );
    expect(rows.rows.find((r) => r.change_summary === 'DM save')?.created_by_user_id).toBe(u('dm'));
    expect(rows.rows.find((r) => r.change_summary === 'Admin save')?.created_by_user_id).toBe(u('admin'));
    const version = rows.rows.find((r) => r.change_summary === 'DM save')!;
    await characters.restoreCharacterVersion(u('dm'), charIds.cInCampaign, version.id);
    await expect(characters.restoreCharacterVersion(u('player'), charIds.cInCampaign, version.id)).rejects.toThrow('Character not found.');
  });

  it('once the character leaves the campaign the DM loses edit', async () => {
    const A = campaignIds[0];
    await campaigns.removeCharacterFromCampaign(u('owner'), charIds.cInCampaign);
    expect(await refused(() => serviceCalls.restCharacter('dm', 'cInCampaign'))).toBe(true);
    expect(await refused(() => serviceCalls.restCharacter('owner', 'cInCampaign'))).toBe(false);
    await campaigns.addCharacterToCampaign(u('owner'), charIds.cInCampaign, A);
    expect(await refused(() => serviceCalls.restCharacter('dm', 'cInCampaign'))).toBe(false);
  });

  // ---- Sheet page: load and the inventory actions ----
  const run = (action: any, who: string, charKey: string, fields: Record<string, string> = {}) =>
    action({
      request: { formData: async () => new URLSearchParams(fields) },
      params: { id: charIds[charKey] },
      locals: { user: { id: u(who), role: who.startsWith('admin') ? 'admin' : 'user' } }
    });

  it('sheet load: owner, DM, co-DM and admin open it (with the right access flags); member, outsider, other DM get 404', async () => {
    const load = (who: string, charKey: string) =>
      (pageRoute.load as any)({ params: { id: charIds[charKey] }, locals: { user: { id: u(who) } }, depends: () => {} });
    for (const [who, expected] of Object.entries(editMatrix)) {
      if (expected.cInCampaign) {
        const data = await load(who, 'cInCampaign');
        expect(data.access.canEdit).toBe(true);
        expect(data.access.isOwner).toBe(who === 'owner');
        expect(data.access.viaAdmin).toBe(who === 'admin');
        expect(data.access.isCampaignDm).toBe(who === 'dm' || who === 'codm');
      } else {
        await expect(load(who, 'cInCampaign')).rejects.toMatchObject({ status: 404 });
      }
    }
  });

  it('inventory actions (add, equip, remove): editors allowed, everyone else gets a 403', async () => {
    for (const [who, expected] of Object.entries(editMatrix)) {
      const added = await run(pageRoute.actions.addInventoryItem, who, 'cInCampaign', { name: `IT item ${who}` });
      if (expected.cInCampaign) expect(added, `add ${who}`).toEqual({ contentUpdated: true });
      else expect(added, `add ${who}`).toMatchObject({ status: 403 });
    }
    const item = (await query<{ id: string }>(`SELECT id FROM character_inventory_items WHERE character_id = $1 AND name = 'IT item dm'`, [charIds.cInCampaign])).rows[0];
    expect(item).toBeTruthy();
    for (const [who, expected] of Object.entries(editMatrix)) {
      const equipped = await run(pageRoute.actions.setEquipped, who, 'cInCampaign', { inventoryId: item.id, equipped: 'true' });
      if (expected.cInCampaign) expect(equipped, `equip ${who}`).toEqual({ contentUpdated: true });
      else expect(equipped, `equip ${who}`).toMatchObject({ status: 403 });
    }
    expect(await run(pageRoute.actions.removeInventoryItem, 'player', 'cInCampaign', { inventoryId: item.id })).toMatchObject({ status: 403 });
    expect(await run(pageRoute.actions.removeInventoryItem, 'codm', 'cInCampaign', { inventoryId: item.id })).toEqual({ contentUpdated: true });
  });

  it('logRoll: only someone who can ACT logs a roll as the character (admin and members do not)', async () => {
    const roll = { label: 'Athletics', total: '15', breakdown: '10 + 5', natural: '10' };
    for (const who of Object.keys(editMatrix)) {
      const outcome = await run(pageRoute.actions.logRoll, who, 'cInCampaign', roll);
      expect(outcome, who).toEqual({ loggedRoll: actors.includes(who) });
    }
    const rows = await query('SELECT 1 FROM roll_log_entries WHERE session_id = $1', [ROOM]);
    expect(rows.rows.length).toBe(actors.length);
  });

  // ---- VTT rolls: act, not edit ----
  const post = async (route: any, who: string, charKey: string, body: Record<string, unknown>) => {
    const response: Response = await route.POST({ locals: { user: { id: u(who) } }, params: { id: charIds[charKey] }, request: { json: async () => body } });
    return { status: response.status, body: await response.json() };
  };

  it('roll-item and roll-spell: owner and DMs get past the check; admin (who can edit), members and outsiders get not_found', async () => {
    expect(editMatrix.admin.cInCampaign).toBe(true); // admin CAN edit this character, but must not roll for it
    for (const who of Object.keys(editMatrix)) {
      const item = await post(rollItemRoute, who, 'cInCampaign', { inventoryId: FAKE });
      const spell = await post(rollSpellRoute, who, 'cInCampaign', { instanceId: FAKE });
      // Allowed callers reach the "no such item / spell" step; refused ones are stopped before it.
      expect(item.body.error, `roll-item ${who}`).toBe(actors.includes(who) ? 'item_not_found' : 'not_found');
      expect(spell.body.error, `roll-spell ${who}`).toBe(actors.includes(who) ? 'spell_not_found' : 'not_found');
    }
  });

  it('sheet useItem, triggerContent and castSpell actions: a pure admin is refused, owner and DMs are not', async () => {
    const actions: [any, Record<string, string>][] = [
      [pageRoute.actions.useItem, { inventoryId: FAKE }],
      [pageRoute.actions.triggerContent, { instanceId: FAKE }],
      [pageRoute.actions.castSpell, { instanceId: FAKE }]
    ];
    for (const [action, fields] of actions) {
      for (const who of Object.keys(editMatrix)) {
        const wasRefused = await refused(() => run(action, who, 'cInCampaign', fields));
        expect(wasRefused, `${who}`).toBe(!actors.includes(who));
      }
    }
    // Bookkeeping edits stay open to the admin: spell slots, resources, rest.
    expect(await refused(() => run(pageRoute.actions.rest, 'admin', 'cInCampaign', { restType: 'short_rest' }))).toBe(false);
    expect(await refused(() => run(pageRoute.actions.spellSlot, 'admin', 'cInCampaign', { slotType: 'standard', slotLevel: '1', delta: '-1' }))).toBe(false);
  });

  it('an admin who OWNS the character, or who is its campaign DM, can still roll and act', async () => {
    for (const [who, charKey] of [['adminOwner', 'cAdminOwn'], ['adminDm', 'cInAdminDm']] as const) {
      expect(await run(pageRoute.actions.logRoll, who, charKey, { label: 'Stealth', total: '12', breakdown: '', natural: '8' }), who).toEqual({ loggedRoll: true });
      expect((await post(rollItemRoute, who, charKey, { inventoryId: FAKE })).body.error, `roll-item ${who}`).toBe('item_not_found');
      expect((await post(rollSpellRoute, who, charKey, { instanceId: FAKE })).body.error, `roll-spell ${who}`).toBe('spell_not_found');
      for (const [action, fields] of [
        [pageRoute.actions.castSpell, { instanceId: FAKE }],
        [pageRoute.actions.useItem, { inventoryId: FAKE }],
        [pageRoute.actions.triggerContent, { instanceId: FAKE }]
      ] as [any, Record<string, string>][]) {
        expect(await refused(() => run(action, who, charKey, fields)), `${who} act`).toBe(false);
      }
    }
    // A pure admin on the same DM-run character is still refused (the contrast).
    expect((await post(rollItemRoute, 'admin', 'cInAdminDm', { inventoryId: FAKE })).body.error).toBe('not_found');
  });

  // ---- Stale-save guard ----
  const versionOf = async (charKey: string) =>
    (await query<{ sheet_version: number }>('SELECT sheet_version FROM characters WHERE id = $1', [charIds[charKey]])).rows[0].sheet_version;

  it('stale guard: a second save with the same loaded version is refused and writes nothing', async () => {
    const loaded = await versionOf('cLoose');
    const next = await characters.updateCharacter(u('owner'), charIds.cLoose, form({ name: 'First', sheetVersion: String(loaded) }), 'first');
    expect(next).toBe(loaded + 1);
    await expect(characters.updateCharacter(u('owner'), charIds.cLoose, form({ name: 'Second', sheetVersion: String(loaded) }), 'second')).rejects.toBeInstanceOf(
      characters.StaleSheetError
    );
    expect((await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [charIds.cLoose])).rows[0].name).toBe('First');
    // The refused save left no version row either.
    expect((await query('SELECT 1 FROM character_versions WHERE character_id = $1 AND change_summary = $2', [charIds.cLoose, 'second'])).rows.length).toBe(0);
  });

  it('stale guard: the owner saving again with the version their last save returned is NOT refused', async () => {
    let token = await versionOf('cLoose');
    for (let i = 0; i < 3; i += 1) {
      token = await characters.updateCharacter(u('owner'), charIds.cLoose, form({ name: `Own ${i}`, sheetVersion: String(token) }), 'own');
    }
    expect(token).toBe(await versionOf('cLoose'));
  });

  it("stale guard: a DM save makes the owner's older open sheet stale; a missing field skips the check", async () => {
    const ownersToken = await versionOf('cInCampaign');
    await characters.updateCharacter(u('dm'), charIds.cInCampaign, form({ name: 'DM was here', sheetVersion: String(ownersToken) }), 'dm');
    await expect(
      characters.updateCharacter(u('owner'), charIds.cInCampaign, form({ name: 'Owner late', sheetVersion: String(ownersToken) }), 'late')
    ).rejects.toBeInstanceOf(characters.StaleSheetError);
    // Old tab from before the deploy: no field, no check.
    await expect(characters.updateCharacter(u('owner'), charIds.cInCampaign, form({ name: 'No token' }), 'no token')).resolves.toBeTypeOf('number');
  });

  it('stale guard: the sheet Save action returns 409 staleSheet, and the new version on success', async () => {
    const loaded = await versionOf('cLoose');
    const ok = await run(pageRoute.actions.save, 'owner', 'cLoose', { name: 'Via action', sheetVersion: String(loaded) });
    expect(ok).toEqual({ saved: true, sheetVersion: loaded + 1 });
    const stale = await run(pageRoute.actions.save, 'owner', 'cLoose', { name: 'Again', sheetVersion: String(loaded) });
    expect(stale).toMatchObject({ status: 409, data: { staleSheet: true } });
  });

  it('stale guard: button actions, inventory adds and VTT-style HP changes do not bump the version; a restore does', async () => {
    const before = await versionOf('cLoose');
    await catalogue.restCharacter(u('owner'), charIds.cLoose, 'long_rest');
    await catalogue.newBattle(u('owner'), charIds.cLoose);
    await characters.spendHitDice(u('owner'), charIds.cLoose, 0, 1, 1, 0);
    await run(pageRoute.actions.addInventoryItem, 'owner', 'cLoose', { name: 'Forage-like find' });
    await query(`UPDATE character_resources SET current_value = current_value - 1 WHERE character_id = $1 AND resource_key = 'hp'`, [charIds.cLoose]);
    expect(await versionOf('cLoose')).toBe(before);

    const version = (await query<{ id: string }>('SELECT id FROM character_versions WHERE character_id = $1 LIMIT 1', [charIds.cLoose])).rows[0];
    await characters.restoreCharacterVersion(u('owner'), charIds.cLoose, version.id);
    expect(await versionOf('cLoose')).toBe(before + 1);
  });

  it('stale guard: two simultaneous saves from the same loaded version, exactly one wins', async () => {
    const loaded = await versionOf('cLoose');
    // Owner and admin can both edit the loose character.
    const results = await Promise.allSettled([
      characters.updateCharacter(u('owner'), charIds.cLoose, form({ name: 'Race A', sheetVersion: String(loaded) }), 'race a'),
      characters.updateCharacter(u('admin'), charIds.cLoose, form({ name: 'Race B', sheetVersion: String(loaded) }), 'race b')
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await versionOf('cLoose')).toBe(loaded + 1);
  });

  it('stale guard with the changes-only inventory Save: a refusal posts the baseline but changes no rows', async () => {
    await run(pageRoute.actions.addInventoryItem, 'owner', 'cLoose', { name: 'Baseline item' });
    const rows = (
      await query<{ id: string; name: string }>(`SELECT id, name FROM character_inventory_items WHERE character_id = $1 AND name = 'Baseline item'`, [charIds.cLoose])
    ).rows;
    const baseline = JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name })));
    const stale = String((await versionOf('cLoose')) - 1);
    // The posted inventory is empty, which with a baseline means "the user deleted these rows".
    await expect(
      characters.updateCharacter(u('owner'), charIds.cLoose, form({ name: 'X', sheetVersion: stale, inventoryBaseline: baseline }), 'stale inv')
    ).rejects.toBeInstanceOf(characters.StaleSheetError);
    expect((await query('SELECT 1 FROM character_inventory_items WHERE id = $1', [rows[0].id])).rows.length).toBe(1);
  });
});

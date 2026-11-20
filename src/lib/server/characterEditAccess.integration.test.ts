import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed tests for campaign Units C and D: who may VIEW a character (D: also plain campaign
// members), who may EDIT a character (owner, campaign DM / co-DM, site
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
const historyRoute = await import('../../routes/characters/[id]/history/+server');
const versionsRoute = await import('../../routes/characters/[id]/versions/+server');
const activityStatusRoute = await import('../../routes/vtt/api/characters/[id]/activity-status/+server');
const vttCharacterRoute = await import('../../routes/vtt/api/characters/[id]/+server');

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

// Who may VIEW cInCampaign: everyone who can edit it, plus a plain member of its campaign.
const viewMatrix: Record<string, boolean> = { owner: true, dm: true, codm: true, admin: true, player: true, outsider: false, otherDm: false };

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

  it('getCharacter and listVersions follow VIEW access (a plain member sees the character; outsiders do not)', async () => {
    for (const [who, expected] of Object.entries(viewMatrix)) {
      expect(Boolean(await characters.getCharacter(u(who), charIds.cInCampaign)), `getCharacter ${who}`).toBe(expected);
      // A campaign-less character is only visible to its owner and the admin.
      expect(Boolean(await characters.getCharacter(u(who), charIds.cLoose)), `getCharacter loose ${who}`).toBe(editMatrix[who].cLoose);
    }
    // The saves above left versions behind; a plain member can list them, an outsider cannot.
    expect((await characters.listVersions(u('dm'), charIds.cInCampaign)).length).toBeGreaterThan(0);
    expect((await characters.listVersions(u('player'), charIds.cInCampaign)).length).toBeGreaterThan(0);
    expect(await characters.listVersions(u('outsider'), charIds.cInCampaign)).toEqual([]);
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

  it('sheet load: owner, DM, co-DM, admin and a plain member open it (with the right access flags); outsider and other DM get 404', async () => {
    const load = (who: string, charKey: string) =>
      (pageRoute.load as any)({ params: { id: charIds[charKey] }, locals: { user: { id: u(who) } }, depends: () => {} });
    for (const [who, expected] of Object.entries(editMatrix)) {
      if (viewMatrix[who]) {
        const data = await load(who, 'cInCampaign');
        expect(data.access.canView).toBe(true);
        expect(data.access.canEdit).toBe(expected.cInCampaign); // a plain member is read-only
        expect(data.access.canAct).toBe(actors.includes(who));
        expect(data.access.isOwner).toBe(who === 'owner');
        expect(data.access.viaAdmin).toBe(who === 'admin'); // a read-only member is NOT "via admin"
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

// ---- Unit D: member view access and the read-only sheet ----
describe.skipIf(!enabled)('member view access (Unit D) against the local dev DB', () => {
  const run = (action: any, who: string, charKey: string, fields: Record<string, string> = {}) =>
    action({
      request: { formData: async () => new URLSearchParams(fields) },
      params: { id: charIds[charKey] },
      locals: { user: { id: u(who), role: who.startsWith('admin') ? 'admin' : 'user' } }
    });
  const get = async (route: any, who: string, charKey: string) => {
    try {
      const response: Response = await route.GET({ params: { id: charIds[charKey] }, locals: { user: { id: u(who) } } });
      return { status: response.status, body: await response.json() };
    } catch (error: any) {
      return { status: error?.status as number, body: null }; // SvelteKit error() throws
    }
  };

  it('getCharacterAccess says a plain member can view but not edit or act', async () => {
    const { getCharacterAccess } = await import('./services/access');
    expect(await getCharacterAccess({ query }, u('player'), charIds.cInCampaign)).toMatchObject({
      canView: true, canEdit: false, canAct: false, isOwner: false, isCampaignDm: false, viaAdmin: false
    });
    expect(await getCharacterAccess({ query }, u('outsider'), charIds.cInCampaign)).toMatchObject({ canView: false, canEdit: false });
  });

  it('a member loads the full sheet via getCharacter and getCharacterWithAccess', async () => {
    const loaded = await characters.getCharacterWithAccess(u('player'), charIds.cInCampaign);
    expect(loaded?.character.id).toBe(charIds.cInCampaign);
    expect(loaded?.access.canEdit).toBe(false);
    expect(await characters.getCharacter(u('outsider'), charIds.cInCampaign)).toBeNull();
  });

  it('a member cannot write: save, restore, content, inventory and play actions all refuse', async () => {
    const version = (await query<{ id: string }>('SELECT id FROM character_versions WHERE character_id = $1 LIMIT 1', [charIds.cInCampaign])).rows[0];
    const before = (await query<{ name: string; sheet_version: number }>('SELECT name, sheet_version FROM characters WHERE id = $1', [charIds.cInCampaign])).rows[0];
    await expect(characters.updateCharacter(u('player'), charIds.cInCampaign, form({ name: 'Viewer wrote this' }), 'viewer')).rejects.toThrow('Character not found.');
    await expect(characters.restoreCharacterVersion(u('player'), charIds.cInCampaign, version.id)).rejects.toThrow('Character not found.');
    // Straight through the sheet page's own actions, as a devtools POST would.
    await expect(run(pageRoute.actions.save, 'player', 'cInCampaign', { name: 'Viewer wrote this' })).rejects.toThrow('Character not found.');
    await expect(run(pageRoute.actions.restoreVersion, 'player', 'cInCampaign', { versionId: version.id })).rejects.toThrow('Character not found.');
    for (const [name, fields] of [
      ['addContent', { contentId: FAKE }],
      ['removeContent', { instanceId: FAKE }],
      ['contentState', { instanceId: FAKE }],
      ['contentResource', { resourceId: FAKE, delta: '-1' }],
      ['inventoryResource', { resourceId: FAKE, delta: '-1' }],
      ['spellSlot', { slotType: 'standard', slotLevel: '1', delta: '-1' }],
      ['rest', { restType: 'long_rest' }],
      ['advanceRound', {}],
      ['advanceTurn', {}],
      ['newBattle', {}],
      ['useItem', { inventoryId: FAKE }],
      ['triggerContent', { instanceId: FAKE }],
      ['castSpell', { instanceId: FAKE }],
      ['spendHitDice', { classIndex: '0', spent: '1' }]
    ] as [string, Record<string, string>][]) {
      expect(await refused(() => run((pageRoute.actions as any)[name], 'player', 'cInCampaign', fields)), `${name} by a member`).toBe(true);
    }
    for (const name of ['addInventoryItem', 'setEquipped', 'removeInventoryItem']) {
      expect(await run((pageRoute.actions as any)[name], 'player', 'cInCampaign', { name: 'x', inventoryId: FAKE }), name).toMatchObject({ status: 403 });
    }
    // The campaign controls refuse a member too (not the owner, not a manager).
    expect(await run(pageRoute.actions.setPartyActive, 'player', 'cInCampaign', { active: '0' })).toMatchObject({ status: 400 });
    expect(await run(pageRoute.actions.leaveCampaign, 'player', 'cInCampaign')).toMatchObject({ status: 400 });
    const after = (await query<{ name: string; sheet_version: number }>('SELECT name, sheet_version FROM characters WHERE id = $1', [charIds.cInCampaign])).rows[0];
    expect(after).toEqual(before);
  });

  it('history, versions and activity-status are readable by a member and 404 for an outsider', async () => {
    for (const route of [historyRoute, activityStatusRoute]) {
      expect((await get(route, 'player', 'cInCampaign')).status).toBe(200);
      expect((await get(route, 'outsider', 'cInCampaign')).status).toBe(404);
      expect((await get(route, 'otherDm', 'cInCampaign')).status).toBe(404);
    }
    const versions = await get(versionsRoute, 'player', 'cInCampaign');
    expect(versions.status).toBe(200);
    expect(versions.body.versions.length).toBeGreaterThan(0);
    expect((await get(versionsRoute, 'outsider', 'cInCampaign')).body.versions).toEqual([]);
  });

  it('archived campaign: members lose view, the owner and admin keep it', async () => {
    const D = await campaigns.createCampaign(u('otherDm'), `${tag} D`, '');
    campaignIds.push(D);
    const code = (await query<{ invite_code: string }>('SELECT invite_code FROM campaigns WHERE id = $1', [D])).rows[0].invite_code;
    for (const key of ['owner', 'player']) await campaigns.joinCampaignByInviteCode(u(key), code);
    await makeCharacter('cInD', 'owner');
    await campaigns.addCharacterToCampaign(u('owner'), charIds.cInD, D);
    expect(await characters.getCharacter(u('player'), charIds.cInD)).not.toBeNull();
    // Archive WITHOUT releasing the character, to prove the access rule itself (archiveCampaign also releases).
    await query('UPDATE campaigns SET is_archived = true WHERE id = $1', [D]);
    expect(await characters.getCharacter(u('player'), charIds.cInD)).toBeNull();
    expect(await characters.getCharacter(u('otherDm'), charIds.cInD)).toBeNull();
    expect(await characters.getCharacter(u('owner'), charIds.cInD)).not.toBeNull();
    expect(await characters.getCharacter(u('admin'), charIds.cInD)).not.toBeNull();
    expect((await campaigns.listCampaignCharactersForUser(u('player'))).some((g) => g.campaignId === D)).toBe(false);
  });

  it('a member can pull the character through GET /vtt/api/characters/[id]; an outsider gets 404', async () => {
    const member = await get(vttCharacterRoute, 'player', 'cInCampaign');
    expect(member.status).toBe(200);
    expect(member.body).toHaveProperty('maxHp');
    expect((await get(vttCharacterRoute, 'outsider', 'cInCampaign')).status).toBe(404);
  });

  // The roster tests build their own campaign and characters, so they do not depend on earlier tests.
  const joinCode = async (campaignId: string) =>
    (await query<{ invite_code: string }>('SELECT invite_code FROM campaigns WHERE id = $1', [campaignId])).rows[0].invite_code;

  it("roster: other people's characters in the user's live campaigns, grouped by campaign, never your own or an outsider's", async () => {
    const E = await campaigns.createCampaign(u('otherDm'), `${tag} E`, '');
    campaignIds.push(E);
    const code = await joinCode(E);
    for (const key of ['owner', 'player']) await campaigns.joinCampaignByInviteCode(u(key), code);
    await makeCharacter('rosterOwner', 'owner');
    await makeCharacter('rosterPlayer', 'player');
    await campaigns.addCharacterToCampaign(u('owner'), charIds.rosterOwner, E);
    await campaigns.addCharacterToCampaign(u('player'), charIds.rosterPlayer, E);

    const group = async (who: string) => (await campaigns.listCampaignCharactersForUser(u(who))).find((g) => g.campaignId === E);
    // The player sees the owner's character (with its owner's name), never their own.
    expect((await group('player'))?.characters.map((c) => c.id)).toEqual([charIds.rosterOwner]);
    expect((await group('player'))?.characters[0].ownerName).toBe('IT owner');
    expect((await group('owner'))?.characters.map((c) => c.id)).toEqual([charIds.rosterPlayer]);
    // The DM sees both; an outsider (not a member) sees nothing from E.
    expect((await group('otherDm'))?.characters.map((c) => c.id).sort()).toEqual([charIds.rosterOwner, charIds.rosterPlayer].sort());
    expect(await group('outsider')).toBeUndefined();
  });

  it("roster: an admin only gets their own memberships (not every campaign), and archived campaigns are left out", async () => {
    // 'admin' is a member of nothing, even though campaigns with characters exist.
    expect(await campaigns.listCampaignCharactersForUser(u('admin'))).toEqual([]);
    // 'adminDm' is the DM of campaign C only, so only C appears (with the player's character in it).
    const C = (await query<{ id: string }>('SELECT id FROM campaigns WHERE name = $1', [`${tag} C`])).rows[0].id;
    const forAdminDm = await campaigns.listCampaignCharactersForUser(u('adminDm'));
    expect(forAdminDm.map((g) => g.campaignId)).toEqual([C]);
    expect(forAdminDm[0].characters.map((c) => c.id)).toEqual([charIds.cInAdminDm]);
    // Archiving (rows kept in place) drops the group.
    await query('UPDATE campaigns SET is_archived = true WHERE id = $1', [C]);
    expect(await campaigns.listCampaignCharactersForUser(u('adminDm'))).toEqual([]);
    await query('UPDATE campaigns SET is_archived = false WHERE id = $1', [C]);
  });
});

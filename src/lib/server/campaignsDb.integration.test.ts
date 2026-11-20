import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed campaign harness. SKIPPED unless CAMPAIGN_DB_TEST=1, so the normal suite never touches
// a database. It talks to whatever DATABASE_URL points at, so only ever run it against the LOCAL dev
// DB (localhost / dndchar_dev) after `npm run db:migrate`. It creates throwaway users (inserted into
// `users` only, never `sessions`), characters and campaigns, and deletes them all in afterAll. It
// never touches the migrated 'Main Campaign'.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   CAMPAIGN_DB_TEST=1 npx vitest run src/lib/server/campaignsDb.integration.test.ts
const enabled = process.env.CAMPAIGN_DB_TEST === '1';

const { query } = await import('$lib/server/db');
const campaigns = await import('./services/campaigns');
const access = await import('./services/access');

const tag = `zzcamp${crypto.randomBytes(4).toString('hex')}`;
const userIds: Record<string, string> = {};
const charIds: Record<string, string> = {};
const campaignIds: string[] = [];

async function makeUser(key: string, role: 'user' | 'admin' = 'user') {
  const result = await query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`${tag}-${key}@example.invalid`, `IT ${key}`, role]
  );
  userIds[key] = result.rows[0].id;
}
async function makeCharacter(key: string, ownerKey: string) {
  const result = await query<{ id: string }>(`INSERT INTO characters (owner_user_id, name) VALUES ($1, $2) RETURNING id`, [userIds[ownerKey], `IT char ${key}`]);
  charIds[key] = result.rows[0].id;
}
async function newCampaign(ownerKey: string, name: string) {
  const id = await campaigns.createCampaign(userIds[ownerKey], name, '');
  campaignIds.push(id);
  return id;
}
async function codes(id: string) {
  const row = await query<{ invite_code: string; room_code: string }>('SELECT invite_code, room_code FROM campaigns WHERE id = $1', [id]);
  return { invite: row.rows[0].invite_code, room: row.rows[0].room_code };
}
async function roles(id: string) {
  const rows = await query<{ user_id: string; role: string }>('SELECT user_id, role FROM campaign_members WHERE campaign_id = $1', [id]);
  const byKey: Record<string, string> = {};
  for (const row of rows.rows) byKey[Object.keys(userIds).find((k) => userIds[k] === row.user_id) ?? row.user_id] = row.role;
  return byKey;
}
const charCampaign = async (key: string) => (await query<{ campaign_id: string | null }>('SELECT campaign_id FROM characters WHERE id = $1', [charIds[key]])).rows[0].campaign_id;
const u = (key: string) => userIds[key];

beforeAll(async () => {
  if (!enabled) return;
  // Guard FIRST, before any query: local database only, and no ?host= override.
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
  await makeUser('dm');
  await makeUser('p1');
  await makeUser('p2');
  await makeUser('outsider');
  await makeUser('admin', 'admin');
  await makeCharacter('p1', 'p1');
  await makeCharacter('p2', 'p2');
  await makeCharacter('outsider', 'outsider');
  console.info('[campaign integration] database host', target.hostname);
});

afterAll(async () => {
  if (!enabled || !userIds.dm) return;
  // Users first (cascades their members and characters), then the test campaigns by id. The app
  // itself never hard-deletes campaigns; this is test cleanup only.
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(userIds)]);
  if (campaignIds.length) await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [campaignIds]);
});

describe.skipIf(!enabled)('campaigns against the local dev DB', () => {
  let A = '';
  let B = '';

  it('sanity: the target is local and the migrated campaign exists untouched', async () => {
    expect(['localhost', '127.0.0.1', '::1']).toContain(new URL(env.DATABASE_URL!).hostname);
    const main = await query('SELECT 1 FROM campaigns WHERE id = $1', ['00000000-0000-4000-8000-000000000001']);
    expect(main.rows.length).toBe(1);
  });

  it('create: the creator is the primary DM and the codes match the CHECK patterns', async () => {
    A = await newCampaign('dm', `${tag} A`);
    expect(await roles(A)).toEqual({ dm: 'dm' });
    const { invite, room } = await codes(A);
    expect(invite).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(room).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    await expect(campaigns.createCampaign(u('dm'), '   ', '')).rejects.toThrow(/name/);
  });

  it('join by code: lowercase with a hyphen works, twice keeps one row, bad and archived codes fail', async () => {
    const { invite } = await codes(A);
    const messy = `${invite.slice(0, 5)}-${invite.slice(5)}`.toLowerCase();
    expect(await campaigns.joinCampaignByInviteCode(u('p1'), messy)).toBe(A);
    await campaigns.joinCampaignByInviteCode(u('p1'), invite);
    await campaigns.joinCampaignByInviteCode(u('p2'), invite);
    const count = await query('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [A, u('p1')]);
    expect(count.rows.length).toBe(1);
    expect((await roles(A)).p1).toBe('player');
    await expect(campaigns.joinCampaignByInviteCode(u('outsider'), 'AAAAAAAAAA')).rejects.toThrow(/wasn't found/);

    const dead = await newCampaign('dm', `${tag} archived`);
    const deadInvite = (await codes(dead)).invite;
    await campaigns.archiveCampaign(u('dm'), dead);
    await expect(campaigns.joinCampaignByInviteCode(u('outsider'), deadInvite)).rejects.toThrow(/wasn't found/);
    expect(await campaigns.findCampaignByInviteCode(deadInvite)).toBeNull();
  });

  it('co-DM rules: one slot, co-DM cannot demote or remove the primary, can remove players', async () => {
    await campaigns.setMemberRole(u('dm'), A, u('p1'), 'co_dm');
    await expect(campaigns.setMemberRole(u('dm'), A, u('p2'), 'co_dm')).rejects.toThrow('This campaign already has a co-DM.');
    await expect(campaigns.setMemberRole(u('p1'), A, u('dm'), 'player')).rejects.toThrow();
    await expect(campaigns.removeMember(u('p1'), A, u('dm'))).rejects.toThrow();
    await campaigns.removeMember(u('p1'), A, u('p2'));
    expect(await roles(A)).toEqual({ dm: 'dm', p1: 'co_dm' });
    await campaigns.joinCampaignByInviteCode(u('p2'), (await codes(A)).invite);
  });

  it('the DB itself refuses a second dm or co_dm row', async () => {
    await expect(query(`UPDATE campaign_members SET role = 'co_dm' WHERE campaign_id = $1 AND user_id = $2`, [A, u('p2')])).rejects.toMatchObject({ code: '23505' });
    await expect(query(`UPDATE campaign_members SET role = 'dm' WHERE campaign_id = $1 AND user_id = $2`, [A, u('p2')])).rejects.toMatchObject({ code: '23505' });
  });

  it('primary leaves with a co-DM: the co-DM is now primary, and a lone primary cannot leave', async () => {
    await campaigns.leaveCampaign(u('dm'), A);
    expect(await roles(A)).toEqual({ p1: 'dm', p2: 'player' });
    await expect(campaigns.leaveCampaign(u('p1'), A)).rejects.toThrow(/Hand over or archive/);
  });

  it('admin make-primary: old primary becomes a player when the co-DM slot is full, or takes the target slot', async () => {
    await campaigns.setMemberRole(u('p1'), A, u('p2'), 'co_dm');
    await campaigns.joinCampaignByInviteCode(u('dm'), (await codes(A)).invite);
    // Roles now: p1 dm, p2 co_dm, dm player. The co-DM slot is full, so p1 drops to player.
    await campaigns.setMemberRole(u('admin'), A, u('dm'), 'dm');
    expect(await roles(A)).toEqual({ dm: 'dm', p1: 'player', p2: 'co_dm' });
    // Promoting the co-DM: the old primary takes the slot the co-DM is leaving.
    await campaigns.setMemberRole(u('admin'), A, u('p2'), 'dm');
    expect(await roles(A)).toEqual({ dm: 'co_dm', p1: 'player', p2: 'dm' });
    // A non-admin can't hand the role over.
    await expect(campaigns.setMemberRole(u('p2'), A, u('p1'), 'dm')).rejects.toThrow();
  });

  it('the only DM cannot leave a live campaign, admin included; anyone can leave an archived one', async () => {
    const solo = await newCampaign('admin', `${tag} admin solo`);
    await expect(campaigns.leaveCampaign(u('admin'), solo)).rejects.toThrow('Hand over or archive the campaign instead.');
    const dmSolo = await newCampaign('dm', `${tag} dm solo`);
    await expect(campaigns.leaveCampaign(u('dm'), dmSolo)).rejects.toThrow();
    await campaigns.archiveCampaign(u('dm'), dmSolo);
    await campaigns.leaveCampaign(u('dm'), dmSolo);
    expect(await roles(dmSolo)).toEqual({});
  });

  it('primary swaps with the existing co-DM (not with a player); a concurrent double promotion hits the friendly error', async () => {
    const S = await newCampaign('dm', `${tag} swap`);
    const invite = (await codes(S)).invite;
    await campaigns.joinCampaignByInviteCode(u('p1'), invite);
    await campaigns.joinCampaignByInviteCode(u('p2'), invite);
    await expect(campaigns.setMemberRole(u('dm'), S, u('p1'), 'dm')).rejects.toThrow();
    // Two promotions at once: exactly one wins, the other gets the friendly message (never a 500).
    const results = await Promise.allSettled([
      campaigns.setMemberRole(u('dm'), S, u('p1'), 'co_dm'),
      campaigns.setMemberRole(u('dm'), S, u('p2'), 'co_dm')
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toBe('This campaign already has a co-DM.');
    const current = await roles(S);
    const coKey = current.p1 === 'co_dm' ? 'p1' : 'p2';
    await campaigns.setMemberRole(u('dm'), S, u(coKey), 'dm');
    expect((await roles(S))[coKey]).toBe('dm');
    expect((await roles(S)).dm).toBe('co_dm');
    // The co-DM can't take it back by force, and the new primary can swap back.
    await campaigns.setMemberRole(u(coKey), S, u('dm'), 'dm');
    expect((await roles(S)).dm).toBe('dm');
  });

  it('joining a campaign that has just been archived fails with the not-found message', async () => {
    const J = await newCampaign('dm', `${tag} join race`);
    const invite = (await codes(J)).invite;
    await campaigns.archiveCampaign(u('dm'), J);
    await expect(campaigns.joinCampaignByInviteCode(u('outsider'), invite)).rejects.toThrow(/wasn't found/);
    expect(await roles(J)).toEqual({ dm: 'dm' });
  });

  it('characters: add own only, only to a campaign you are in, moving leaves one campaign_id', async () => {
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, A);
    expect(await charCampaign('p1')).toBe(A);
    await expect(campaigns.addCharacterToCampaign(u('p1'), charIds.p2, A)).rejects.toThrow('Character not found.');
    await expect(campaigns.addCharacterToCampaign(u('outsider'), charIds.outsider, A)).rejects.toThrow(/Join the campaign/);

    B = await newCampaign('dm', `${tag} B`);
    await campaigns.joinCampaignByInviteCode(u('p1'), (await codes(B)).invite);
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, B);
    expect(await charCampaign('p1')).toBe(B);
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, A);
    expect(await charCampaign('p1')).toBe(A);
  });

  it('party flag and removal: owner or a DM, nobody else', async () => {
    await campaigns.setCharacterPartyActive(u('p1'), charIds.p1, false);
    await campaigns.setCharacterPartyActive(u('p2'), charIds.p1, true); // p2 is the primary DM
    await expect(campaigns.setCharacterPartyActive(u('outsider'), charIds.p1, false)).rejects.toThrow();
    await expect(campaigns.removeCharacterFromCampaign(u('outsider'), charIds.p1)).rejects.toThrow();
    // A plain member who isn't the owner can't either.
    await campaigns.joinCampaignByInviteCode(u('outsider'), (await codes(A)).invite);
    await expect(campaigns.removeCharacterFromCampaign(u('outsider'), charIds.p1)).rejects.toThrow();
    await campaigns.removeMember(u('p2'), A, u('outsider'));
    // Tied to a campaign: a character that is not in the expected campaign is refused, as a CampaignError.
    const wrong = '00000000-0000-4000-8000-0000000000aa';
    const refusal = await campaigns.setCharacterPartyActive(u('p2'), charIds.p1, true, wrong).catch((e) => e);
    expect(refusal.name).toBe('CampaignError');
    expect(refusal.message).toBe('That character is not in this campaign.');
    await expect(campaigns.removeCharacterFromCampaign(u('p2'), charIds.p1, wrong)).rejects.toThrow('not in this campaign');
    await campaigns.setCharacterPartyActive(u('p2'), charIds.p1, true, A);
  });

  it('getCampaignPage: invite code only for DMs and admin; non-members get null', async () => {
    expect((await campaigns.getCampaignPage(u('p2'), A))?.campaign.inviteCode).toBeTruthy();
    expect((await campaigns.getCampaignPage(u('admin'), A))?.campaign.inviteCode).toBeTruthy();
    const asPlayer = await campaigns.getCampaignPage(u('p1'), A);
    expect(asPlayer?.campaign.inviteCode).toBeNull();
    expect(asPlayer?.characters.map((c) => c.id)).toEqual([charIds.p1]);
    expect(asPlayer?.myCharacters[0]).toMatchObject({ id: charIds.p1, campaignId: A });
    expect(await campaigns.getCampaignPage(u('outsider'), A)).toBeNull();
  });

  it('getCharacterAccess agrees with the pure matrix for every throwaway user', async () => {
    for (const charKey of ['p1', 'p2', 'outsider']) {
      const row = await query<{ owner_user_id: string; campaign_id: string | null; is_archived: boolean | null }>(
        'SELECT c.owner_user_id, c.campaign_id, cp.is_archived FROM characters c LEFT JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.id = $1',
        [charIds[charKey]]
      );
      for (const userKey of Object.keys(userIds)) {
        const member = row.rows[0].campaign_id
          ? await query<{ role: any }>('SELECT role FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [row.rows[0].campaign_id, u(userKey)])
          : { rows: [] as { role: any }[] };
        const expected = access.decideCharacterAccess({
          userId: u(userKey),
          isAdmin: userKey === 'admin',
          ownerUserId: row.rows[0].owner_user_id,
          campaignId: row.rows[0].campaign_id,
          campaignArchived: Boolean(row.rows[0].is_archived),
          memberRole: member.rows[0]?.role ?? null
        });
        expect(await access.getCharacterAccess({ query }, u(userKey), charIds[charKey])).toEqual(expected);
      }
    }
    expect(await access.getCharacterAccess({ query }, u('p1'), crypto.randomUUID())).toBeNull();
    await expect(access.assertCanEditCharacter({ query }, u('p1'), charIds.p2)).rejects.toThrow('Character not found.');
    expect(await access.isCampaignDm({ query }, u('p2'), A)).toBe(true);
    expect(await access.isCampaignDm({ query }, u('admin'), A)).toBe(false);
  });

  it('remove member: their characters leave, and the room join clears only for this campaign room', async () => {
    const room = (await codes(A)).room;
    await query('UPDATE users SET active_vtt_session_id = $2 WHERE id = $1', [u('p1'), room]);
    const out = await campaigns.removeMember(u('p2'), A, u('p1'));
    expect(out).toEqual({ roomCode: room, targetUserId: u('p1') });
    expect(await charCampaign('p1')).toBeNull();
    const cleared = await query<{ active_vtt_session_id: string | null }>('SELECT active_vtt_session_id FROM users WHERE id = $1', [u('p1')]);
    expect(cleared.rows[0].active_vtt_session_id).toBeNull();

    // Rejoin, sit in some other room, get removed again: the other room join is left alone.
    await campaigns.joinCampaignByInviteCode(u('p1'), (await codes(A)).invite);
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, A);
    await query('UPDATE users SET active_vtt_session_id = $2 WHERE id = $1', [u('p1'), 'ZZZZZZ']);
    await campaigns.removeMember(u('p2'), A, u('p1'));
    const kept = await query<{ active_vtt_session_id: string | null }>('SELECT active_vtt_session_id FROM users WHERE id = $1', [u('p1')]);
    expect(kept.rows[0].active_vtt_session_id).toBe('ZZZZZZ');
    expect(await charCampaign('p1')).toBeNull();
  });

  it('regenerate invite: the old code fails, the new one works; players cannot', async () => {
    const old = (await codes(A)).invite;
    await expect(campaigns.regenerateInviteCode(u('p1'), A)).rejects.toThrow();
    const fresh = await campaigns.regenerateInviteCode(u('p2'), A);
    expect(fresh).not.toBe(old);
    expect(await campaigns.findCampaignByInviteCode(old)).toBeNull();
    expect((await campaigns.findCampaignByInviteCode(fresh))?.id).toBe(A);
  });

  it('archive: releases characters, DM or admin only', async () => {
    const C = await newCampaign('dm', `${tag} C`);
    await campaigns.joinCampaignByInviteCode(u('p1'), (await codes(C)).invite);
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, C);
    await expect(campaigns.archiveCampaign(u('p1'), C)).rejects.toThrow();
    await campaigns.archiveCampaign(u('dm'), C);
    expect(await charCampaign('p1')).toBeNull();
    await expect(campaigns.archiveCampaign(u('dm'), C)).rejects.toThrow(/already archived/);
    expect((await campaigns.getCampaignByRoomCode((await codes(C)).room))).toEqual({ id: C, isArchived: true });
    expect(await campaigns.getCampaignByRoomCode('NOSUCHRM')).toBeNull();
  });

  it('listCampaigns: pages of 12, clamped page, literal %, membership scoping, archived for admin only', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 13; i += 1) ids.push(await newCampaign('dm', `${tag} list ${String(i).padStart(2, '0')}`));
    ids.push(await newCampaign('dm', `${tag} list 100% real`));

    const page1 = await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, page: 1 });
    expect(page1).toMatchObject({ total: 14, page: 1, pageCount: 2 });
    expect(page1.items.length).toBe(12);
    const page2 = await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, page: 2 });
    expect(page2.items.length).toBe(2);
    const clamped = await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, page: 99 });
    expect(clamped).toMatchObject({ page: 2, pageCount: 2 });
    expect(clamped.items.length).toBe(2);
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, page: -5 })).page).toBe(1);
    // Absurd page numbers are capped, then clamped to the last page (no overflow, no 500).
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, page: 1e21 }))).toMatchObject({ page: 2, pageCount: 2 });

    // "%" is literal: it matches the one name containing it, and "list%" matches nothing.
    expect((await campaigns.listCampaigns(u('admin'), { q: '100%' })).items.map((i) => i.name)).toEqual([`${tag} list 100% real`]);
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag} list%` })).total).toBe(0);
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag}_list` })).total).toBe(0);

    // A player sees only campaigns they're in; the DM sees theirs; an outsider none.
    expect((await campaigns.listCampaigns(u('p2'), { q: `${tag} list` })).total).toBe(0);
    expect((await campaigns.listCampaigns(u('dm'), { q: `${tag} list` })).total).toBe(14);
    expect((await campaigns.listCampaigns(u('dm'), { q: `${tag} list` })).items[0].myRole).toBe('dm');

    // Archived: hidden from members, and from admin unless asked for.
    await campaigns.archiveCampaign(u('dm'), ids[0]);
    expect((await campaigns.listCampaigns(u('dm'), { q: `${tag} list`, includeArchived: true })).total).toBe(13);
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag} list` })).total).toBe(13);
    expect((await campaigns.listCampaigns(u('admin'), { q: `${tag} list`, includeArchived: true })).total).toBe(14);
  });
});

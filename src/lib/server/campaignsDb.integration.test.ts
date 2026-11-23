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
    expect(out).toMatchObject({ roomCode: room, targetUserId: u('p1') });
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
    expect((await campaigns.getCampaignByRoomCode((await codes(C)).room))).toEqual({ id: C, isArchived: true, roomCode: (await codes(C)).room });
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

// ---------------------------------------------------------------------------------------------
// Unit E: campaign rooms. The ticket route, GM-gated room routes, room recreation, game sessions,
// the sheet's room join, kicks on membership changes and the roll log backlog cap. Everything is
// called as route handlers / services with a `locals.user` object; no real sockets (those are in
// vttCampaignJoin.test.ts), only fake socket objects in the in-memory room.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!enabled)('campaign rooms against the local dev DB (Unit E)', () => {
  let R = '';
  let ROOM_R = '';
  let sessionIds: string[] = [];
  const extraRooms: string[] = [];

  const store = () => import('../../../vtt/server/store.js');
  const ticketRoute = () => import('../../routes/vtt/api/campaigns/[id]/ticket/+server');
  const combatRoute = () => import('../../routes/vtt/api/session/[id]/combat/+server');
  const gameSessionRoute = () => import('../../routes/vtt/api/session/[id]/game-session/+server');
  const sheetRoute = () => import('../../routes/characters/[id]/+page.server');
  const campaignPageRoute = () => import('../../routes/campaigns/[id]/+page.server');
  const rooms = () => import('./services/campaignRooms');
  const gameSessions = () => import('./services/gameSessions');

  const locals = (key: string) => ({ user: { id: u(key), role: key === 'admin' ? 'admin' : 'user', displayName: `IT ${key}` } });
  const jsonRequest = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });
  const form = (fields: Record<string, string>) => ({ formData: async () => new URLSearchParams(fields) }) as unknown as Request;
  const askTicket = async (key: string, body: object, campaignId = R) => {
    const route = await ticketRoute();
    const response = await route.POST({ params: { id: campaignId }, request: jsonRequest(body), locals: locals(key) } as any);
    return { status: response.status, body: await response.json() };
  };
  // A fake live socket: enough for the room's GM check and for the kick, and it records both.
  const fakeSocket = (fields: object) => {
    const meta: any = { ws: { readyState: 1, OPEN: 1, _closed: [] as number[], _sent: [] as any[] }, ...fields };
    meta.ws.send = (text: string) => meta.ws._sent.push(JSON.parse(text));
    meta.ws.close = (code: number) => meta.ws._closed.push(code);
    return meta;
  };
  const seatGm = async (key: string) => {
    const s = await store();
    const meta = fakeSocket({ sessionId: ROOM_R, role: 'gm', playerId: null, gmUserId: u(key), gmSeat: 'primary' });
    s.socketsBySession.get(ROOM_R).add(meta);
    s.sessions.get(ROOM_R).gmSocketId = u(key);
    return meta;
  };

  beforeAll(async () => {
    R = await newCampaign('dm', `${tag} room`);
    ROOM_R = (await codes(R)).room;
    const { invite } = await codes(R);
    await campaigns.joinCampaignByInviteCode(u('p1'), invite);
    await campaigns.joinCampaignByInviteCode(u('p2'), invite);
    await campaigns.setMemberRole(u('dm'), R, u('p1'), 'co_dm');
  });

  afterAll(async () => {
    if (!enabled) return;
    const s = await store();
    for (const code of [ROOM_R, ...extraRooms]) {
      s.sessions.delete(code);
      s.socketsBySession.delete(code);
    }
    await query('DELETE FROM roll_log_entries WHERE session_id = ANY($1::text[])', [[ROOM_R, ...extraRooms]]);
    if (campaignIds.length) await query('DELETE FROM game_sessions WHERE campaign_id = ANY($1::uuid[])', [campaignIds]);
  });

  it('the ticket route: member -> ticket, wrong asks refused, admin non-member refused', async () => {
    const player = await askTicket('p2', { role: 'player' });
    expect(player.status).toBe(200);
    expect(player.body).toMatchObject({ sessionId: ROOM_R, role: 'player', userId: u('p2'), displayName: 'IT p2' });
    const s = await store();
    expect(s.consumeJoinTicket(player.body.ticket)).toMatchObject({ sessionId: ROOM_R, userId: u('p2'), role: 'player', seat: null });
    expect((await query('SELECT active_vtt_session_id FROM users WHERE id = $1', [u('p2')])).rows[0].active_vtt_session_id).toBe(ROOM_R);

    expect((await askTicket('p2', { role: 'gm' })).body).toEqual({ error: 'not_dm' });
    // Takeover is passed through for any DM (the join handler decides if it applies); not for players.
    expect(s.consumeJoinTicket((await askTicket('p1', { role: 'gm', takeoverOf: 'self' })).body.ticket)).toMatchObject({ seat: 'co', takeoverOf: 'self' });
    expect((await askTicket('p2', { role: 'player', takeoverOf: 'self' })).body).toEqual({ error: 'not_dm' });
    expect((await askTicket('admin', { role: 'gm' })).body).toEqual({ error: 'not_member' });
    expect((await askTicket('admin', { role: 'player' })).body).toEqual({ error: 'not_member' });
    expect((await askTicket('outsider', { role: 'player' })).body).toEqual({ error: 'not_member' });
    expect((await askTicket('p2', { role: 'banana' })).status).toBe(400);
    expect((await askTicket('p2', { role: 'player' }, 'not-a-uuid')).status).toBe(404);
    expect((await askTicket('p2', { role: 'player' }, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });

  it('the ticket route: primary DM gets a primary-seat GM ticket, co-DM a co seat, and the room is recreated after a restart', async () => {
    const s = await store();
    const primary = await askTicket('dm', { role: 'gm' });
    expect(primary.status).toBe(200);
    expect(s.consumeJoinTicket(primary.body.ticket)).toMatchObject({ role: 'gm', seat: 'primary', takeoverOf: null });
    expect((await query('SELECT active_vtt_session_id FROM users WHERE id = $1', [u('dm')])).rows[0].active_vtt_session_id).toBe(ROOM_R);
    expect(s.consumeJoinTicket((await askTicket('dm', { role: 'gm', takeoverOf: 'co' })).body.ticket)).toMatchObject({ seat: 'primary', takeoverOf: 'co' });
    expect(s.consumeJoinTicket((await askTicket('p1', { role: 'gm' })).body.ticket)).toMatchObject({ seat: 'co', takeoverOf: null });

    // Restart: the in-memory room vanishes; an active game session row is re-attached on reopen.
    const gs = await gameSessions();
    const gameSessionId = await gs.createGameSession(u('dm'), 'before restart', R);
    s.sessions.delete(ROOM_R);
    s.socketsBySession.delete(ROOM_R);
    await askTicket('p2', { role: 'player' });
    expect(s.sessions.get(ROOM_R)).toMatchObject({ id: ROOM_R, campaignId: R, gameSessionId });
  });

  it('a second game session for the campaign ends the first', async () => {
    const gs = await gameSessions();
    const first = await gs.createGameSession(u('dm'), 'one', R);
    const second = await gs.createGameSession(u('dm'), 'two', R);
    const active = await query<{ id: string }>('SELECT id FROM game_sessions WHERE campaign_id = $1 AND is_active', [R]);
    expect(active.rows.map((r) => r.id)).toEqual([second]);
    expect(first).not.toBe(second);
    sessionIds = [first, second];
  });

  it('combat and game-session routes: a non-GM in a campaign room gets 403, the seated GM does not', async () => {
    const s = await store();
    await askTicket('p2', { role: 'player' }); // makes sure the room is live
    const combat = await combatRoute();
    const game = await gameSessionRoute();
    const call = (route: any, key: string, body: object) => route.POST({ params: { id: ROOM_R }, request: jsonRequest(body), locals: locals(key) } as any);

    // The dm is a DM but holds no seat yet, so is refused too: the seat is what counts.
    for (const key of ['p2', 'p1', 'outsider', 'admin', 'dm']) {
      expect((await call(combat, key, { action: 'stop' })).status, key).toBe(403);
      expect((await call(game, key, { action: 'stop' })).status, key).toBe(403);
    }
    expect(await (await call(combat, 'p2', { action: 'stop' })).json()).toEqual({ error: 'not_gm' });

    await seatGm('dm');
    // The admin still can't act, even with a seated GM present.
    expect((await call(combat, 'admin', { action: 'stop' })).status).toBe(403);
    expect((await call(combat, 'dm', { action: 'stop' })).status).toBe(200);
    // Game-session start records the campaign; ending it works for the GM.
    const started = await (await call(game, 'dm', { action: 'start', name: 'IT night' })).json();
    expect((await query('SELECT campaign_id FROM game_sessions WHERE id = $1', [started.gameSessionId])).rows[0].campaign_id).toBe(R);
    expect(s.sessions.get(ROOM_R).gameSessionId).toBe(started.gameSessionId);
    expect((await call(game, 'dm', { action: 'stop' })).status).toBe(200);
    expect((await query('SELECT is_active FROM game_sessions WHERE id = $1', [started.gameSessionId])).rows[0].is_active).toBe(false);
    s.sessions.get(ROOM_R).gmSocketId = null;
    s.socketsBySession.get(ROOM_R).clear();
    sessionIds.push(started.gameSessionId);
  });

  it('endGameSession: owner, co-DM and admin may end it; a player and an outsider may not', async () => {
    const gs = await gameSessions();
    const isActive = async (id: string) => (await query('SELECT is_active FROM game_sessions WHERE id = $1', [id])).rows[0].is_active;
    for (const [key, shouldEnd] of [['p2', false], ['outsider', false], ['p1', true], ['dm', true], ['admin', true]] as const) {
      const id = await gs.createGameSession(u('dm'), 'end test', R);
      await gs.endGameSession(u(key), id);
      expect(await isActive(id), key).toBe(!shouldEnd);
    }
  });

  it('listGameSessionsForUser includes the campaign sessions of a member who never posted', async () => {
    const gs = await gameSessions();
    const mine = await gs.listGameSessionsForUser(u('p2'));
    expect(mine.map((g) => g.id)).toEqual(expect.arrayContaining(sessionIds));
    expect((await gs.listGameSessionsForUser(u('outsider'))).map((g) => g.id)).not.toContain(sessionIds[0]);
  });

  it('listFindsForGameSession: a campaign DM (not just the owner or admin) is the DM', async () => {
    const forage = await import('./services/forage');
    const view = (key: string) => forage.listFindsForGameSession(sessionIds[0], { id: u(key), role: key === 'admin' ? 'admin' : 'user' });
    expect((await view('dm'))?.isDm).toBe(true);
    expect((await view('p1'))?.isDm).toBe(true);
    expect((await view('admin'))?.isDm).toBe(true);
    expect((await view('p2'))?.isDm).toBe(false);
    expect((await view('outsider'))?.isDm).toBe(false);
  });

  it('the sheet joinRoom accepts a campaign room code only from a real member', async () => {
    const s = await store();
    const page = await sheetRoute();
    const join = (key: string, code: string) => (page.actions as any).joinRoom({ request: form({ roomId: code }), locals: locals(key), params: { id: charIds.p2 } });
    s.sessions.delete(ROOM_R);
    s.socketsBySession.delete(ROOM_R);
    expect(await join('p2', ROOM_R.toLowerCase())).toEqual({ joinedRoom: true });
    expect(s.sessions.get(ROOM_R)?.campaignId).toBe(R);
    for (const key of ['outsider', 'admin']) {
      const refused: any = await join(key, ROOM_R);
      expect(refused.status, key).toBe(400);
      expect(refused.data.joinRoomError).toBe('That room code was not found.');
    }
  });

  it('roll log backlog: at most the newest 200 rows, oldest first; afterId still returns everything newer', async () => {
    const { listRollLogEntries } = await import('./services/rollLog');
    await query(
      `INSERT INTO roll_log_entries (session_id, message, created_at)
       SELECT $1, 'roll ' || n, now() - make_interval(secs => 1000 - n) FROM generate_series(1, 230) AS n`,
      [ROOM_R]
    );
    const backlog = await listRollLogEntries(ROOM_R);
    expect(backlog.length).toBe(200);
    expect(backlog[0].message).toBe('roll 31');
    expect(backlog[199].message).toBe('roll 230');
    const after = await listRollLogEntries(ROOM_R, backlog[150].id);
    expect(after.length).toBe(49);
  });

  it('createGameSession: two simultaneous Starts leave exactly one active session', async () => {
    const gs = await gameSessions();
    await Promise.all([gs.createGameSession(u('dm'), 'double click', R), gs.createGameSession(u('dm'), 'double click', R)]);
    const active = await query('SELECT id FROM game_sessions WHERE campaign_id = $1 AND is_active', [R]);
    expect(active.rows.length).toBe(1);
  });

  it('joinRoom with a dashed, lower-case code uses the canonical room (no phantom room)', async () => {
    const s = await store();
    const page = await sheetRoute();
    const dashed = `${ROOM_R.slice(0, 4)}-${ROOM_R.slice(4)}`.toLowerCase();
    s.sessions.delete(ROOM_R);
    s.socketsBySession.delete(ROOM_R);
    expect(await (page.actions as any).joinRoom({ request: form({ roomId: dashed }), locals: locals('p2'), params: { id: charIds.p2 } })).toEqual({ joinedRoom: true });
    expect((await query('SELECT active_vtt_session_id FROM users WHERE id = $1', [u('p2')])).rows[0].active_vtt_session_id).toBe(ROOM_R);
    expect(s.sessions.has(ROOM_R)).toBe(true);
    expect(s.sessions.has(dashed.toUpperCase())).toBe(false);
    expect(s.sessions.has(dashed)).toBe(false);
  });

  it('removing a member kicks them; demoting the GM-seat holder kicks them; archiving closes the room', async () => {
    const s = await store();
    const rooms2 = await rooms();
    const detail = await campaignPageRoute();
    const act = (name: string, key: string, fields: Record<string, string>, id: string) =>
      (detail.actions as any)[name]({ request: form(fields), params: { id }, locals: locals(key) });

    // A fresh campaign so the other tests' state isn't disturbed.
    const K = await newCampaign('dm', `${tag} kick`);
    const roomK = (await codes(K)).room;
    extraRooms.push(roomK);
    const { invite } = await codes(K);
    await campaigns.joinCampaignByInviteCode(u('p1'), invite);
    await campaigns.joinCampaignByInviteCode(u('p2'), invite);
    await rooms2.openCampaignRoom({ id: K, roomCode: roomK });
    const socketFor = (fields: object) => {
      const meta = fakeSocket({ sessionId: roomK, ...fields });
      s.socketsBySession.get(roomK).add(meta);
      return meta;
    };

    // Remove p2: their socket gets kicked, p1's doesn't, and p2's unused ticket is revoked.
    const p2 = socketFor({ role: 'player', playerId: u('p2') });
    const p1 = socketFor({ role: 'player', playerId: u('p1') });
    const p2Ticket = (await askTicket('p2', { role: 'player' }, K)).body.ticket;
    await act('removeMember', 'dm', { userId: u('p2') }, K);
    expect(s.consumeJoinTicket(p2Ticket)).toBeNull();
    expect(p2.ws._closed).toEqual([4001]);
    expect(p2.ws._sent[0]).toEqual({ type: 'kicked', reason: 'removed_from_campaign' });
    expect(p1.ws._closed).toEqual([]);

    // Swap: the seated primary DM is swapped with the co-DM by an admin make-primary; the seated
    // user's rank follows their new role (the old primary keeps the seat as 'co').
    await campaigns.setMemberRole(u('dm'), K, u('p1'), 'co_dm');
    const seatedPrimary = socketFor({ role: 'gm', playerId: null, userId: u('dm'), gmUserId: u('dm'), gmSeat: 'primary' });
    s.sessions.get(roomK).gmSocketId = u('dm');
    await act('setRole', 'admin', { userId: u('p1'), role: 'dm' }, K);
    expect(await roles(K)).toMatchObject({ p1: 'dm', dm: 'co_dm' });
    expect(seatedPrimary.gmSeat).toBe('co');
    expect(seatedPrimary.ws._closed).toEqual([]);
    seatedPrimary.role = 'player';
    s.sessions.get(roomK).gmSocketId = null;

    // Demote the co-DM who holds the seat: kicked with role_changed, and the seat is released.
    const gm = socketFor({ role: 'gm', playerId: null, userId: u('dm'), gmUserId: u('dm'), gmSeat: 'co' });
    s.sessions.get(roomK).gmSocketId = u('dm');
    await act('setRole', 'p1', { userId: u('dm'), role: 'player' }, K);
    expect(gm.ws._closed).toEqual([4001]);
    expect(gm.ws._sent[0]).toEqual({ type: 'kicked', reason: 'role_changed' });
    expect(s.sessions.get(roomK).gmSocketId).toBeNull();

    // Archive (by the new primary p1): everyone is kicked, the room is gone and its game session ends.
    const other = socketFor({ role: 'player', playerId: u('dm') });
    const gsId = await (await gameSessions()).createGameSession(u('p1'), 'to be archived', K);
    await expect(act('archive', 'p1', {}, K)).rejects.toMatchObject({ status: 303 });
    expect((await query('SELECT is_active FROM game_sessions WHERE id = $1', [gsId])).rows[0].is_active).toBe(false);
    expect(other.ws._closed).toEqual([4001]);
    expect(s.sessions.has(roomK)).toBe(false);
    expect((await askTicket('p1', { role: 'player' }, K)).body).toEqual({ error: 'not_member' });
    expect(s.sessions.has(roomK)).toBe(false);
    // And a sheet can't join an archived campaign's room either.
    const sheet = await sheetRoute();
    const refused: any = await (sheet.actions as any).joinRoom({ request: form({ roomId: roomK }), locals: locals('p1'), params: { id: charIds.p1 } });
    expect(refused.status).toBe(400);
  });

  it('a character leaving the campaign (or its player being removed) takes its token off the live map', async () => {
    const s = await store();
    const rooms2 = await rooms();
    const detail = await campaignPageRoute();
    const act = (name: string, key: string, fields: Record<string, string>, id: string) =>
      (detail.actions as any)[name]({ request: form(fields), params: { id }, locals: locals(key) });

    const T = await newCampaign('dm', `${tag} tokens`);
    const roomT = (await codes(T)).room;
    extraRooms.push(roomT);
    await campaigns.joinCampaignByInviteCode(u('p2'), (await codes(T)).invite);
    await makeCharacter('tokA', 'p2');
    await makeCharacter('tokB', 'p2');
    await makeCharacter('tokDm', 'dm');
    for (const [key, owner] of [['tokA', 'p2'], ['tokB', 'p2'], ['tokDm', 'dm']]) {
      await campaigns.addCharacterToCampaign(u(owner), charIds[key], T);
    }
    const session = await rooms2.openCampaignRoom({ id: T, roomCode: roomT });
    session.tokens = {
      a: { id: 'a', type: 'pc', characterId: charIds.tokA },
      b: { id: 'b', type: 'pc', characterId: charIds.tokB },
      dm: { id: 'dm', type: 'pc', characterId: charIds.tokDm },
      goblin: { id: 'goblin', type: 'enemy' }
    };
    const gm = fakeSocket({ sessionId: roomT, role: 'gm', playerId: null, gmUserId: u('dm') });
    s.socketsBySession.get(roomT).add(gm);

    // "No, just the character": only that character's token goes.
    await act('removeCharacter', 'dm', { characterId: charIds.tokA }, T);
    expect(Object.keys(s.sessions.get(roomT).tokens).sort()).toEqual(['b', 'dm', 'goblin']);
    expect(gm.ws._sent).toContainEqual({ type: 'token:remove:bulk', tokenIds: ['a'] });

    // "Yes, remove the player too": the rest of their characters' tokens go; others stay.
    await act('removeMember', 'dm', { userId: u('p2') }, T);
    expect(Object.keys(s.sessions.get(roomT).tokens).sort()).toEqual(['dm', 'goblin']);
    expect(gm.ws._sent).toContainEqual({ type: 'token:remove:bulk', tokenIds: ['b'] });
  });
});

// ---------------------------------------------------------------------------------------------
// Unit F: the /vtt lobby list (membership only) and the campaign-aware picker rows.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!enabled)('VTT lobby and picker queries (Unit F)', () => {
  it('membersOnly drops the admin override (a non-member admin has no table), but keeps real memberships', async () => {
    const F = await newCampaign('dm', `${tag} lobby`);
    const q = `${tag} lobby`;
    // Normal list: the admin sees it through the override. Lobby list: they don't.
    expect((await campaigns.listCampaigns(u('admin'), { q })).total).toBe(1);
    expect((await campaigns.listCampaigns(u('admin'), { q, membersOnly: true })).total).toBe(0);
    // includeArchived is ignored for a members-only list (archived campaigns have no table).
    expect((await campaigns.listCampaigns(u('admin'), { q, membersOnly: true, includeArchived: true })).total).toBe(0);
    // A real member sees it with their role; once the admin joins, they see it too.
    expect((await campaigns.listCampaigns(u('dm'), { q, membersOnly: true })).items[0]).toMatchObject({ id: F, myRole: 'dm' });
    await campaigns.joinCampaignByInviteCode(u('admin'), (await codes(F)).invite);
    expect((await campaigns.listCampaigns(u('admin'), { q, membersOnly: true })).items[0]).toMatchObject({ id: F, myRole: 'player' });
    // Archived: gone from a members-only list for the DM as well.
    await campaigns.archiveCampaign(u('dm'), F);
    expect((await campaigns.listCampaigns(u('dm'), { q, membersOnly: true, includeArchived: true })).total).toBe(0);
  });

  it('picker rows: the GM gets the active party with owners, a player only their own', async () => {
    const G = await newCampaign('dm', `${tag} picker`);
    const { invite } = await codes(G);
    await campaigns.joinCampaignByInviteCode(u('p1'), invite);
    await campaigns.joinCampaignByInviteCode(u('p2'), invite);
    await campaigns.addCharacterToCampaign(u('p1'), charIds.p1, G);
    await campaigns.addCharacterToCampaign(u('p2'), charIds.p2, G);
    await campaigns.setCharacterPartyActive(u('p2'), charIds.p2, false);

    const gm = await campaigns.listCampaignPickerCharacters(G, u('dm'), true);
    expect(gm.map((c) => c.id)).toEqual([charIds.p1]); // p2's character is benched, so not offered
    expect(gm[0]).toMatchObject({ ownerUserId: u('p1'), ownerName: 'IT p1' });

    // A player sees their own characters in this campaign, benched or not, and never someone else's.
    expect((await campaigns.listCampaignPickerCharacters(G, u('p2'), false)).map((c) => c.id)).toEqual([charIds.p2]);
    expect((await campaigns.listCampaignPickerCharacters(G, u('p1'), false)).map((c) => c.id)).toEqual([charIds.p1]);
    // Someone with nothing in the campaign gets an empty list, and a character moved elsewhere drops out.
    expect(await campaigns.listCampaignPickerCharacters(G, u('outsider'), false)).toEqual([]);
    await campaigns.removeCharacterFromCampaign(u('p1'), charIds.p1);
    expect(await campaigns.listCampaignPickerCharacters(G, u('dm'), true)).toEqual([]);
  });
});

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { createSession, sessions, socketsBySession, setWatches, watchersByTopic } from '../../../vtt/server/store.js';

// DB-backed forage harness. SKIPPED unless FORAGE_DB_TEST=1, so the normal suite never touches a
// database. It talks to whatever DATABASE_URL points at, so only ever run it against the LOCAL dev
// DB (localhost / dndchar_dev) after `npm run db:seed:forage-test`. It creates one throwaway user
// (plus character, inventory, finds, roll-log rows) and deletes them all in afterAll.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   FORAGE_DB_TEST=1 npx vitest run src/lib/server/forageDb.integration.test.ts
const enabled = process.env.FORAGE_DB_TEST === '1';

const { query, withTransaction } = await import('$lib/server/db');
const playerRoute = await import('../../routes/vtt/api/forage/+server');
const mineRoute = await import('../../routes/vtt/api/forage/mine/+server');
const tablesRoute = await import('../../routes/vtt/api/forage/tables/+server');
const gmRoute = await import('../../routes/vtt/api/session/[id]/forage/+server');
const adminRoute = await import('../../routes/vtt/api/forage/admin/+server');
const forage = await import('./services/forage');
const characters = await import('./services/characters');

const tag = `zzforage${crypto.randomBytes(4).toString('hex')}`;
const ROOM = `IT${tag.slice(-6).toUpperCase()}`;
const gmId = crypto.randomUUID();
let userId = '';
let otherUserId = '';
let characterId = '';
let meadowId = '';
let itemIds: Record<string, string> = {};

const user = () => ({ id: userId, displayName: 'IT Player', role: 'user' as const });
const gmUser = () => ({ id: gmId, displayName: 'IT GM', role: 'user' as const });
const adminUser = () => ({ id: gmId, displayName: 'IT Admin', role: 'admin' as const });

async function call(handler: any, who: any, init: { body?: unknown; params?: Record<string, string>; search?: string } = {}) {
  const response: Response = await handler({
    locals: { user: who },
    request: new Request('http://localhost/x', { method: init.body ? 'POST' : 'GET', body: init.body ? JSON.stringify(init.body) : undefined }),
    params: init.params ?? {},
    url: new URL(`http://localhost/x${init.search ?? ''}`)
  });
  return { status: response.status, body: await response.json() };
}

const startBody = (extra: Record<string, unknown> = {}) => ({
  action: 'start', characterId, skillKey: 'nature', areaType: 'meadow', category: 'plant', tableId: meadowId, ...extra
});

function liveSocket(role: string, playerId: string | null) {
  return { ws: { readyState: 1, OPEN: 1, send: vi.fn() }, role, playerId, sessionId: ROOM, watchTopics: new Set<string>(), gmUserId: role === 'gm' ? gmId : undefined };
}

async function inventory() {
  const rows = await query<any>(
    'SELECT id, name, quantity, source_content_id, notes, equipped FROM character_inventory_items WHERE character_id = $1 ORDER BY sort_order, name', [characterId]
  );
  return rows.rows;
}
const qtyOf = (rows: any[], itemKey: string) => rows.filter((row) => row.source_content_id === itemIds[itemKey]).reduce((sum, row) => sum + row.quantity, 0);

async function resetFinds() {
  await query('DELETE FROM finds WHERE finder_user_id = $1', [userId]);
  await query('DELETE FROM character_inventory_items WHERE character_id = $1', [characterId]);
  for (const session of sessions.values()) { session.forage = {}; session.forageResults = {}; }
}

beforeAll(async () => {
  if (!enabled) return;
  // Guard FIRST, before any query: local database only, and no ?host= override.
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
  const host = new URL(env.DATABASE_URL ?? 'postgres://none@none/none').hostname;
  const u = await query<{ id: string }>(`INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Player', 'x') RETURNING id`, [`${tag}@example.invalid`]);
  userId = u.rows[0].id;
  const o = await query<{ id: string }>(`INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Other', 'x') RETURNING id`, [`${tag}-o@example.invalid`]);
  otherUserId = o.rows[0].id;
  const c = await query<{ id: string }>(`INSERT INTO characters (owner_user_id, name) VALUES ($1, 'Thorne') RETURNING id`, [userId]);
  characterId = c.rows[0].id;
  const t = await query<{ id: string }>(`SELECT id FROM find_tables WHERE area_type = 'meadow' AND category = 'plant' AND is_archived = false`);
  meadowId = t.rows[0].id;
  const items = await query<{ id: string; content_key: string }>(`SELECT id, content_key FROM content_definitions WHERE content_key LIKE 'test:forage:%'`);
  itemIds = Object.fromEntries(items.rows.map((row) => [row.content_key.replace('test:forage:', ''), row.id]));
  console.info('[forage integration] database host', host);
});

afterAll(async () => {
  if (!enabled || !userId) return;
  await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
  sessions.delete(ROOM);
  socketsBySession.delete(ROOM);
  watchersByTopic.clear();
});

describe.skipIf(!enabled)('forage against the local dev DB', () => {
  it('sanity: the seed is present and the target is local', () => {
    expect(['localhost', '127.0.0.1', '::1']).toContain(new URL(env.DATABASE_URL!).hostname);
    expect(meadowId).toBeTruthy();
    expect(itemIds.moonleaf).toBeTruthy();
  });

  describe('self-serve (no room, so no DM)', () => {
    it('start rolls a check and logs it unmarked, a second start resumes it, a pass inserts rows, a re-mark is stale', async () => {
      await resetFinds();
      const first = await call(playerRoute.POST, user(), { body: startBody() });
      expect(first.status).toBe(200);
      expect(first.body.mode).toBe('self');
      expect(first.body.check.skillLabel).toBe('Nature');
      const status = await query('SELECT status, mode, room_code FROM finds WHERE id = $1', [first.body.findId]);
      expect(status.rows[0]).toMatchObject({ status: 'checked', mode: 'self', room_code: null });

      const again = await call(playerRoute.POST, user(), { body: startBody() });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('resume');
      expect(again.body.unmarkedSelf.findId).toBe(first.body.findId);

      // mine reports it too
      const mine = await call(mineRoute.GET, user(), { search: `?characterId=${characterId}` });
      expect(mine.body.unmarkedSelf.findId).toBe(first.body.findId);
      expect(mine.body.inRoom).toBe(false);
      expect(mine.body.dmPresent).toBe(false);

      // Force a pass-able check (not a nat 1) so the result does not depend on the dice.
      await query(`UPDATE finds SET check_json = jsonb_set(check_json, '{nat1}', 'false') WHERE id = $1`, [first.body.findId]);
      const marked = await call(playerRoute.POST, user(), { body: { action: 'self_mark', findId: first.body.findId, passed: true } });
      expect(marked.status).toBe(200);
      expect(marked.body.status).toBe('found');
      expect(marked.body.lines.length).toBeGreaterThan(0);
      const rows = await inventory();
      expect(rows.length).toBe(marked.body.lines.length);

      const stale = await call(playerRoute.POST, user(), { body: { action: 'self_mark', findId: first.body.findId, passed: true } });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('stale');
      const stored = await query('SELECT area_type, category, find_table_id FROM finds WHERE id = $1', [first.body.findId]);
      expect(stored.rows[0]).toMatchObject({ area_type: 'meadow', category: 'plant', find_table_id: meadowId });
    });

    it('an area + category with no table rolls and marks like any other, and a pass finds nothing', async () => {
      await resetFinds();
      const start = await call(playerRoute.POST, user(), { body: startBody({ areaType: tag, category: 'gem', tableId: undefined }) });
      expect(start.status).toBe(200);
      expect(start.body.mode).toBe('self');
      const row = await query('SELECT status, find_table_id, area_type, category FROM finds WHERE id = $1', [start.body.findId]);
      expect(row.rows[0]).toMatchObject({ status: 'checked', find_table_id: null, area_type: tag, category: 'gem' });

      await query(`UPDATE finds SET check_json = jsonb_set(check_json, '{nat1}', 'false') WHERE id = $1`, [start.body.findId]);
      const marked = await call(playerRoute.POST, user(), { body: { action: 'self_mark', findId: start.body.findId, passed: true } });
      expect(marked.status).toBe(200);
      expect(marked.body.status).toBe('failed');
      expect(marked.body.lines).toEqual([]);
      expect(await inventory()).toEqual([]);

      // The admin review still lists it, naming what was searched for.
      const admin = await forage.listFindsForAdmin({ characterId });
      expect(admin[0]).toMatchObject({ id: start.body.findId, status: 'failed', tableName: `No table (${tag}, gem)` });
      expect(admin[0].revertNote).toMatch(/No table/);
    });

    it('a nat 1 marked as a pass is stored as failed, with no items', async () => {
      await resetFinds();
      const started = await call(playerRoute.POST, user(), { body: startBody() });
      await query(`UPDATE finds SET check_json = check_json || '{"nat1": true, "natural": 1}' WHERE id = $1`, [started.body.findId]);
      const marked = await call(playerRoute.POST, user(), { body: { action: 'self_mark', findId: started.body.findId, passed: true } });
      expect(marked.body.status).toBe('failed');
      expect((await inventory()).length).toBe(0);
      const row = await query('SELECT status, results FROM finds WHERE id = $1', [started.body.findId]);
      expect(row.rows[0]).toMatchObject({ status: 'failed', results: [] });
    });

    it('admin can clear a stuck unmarked check, a non-admin cannot', async () => {
      await resetFinds();
      const started = await call(playerRoute.POST, user(), { body: startBody() });
      expect((await call(adminRoute.POST, user(), { body: { action: 'clear', findId: started.body.findId } })).status).toBe(403);
      const listed = await call(adminRoute.GET, adminUser());
      expect(listed.body.unmarked.some((row: any) => row.findId === started.body.findId)).toBe(true);
      expect((await call(adminRoute.POST, adminUser(), { body: { action: 'clear', findId: started.body.findId } })).status).toBe(200);
      const next = await call(playerRoute.POST, user(), { body: startBody() });
      expect(next.status).toBe(200);
    });

    it('an unknown character is 404 and a skill outside the 18 is 400', async () => {
      await resetFinds();
      expect((await call(playerRoute.POST, user(), { body: startBody({ characterId: crypto.randomUUID() }) })).status).toBe(404);
      expect((await call(playerRoute.POST, { ...user(), id: otherUserId }, { body: startBody() })).status).toBe(404);
      expect((await call(playerRoute.POST, user(), { body: startBody({ skillKey: 'fishing' }) })).status).toBe(400);
      // Rev 4: a real skill that is not on the self-serve short list is refused too.
      expect((await call(playerRoute.POST, user(), { body: startBody({ skillKey: 'stealth' }) })).body.error).toBe('skill_not_allowed');
    });
  });

  describe('DM mode', () => {
    let gm: ReturnType<typeof liveSocket>;
    let finder: ReturnType<typeof liveSocket>;
    let bystander: ReturnType<typeof liveSocket>;
    let watcher: any;

    beforeAll(() => {
      if (!enabled) return;
      const session: any = createSession(ROOM);
      session.gmSocketId = gmId;
      session.players = { [userId]: { id: userId, name: 'IT Player', tokenIds: [], connected: true } };
      sessions.set(ROOM, session);
      gm = liveSocket('gm', null);
      finder = liveSocket('player', userId);
      bystander = liveSocket('player', otherUserId);
      socketsBySession.set(ROOM, new Set([gm, finder, bystander] as any));
      watcher = { ws: { readyState: 1, OPEN: 1, send: vi.fn() }, role: null, playerId: null, watchTopics: new Set<string>() };
      setWatches(watcher, [`room:${ROOM}`]);
    });

    const frames = (socket: any) => socket.ws.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    const gmAct = (body: Record<string, unknown>, who: any = gmUser()) => call(gmRoute.POST, who, { body, params: { id: ROOM } });

    it('runs request -> check (GM changes skill) -> mark pass -> edit -> approve, with the right visibility', async () => {
      await resetFinds();
      const start = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      expect(start.status).toBe(200);
      expect(start.body.mode).toBe('dm');
      expect(Object.keys(start.body.request).sort()).toEqual(['check', 'id', 'source', 'stage']);
      const session: any = sessions.get(ROOM);
      const requestId = start.body.request.id;
      // Rev 4: in DM mode the player's picks are ignored, the DM chooses.
      expect(session.forage[userId].choice.skillKey).toBe('');

      // The GM's update carries no pre-filled choice, only the player's counters.
      const gmUpdate = frames(gm).find((f: any) => f.type === 'forage:update');
      expect(gmUpdate.request.choice.tableId).toBe('');

      // A second start while pending resumes.
      const second = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('resume');
      expect(second.body.pending.id).toBe(requestId);

      // Not the GM: forbidden. Wrong request id: stale.
      expect((await gmAct({ action: 'check', requestId, skillKey: 'nature', tableId: meadowId }, user())).status).toBe(403);
      expect((await gmAct({ action: 'check', requestId: 'nope', skillKey: 'nature', tableId: meadowId })).status).toBe(409);

      // The GM changes the skill.
      const checked = await gmAct({ action: 'check', requestId, skillKey: 'survival', areaType: 'meadow', category: 'plant', tableId: meadowId });
      expect(checked.status).toBe(200);
      expect(checked.body.request.check.skillKey).toBe('survival');
      expect(checked.body.request.stage).toBe('checked');
      // The same stage twice is refused.
      expect((await gmAct({ action: 'check', requestId, skillKey: 'survival', tableId: meadowId })).body.error).toBe('wrong_stage');

      // Withdraw is refused with the GM connected after a check.
      const withdrawLive = await call(playerRoute.POST, user(), { body: { action: 'withdraw', requestId } });
      expect(withdrawLive.status).toBe(409);

      // Mark pass (force the die so a nat 1 cannot make this flaky).
      session.forage[userId].check.nat1 = false;
      const passed = await gmAct({ action: 'mark', requestId, passed: true });
      expect(passed.status).toBe(200);
      expect(passed.body.request.stage).toBe('preview');
      const preview = session.forage[userId].preview;
      expect(preview.lines.length).toBeGreaterThan(0);
      expect(preview.tableEntries.length).toBe(6);

      // Reroll keeps the preview stage.
      expect((await gmAct({ action: 'reroll', requestId })).body.request.stage).toBe('preview');

      // Invalid approvals: a foreign item, qty 5000, qty 0.
      expect((await gmAct({ action: 'approve', requestId, lines: [{ itemId: crypto.randomUUID(), qty: 1 }] })).status).toBe(400);
      expect((await gmAct({ action: 'approve', requestId, lines: [{ itemId: itemIds.moonleaf, qty: 5000 }] })).status).toBe(400);
      expect(session.forage[userId].stage).toBe('preview');

      // Edit (add Glowcap, a weight-1 entry) and approve; a double approve makes one find.
      const approve = { action: 'approve', requestId, lines: [{ itemId: itemIds.moonleaf, qty: 3 }, { itemId: itemIds['glowcap-mushroom'], qty: 1 }] };
      const [a, b] = await Promise.all([gmAct(approve), gmAct(approve)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const finds = await query('SELECT mode, status, game_session_id, room_code, results FROM finds WHERE finder_user_id = $1', [userId]);
      expect(finds.rows.length).toBe(1);
      expect(finds.rows[0]).toMatchObject({ mode: 'dm', status: 'found', room_code: ROOM });
      expect(finds.rows[0].results.map((r: any) => r.inventory_id).every(Boolean)).toBe(true);
      const rows = await inventory();
      expect(qtyOf(rows, 'moonleaf')).toBe(3);
      expect(qtyOf(rows, 'glowcap-mushroom')).toBe(1);

      // Roll log: one line, no item names.
      const log = await query('SELECT message, details FROM roll_log_entries WHERE session_id = $1 ORDER BY created_at DESC', [ROOM]);
      expect(log.rows[0].message).toMatch(/^Thorne foraged \(Survival .*pass\) and found 4 items\.$/);
      expect(JSON.stringify(log.rows[0])).not.toMatch(/Moonleaf|Glowcap/);

      // The finder's result survives for a missed haul, and dismiss clears it.
      const mine = await call(mineRoute.GET, user(), { search: `?characterId=${characterId}&roomId=${ROOM}` });
      expect(mine.body.lastDm.outcome).toBe('approved');
      expect(mine.body.dmPresent).toBe(true);
      expect(mine.body.pending).toBeNull();
      await call(playerRoute.POST, user(), { body: { action: 'dismiss', requestId: mine.body.lastDm.requestId } });
      expect((await call(mineRoute.GET, user(), { search: `?characterId=${characterId}&roomId=${ROOM}` })).body.lastDm).toBeNull();

      // Visibility across every frame sent so far.
      const finderText = JSON.stringify(frames(finder));
      expect(finderText).not.toContain('tableEntries');
      expect(finderText).not.toContain('"preview":');
      expect(finderText).not.toContain('Nature DC');
      expect(frames(bystander).filter((f: any) => f.type?.startsWith('forage:'))).toEqual([]);
      const watcherFrames = frames(watcher);
      expect(watcherFrames.length).toBeGreaterThan(0);
      // A watcher sees detail-free pings plus the existing (already public, name-free) roll:log line, never forage:update/closed.
      for (const frame of watcherFrames) {
        if (frame.type === 'forage:ping') expect(frame).toEqual({ type: 'forage:ping', playerId: userId, topic: `room:${ROOM}` });
        else expect(frame.type).toBe('roll:log');
      }
      expect(JSON.stringify(watcherFrames)).not.toMatch(/Moonleaf|Glowcap/);
    });

    it('a nat 1 pass closes as failed with a fail roll-log line, and a fail logs nothing in finds', async () => {
      await resetFinds();
      await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      const start = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      const requestId = start.body.request.id;
      await gmAct({ action: 'check', requestId, skillKey: 'nature', tableId: meadowId });
      const session: any = sessions.get(ROOM);
      // Force a natural 1 (and clear a natural 20 the dice may have rolled, which would win in the wording).
      session.forage[userId].check.nat1 = true;
      session.forage[userId].check.nat20 = false;
      session.forage[userId].check.natural = 1;
      const marked = await gmAct({ action: 'mark', requestId, passed: true });
      expect(marked.body.outcome).toBe('failed');
      expect((await query('SELECT 1 FROM finds WHERE finder_user_id = $1', [userId])).rowCount).toBe(0);
      const log = await query('SELECT message FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      expect(log.rows[0].message).toContain('natural 1, fail');
      expect(session.forageResults[userId].outcome).toBe('failed');
    });

    it('withdraw works at checked once the GM socket has closed, and a cancel logs nothing', async () => {
      await resetFinds();
      const start = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      const requestId = start.body.request.id;
      await gmAct({ action: 'check', requestId, skillKey: 'nature', tableId: meadowId });
      gm.ws.readyState = 3;
      const withdrawn = await call(playerRoute.POST, user(), { body: { action: 'withdraw', requestId } });
      expect(withdrawn.status).toBe(200);
      expect((sessions.get(ROOM) as any).forage).toEqual({});

      // With the GM gone, a new press self-serves (even though gmSocketId is still set).
      const next = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      expect(next.body.mode).toBe('self');
      expect((await query('SELECT room_code FROM finds WHERE id = $1', [next.body.findId])).rows[0].room_code).toBe(ROOM);

      // Self-serve in a live room posts a roll-log line carrying "self-served".
      await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      await query(`UPDATE finds SET check_json = jsonb_set(check_json, '{nat1}', 'false') WHERE id = $1`, [next.body.findId]);
      const marked = await call(playerRoute.POST, user(), { body: { action: 'self_mark', findId: next.body.findId, passed: true } });
      expect(marked.body.status).toBe('found');
      const log = await query('SELECT message FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      expect(log.rows[0].message).toContain('self-served');
      gm.ws.readyState = 1;
    });

    it('a GM with the placeholder id cannot act, and counts as no DM', async () => {
      await resetFinds();
      const session: any = sessions.get(ROOM);
      session.gmSocketId = 'gm';
      const start = await call(playerRoute.POST, user(), { body: startBody({ roomId: ROOM }) });
      expect(start.body.mode).toBe('self');
      session.gmSocketId = gmId;
    });
  });

  describe('tables endpoint (Q9)', () => {
    it('suggestedCheck is absent for a player and present for the room GM', async () => {
      const player = await call(tablesRoute.GET, user(), { search: `?roomId=${ROOM}` });
      // Rev 4: a player gets the short skill list and separate area / category lists, no table names or counts.
      expect(player.body.skills).toHaveLength(6);
      expect(player.body.tables).toBeUndefined();
      expect(player.body.options).toBeUndefined();
      expect(player.body.areas).toContain('meadow');
      expect(player.body.categories).toContain('plant');
      expect(JSON.stringify(player.body)).not.toContain('Nature DC');
      const gmView = await call(tablesRoute.GET, gmUser(), { search: `?roomId=${ROOM}` });
      expect(gmView.body.tables.find((t: any) => t.id === meadowId).suggestedCheck).toBe('Nature DC 12');
      const gmNoRoom = await call(tablesRoute.GET, gmUser());
      expect(gmNoRoom.body.tables).toBeUndefined();
    });
  });

  describe('stacking, undo and the stale-sheet Save', () => {
    const seedRow = async (itemKey: string, quantity: number, extra: { equipped?: boolean; notes?: string } = {}) => {
      const row = await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, category, quantity, equipped, location, source_content_id, notes, sort_order)
         VALUES ($1, $2, 'consumable', $3, $4, $5, $6, $7, 0) RETURNING id`,
        [characterId, itemKey, quantity, extra.equipped ?? false, extra.equipped ? 'equipped' : 'backpack', itemIds[itemKey], extra.notes ?? '']
      );
      return row.rows[0].id;
    };
    const lines = (...entries: Array<[string, number]>) => entries.map(([key, qty]) => ({ itemId: itemIds[key], qty }));
    const approve = (qtyLines: any[]) => forage.approveDmFind({
      characterId, finderUserId: userId, tableId: meadowId, lines: qtyLines, nat20: false,
      check: { skillKey: 'nature', skillLabel: 'Nature', total: 15, natural: 12, nat20: false, nat1: false, text: '', poolSummary: '' },
      gameSessionId: null, roomCode: null
    });

    it('stacks onto a matching row, skips equipped or noted rows, and an archived item rolls the whole thing back', async () => {
      await resetFinds();
      const plain = await seedRow('moonleaf', 3);
      await seedRow('bitterroot', 1, { notes: 'my lucky root' });
      const saved = await approve(lines(['moonleaf', 2], ['bitterroot', 2]));
      const rows = await inventory();
      expect(rows.find((r) => r.id === plain).quantity).toBe(5);
      // Bitterroot with notes is not matched, so a separate new row is made.
      expect(rows.filter((r) => r.source_content_id === itemIds.bitterroot).map((r) => r.quantity).sort()).toEqual([1, 2]);
      const find = await query('SELECT results FROM finds WHERE id = $1', [saved.findId]);
      expect(find.rows[0].results.find((r: any) => r.item_id === itemIds.moonleaf)).toMatchObject({ qty: 2, inventory_id: plain });

      // Archived item: the whole approval rolls back (no new find, quantities unchanged).
      const findsBefore = (await query('SELECT 1 FROM finds WHERE finder_user_id = $1', [userId])).rowCount;
      await query('UPDATE content_definitions SET is_archived = true WHERE id = $1', [itemIds['silverthorn-berry']]);
      try {
        await expect(approve(lines(['moonleaf', 1], ['silverthorn-berry', 1]))).rejects.toThrow();
      } finally {
        await query('UPDATE content_definitions SET is_archived = false WHERE id = $1', [itemIds['silverthorn-berry']]);
      }
      expect(qtyOf(await inventory(), 'moonleaf')).toBe(5);
      expect((await query('SELECT 1 FROM finds WHERE finder_user_id = $1', [userId])).rowCount).toBe(findsBefore);
    });

    it('undo of an untouched find deletes the rows it created', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 2], ['bitterroot', 1]));
      expect((await inventory()).length).toBe(2);
      const reverted = await forage.revertFind({ findId: saved.findId, adminUserId: userId });
      expect(reverted!.note).toBe('Moonleaf: removed; Bitterroot: removed');
      expect((await inventory()).length).toBe(0);
      const find = await query('SELECT status, revert_note, reverted_by_user_id FROM finds WHERE id = $1', [saved.findId]);
      expect(find.rows[0]).toMatchObject({ status: 'reverted', reverted_by_user_id: userId });
      // A second undo finds nothing to undo.
      expect(await forage.revertFind({ findId: saved.findId, adminUserId: userId })).toBeNull();
    });

    it('undo reduces by what the find added, deletes at zero, notes the rest, and touches no other row', async () => {
      await resetFinds();
      const older = await seedRow('moonleaf', 4, { notes: 'older stack' }); // has notes, so never matched: must stay 4
      const moon = await seedRow('moonleaf', 1); // matched: 1 + 3 = 4
      const bitter = await seedRow('bitterroot', 1);
      const glow = await seedRow('glowcap-mushroom', 1);
      const saved = await approve(lines(['moonleaf', 3], ['bitterroot', 2], ['glowcap-mushroom', 1], ['silverthorn-berry', 1]));
      expect(qtyOf(await inventory(), 'moonleaf')).toBe(8);

      // Afterwards the player used 2 Bitterroot, found 3 more Glowcap, and dropped the Silverthorn row.
      await query('UPDATE character_inventory_items SET quantity = 1 WHERE id = $1', [bitter]);
      await query('UPDATE character_inventory_items SET quantity = 5 WHERE id = $1', [glow]);
      const silver = (await inventory()).find((r) => r.source_content_id === itemIds['silverthorn-berry']);
      await query('DELETE FROM character_inventory_items WHERE id = $1', [silver.id]);

      const reverted = await forage.revertFind({ findId: saved.findId, adminUserId: userId });
      expect(reverted!.note).toContain('Moonleaf: reduced 4 -> 1');
      expect(reverted!.note).toContain('Bitterroot: removed (1 left of 2 found)');
      expect(reverted!.note).toContain('Glowcap Mushroom: reduced 5 -> 4');
      expect(reverted!.note).toContain('Silverthorn Berry: already removed by the player');

      const after = await inventory();
      expect(after.find((r) => r.id === older).quantity).toBe(4);
      expect(after.find((r) => r.id === moon).quantity).toBe(1);
      expect(after.find((r) => r.id === bitter)).toBeUndefined();
      expect(after.find((r) => r.id === glow).quantity).toBe(4);
    });

    it('the sheet Save leaves an untouched stacked row alone and lets an edit win (real DB)', async () => {
      await resetFinds();
      const moon = await seedRow('moonleaf', 3);
      const rope = await seedRow('bitterroot', 1);
      const loaded = (await inventory()).map((r) => ({
        id: r.id, name: r.name, category: 'consumable', location: 'backpack' as const, quantity: r.quantity, equipped: false,
        isEquipment: false, acBonus: 0, toHitBonus: 0, damageBonus: 0, attackAbility: 'str' as const, proficient: true,
        sourceContentId: r.source_content_id, attuned: false, damageRolls: '', effects: '', abilityBonuses: {}, notes: ''
      }));
      // A forage stacks onto Moonleaf (3 -> 5) and adds a row, behind the open sheet's back.
      await approve(lines(['moonleaf', 2], ['glowcap-mushroom', 2]));

      // Save 1: nothing edited. Everything the find did survives.
      await withTransaction((client) => characters.saveInventoryChanges(client, characterId, loaded, loaded));
      let rows = await inventory();
      expect(rows.find((r) => r.id === moon).quantity).toBe(5);
      expect(qtyOf(rows, 'glowcap-mushroom')).toBe(2);

      // Save 2: the user edits the Bitterroot quantity and removes nothing. Their edit wins, the rest holds.
      const edited = loaded.map((r) => (r.id === rope ? { ...r, quantity: 9 } : r));
      await withTransaction((client) => characters.saveInventoryChanges(client, characterId, edited, loaded));
      rows = await inventory();
      expect(rows.find((r) => r.id === rope).quantity).toBe(9);
      expect(rows.find((r) => r.id === moon).quantity).toBe(5);

      // Save 3: the user removes Bitterroot (not posted). Only it is deleted.
      await withTransaction((client) => characters.saveInventoryChanges(client, characterId, loaded.filter((r) => r.id !== rope), loaded));
      rows = await inventory();
      expect(rows.find((r) => r.id === rope)).toBeUndefined();
      expect(rows.find((r) => r.id === moon).quantity).toBe(5);
      expect(qtyOf(rows, 'glowcap-mushroom')).toBe(2);

      // Save 4: a brand-new row is inserted.
      const added = { ...loaded[0], id: undefined, name: 'Torch', quantity: 4, sourceContentId: null };
      await withTransaction((client) => characters.saveInventoryChanges(client, characterId, [...loaded.filter((r) => r.id === moon), added as any], loaded));
      rows = await inventory();
      expect(rows.find((r) => r.name === 'Torch').quantity).toBe(4);
    });

    it('updateCharacter (the real Save path) keeps a stacked quantity when the posted row is untouched, and falls back to a full replace with no baseline', async () => {
      await resetFinds();
      const moon = await seedRow('moonleaf', 3);
      const loaded = (await inventory()).map((r) => ({
        id: r.id, name: r.name, category: 'consumable', location: 'backpack', quantity: r.quantity, equipped: false,
        isEquipment: false, acBonus: 0, toHitBonus: 0, damageBonus: 0, attackAbility: 'str', proficient: true,
        sourceContentId: r.source_content_id, attuned: false, damageRolls: '', effects: '', notes: ''
      }));
      await approve(lines(['moonleaf', 2], ['glowcap-mushroom', 1]));

      const formFor = (rows: any[], withBaseline: boolean) => {
        const form = new FormData();
        form.set('name', 'Thorne');
        if (withBaseline) form.set('inventoryBaseline', JSON.stringify(loaded));
        for (const r of rows) {
          form.append('inventoryId', r.id ?? ''); form.append('inventorySourceContentId', r.sourceContentId ?? '');
          form.append('inventoryAttuned', 'false'); form.append('inventoryName', r.name); form.append('inventoryCategory', r.category);
          form.append('inventoryLocation', 'backpack'); form.append('inventoryQuantity', String(r.quantity));
          form.append('inventoryEquipped', 'false'); form.append('inventoryIsEquipment', 'false');
          for (const f of ['AcBonus', 'ToHitBonus', 'DamageBonus']) form.append('inventory' + f, '0');
          form.append('inventoryAttackAbility', 'str'); form.append('inventoryProficient', 'true');
          form.append('inventoryDamageRolls', ''); form.append('inventoryEffects', ''); form.append('inventoryNotes', '');
        }
        return form;
      };

      await characters.updateCharacter(userId, characterId, formFor(loaded, true), 'Manual save');
      let rows = await inventory();
      expect(rows.find((r) => r.id === moon).quantity).toBe(5);
      expect(qtyOf(rows, 'glowcap-mushroom')).toBe(1);

      // No baseline (an old client): the legacy full replace, which drops rows the form never posted.
      await characters.updateCharacter(userId, characterId, formFor(loaded, false), 'Manual save');
      rows = await inventory();
      expect(rows.find((r) => r.id === moon).quantity).toBe(3);
      expect(qtyOf(rows, 'glowcap-mushroom')).toBe(0);
    });
  });

  // Unit D: share, the per-viewer session summary, and the admin undo with a real find and DB.
  describe('share, session summary and undo (unit D)', () => {
    const shareRoute = () => import('../../routes/vtt/api/finds/[id]/share/+server');
    const findsRoute = () => import('../../routes/vtt/api/game-sessions/[id]/finds/+server');
    let gameId = '';
    const lines = (...entries: Array<[string, number]>) => entries.map(([key, qty]) => ({ itemId: itemIds[key], qty }));
    const approve = (qtyLines: any[]) => forage.approveDmFind({
      characterId, finderUserId: userId, tableId: meadowId, lines: qtyLines, nat20: false,
      check: { skillKey: 'nature', skillLabel: 'Nature', total: 15, natural: 12, nat20: false, nat1: false, text: '', poolSummary: '' },
      gameSessionId: gameId, roomCode: ROOM
    });
    const share = async (who: any, findId: string) => (await shareRoute()).POST({ locals: { user: who }, params: { id: findId } } as any);
    const summary = async (who: any) => {
      const res = await (await findsRoute()).GET({ locals: { user: who }, params: { id: gameId } } as any);
      return res.json();
    };
    const bystander = () => ({ id: crypto.randomUUID(), displayName: 'Bystander', role: 'user' as const });
    const dmOwner = () => ({ id: otherUserId, displayName: 'IT Other', role: 'user' as const });

    beforeAll(async () => {
      const g = await query<{ id: string }>(`INSERT INTO game_sessions (owner_user_id, name) VALUES ($1, 'IT session') RETURNING id`, [otherUserId]);
      gameId = g.rows[0].id;
      sessions.set(ROOM, createSession(ROOM));
    });

    it('shares once (owner-checked, one way), the log line names items only on the share, and a second share adds nothing', async () => {
      await resetFinds();
      await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      const saved = await approve(lines(['moonleaf', 3], ['bitterroot', 2]));

      expect((await share({ id: otherUserId, role: 'user' }, saved.findId)).status).toBe(403);
      expect((await share(user(), saved.findId)).status).toBe(200);
      expect((await share(user(), saved.findId)).status).toBe(200);

      const logged = await query<{ message: string; details: any }>('SELECT message, details FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      expect(logged.rows.length).toBe(1);
      expect(logged.rows[0].message).toBe('Thorne shared their find: Moonleaf x3, Bitterroot x2.');
      expect(JSON.stringify(logged.rows[0].details)).not.toContain('Moonleaf');
      expect((await query('SELECT shared FROM finds WHERE id = $1', [saved.findId])).rows[0].shared).toBe(true);
    });

    it('a failed or reverted find cannot be shared (409)', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 1]));
      await forage.revertFind({ findId: saved.findId, adminUserId: otherUserId });
      expect((await share(user(), saved.findId)).status).toBe(409);
      // A failed find is always a self-serve one (a DM-mode find is only logged once approved).
      const failed = await query<{ id: string }>(
        `INSERT INTO finds (mode, status, game_session_id, character_id, finder_user_id, find_table_id) VALUES ('self', 'failed', $1, $2, $3, $4) RETURNING id`,
        [gameId, characterId, userId, meadowId]);
      expect((await share(user(), failed.rows[0].id)).status).toBe(409);
    });

    it('redacts per viewer: DM and finder see names, a bystander sees a count, sharing opens it to all', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 3], ['bitterroot', 2]));

      const asDm = await summary(dmOwner());
      expect(asDm.isDm).toBe(true);
      expect(asDm.finds[0]).toMatchObject({ view: 'full', itemCount: 5, canShare: false });
      expect(asDm.finds[0].items.map((i: any) => i.name).sort()).toEqual(['Bitterroot', 'Moonleaf']);

      expect((await summary(user())).finds[0]).toMatchObject({ view: 'full', canShare: true });

      const asOther = await summary(bystander());
      expect(asOther.finds[0]).toMatchObject({ view: 'redacted', text: 'Thorne foraged and found 5 items.' });
      expect(JSON.stringify(asOther)).not.toMatch(/Moonleaf|Bitterroot|Nature|Meadow/);

      // Rev 4: the table name goes to the DM only, never to the finder or a bystander.
      expect(asDm.finds[0].tableName).toBeTruthy();
      expect((await summary(user())).finds[0].tableName).toBe('');

      await share(user(), saved.findId);
      const afterShare = await summary(bystander());
      expect(afterShare.finds[0]).toMatchObject({ view: 'full', shared: true, canShare: false, tableName: '' });
      expect(JSON.stringify(afterShare)).not.toMatch(/Meadow/);

      // An unmarked check is never listed, and a find outside any game session isn't here at all.
      await query(`INSERT INTO finds (mode, status, game_session_id, character_id, finder_user_id, find_table_id) VALUES ('self', 'checked', $1, $2, $3, $4)`,
        [gameId, characterId, userId, meadowId]);
      expect((await summary(dmOwner())).finds.length).toBe(1);
      await query(`UPDATE finds SET game_session_id = NULL WHERE id = $1`, [saved.findId]);
      expect((await summary(dmOwner())).finds.length).toBe(0);
    });

    it('the character owner who is not the finder may share', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 1]));
      await query('UPDATE finds SET finder_user_id = $2 WHERE id = $1', [saved.findId, otherUserId]);
      expect((await share(user(), saved.findId)).status).toBe(200); // user() owns the character
      expect((await share(bystander(), saved.findId)).status).toBe(403);
      await query('DELETE FROM finds WHERE id = $1', [saved.findId]); // resetFinds only clears the user's own finds
    });

    it('a shared find that is later undone is redacted for a bystander, with the note kept for the DM', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 2]));
      await share(user(), saved.findId);
      await forage.revertFind({ findId: saved.findId, adminUserId: otherUserId });
      expect((await summary(bystander())).finds[0]).toMatchObject({ view: 'redacted', text: "Thorne's find was undone by the DM." });
      expect((await summary(dmOwner())).finds[0]).toMatchObject({ view: 'full', status: 'reverted', revertNote: 'Moonleaf: removed' });
      // A malformed id is a clean null, not a database error.
      expect(await forage.revertFind({ findId: 'not-a-uuid', adminUserId: otherUserId })).toBeNull();
    });

    it('a reverted find shows the note to the DM and a plain line to a bystander', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 2]));
      await forage.revertFind({ findId: saved.findId, adminUserId: otherUserId });
      const asDm = await summary(dmOwner());
      expect(asDm.finds[0]).toMatchObject({ view: 'full', status: 'reverted', revertNote: 'Moonleaf: removed' });
      expect((await summary(bystander())).finds[0]).toMatchObject({ view: 'redacted', text: "Thorne's find was undone by the DM." });
    });

    it('the admin list names items and the inventory row they wrote to, and filters by status', async () => {
      await resetFinds();
      const saved = await approve(lines(['moonleaf', 2]));
      const all = await forage.listFindsForAdmin({ gameSessionId: gameId, characterId });
      expect(all[0].items[0]).toMatchObject({ name: 'Moonleaf', qty: 2, row: { name: 'Moonleaf', quantity: 2 } });
      expect((await forage.listFindsForAdmin({ gameSessionId: gameId, status: 'reverted' })).length).toBe(0);
      expect((await forage.listFindsForAdmin({ gameSessionId: gameId, status: 'dm' })).length).toBe(1);
      expect((await forage.listFindsForAdmin({ gameSessionId: gameId, status: 'self' })).length).toBe(0);
      await forage.revertFind({ findId: saved.findId, adminUserId: otherUserId });
      const after = await forage.listFindsForAdmin({ gameSessionId: gameId, status: 'reverted' });
      expect(after[0]).toMatchObject({ status: 'reverted', revertNote: 'Moonleaf: removed' });
      expect(after[0].items[0].row).toBeNull();
    });

    it('the admin endpoint undo posts the name-free undo line', async () => {
      await resetFinds();
      await query('DELETE FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      const saved = await approve(lines(['moonleaf', 2]));
      const undone = await call(adminRoute.POST, { id: otherUserId, displayName: 'IT Other', role: 'admin' }, { body: { action: 'undo', findId: saved.findId } });
      expect(undone.status).toBe(200);
      const logged = await query<{ message: string }>('SELECT message FROM roll_log_entries WHERE session_id = $1', [ROOM]);
      expect(logged.rows.map((row) => row.message)).toEqual(["The DM undid Thorne's find."]);
    });
  });

  describe('recent finds (unit E)', () => {
    const recentRoute = () => import('../../routes/vtt/api/forage/recent/+server');
    const get = async (who: any) => call((await recentRoute()).GET, who, { search: `?characterId=${characterId}` });
    const check = { skillKey: 'nature', skillLabel: 'Nature', total: 15, natural: 12, nat20: false, nat1: false, text: '', poolSummary: '' };

    it('lists the owner finds: found and undone finds, newest first, with no table fields, and leaves out failed and unmarked', async () => {
      await resetFinds();
      const first = await forage.approveDmFind({
        characterId, finderUserId: userId, tableId: meadowId, lines: [{ itemId: itemIds.moonleaf, qty: 3 }], nat20: false, check, gameSessionId: null, roomCode: null
      });
      const second = await forage.approveDmFind({
        characterId, finderUserId: userId, tableId: meadowId, lines: [{ itemId: itemIds.bitterroot, qty: 2 }], nat20: false, check, gameSessionId: null, roomCode: null
      });
      await forage.revertFind({ findId: second.findId, adminUserId: otherUserId });
      await query(`INSERT INTO finds (mode, status, character_id, finder_user_id, find_table_id) VALUES ('self', 'failed', $1, $2, $3)`, [characterId, userId, meadowId]);
      await query(`INSERT INTO finds (mode, status, character_id, finder_user_id, find_table_id) VALUES ('self', 'checked', $1, $2, $3)`, [characterId, userId, meadowId]);

      const res = await get(user());
      expect(res.status).toBe(200);
      expect(res.body.finds.map((f: any) => f.id)).toEqual([second.findId, first.findId]);
      expect(res.body.finds[0]).toMatchObject({ status: 'reverted', mode: 'dm', shared: false, items: [{ name: 'Bitterroot', qty: 2 }] });
      expect(res.body.finds[0].revertNote).toContain('Bitterroot');
      expect(res.body.finds[1]).toMatchObject({ status: 'found', items: [{ name: 'Moonleaf', qty: 3 }] });
      // Rev 4: nothing about tables, and no inventory row ids either.
      expect(JSON.stringify(res.body)).not.toMatch(/table|suggested|Meadow|Nature DC|inventory|find_table/i);
      expect(Object.keys(res.body.finds[0]).sort()).toEqual(['createdAt', 'id', 'items', 'mode', 'revertNote', 'shared', 'status']);
    });

    it('is owner-checked and capped at ten', async () => {
      await resetFinds();
      expect((await get({ id: otherUserId, displayName: 'IT Other', role: 'user' })).status).toBe(404);
      for (let i = 0; i < 12; i++) {
        await query(`INSERT INTO finds (mode, status, character_id, finder_user_id, find_table_id) VALUES ('self', 'found', $1, $2, $3)`, [characterId, userId, meadowId]);
      }
      expect((await get(user())).body.finds.length).toBe(10);
    });

    it('a self-serve find with no game session can be shared from the list', async () => {
      await resetFinds();
      const saved = await forage.approveDmFind({
        characterId, finderUserId: userId, tableId: meadowId, lines: [{ itemId: itemIds.moonleaf, qty: 1 }], nat20: false, check, gameSessionId: null, roomCode: null
      });
      const shareRoute = await import('../../routes/vtt/api/finds/[id]/share/+server');
      const shared = await shareRoute.POST({ locals: { user: user() }, params: { id: saved.findId } } as any);
      expect(shared.status).toBe(200);
      expect((await get(user())).body.finds[0]).toMatchObject({ id: saved.findId, shared: true });
    });
  });
});

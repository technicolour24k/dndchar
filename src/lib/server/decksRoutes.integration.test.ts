import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the deck endpoints and announcements (decks unit 5). SKIPPED unless DECK_DB_TEST=1.
// Local DB only (guarded below). Seeded deck (migration 048) must be applied.
const enabled = process.env.DECK_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');

describe.skipIf(!enabled)('deck routes and announcements', () => {
  it('guards access, nudges token HP both ways, logs, and keeps watch topics content-free', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const decks = await import('./services/decks');
    const { announceDeck } = await import('./vttDeckAnnounce');
    const store = await import('$vtt/store.js');
    const drawRoute = await import('../../routes/vtt/api/decks/draw/+server');
    const undoRoute = await import('../../routes/vtt/api/decks/draws/[id]/undo/+server');
    const chooseRoute = await import('../../routes/vtt/api/decks/draws/[id]/choose/+server');
    const tag = `zzdeckr${crypto.randomBytes(4).toString('hex')}`;
    const newUser = async (suffix: string, name: string, role = 'user') => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`, [`${tag}${suffix}@example.invalid`, name, role])).rows[0].id;
    const dmId = await newUser('-dm', 'IT DM');
    const p1 = await newUser('-p1', 'IT P1');
    const p2 = await newUser('-p2', 'IT P2');
    const admin = await newUser('-admin', 'IT Admin', 'admin');
    let campaignId = '';
    const roomCode = code(8);
    try {
      campaignId = (await query<{ id: string }>(
        'INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} deck`, code(10), roomCode])).rows[0].id;
      for (const [uid, role] of [[dmId, 'dm'], [p1, 'player'], [p2, 'player']] as const) {
        await query('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [campaignId, uid, role]);
      }
      const mk = async (owner: string, name: string) => {
        const id = await createCharacter(owner, name);
        await query('UPDATE characters SET campaign_id = $2, party_active = true WHERE id = $1', [id, campaignId]);
        await query(`UPDATE character_resources SET current_value = 20, max_value = 20 WHERE character_id = $1 AND resource_key = 'hp'`, [id]);
        return id;
      };
      const A = await mk(p1, 'Aria');
      const B = await mk(p2, 'Brom');
      const deckId = (await query<{ id: string }>(`SELECT id FROM content_definitions WHERE content_key = 'deck:mystical_fate' AND owner_user_id IS NULL`)).rows[0].id;
      await decks.setCampaignDeck({ userId: dmId, campaignId, deckId, enabled: true });
      const hp = async (id: string) => (await query<any>(`SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = 'hp'`, [id])).rows[0].current_value as number;

      // Endpoint access: a campaign member who does not own the character, and a site admin, both get 403.
      const post = (userId: string, characterId: string) =>
        drawRoute.POST({ locals: { user: { id: userId } }, request: { json: async () => ({ characterId, deckId }) } } as any);
      expect((await post(p2, A)).status).toBe(403);
      expect((await post(admin, A)).status).toBe(403);
      expect((await post(p1, crypto.randomUUID())).status).toBe(403);

      // A live room with the character's PC token (and an enemy token that must not move) and a GM watcher.
      const session: any = store.createSession(roomCode, { campaignId });
      session.map = { revealed: true };
      session.tokens = {
        pc: { id: 'pc', type: 'pc', characterId: A, stats: { hp: 20, maxHp: 20 } },
        en: { id: 'en', type: 'enemy', characterId: A, stats: { hp: 20, maxHp: 20 } }
      };
      store.sessions.set(roomCode, session);
      const gmSent: any[] = [];
      const watchSent: any[] = [];
      const open = 1;
      store.socketsBySession.set(roomCode, new Set([{ ws: { readyState: 1, OPEN: open, send: (m: string) => gmSent.push(JSON.parse(m)) }, role: 'gm', playerId: null, gmUserId: dmId, watchTopics: new Set() }]) as any);
      store.watchersByTopic.set(`room:${roomCode}`, new Set([{ ws: { readyState: 1, OPEN: open, send: (m: string) => watchSent.push(JSON.parse(m)) }, role: 'watcher', watchTopics: new Set() }]) as any);

      // Failed Queen of hearts: 2d10+5 damage to each member (every die a 5, so 15). Aria 20 -> 5, and so does her PC token.
      const drawn = await decks.drawCard({ userId: p1, characterId: A, deckId, deps: { cardId: 'black:hearts:Q', rollDie: () => 5 } });
      expect(drawn.draw.success).toBe(false);
      expect(await hp(A)).toBe(5);
      await announceDeck(drawn.draw, 'drawn');
      expect(session.tokens.pc.stats.hp).toBe(5);
      expect(session.tokens.en.stats.hp).toBe(20);
      const stored = await decks.listDrawsForCampaign(dmId, campaignId);
      expect(stored[0].results.find((line) => line.characterId === A)?.tokenHpDeltas).toEqual({ pc: -15 });
      expect(gmSent.map((m) => m.type)).toEqual(expect.arrayContaining(['token:stat:update', 'roll:log', 'deck:drawn']));
      const log = await query<any>(`SELECT message, details FROM roll_log_entries WHERE session_id = $1`, [roomCode]);
      expect(log.rows[0].message).toContain('Queen of Hearts');
      expect(log.rows[0].details).toMatchObject({ kind: 'deck_draw', drawId: drawn.draw.id, success: false });
      // Watchers (unauthenticated) only ever get the public roll line and a content-free ping.
      expect(watchSent.map((m) => m.type).sort()).toEqual(['deck:ping', 'roll:log']);
      expect(watchSent.find((m) => m.type === 'deck:ping')).toEqual({ type: 'deck:ping', characterIds: expect.any(Array), topic: `room:${roomCode}` });

      // Undo: a player gets 403, the DM 200 and the token goes back up by exactly what it lost; a second undo is 409.
      const undo = (userId: string) => undoRoute.POST({ locals: { user: { id: userId } }, params: { id: drawn.draw.id } } as any);
      expect((await undo(p1)).status).toBe(403);
      expect((await undo(dmId)).status).toBe(200);
      expect(await hp(A)).toBe(20);
      expect(session.tokens.pc.stats.hp).toBe(20);
      expect(gmSent.map((m) => m.type)).toContain('deck:undone');
      expect((await undo(dmId)).status).toBe(409);

      // Token AC follows the sheet by delta (unit 5b): a failed 3 of clubs is -3 AC on the drawer's token (with a
      // manual +2 on top), it comes back when the effect expires, and again when an undo removes it.
      const { characterStatsFor } = await import('$lib/rules/characterStats');
      const { getCharacterForRoll } = await import('./services/characters');
      const { advanceCharacterRound } = await import('./services/catalogue');
      const { followSheetAc } = await import('./vttTokenAc');
      const sheetAc = async () => characterStatsFor((await getCharacterForRoll(A))!).armorClass.value;
      const base = await sheetAc();
      session.tokens.pc.ac = base + 2; // a GM's manual offset
      session.tokens.pc.sheetAc = base;
      const failed = await decks.drawCard({ userId: p1, characterId: A, deckId, deps: { cardId: 'gold:clubs:3', rollDie: () => 1 } });
      expect(failed.draw.success).toBe(false);
      await announceDeck(failed.draw, 'drawn');
      expect(session.tokens.pc.ac).toBe(base + 2 - 3);
      for (let i = 0; i < 10; i += 1) await advanceCharacterRound(p1, A);
      await followSheetAc([A]);
      expect(session.tokens.pc.ac).toBe(base + 2);
      const failed2 = await decks.drawCard({ userId: p1, characterId: A, deckId, deps: { cardId: 'gold:clubs:3', rollDie: () => 1 } });
      await announceDeck(failed2.draw, 'drawn');
      expect(session.tokens.pc.ac).toBe(base + 2 - 3);
      expect((await undoRoute.POST({ locals: { user: { id: dmId } }, params: { id: failed2.draw.id } } as any)).status).toBe(200);
      expect(session.tokens.pc.ac).toBe(base + 2);

      // An Ace waits for a choice: 409 for a second draw (with the draw), 400 for a bad value, 200 for a good one.
      const ace = await decks.drawCard({ userId: p2, characterId: B, deckId, deps: { cardId: 'gold:hearts:A' } });
      expect(ace.status).toBe('choosing');
      const again = await post(p2, B);
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe('choosing');
      const choose = (userId: string, value: unknown) =>
        chooseRoute.POST({ locals: { user: { id: userId } }, params: { id: ace.draw.id }, request: { json: async () => ({ value }) } } as any);
      expect((await choose(p2, 'x')).status).toBe(400);
      expect((await choose(p2, 5)).status).toBe(400);
      expect((await choose(p1, 11)).status).toBe(403);
      expect((await choose(p2, 11)).status).toBe(200);
      expect((await choose(p2, 11)).status).toBe(409);
    } finally {
      store.sessions.delete(roomCode);
      store.socketsBySession.delete(roomCode);
      store.watchersByTopic.delete(`room:${roomCode}`);
      await query('DELETE FROM roll_log_entries WHERE session_id = $1', [roomCode]);
      await query('DELETE FROM deck_draws WHERE campaign_id = $1', [campaignId || '00000000-0000-0000-0000-000000000000']);
      await query('DELETE FROM campaign_decks WHERE campaign_id = $1', [campaignId || '00000000-0000-0000-0000-000000000000']);
      await query('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
      if (campaignId) await query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    }
  });
});

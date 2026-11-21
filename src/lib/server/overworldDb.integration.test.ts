import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed overworld harness. SKIPPED unless CAMPAIGN_DB_TEST=1, so the normal suite never touches a
// database. It talks to whatever DATABASE_URL points at, so only ever run it against the LOCAL dev DB
// (localhost / dndchar_dev) after `npm run db:migrate`. It creates throwaway users (inserted into
// `users` only, never `sessions`) and campaigns, and deletes them all in afterAll. Image files go to a
// temp dir (UPLOAD_DIR), never the real data folder. The live-update notify is stubbed.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   CAMPAIGN_DB_TEST=1 npx vitest run src/lib/server/overworldDb.integration.test.ts
const enabled = process.env.CAMPAIGN_DB_TEST === '1';

vi.mock('$lib/server/overworldNotify', () => ({
  notifyOverworldChanged: vi.fn(),
  notifyMapGranted: vi.fn()
}));

const { query } = await import('$lib/server/db');
const campaigns = await import('./services/campaigns');
const overworld = await import('./services/overworld');
const { validateUpload } = await import('./overworldUpload');
const notify = await import('$lib/server/overworldNotify');

const tag = `zzow${crypto.randomBytes(4).toString('hex')}`;
const userIds: Record<string, string> = {};
const campaignIds: string[] = [];
let uploadRoot = '';
const originalUploadDir = process.env.UPLOAD_DIR;

async function makeUser(key: string, role: 'user' | 'admin' = 'user') {
  const result = await query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`${tag}-${key}@example.invalid`, `IT ${key}`, role]
  );
  userIds[key] = result.rows[0].id;
}
const u = (key: string) => userIds[key];

async function newCampaign(name: string): Promise<{ id: string; invite: string }> {
  const id = await campaigns.createCampaign(u('dm'), `${tag} ${name}`, '');
  campaignIds.push(id);
  const row = await query<{ invite_code: string }>('SELECT invite_code FROM campaigns WHERE id = $1', [id]);
  return { id, invite: row.rows[0].invite_code };
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
// A PNG header is all the sniffer needs, and keeps the test files tiny.
function pngFile(width: number, height: number, name = 'map.png') {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [0, 0, 0, 13, ...'IHDR'.split('').map((c) => c.charCodeAt(0)), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  return new File([Uint8Array.from([...sig, ...ihdr])], name, { type: 'image/png' });
}
const image = (w = 1200, h = 800) => validateUpload(pngFile(w, h));

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, `expected OverworldError ${code}`).toBeInstanceOf(overworld.OverworldError);
  expect((error as InstanceType<typeof overworld.OverworldError>).code).toBe(code);
}

const dirFor = (campaignId: string) => path.join(uploadRoot, 'overworld', campaignId);
const filesIn = async (campaignId: string) => (await fs.readdir(dirFor(campaignId)).catch(() => [])) as string[];
const exists = (p: string) => fs.access(p).then(() => true, () => false);

beforeAll(async () => {
  if (!enabled) return;
  // Guard FIRST, before any query: local database only, and no ?host= override.
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
  uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overworld-it-'));
  process.env.UPLOAD_DIR = uploadRoot;
  for (const key of ['dm', 'codm', 'p1', 'p2', 'outsider']) await makeUser(key);
  await makeUser('adminOut', 'admin');
  await makeUser('adminPlayer', 'admin');
  console.info('[overworld integration] database host', target.hostname);
});

afterAll(async () => {
  if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = originalUploadDir;
  if (uploadRoot) await fs.rm(uploadRoot, { recursive: true, force: true });
  if (!enabled || !userIds.dm) return;
  // Users first (cascades their members), then the test campaigns (cascades maps, pins, routes).
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [Object.values(userIds)]);
  if (campaignIds.length) await query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [campaignIds]);
});

describe.skipIf(!enabled)('overworld against the local dev DB', () => {
  let C = '';
  let mapId = '';
  let firstFile = '';

  it('sanity: the target is local', () => {
    expect(['localhost', '127.0.0.1', '::1']).toContain(new URL(env.DATABASE_URL!).hostname);
  });

  it('setup: a campaign with a DM, a co-DM and two players (one of them a site admin)', async () => {
    const created = await newCampaign('main');
    C = created.id;
    for (const key of ['codm', 'p1', 'p2', 'adminPlayer']) await campaigns.joinCampaignByInviteCode(u(key), created.invite);
    await campaigns.setMemberRole(u('dm'), C, u('codm'), 'co_dm');
  });

  it('a DM creates a map from a tiny generated PNG; the file lands under UPLOAD_DIR; notify fires once', async () => {
    vi.mocked(notify.notifyOverworldChanged).mockClear();
    mapId = await overworld.createMap(u('dm'), C, { name: 'Faerun', milesAcross: 1500 }, await image());
    expect(vi.mocked(notify.notifyOverworldChanged)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify.notifyOverworldChanged)).toHaveBeenCalledWith(C, mapId);
    const view = await overworld.getMapView(u('dm'), C, mapId);
    expect(view?.map).toMatchObject({ name: 'Faerun', imageWidth: 1200, imageHeight: 800, milesAcross: 1500, grantedAt: null });
    firstFile = view!.map.imageFile;
    expect(await filesIn(C)).toEqual([firstFile]);
    expect(view!.map.imageUrl).toBe(`/campaigns/${C}/overworld/${mapId}/image/${firstFile}`);
    expect(view!.viewer).toEqual({ canManage: true, canCreatePin: true, canCreateParty: true });
  });

  it("a player can't see the map until it is granted; players can't create maps (and no file is written)", async () => {
    expect(await overworld.getMapView(u('p1'), C, mapId)).toBeNull();
    expect((await overworld.listMapsForViewer(u('p1'), C))?.maps).toEqual([]);
    expect((await overworld.listMapsForViewer(u('codm'), C))?.maps.map((m) => m.id)).toEqual([mapId]);
    expect(await overworld.getMapImageForViewer(u('p1'), C, mapId, firstFile)).toBeNull();

    const before = await filesIn(C);
    await expectCode(overworld.createMap(u('p1'), C, { name: 'Nope', milesAcross: null }, await image()), 'forbidden');
    expect(await filesIn(C)).toEqual(before);

    await overworld.setMapGranted(u('dm'), C, mapId, true);
    expect((await overworld.getMapView(u('p1'), C, mapId))?.viewer).toEqual({ canManage: false, canCreatePin: true, canCreateParty: false });
    expect((await overworld.listMapsForViewer(u('p1'), C))?.maps.map((m) => m.id)).toEqual([mapId]);
    expect(await overworld.getMapImageForViewer(u('p1'), C, mapId, firstFile)).toBe(path.join(dirFor(C), firstFile));
    expect(await overworld.getMapImageForViewer(u('p1'), C, mapId, 'other.png')).toBeNull();
    await expectCode(overworld.updateMap(u('p1'), C, mapId, { name: 'x', milesAcross: null }), 'forbidden');
    await expectCode(overworld.setMapGranted(u('p1'), C, mapId, false), 'forbidden');
    await expectCode(overworld.archiveMap(u('p1'), C, mapId), 'forbidden');
  });

  it('non-members get nothing, a site admin who is not a member included (Rev 2)', async () => {
    for (const key of ['outsider', 'adminOut']) {
      expect(await overworld.listMapsForViewer(u(key), C)).toBeNull();
      expect(await overworld.getMapView(u(key), C, mapId)).toBeNull();
      expect(await overworld.getMapImageForViewer(u(key), C, mapId, firstFile)).toBeNull();
      await expectCode(overworld.createMap(u(key), C, { name: 'x', milesAcross: null }, await image()), 'not_found');
      await expectCode(overworld.createPin(u(key), C, mapId, { x: 0.5, y: 0.5 }), 'not_found');
      await expectCode(overworld.setMapGranted(u(key), C, mapId, false), 'not_found');
    }
  });

  it('a site admin who is a player has exactly player rights', async () => {
    expect((await overworld.getMapView(u('adminPlayer'), C, mapId))?.viewer).toEqual({ canManage: false, canCreatePin: true, canCreateParty: false });
    await expectCode(overworld.createMap(u('adminPlayer'), C, { name: 'x', milesAcross: null }, await image()), 'forbidden');
    await expectCode(overworld.createPin(u('adminPlayer'), C, mapId, { kind: 'party', x: 0.5, y: 0.5 }), 'forbidden');
  });

  it('a map id from another campaign is not found', async () => {
    const other = await newCampaign('other');
    expect(await overworld.getMapView(u('dm'), other.id, mapId)).toBeNull();
    await expectCode(overworld.createPin(u('dm'), other.id, mapId, { x: 0.5, y: 0.5 }), 'not_found');
  });

  it('replacing the image deletes the old file and the old name stops resolving', async () => {
    await expectCode(overworld.replaceMapImage(u('p1'), C, mapId, await image()), 'forbidden');
    expect(await filesIn(C)).toEqual([firstFile]);

    await overworld.replaceMapImage(u('dm'), C, mapId, await image(2000, 1000));
    const view = await overworld.getMapView(u('dm'), C, mapId);
    expect(view!.map).toMatchObject({ imageWidth: 2000, imageHeight: 1000 });
    const secondFile = view!.map.imageFile;
    expect(secondFile).not.toBe(firstFile);
    expect(await filesIn(C)).toEqual([secondFile]);
    expect(await overworld.getMapImageForViewer(u('p1'), C, mapId, firstFile)).toBeNull();
    expect(await overworld.getMapImageForViewer(u('p1'), C, mapId, secondFile)).not.toBeNull();
  });

  it('a DM pin is DM-locked; a player cannot edit, move or delete it; kind and dm_locked never change', async () => {
    const dmPin = await overworld.createPin(u('dm'), C, mapId, { x: 0.2, y: 0.3, label: 'DM pin' });
    let row = (await query('SELECT kind, dm_locked FROM overworld_pins WHERE id = $1', [dmPin])).rows[0];
    expect(row).toEqual({ kind: 'pin', dm_locked: true });

    await expectCode(overworld.updatePin(u('p1'), C, mapId, dmPin, { label: 'mine now' }), 'forbidden');
    await expectCode(overworld.movePin(u('p1'), C, mapId, dmPin, { x: 0.9, y: 0.9 }), 'forbidden');
    await expectCode(overworld.deletePin(u('p1'), C, mapId, dmPin), 'forbidden');

    // The co-DM may edit it; a forged kind / position in the fields is ignored by updatePin.
    await overworld.updatePin(u('codm'), C, mapId, dmPin, { label: 'Edited', kind: 'party', x: 0.9, y: 0.9 });
    row = (await query('SELECT kind, dm_locked, label, x, y FROM overworld_pins WHERE id = $1', [dmPin])).rows[0];
    expect(row).toEqual({ kind: 'pin', dm_locked: true, label: 'Edited', x: 0.2, y: 0.3 });
    await overworld.movePin(u('codm'), C, mapId, dmPin, { x: 0.25, y: 0.35 });
  });

  it("a player's public pin can be deleted by another player; visibility changes are creator or DM only", async () => {
    const pin = await overworld.createPin(u('p1'), C, mapId, { x: 0.1, y: 0.1, label: 'p1 pin' });
    await expectCode(overworld.updatePin(u('p2'), C, mapId, pin, { visibility: 'private' }), 'forbidden');
    await overworld.updatePin(u('p2'), C, mapId, pin, { label: 'renamed by p2' });
    await overworld.updatePin(u('p1'), C, mapId, pin, { visibility: 'private' });
    await overworld.updatePin(u('dm'), C, mapId, pin, { visibility: 'everyone' });
    await overworld.deletePin(u('p2'), C, mapId, pin);
    expect((await query('SELECT 1 FROM overworld_pins WHERE id = $1', [pin])).rows.length).toBe(0);
  });

  it('a private player pin is hidden from another player, visible to both DMs, never to a non-member', async () => {
    const pin = await overworld.createPin(u('p1'), C, mapId, { x: 0.4, y: 0.4, label: 'secret', visibility: 'private' });
    const labelsFor = async (key: string) => (await overworld.getMapView(u(key), C, mapId))?.pins.map((p) => p.label) ?? [];
    expect(await labelsFor('p1')).toContain('secret');
    expect(await labelsFor('dm')).toContain('secret');
    expect(await labelsFor('codm')).toContain('secret');
    expect(await labelsFor('p2')).not.toContain('secret');
    expect(await labelsFor('adminPlayer')).not.toContain('secret');
    expect(await labelsFor('adminOut')).toEqual([]);
    await expectCode(overworld.updatePin(u('p2'), C, mapId, pin, { label: 'peek' }), 'not_found');
    await expectCode(overworld.deletePin(u('p2'), C, mapId, pin), 'not_found');
    // Per-item flags sent to the client.
    const dmView = (await overworld.getMapView(u('dm'), C, mapId))!.pins.find((p) => p.id === pin)!;
    expect(dmView).toMatchObject({ canEdit: true, canChangeVisibility: true, createdByName: 'IT p1', visibility: 'private' });
  });

  it('party pins: refused for a player, fine for a DM, always DM-locked', async () => {
    await expectCode(overworld.createPin(u('p1'), C, mapId, { kind: 'party', x: 0.5, y: 0.5 }), 'forbidden');
    const party = await overworld.createPin(u('dm'), C, mapId, { kind: 'party', x: 0.5, y: 0.5, label: 'We are here' });
    const row = (await query('SELECT kind, dm_locked FROM overworld_pins WHERE id = $1', [party])).rows[0];
    expect(row).toEqual({ kind: 'party', dm_locked: true });
    await expectCode(overworld.movePin(u('p1'), C, mapId, party, { x: 0.6, y: 0.6 }), 'forbidden');
    await overworld.movePin(u('dm'), C, mapId, party, { x: 0.6, y: 0.6 });
  });

  it('routes: 4 points make 3 legs; deleting the middle leg leaves 2; deleting the rest deletes the route', async () => {
    const points = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.3, y: 0.2 }, { x: 0.4, y: 0.2 }];
    const routeId = await overworld.createRoute(u('p1'), C, mapId, points, { label: 'Road' });
    const legs = async () => (await overworld.getMapView(u('p1'), C, mapId))!.routes.find((r) => r.id === routeId)?.legs ?? [];
    expect((await legs()).map((l) => l.seq)).toEqual([0, 1, 2]);

    // Another player may delete a leg of a public player route.
    const [first, middle, last] = await legs();
    expect(await overworld.deleteRouteLeg(u('p2'), C, mapId, routeId, middle.id)).toEqual({ routeDeleted: false });
    expect((await legs()).map((l) => l.seq)).toEqual([0, 2]);
    expect(await overworld.deleteRouteLeg(u('p1'), C, mapId, routeId, first.id)).toEqual({ routeDeleted: false });
    expect(await overworld.deleteRouteLeg(u('p1'), C, mapId, routeId, last.id)).toEqual({ routeDeleted: true });
    expect((await query('SELECT 1 FROM overworld_routes WHERE id = $1', [routeId])).rows.length).toBe(0);
  });

  it('appendRouteLegs continues in seq order; a stale start gives route_changed and saves nothing', async () => {
    const routeId = await overworld.createRoute(u('dm'), C, mapId, [{ x: 0.1, y: 0.5 }, { x: 0.2, y: 0.5 }], { colour: 'blue' });
    await overworld.appendRouteLegs(u('dm'), C, mapId, routeId, { x: 0.2, y: 0.5 }, [{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.4, y: 0.5 }]);
    let legs = (await overworld.getMapView(u('dm'), C, mapId))!.routes.find((r) => r.id === routeId)!.legs;
    expect(legs.map((l) => [l.seq, l.x2])).toEqual([[0, 0.2], [1, 0.3], [2, 0.4]]);

    await expectCode(
      overworld.appendRouteLegs(u('dm'), C, mapId, routeId, { x: 0.2, y: 0.5 }, [{ x: 0.2, y: 0.5 }, { x: 0.9, y: 0.9 }]),
      'route_changed'
    );
    legs = (await overworld.getMapView(u('dm'), C, mapId))!.routes.find((r) => r.id === routeId)!.legs;
    expect(legs.length).toBe(3);

    // A DM route is DM-locked: a player cannot continue, edit or delete it.
    await expectCode(overworld.appendRouteLegs(u('p1'), C, mapId, routeId, { x: 0.4, y: 0.5 }, [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.5 }]), 'forbidden');
    await expectCode(overworld.updateRoute(u('p1'), C, mapId, routeId, { label: 'x' }), 'forbidden');
    await expectCode(overworld.deleteRoute(u('p1'), C, mapId, routeId), 'forbidden');
    await overworld.updateRoute(u('codm'), C, mapId, routeId, { label: 'Renamed', visibility: 'private' });
    await overworld.deleteRoute(u('dm'), C, mapId, routeId);
  });

  it('a private route is hidden from other players', async () => {
    const routeId = await overworld.createRoute(u('p1'), C, mapId, [{ x: 0.1, y: 0.8 }, { x: 0.2, y: 0.8 }], { visibility: 'private' });
    const ids = async (key: string) => (await overworld.getMapView(u(key), C, mapId))!.routes.map((r) => r.id);
    expect(await ids('p1')).toContain(routeId);
    expect(await ids('codm')).toContain(routeId);
    expect(await ids('p2')).not.toContain(routeId);
    await expectCode(overworld.deleteRoute(u('p2'), C, mapId, routeId), 'not_found');
    await overworld.deleteRoute(u('p1'), C, mapId, routeId);
  });

  it('notify: once per successful write, never for a refused one', async () => {
    const mock = vi.mocked(notify.notifyOverworldChanged);
    mock.mockClear();
    const pin = await overworld.createPin(u('p1'), C, mapId, { x: 0.7, y: 0.7 });
    expect(mock).toHaveBeenCalledTimes(1);
    await expectCode(overworld.createPin(u('p1'), C, mapId, { kind: 'party', x: 0.7, y: 0.7 }), 'forbidden');
    expect(mock).toHaveBeenCalledTimes(1);
    await overworld.deletePin(u('p1'), C, mapId, pin);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock).toHaveBeenLastCalledWith(C, mapId);
  });

  it('limits: two parallel createPin calls at the 499/500 edge give exactly one success', async () => {
    const edge = await overworld.createMap(u('dm'), C, { name: 'Edge', milesAcross: null }, await image());
    await overworld.setMapGranted(u('dm'), C, edge, true);
    // Fill to 499 directly (500 inserts through the service would be slow and pointless).
    await query(
      `INSERT INTO overworld_pins (map_id, x, y, created_by_user_id)
       SELECT $1, 0.5, 0.5, $2 FROM generate_series(1, 499)`,
      [edge, u('dm')]
    );
    const results = await Promise.allSettled([
      overworld.createPin(u('p1'), C, edge, { x: 0.1, y: 0.1 }),
      overworld.createPin(u('p2'), C, edge, { x: 0.2, y: 0.2 })
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as InstanceType<typeof overworld.OverworldError>).code).toBe('limit');
    expect((await query('SELECT count(*)::int AS n FROM overworld_pins WHERE map_id = $1', [edge])).rows[0].n).toBe(500);
  });

  it('replaceMapImage notifies exactly once', async () => {
    const m = await overworld.createMap(u('dm'), C, { name: 'Replace me', milesAcross: null }, await image());
    const mock = vi.mocked(notify.notifyOverworldChanged);
    mock.mockClear();
    await overworld.replaceMapImage(u('dm'), C, m, await image(900, 900));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(C, m);
    // A refused replace does not notify.
    await expectCode(overworld.replaceMapImage(u('p1'), C, m, await image()), 'forbidden');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('route_changed after the last leg is deleted, and bad coordinates are refused by the service', async () => {
    const m = await overworld.createMap(u('dm'), C, { name: 'Routes', milesAcross: null }, await image());
    const routeId = await overworld.createRoute(u('dm'), C, m, [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], {});
    const legs = (await overworld.getMapView(u('dm'), C, m))!.routes[0].legs;
    // Someone deletes the last leg, so the end the other client saw (0.3, 0.3) is gone.
    await overworld.deleteRouteLeg(u('dm'), C, m, routeId, legs[1].id);
    await expectCode(
      overworld.appendRouteLegs(u('dm'), C, m, routeId, { x: 0.3, y: 0.3 }, [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }]),
      'route_changed'
    );
    expect((await overworld.getMapView(u('dm'), C, m))!.routes[0].legs.length).toBe(1);

    // Continuing from the real end works, and the new leg starts exactly at the stored end point.
    await overworld.appendRouteLegs(u('dm'), C, m, routeId, { x: 0.2, y: 0.2 }, [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }]);
    const after = (await overworld.getMapView(u('dm'), C, m))!.routes[0].legs;
    expect(after.map((l) => [l.seq, l.x1, l.x2])).toEqual([[0, 0.1, 0.2], [1, 0.2, 0.5]]);

    // Service-level coordinate guards (NaN, out of range).
    const pin = await overworld.createPin(u('dm'), C, m, { x: 0.5, y: 0.5 });
    await expectCode(overworld.movePin(u('dm'), C, m, pin, { x: 1.5, y: 0.5 }), 'invalid');
    await expectCode(overworld.movePin(u('dm'), C, m, pin, { x: NaN, y: 0.5 }), 'invalid');
    await expectCode(overworld.createRoute(u('dm'), C, m, [{ x: 0.1, y: 0.1 }, { x: -0.1, y: 0.2 }], {}), 'invalid');
    await expectCode(overworld.appendRouteLegs(u('dm'), C, m, routeId, { x: 0.5, y: 0.5 }, [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 2 }]), 'invalid');
  });

  it('an archived map vanishes for everyone, DMs included, and its file is kept', async () => {
    await overworld.archiveMap(u('dm'), C, mapId);
    expect(await overworld.getMapView(u('dm'), C, mapId)).toBeNull();
    expect(await overworld.getMapView(u('p1'), C, mapId)).toBeNull();
    expect((await overworld.listMapsForViewer(u('dm'), C))?.maps.map((m) => m.id)).not.toContain(mapId);
    expect((await filesIn(C)).length).toBeGreaterThanOrEqual(1);
    await expectCode(overworld.createPin(u('dm'), C, mapId, { x: 0.5, y: 0.5 }), 'not_found');
  });

  it('an archived campaign refuses every write (the DM too) and its members cannot read', async () => {
    const live = await newCampaign('to-archive');
    await campaigns.joinCampaignByInviteCode(u('p1'), live.invite);
    const m = await overworld.createMap(u('dm'), live.id, { name: 'Soon gone', milesAcross: null }, await image());
    await overworld.setMapGranted(u('dm'), live.id, m, true);
    const pin = await overworld.createPin(u('p1'), live.id, m, { x: 0.5, y: 0.5 });
    const route = await overworld.createRoute(u('p1'), live.id, m, [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], {});

    await campaigns.archiveCampaign(u('dm'), live.id);

    for (const key of ['dm', 'p1']) {
      await expectCode(overworld.createMap(u(key), live.id, { name: 'x', milesAcross: null }, await image()), 'archived');
      await expectCode(overworld.createPin(u(key), live.id, m, { x: 0.5, y: 0.5 }), 'archived');
      await expectCode(overworld.movePin(u(key), live.id, m, pin, { x: 0.6, y: 0.6 }), 'archived');
      await expectCode(overworld.deleteRoute(u(key), live.id, m, route), 'archived');
      await expectCode(overworld.setMapGranted(u(key), live.id, m, false), 'archived');
      expect(await overworld.getMapView(u(key), live.id, m)).toBeNull();
      expect(await overworld.listMapsForViewer(u(key), live.id)).toBeNull();
    }
    // A site admin who is not a member still gets nothing.
    await expectCode(overworld.createPin(u('adminOut'), live.id, m, { x: 0.5, y: 0.5 }), 'not_found');
    expect(await overworld.getMapView(u('adminOut'), live.id, m)).toBeNull();
  });
});

import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { getCampaignAccess, isUuid, type Queryable } from '$lib/server/services/access';
import { OverworldError } from '$lib/server/overworldError';
import { dropMapPreviews, notifyOverworldChanged } from '$lib/server/overworldNotify';
import {
  removeImageFile,
  storeImageThenRun,
  isSafeImageFileName,
  type ValidatedImage
} from '$lib/server/overworldUpload';
import { overworldImageDir } from '$lib/server/uploadStorage';
import path from 'node:path';
import type { PinFields, RouteFields } from '$lib/overworld/input';
import { MAX_LEGS_PER_ROUTE, MAX_PINS_PER_MAP, MAX_ROUTES_PER_MAP } from '$lib/overworld/palette';
import {
  canChangeVisibility,
  canCreate,
  canEditItem,
  canManageMaps,
  canOpenOverworld,
  canSeeItem,
  canSeeMap,
  dmLockedOnCreate,
  isOverworldDm
} from '$lib/overworld/rules';
import type {
  ItemFacts,
  MapList,
  MapView,
  OverworldMap,
  OverworldPin,
  OverworldRoute,
  OverworldRouteLeg,
  OverworldViewer,
  PinView,
  Pt,
  RouteView
} from '$lib/types/overworld';

export { OverworldError };

// Overworld service: plain pg, every write re-checks access with the pure rules in
// $lib/overworld/rules.ts. Rev 2: ONLY the campaign role counts. The site-admin flag is never read
// here, so an admin who is not a member gets "not found" like anyone else.
//
// Conventions:
// - Reads return null when the viewer may not see the thing. Writes throw OverworldError.
// - `not_found` also means "exists but you cannot see it".
// - Each write loads the viewer (role + campaign archived flag) INSIDE its transaction, so a campaign
//   archived a moment ago is respected, and notifies after COMMIT.

type Db = Queryable;

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown): string | null => (value == null ? null : iso(value));

const MAP_COLUMNS = `id, campaign_id, name, image_file, image_width, image_height, image_bytes, miles_across,
  granted_at, archived_at, created_by_user_id, created_at, updated_at`;
const PIN_COLUMNS = `id, map_id, kind, x, y, label, note, colour, icon, visibility, dm_locked,
  created_by_user_id, updated_by_user_id, created_at, updated_at`;
// Same columns prefixed with the p. alias, for the join with users.
const PIN_COLUMNS_P = PIN_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ');
const ROUTE_COLUMNS =`id, map_id, label, colour, visibility, dm_locked, created_by_user_id, updated_by_user_id,
  created_at, updated_at`;

function mapFromRow(r: any): OverworldMap {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    name: r.name,
    imageFile: r.image_file,
    imageWidth: r.image_width,
    imageHeight: r.image_height,
    imageBytes: r.image_bytes,
    milesAcross: r.miles_across,
    grantedAt: isoOrNull(r.granted_at),
    archivedAt: isoOrNull(r.archived_at),
    createdByUserId: r.created_by_user_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  };
}

function pinFromRow(r: any): OverworldPin {
  return {
    id: r.id,
    mapId: r.map_id,
    kind: r.kind,
    x: r.x,
    y: r.y,
    label: r.label,
    note: r.note,
    colour: r.colour,
    icon: r.icon,
    visibility: r.visibility,
    dmLocked: r.dm_locked,
    createdByUserId: r.created_by_user_id,
    updatedByUserId: r.updated_by_user_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  };
}

function routeFromRow(r: any): OverworldRoute {
  return {
    id: r.id,
    mapId: r.map_id,
    label: r.label,
    colour: r.colour,
    visibility: r.visibility,
    dmLocked: r.dm_locked,
    createdByUserId: r.created_by_user_id,
    updatedByUserId: r.updated_by_user_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  };
}

const legFromRow = (r: any): OverworldRouteLeg => ({
  id: r.id, routeId: r.route_id, seq: r.seq, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2
});

const itemFacts = (item: { kind?: 'pin' | 'party'; visibility: 'everyone' | 'private'; dmLocked: boolean; createdByUserId: string | null }): ItemFacts => ({
  kind: item.kind,
  visibility: item.visibility,
  dmLocked: item.dmLocked,
  createdByUserId: item.createdByUserId
});

export const mapImageUrl = (campaignId: string, mapId: string, imageFile: string) =>
  `/campaigns/${campaignId}/overworld/${mapId}/image/${imageFile}`;

// ---------------------------------------------------------------------------------------------
// Viewer and map loading
// ---------------------------------------------------------------------------------------------

/** The viewer's facts for one campaign, from the campaign role only. Null = no such campaign. */
export async function loadViewer(db: Db, userId: string, campaignId: string): Promise<OverworldViewer | null> {
  const access = await getCampaignAccess(db, userId, campaignId);
  if (!access) return null;
  // access.isAdmin is deliberately ignored (Rev 2).
  return { userId, role: access.role, campaignArchived: access.archived };
}

// For writes: not a member (admin or not) reads as not found; an archived campaign refuses.
async function writerViewer(db: Db, userId: string, campaignId: string): Promise<OverworldViewer> {
  const viewer = await loadViewer(db, userId, campaignId);
  if (!viewer || viewer.role === null) throw new OverworldError('not_found', 'Not found.');
  if (viewer.campaignArchived) throw new OverworldError('archived', 'This campaign is archived.');
  return viewer;
}

async function loadMap(db: Db, campaignId: string, mapId: string, lock = false): Promise<OverworldMap | null> {
  if (!isUuid(campaignId) || !isUuid(mapId)) return null;
  const result = await db.query(
    `SELECT ${MAP_COLUMNS} FROM overworld_maps WHERE id = $1 AND campaign_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [mapId, campaignId]
  );
  return result.rows[0] ? mapFromRow(result.rows[0]) : null;
}

// Writer gate for anything on a map: member of a live campaign who can see the map. Locks the map row
// so counted limits and concurrent edits on one map are serialised.
async function gateMapWrite(db: Db, userId: string, campaignId: string, mapId: string) {
  const viewer = await writerViewer(db, userId, campaignId);
  const map = await loadMap(db, campaignId, mapId, true);
  if (!map || !canSeeMap(viewer, map)) throw new OverworldError('not_found', 'Not found.');
  return { viewer, map };
}

// Same, but for DM-only map management.
async function gateManage(db: Db, userId: string, campaignId: string, mapId: string) {
  const gate = await gateMapWrite(db, userId, campaignId, mapId);
  if (!canManageMaps(gate.viewer)) throw new OverworldError('forbidden', 'Only a DM can manage maps.');
  return gate;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Maps this viewer may open in a campaign, or null if they may not open the overworld at all. */
export async function listMapsForViewer(userId: string, campaignId: string): Promise<MapList | null> {
  const viewer = await loadViewer({ query }, userId, campaignId);
  if (!viewer || !canOpenOverworld(viewer)) return null;

  const dm = isOverworldDm(viewer);
  const rows = await query(
    `
      SELECT m.id, m.name, m.image_file, m.image_width, m.image_height, m.miles_across, m.granted_at, m.archived_at,
        (SELECT count(*)::int FROM overworld_pins p
          WHERE p.map_id = m.id AND (p.visibility = 'everyone' OR p.created_by_user_id = $2 OR $3::boolean)) AS pin_count
      FROM overworld_maps m
      WHERE m.campaign_id = $1 AND m.archived_at IS NULL
      ORDER BY m.created_at, m.id
    `,
    [campaignId, userId, dm]
  );
  const maps = rows.rows
    .filter((r) => canSeeMap(viewer, { grantedAt: isoOrNull(r.granted_at), archivedAt: null }))
    .map((r) => ({
      id: r.id as string,
      name: r.name as string,
      granted: r.granted_at !== null,
      imageUrl: mapImageUrl(campaignId, r.id, r.image_file),
      pinCount: r.pin_count as number,
      imageWidth: r.image_width as number,
      imageHeight: r.image_height as number,
      milesAcross: r.miles_across as number | null
    }));
  return { viewer: { canManage: canManageMaps(viewer) }, maps };
}

/** One map with the pins and routes this viewer may see, or null if they may not see the map. */
export async function getMapView(userId: string, campaignId: string, mapId: string): Promise<MapView | null> {
  const viewer = await loadViewer({ query }, userId, campaignId);
  if (!viewer || !canOpenOverworld(viewer)) return null;
  const map = await loadMap({ query }, campaignId, mapId);
  if (!map || !canSeeMap(viewer, map)) return null;

  const [pinRows, routeRows, legRows] = await Promise.all([
    query(
      `SELECT ${PIN_COLUMNS_P}, u.display_name AS created_by_name
       FROM overworld_pins p LEFT JOIN users u ON u.id = p.created_by_user_id
       WHERE p.map_id = $1 ORDER BY p.created_at, p.id`,
      [mapId]
    ),
    query(
      `SELECT r.id, r.map_id, r.label, r.colour, r.visibility, r.dm_locked, r.created_by_user_id, r.updated_by_user_id,
              r.created_at, r.updated_at, u.display_name AS created_by_name
       FROM overworld_routes r LEFT JOIN users u ON u.id = r.created_by_user_id
       WHERE r.map_id = $1 ORDER BY r.created_at, r.id`,
      [mapId]
    ),
    query(
      `SELECT l.id, l.route_id, l.seq, l.x1, l.y1, l.x2, l.y2
       FROM overworld_route_legs l JOIN overworld_routes r ON r.id = l.route_id
       WHERE r.map_id = $1 ORDER BY l.route_id, l.seq`,
      [mapId]
    )
  ]);

  const pins: PinView[] = pinRows.rows
    .map((r) => ({ pin: pinFromRow(r), name: (r.created_by_name as string | null) ?? null }))
    .filter(({ pin }) => canSeeItem(viewer, itemFacts(pin)))
    .map(({ pin, name }) => ({
      ...pin,
      createdByName: name,
      canEdit: canEditItem(viewer, itemFacts(pin)),
      canChangeVisibility: canChangeVisibility(viewer, itemFacts(pin))
    }));

  const legsByRoute = new Map<string, OverworldRouteLeg[]>();
  for (const row of legRows.rows) {
    const leg = legFromRow(row);
    const list = legsByRoute.get(leg.routeId) ?? [];
    list.push(leg);
    legsByRoute.set(leg.routeId, list);
  }
  const routes: RouteView[] = routeRows.rows
    .map((r) => ({ route: routeFromRow(r), name: (r.created_by_name as string | null) ?? null }))
    .filter(({ route }) => canSeeItem(viewer, itemFacts(route)))
    .map(({ route, name }) => ({
      ...route,
      createdByName: name,
      canEdit: canEditItem(viewer, itemFacts(route)),
      canChangeVisibility: canChangeVisibility(viewer, itemFacts(route)),
      legs: legsByRoute.get(route.id) ?? []
    }));

  return {
    map: { ...map, imageUrl: mapImageUrl(campaignId, map.id, map.imageFile) },
    viewer: {
      canManage: canManageMaps(viewer),
      canCreatePin: canCreate(viewer, 'pin'),
      canCreateParty: canCreate(viewer, 'party')
    },
    pins,
    routes
  };
}

/**
 * Live route preview: may this user join the map's preview channel? Same gate as seeing the map
 * (campaign role only). Returns the facts the ticket carries, or null.
 */
export async function getLivePreviewAccess(userId: string, campaignId: string, mapId: string): Promise<{ isDm: boolean } | null> {
  const viewer = await loadViewer({ query }, userId, campaignId);
  if (!viewer || !canOpenOverworld(viewer)) return null;
  const map = await loadMap({ query }, campaignId, mapId);
  if (!map || !canSeeMap(viewer, map)) return null;
  return { isDm: isOverworldDm(viewer) };
}

/**
 * Absolute path of a map's CURRENT image for a viewer who may see the map, or null (wrong file name,
 * old file after a replace, not allowed, no such map). The image route does the rest.
 */
export async function getMapImageForViewer(userId: string, campaignId: string, mapId: string, file: string): Promise<string | null> {
  if (!isSafeImageFileName(file)) return null;
  const viewer = await loadViewer({ query }, userId, campaignId);
  if (!viewer || !canOpenOverworld(viewer)) return null;
  const map = await loadMap({ query }, campaignId, mapId);
  if (!map || !canSeeMap(viewer, map) || map.imageFile !== file) return null;
  return path.join(overworldImageDir(campaignId), map.imageFile);
}

// ---------------------------------------------------------------------------------------------
// Maps (DM only)
// ---------------------------------------------------------------------------------------------

type MapFields = { name: string; milesAcross: number | null };

// Cheap permission check before an image file is written (or an upload body is read), so a refused
// upload never touches disk. The real check is repeated inside the transaction.
export async function assertCanManageMaps(userId: string, campaignId: string): Promise<void> {
  const viewer = await writerViewer({ query }, userId, campaignId);
  if (!canManageMaps(viewer)) throw new OverworldError('forbidden', 'Only a DM can manage maps.');
}

export async function createMap(userId: string, campaignId: string, fields: MapFields, image: ValidatedImage): Promise<string> {
  await assertCanManageMaps(userId, campaignId);
  const mapId = await storeImageThenRun(campaignId, image, (fileName) =>
    withTransaction(async (client) => {
      const viewer = await writerViewer(client, userId, campaignId);
      if (!canManageMaps(viewer)) throw new OverworldError('forbidden', 'Only a DM can manage maps.');
      const inserted = await client.query(
        `INSERT INTO overworld_maps (campaign_id, name, image_file, image_width, image_height, image_bytes, miles_across, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [campaignId, fields.name, fileName, image.width, image.height, image.buffer.length, fields.milesAcross, userId]
      );
      return inserted.rows[0].id as string;
    })
  );
  notifyOverworldChanged(campaignId, mapId);
  return mapId;
}

export async function replaceMapImage(userId: string, campaignId: string, mapId: string, image: ValidatedImage): Promise<void> {
  await assertCanManageMaps(userId, campaignId);
  const oldFile = await storeImageThenRun(campaignId, image, (fileName) =>
    withTransaction(async (client) => {
      const { map } = await gateManage(client, userId, campaignId, mapId);
      await client.query(
        `UPDATE overworld_maps SET image_file = $2, image_width = $3, image_height = $4, image_bytes = $5, updated_at = now()
         WHERE id = $1`,
        [mapId, fileName, image.width, image.height, image.buffer.length]
      );
      return map.imageFile;
    })
  );
  // After COMMIT: the old image is only deleted once nothing refers to it.
  await removeImageFile(campaignId, oldFile);
  notifyOverworldChanged(campaignId, mapId);
}

export async function updateMap(userId: string, campaignId: string, mapId: string, fields: MapFields): Promise<void> {
  await withTransaction(async (client) => {
    await gateManage(client, userId, campaignId, mapId);
    await client.query('UPDATE overworld_maps SET name = $2, miles_across = $3, updated_at = now() WHERE id = $1', [
      mapId, fields.name, fields.milesAcross
    ]);
  });
  notifyOverworldChanged(campaignId, mapId);
}

/** Share (true) or unshare (false) a map with the party. Returns what the grant banner needs. */
export async function setMapGranted(
  userId: string,
  campaignId: string,
  mapId: string,
  granted: boolean
): Promise<{ mapName: string; roomCode: string }> {
  const result = await withTransaction(async (client) => {
    const { map } = await gateManage(client, userId, campaignId, mapId);
    await client.query('UPDATE overworld_maps SET granted_at = CASE WHEN $2::boolean THEN now() ELSE NULL END, updated_at = now() WHERE id = $1', [
      mapId, granted
    ]);
    const campaign = await client.query('SELECT room_code FROM campaigns WHERE id = $1', [campaignId]);
    return { mapName: map.name, roomCode: campaign.rows[0].room_code as string };
  });
  notifyOverworldChanged(campaignId, mapId);
  // Unsharing: players on the map lose the live preview channel (DMs keep it).
  if (!granted) dropMapPreviews(mapId);
  return result;
}

/** Soft delete. The file is kept. */
export async function archiveMap(userId: string, campaignId: string, mapId: string): Promise<void> {
  await withTransaction(async (client) => {
    await gateManage(client, userId, campaignId, mapId);
    await client.query('UPDATE overworld_maps SET archived_at = now(), updated_at = now() WHERE id = $1', [mapId]);
  });
  notifyOverworldChanged(campaignId, mapId);
  dropMapPreviews(mapId, true);
}

// ---------------------------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------------------------

// Loads and locks an item row on this map, and decides whether the viewer may edit it.
// Cannot-see reads as not found; can-see-but-not-edit is forbidden with a friendly message.
function assertCanEdit(viewer: OverworldViewer, item: ItemFacts, noun: 'pin' | 'route') {
  if (!canSeeItem(viewer, item)) throw new OverworldError('not_found', 'Not found.');
  if (!canEditItem(viewer, item)) throw new OverworldError('forbidden', `Only a DM can change this ${noun}.`);
}

async function loadPin(db: Db, mapId: string, pinId: string): Promise<OverworldPin> {
  if (!isUuid(pinId)) throw new OverworldError('not_found', 'Not found.');
  const result = await db.query(`SELECT ${PIN_COLUMNS} FROM overworld_pins WHERE id = $1 AND map_id = $2 FOR UPDATE`, [pinId, mapId]);
  if (!result.rows[0]) throw new OverworldError('not_found', 'Not found.');
  return pinFromRow(result.rows[0]);
}

export async function createPin(userId: string, campaignId: string, mapId: string, fields: PinFields): Promise<string> {
  const kind = fields.kind ?? 'pin';
  if (fields.x === undefined || fields.y === undefined) throw new OverworldError('invalid', 'Pick a spot on the map.');
  const x = fields.x;
  const y = fields.y;
  assertPoints({ x, y });
  const pinId = await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    if (!canCreate(viewer, kind)) throw new OverworldError('forbidden', 'Only a DM can add a party pin.');
    const count = await client.query('SELECT count(*)::int AS n FROM overworld_pins WHERE map_id = $1', [mapId]);
    if (count.rows[0].n >= MAX_PINS_PER_MAP) throw new OverworldError('limit', `A map can have up to ${MAX_PINS_PER_MAP} pins.`);
    const inserted = await client.query(
      `INSERT INTO overworld_pins (map_id, kind, x, y, label, note, colour, icon, visibility, dm_locked, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, ''), COALESCE($6, ''), COALESCE($7, 'red'), COALESCE($8, 'dot'), COALESCE($9, 'everyone'), $10, $11, $11)
       RETURNING id`,
      [mapId, kind, x, y, fields.label ?? null, fields.note ?? null, fields.colour ?? null, fields.icon ?? null, fields.visibility ?? null,
       dmLockedOnCreate(viewer, kind), userId]
    );
    return inserted.rows[0].id as string;
  });
  notifyOverworldChanged(campaignId, mapId);
  return pinId;
}

// Only these columns can ever change through updatePin. kind and dm_locked are fixed at creation,
// and position only moves through movePin.
const PIN_EDITABLE = ['label', 'note', 'colour', 'icon', 'visibility'] as const;

export async function updatePin(userId: string, campaignId: string, mapId: string, pinId: string, fields: PinFields): Promise<void> {
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const pin = await loadPin(client, mapId, pinId);
    assertCanEdit(viewer, itemFacts(pin), 'pin');
    if (fields.visibility !== undefined && fields.visibility !== pin.visibility && !canChangeVisibility(viewer, itemFacts(pin))) {
      throw new OverworldError('forbidden', 'Only the person who added this pin or a DM can change who sees it.');
    }
    const sets: string[] = [];
    const params: unknown[] = [pinId];
    for (const column of PIN_EDITABLE) {
      if (fields[column] !== undefined) {
        params.push(fields[column]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    params.push(userId);
    sets.push(`updated_by_user_id = $${params.length}`, 'updated_at = now()');
    await client.query(`UPDATE overworld_pins SET ${sets.join(', ')} WHERE id = $1`, params);
  });
  notifyOverworldChanged(campaignId, mapId);
}

export async function movePin(userId: string, campaignId: string, mapId: string, pinId: string, to: Pt): Promise<void> {
  assertPoints(to);
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const pin = await loadPin(client, mapId, pinId);
    assertCanEdit(viewer, itemFacts(pin), 'pin');
    await client.query('UPDATE overworld_pins SET x = $2, y = $3, updated_by_user_id = $4, updated_at = now() WHERE id = $1', [
      pinId, to.x, to.y, userId
    ]);
  });
  notifyOverworldChanged(campaignId, mapId);
}

export async function deletePin(userId: string, campaignId: string, mapId: string, pinId: string): Promise<void> {
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const pin = await loadPin(client, mapId, pinId);
    assertCanEdit(viewer, itemFacts(pin), 'pin');
    await client.query('DELETE FROM overworld_pins WHERE id = $1', [pinId]);
  });
  notifyOverworldChanged(campaignId, mapId);
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const SAME_POINT = 1e-6;

// Defence in depth: the form parsers already check this, but the service is callable from elsewhere.
const inUnit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
function assertPoints(...points: Pt[]): void {
  for (const p of points) {
    if (!p || !inUnit(p.x) || !inUnit(p.y)) throw new OverworldError('invalid', 'A point is outside the map.');
  }
}
const samePoint = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < SAME_POINT && Math.abs(a.y - b.y) < SAME_POINT;

async function loadRoute(db: Db, mapId: string, routeId: string): Promise<OverworldRoute> {
  if (!isUuid(routeId)) throw new OverworldError('not_found', 'Not found.');
  const result = await db.query(`SELECT ${ROUTE_COLUMNS} FROM overworld_routes WHERE id = $1 AND map_id = $2 FOR UPDATE`, [routeId, mapId]);
  if (!result.rows[0]) throw new OverworldError('not_found', 'Not found.');
  return routeFromRow(result.rows[0]);
}

// Inserts one leg per consecutive pair of points, numbered from `startSeq`, in a single statement.
async function insertLegs(client: pg.PoolClient, routeId: string, points: Pt[], startSeq: number): Promise<void> {
  const legs = points.slice(0, -1);
  if (legs.length === 0) return;
  await client.query(
    `INSERT INTO overworld_route_legs (route_id, seq, x1, y1, x2, y2)
     SELECT $1, t.seq, t.x1, t.y1, t.x2, t.y2
     FROM unnest($2::int[], $3::float8[], $4::float8[], $5::float8[], $6::float8[]) AS t(seq, x1, y1, x2, y2)`,
    [
      routeId,
      legs.map((_, i) => startSeq + i),
      legs.map((p) => p.x),
      legs.map((p) => p.y),
      points.slice(1).map((p) => p.x),
      points.slice(1).map((p) => p.y)
    ]
  );
}

/** Saves a route: N points become N - 1 legs. Points come from parseRoutePoints. */
export async function createRoute(userId: string, campaignId: string, mapId: string, points: Pt[], fields: RouteFields): Promise<string> {
  if (points.length < 2 || points.length - 1 > MAX_LEGS_PER_ROUTE) throw new OverworldError('invalid', 'A route needs 1 to 200 legs.');
  assertPoints(...points);
  const routeId = await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    // Routes count as pin level: any writer may add one.
    if (!canCreate(viewer, 'pin')) throw new OverworldError('forbidden', 'You cannot add routes here.');
    const count = await client.query('SELECT count(*)::int AS n FROM overworld_routes WHERE map_id = $1', [mapId]);
    if (count.rows[0].n >= MAX_ROUTES_PER_MAP) throw new OverworldError('limit', `A map can have up to ${MAX_ROUTES_PER_MAP} routes.`);
    const inserted = await client.query(
      `INSERT INTO overworld_routes (map_id, label, colour, visibility, dm_locked, created_by_user_id, updated_by_user_id)
       VALUES ($1, COALESCE($2, ''), COALESCE($3, 'white'), COALESCE($4, 'everyone'), $5, $6, $6) RETURNING id`,
      [mapId, fields.label ?? null, fields.colour ?? null, fields.visibility ?? null, dmLockedOnCreate(viewer, 'pin'), userId]
    );
    const id = inserted.rows[0].id as string;
    await insertLegs(client, id, points, 0);
    return id;
  });
  notifyOverworldChanged(campaignId, mapId);
  return routeId;
}

/**
 * Continues a route from its current end. `points` starts at `expectedStart` (what the client thinks
 * the end is) and carries the new waypoints. If the real end has moved (a leg was deleted or someone
 * else continued it) this throws route_changed and nothing is saved.
 */
export async function appendRouteLegs(
  userId: string,
  campaignId: string,
  mapId: string,
  routeId: string,
  expectedStart: Pt,
  points: Pt[]
): Promise<void> {
  assertPoints(expectedStart, ...points);
  if (points.length < 2 || !samePoint(points[0], expectedStart)) throw new OverworldError('invalid', 'The new part of the route must start where it ends now.');
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const route = await loadRoute(client, mapId, routeId);
    assertCanEdit(viewer, itemFacts(route), 'route');
    const last = await client.query(
      'SELECT seq, x2, y2 FROM overworld_route_legs WHERE route_id = $1 ORDER BY seq DESC LIMIT 1',
      [routeId]
    );
    const end = last.rows[0];
    if (!end || !samePoint({ x: end.x2, y: end.y2 }, expectedStart)) {
      throw new OverworldError('route_changed', 'This route was changed by someone else - try again.');
    }
    const legCount = await client.query('SELECT count(*)::int AS n FROM overworld_route_legs WHERE route_id = $1', [routeId]);
    if (legCount.rows[0].n + (points.length - 1) > MAX_LEGS_PER_ROUTE) {
      throw new OverworldError('limit', `A route can have up to ${MAX_LEGS_PER_ROUTE} legs.`);
    }
    // The first new leg starts exactly at the stored end point (it is within 1e-6 of expectedStart).
    const fromEnd: Pt[] = [{ x: end.x2, y: end.y2 }, ...points.slice(1)];
    await insertLegs(client, routeId, fromEnd, (end.seq as number) + 1);
    await client.query('UPDATE overworld_routes SET updated_by_user_id = $2, updated_at = now() WHERE id = $1', [routeId, userId]);
  });
  notifyOverworldChanged(campaignId, mapId);
}

const ROUTE_EDITABLE = ['label', 'colour', 'visibility'] as const;

export async function updateRoute(userId: string, campaignId: string, mapId: string, routeId: string, fields: RouteFields): Promise<void> {
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const route = await loadRoute(client, mapId, routeId);
    assertCanEdit(viewer, itemFacts(route), 'route');
    if (fields.visibility !== undefined && fields.visibility !== route.visibility && !canChangeVisibility(viewer, itemFacts(route))) {
      throw new OverworldError('forbidden', 'Only the person who added this route or a DM can change who sees it.');
    }
    const sets: string[] = [];
    const params: unknown[] = [routeId];
    for (const column of ROUTE_EDITABLE) {
      if (fields[column] !== undefined) {
        params.push(fields[column]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    params.push(userId);
    sets.push(`updated_by_user_id = $${params.length}`, 'updated_at = now()');
    await client.query(`UPDATE overworld_routes SET ${sets.join(', ')} WHERE id = $1`, params);
  });
  notifyOverworldChanged(campaignId, mapId);
}

/** Deletes one leg. If it was the last one the whole route goes too. */
export async function deleteRouteLeg(
  userId: string,
  campaignId: string,
  mapId: string,
  routeId: string,
  legId: string
): Promise<{ routeDeleted: boolean }> {
  const result = await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const route = await loadRoute(client, mapId, routeId);
    assertCanEdit(viewer, itemFacts(route), 'route');
    if (!isUuid(legId)) throw new OverworldError('not_found', 'Not found.');
    const deleted = await client.query('DELETE FROM overworld_route_legs WHERE id = $1 AND route_id = $2', [legId, routeId]);
    if (!deleted.rowCount) throw new OverworldError('not_found', 'Not found.');
    const left = await client.query('SELECT count(*)::int AS n FROM overworld_route_legs WHERE route_id = $1', [routeId]);
    if (left.rows[0].n === 0) {
      await client.query('DELETE FROM overworld_routes WHERE id = $1', [routeId]);
      return { routeDeleted: true };
    }
    await client.query('UPDATE overworld_routes SET updated_by_user_id = $2, updated_at = now() WHERE id = $1', [routeId, userId]);
    return { routeDeleted: false };
  });
  notifyOverworldChanged(campaignId, mapId);
  return result;
}

export async function deleteRoute(userId: string, campaignId: string, mapId: string, routeId: string): Promise<void> {
  await withTransaction(async (client) => {
    const { viewer } = await gateMapWrite(client, userId, campaignId, mapId);
    const route = await loadRoute(client, mapId, routeId);
    assertCanEdit(viewer, itemFacts(route), 'route');
    await client.query('DELETE FROM overworld_routes WHERE id = $1', [routeId]);
  });
  notifyOverworldChanged(campaignId, mapId);
}

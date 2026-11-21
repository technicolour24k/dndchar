import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real overworld list route (load + form actions) with the service mocked out. The access
// rules are tested in rules.test.ts and the gated DB test; here we check the route forwards the
// signed-in user, checks DM rights and the declared size BEFORE reading an upload body, turns service
// errors into inline form errors, and only announces a grant (never an ungrant).
//
// Who may SEE an ungranted map (players cannot) is not tested here: it is decided by the service and
// the pure rules, and covered by rules.test.ts and overworldDb.integration.test.ts.

const svc = {
  listMapsForViewer: vi.fn(),
  assertCanManageMaps: vi.fn(),
  createMap: vi.fn(),
  replaceMapImage: vi.fn(),
  updateMap: vi.fn(),
  setMapGranted: vi.fn(),
  archiveMap: vi.fn()
};
vi.mock('$lib/server/services/overworld', () => svc);
vi.mock('$lib/server/db', () => ({ query: vi.fn(async () => ({ rows: [{ name: 'Test campaign' }] })), withTransaction: vi.fn() }));
const notifyMapGranted = vi.fn();
vi.mock('$lib/server/overworldNotify', () => ({ notifyMapGranted: (...a: unknown[]) => notifyMapGranted(...a), notifyOverworldChanged: vi.fn() }));
const validateUpload = vi.fn();
vi.mock('$lib/server/overworldUpload', () => ({ validateUpload: (...a: unknown[]) => validateUpload(...a) }));

const { OverworldError } = await import('$lib/server/overworldError');
const route = await import('../../routes/campaigns/[id]/overworld/+page.server');
const { MAX_UPLOAD_REQUEST_BYTES } = await import('$lib/server/overworldAction');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const MAP = '33333333-3333-4333-8333-333333333333';
const locals = { user: { id: ME, role: 'user', displayName: 'Me' } };
const params = { id: CAMPAIGN };

// Browsers always send content-length for a multipart upload, so the helper does too (1000 bytes)
// unless a test overrides it; pass { 'content-length': '' } to send none.
function request(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const formData = vi.fn(async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return form;
  });
  return { request: { formData, headers: new Headers(Object.entries({ 'content-length': '1000', ...headers }).filter(([, v]) => v !== '')) } as unknown as Request, formData };
}
const run = (action: any, req: Request) => action({ request: req, params, locals });

beforeEach(() => {
  vi.clearAllMocks();
  svc.assertCanManageMaps.mockResolvedValue(undefined);
  validateUpload.mockResolvedValue({ buffer: Buffer.alloc(1), ext: 'png', width: 10, height: 10 });
});

describe('load', () => {
  it('forwards the signed-in user and returns the list, hiding the warning from non-managers', async () => {
    svc.listMapsForViewer.mockResolvedValue({ viewer: { canManage: false }, maps: [] });
    const depends = vi.fn();
    const data: any = await route.load({ params, locals, depends } as any);
    expect(svc.listMapsForViewer).toHaveBeenCalledWith(ME, CAMPAIGN);
    expect(depends).toHaveBeenCalledWith('overworld:list');
    expect(data).toMatchObject({ campaignName: 'Test campaign', uploadsEphemeral: false });
  });
  it('404s when the service says the viewer cannot open the overworld (non-member, admin or not)', async () => {
    svc.listMapsForViewer.mockResolvedValue(null);
    await expect(route.load({ params, locals, depends: vi.fn() } as any)).rejects.toMatchObject({ status: 404 });
  });
});

describe('upload actions read the body only after the checks', () => {
  it('create: a non-DM is refused before formData() is touched', async () => {
    svc.assertCanManageMaps.mockRejectedValue(new OverworldError('forbidden', 'Only a DM can manage maps.'));
    const { request: req, formData } = request({ name: 'Faerun' });
    const result: any = await run(route.actions.create, req);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Only a DM can manage maps.');
    expect(formData).not.toHaveBeenCalled();
    expect(svc.createMap).not.toHaveBeenCalled();
  });
  it('create: a declared size over the cap is refused before formData() is touched', async () => {
    const { request: req, formData } = request({ name: 'Faerun' }, { 'content-length': String(MAX_UPLOAD_REQUEST_BYTES + 1) });
    const result: any = await run(route.actions.create, req);
    expect(result.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });
  it('create: a missing or non-numeric content-length is 411, before the body is read', async () => {
    for (const headers of [{ 'content-length': '' }, { 'content-length': 'abc' }]) {
      const { request: req, formData } = request({ name: 'Faerun' }, headers);
      const result: any = await run(route.actions.create, req);
      expect(result.status).toBe(411);
      expect(formData).not.toHaveBeenCalled();
    }
  });
  it('a non-member with an oversize request gets 404 (role check first), not 413', async () => {
    svc.assertCanManageMaps.mockRejectedValue(new OverworldError('not_found', 'Not found.'));
    for (const action of [route.actions.create, route.actions.replaceImage]) {
      const { request: req, formData } = request({ mapId: MAP }, { 'content-length': String(MAX_UPLOAD_REQUEST_BYTES + 1) });
      expect(((await run(action, req)) as any).status).toBe(404);
      expect(formData).not.toHaveBeenCalled();
    }
  });
  it('replaceImage: same early checks', async () => {
    const { request: req, formData } = request({ mapId: MAP }, { 'content-length': String(MAX_UPLOAD_REQUEST_BYTES + 1) });
    expect(((await run(route.actions.replaceImage, req)) as any).status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });
  it('create: forwards the user and the parsed fields', async () => {
    const { request: req } = request({ name: ' Faerun ', milesAcross: '1500' }, { 'content-length': '1000' });
    expect(await run(route.actions.create, req)).toEqual({ done: 'created' });
    expect(svc.createMap).toHaveBeenCalledWith(ME, CAMPAIGN, { name: 'Faerun', milesAcross: 1500 }, expect.objectContaining({ ext: 'png' }));
  });
  it('create: a bad name is an inline error and nothing is created', async () => {
    const { request: req } = request({ name: '   ' });
    const result: any = await run(route.actions.create, req);
    expect(result.status).toBe(400);
    expect(svc.createMap).not.toHaveBeenCalled();
  });
  it('replaceImage: forwards the map id from the form', async () => {
    const { request: req } = request({ mapId: MAP });
    expect(await run(route.actions.replaceImage, req)).toEqual({ done: 'replaced', mapId: MAP });
    expect(svc.replaceMapImage).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, expect.anything());
  });
});

describe('map actions', () => {
  it('grant announces the map at the table; ungrant sends nothing', async () => {
    svc.setMapGranted.mockResolvedValue({ mapName: 'Faerun', roomCode: 'ROOM1234' });
    expect(await run(route.actions.grant, request({ mapId: MAP }).request)).toEqual({ done: 'granted', mapId: MAP });
    expect(svc.setMapGranted).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, true);
    expect(notifyMapGranted).toHaveBeenCalledWith('ROOM1234', MAP, 'Faerun');

    notifyMapGranted.mockClear();
    expect(await run(route.actions.ungrant, request({ mapId: MAP }).request)).toEqual({ done: 'ungranted', mapId: MAP });
    expect(svc.setMapGranted).toHaveBeenLastCalledWith(ME, CAMPAIGN, MAP, false);
    expect(notifyMapGranted).not.toHaveBeenCalled();
  });
  it('a refused grant is an inline error and announces nothing', async () => {
    svc.setMapGranted.mockRejectedValue(new OverworldError('not_found', 'Not found.'));
    const result: any = await run(route.actions.grant, request({ mapId: MAP }).request);
    expect(result.status).toBe(404);
    expect(notifyMapGranted).not.toHaveBeenCalled();
  });
  it('updateMap parses name and scale; archive forwards the map id', async () => {
    expect(await run(route.actions.updateMap, request({ mapId: MAP, name: 'Renamed', milesAcross: '' }).request)).toEqual({ done: 'updated', mapId: MAP });
    expect(svc.updateMap).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, { name: 'Renamed', milesAcross: null });
    expect(await run(route.actions.archive, request({ mapId: MAP }).request)).toEqual({ done: 'archived', mapId: MAP });
    expect(svc.archiveMap).toHaveBeenCalledWith(ME, CAMPAIGN, MAP);
  });
  it('a missing map is a 404 inline error carrying the map id (updateMap, archive, replaceImage)', async () => {
    const missing = new OverworldError('not_found', 'Not found.');
    svc.updateMap.mockRejectedValue(missing);
    svc.archiveMap.mockRejectedValue(missing);
    svc.replaceMapImage.mockRejectedValue(missing);
    for (const [action, fields] of [
      [route.actions.updateMap, { mapId: MAP, name: 'x' }],
      [route.actions.archive, { mapId: MAP }],
      [route.actions.replaceImage, { mapId: MAP }]
    ] as const) {
      const result: any = await run(action, request({ ...fields }).request);
      expect(result.status).toBe(404);
      expect(result.data).toEqual({ error: 'Not found.', mapId: MAP });
    }
  });
  it('small forms: a declared body over 64 KB is refused before parsing; a malformed body is an inline error', async () => {
    const { request: big, formData } = request({ mapId: MAP }, { 'content-length': String(70 * 1024) });
    for (const action of [route.actions.updateMap, route.actions.grant, route.actions.ungrant, route.actions.archive]) {
      expect(((await run(action, big)) as any).status).toBe(413);
    }
    expect(formData).not.toHaveBeenCalled();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { formData: async () => { throw new TypeError('Could not parse content as FormData.'); }, headers: new Headers() } as unknown as Request;
    const result: any = await run(route.actions.archive, broken);
    expect(result.status).toBe(500);
    expect(result.data.error).toBe('Something went wrong, please try again.');
    spy.mockRestore();
  });
  it('an unexpected error becomes a generic message, not the raw text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.archiveMap.mockRejectedValue(new Error('connection to 10.0.0.5 refused'));
    const result: any = await run(route.actions.archive, request({ mapId: MAP }).request);
    expect(result.status).toBe(500);
    expect(result.data.error).toBe('Something went wrong, please try again.');
    spy.mockRestore();
  });
});

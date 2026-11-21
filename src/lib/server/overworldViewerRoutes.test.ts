import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real map viewer route (load + pin actions) with the service mocked out. Rights are decided
// by the service and the pure rules (rules.test.ts, overworldDb.integration.test.ts); here we check the
// route forwards the signed-in user and the route params (never anything posted), parses the pin
// fields, caps the body, and turns service errors into inline form errors.

const svc = {
  getMapView: vi.fn(),
  createPin: vi.fn(),
  updatePin: vi.fn(),
  movePin: vi.fn(),
  deletePin: vi.fn()
};
vi.mock('$lib/server/services/overworld', () => svc);

const { OverworldError } = await import('$lib/server/overworldError');
const route = await import('../../routes/campaigns/[id]/overworld/[mapId]/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const MAP = '33333333-3333-4333-8333-333333333333';
const PIN = '44444444-4444-4444-8444-444444444444';
const locals = { user: { id: ME } };
const params = { id: CAMPAIGN, mapId: MAP };

function request(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const formData = vi.fn(async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return form;
  });
  // A browser fetch with FormData always sends content-length, so the helper does too unless overridden ('' = none).
  const all = Object.entries({ 'content-length': '1000', ...headers }).filter(([, v]) => v !== '');
  return { request: { formData, headers: new Headers(all) } as unknown as Request, formData };
}
const run = (action: any, req: Request) => action({ request: req, params, locals });

beforeEach(() => vi.clearAllMocks());

describe('load', () => {
  it('forwards the user and the route params, and depends on overworld:map', async () => {
    svc.getMapView.mockResolvedValue({ map: {}, pins: [], routes: [], viewer: {} });
    const depends = vi.fn();
    const data: any = await route.load({ params, locals, depends } as any);
    expect(svc.getMapView).toHaveBeenCalledWith(ME, CAMPAIGN, MAP);
    expect(depends).toHaveBeenCalledWith('overworld:map');
    expect(data.campaignId).toBe(CAMPAIGN);
  });
  it('404s when the viewer cannot see the map (non-member, admin or not, or ungranted)', async () => {
    svc.getMapView.mockResolvedValue(null);
    await expect(route.load({ params, locals, depends: vi.fn() } as any)).rejects.toMatchObject({ status: 404 });
  });
});

describe('pin actions', () => {
  it('addPin parses the fields and forwards the user and params', async () => {
    svc.createPin.mockResolvedValue(PIN);
    const { request: req } = request({ x: '0.25', y: '0.75', kind: 'pin', label: ' Inn ', note: 'Good ale', colour: 'blue', icon: 'camp', visibility: 'private' });
    expect(await run(route.actions.addPin, req)).toEqual({ done: 'added', pinId: PIN });
    expect(svc.createPin).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, {
      x: 0.25, y: 0.75, kind: 'pin', label: 'Inn', note: 'Good ale', colour: 'blue', icon: 'camp', visibility: 'private'
    });
  });
  it('addPin: a bad position or colour is an inline 400 and nothing is created', async () => {
    for (const fields of <Record<string, string>[]>[{ x: '2', y: '0.5' }, { x: '0.5', y: '0.5', colour: 'pink' }, { x: '0x1', y: '0.5' }]) {
      const result: any = await run(route.actions.addPin, request(fields).request);
      expect(result.status).toBe(400);
    }
    expect(svc.createPin).not.toHaveBeenCalled();
  });
  it('addPin: a player asking for a party pin gets the service refusal inline', async () => {
    svc.createPin.mockRejectedValue(new OverworldError('forbidden', 'Only a DM can add a party pin.'));
    const result: any = await run(route.actions.addPin, request({ x: '0.5', y: '0.5', kind: 'party' }).request);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Only a DM can add a party pin.');
  });
  it('updatePin sends only the fields that were posted (never kind or position)', async () => {
    const { request: req } = request({ pinId: PIN, label: 'New', kind: 'party', x: '0.9', y: '0.9' });
    expect(await run(route.actions.updatePin, req)).toEqual({ done: 'updated' });
    expect(svc.updatePin).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, PIN, { label: 'New' });
  });
  it('movePin forwards the position; a missing one is refused', async () => {
    expect(await run(route.actions.movePin, request({ pinId: PIN, x: '0.4', y: '0.6' }).request)).toEqual({ done: 'moved' });
    expect(svc.movePin).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, PIN, { x: 0.4, y: 0.6 });
    expect(((await run(route.actions.movePin, request({ pinId: PIN, x: '0.4' }).request)) as any).status).toBe(400);
  });
  it('deletePin forwards the pin id; a service refusal is inline', async () => {
    expect(await run(route.actions.deletePin, request({ pinId: PIN }).request)).toEqual({ done: 'deleted' });
    expect(svc.deletePin).toHaveBeenCalledWith(ME, CAMPAIGN, MAP, PIN);
    svc.deletePin.mockRejectedValue(new OverworldError('forbidden', 'Only a DM can change this pin.'));
    const result: any = await run(route.actions.deletePin, request({ pinId: PIN }).request);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('Only a DM can change this pin.');
  });
  it('a missing content-length is 411 before the body is read', async () => {
    const { request: req, formData } = request({ pinId: PIN }, { 'content-length': '' });
    for (const action of [route.actions.addPin, route.actions.updatePin, route.actions.movePin, route.actions.deletePin]) {
      expect(((await run(action, req)) as any).status).toBe(411);
    }
    expect(formData).not.toHaveBeenCalled();
  });
  it('a declared body over 64 KB is refused before it is parsed', async () => {
    const { request: big, formData } = request({ pinId: PIN }, { 'content-length': String(70 * 1024) });
    for (const action of [route.actions.addPin, route.actions.updatePin, route.actions.movePin, route.actions.deletePin]) {
      expect(((await run(action, big)) as any).status).toBe(413);
    }
    expect(formData).not.toHaveBeenCalled();
  });
});

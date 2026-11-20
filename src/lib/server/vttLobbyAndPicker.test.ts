import { beforeEach, describe, expect, it, vi } from 'vitest';

// The /vtt lobby load and the campaign-aware character picker route, with the services mocked.
// The lobby must list real memberships only (an admin gets no extra campaigns), and the picker must
// hand the GM the whole active party but everyone else only their own characters.

const svc = { listCampaigns: vi.fn(), listCampaignPickerCharacters: vi.fn() };
const listCharacters = vi.fn();
const isRoomGm = vi.fn();
vi.mock('$lib/server/services/campaigns', () => svc);
vi.mock('$lib/server/services/characters', () => ({ listCharacters: (...a: unknown[]) => listCharacters(...a) }));
vi.mock('$lib/server/vttForage', () => ({ isRoomGm: (...a: unknown[]) => isRoomGm(...a) }));
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

const { createSession, sessions } = await import('../../../vtt/server/store.js');
const lobby = await import('../../routes/vtt/+page.server');
const picker = await import('../../routes/vtt/api/characters/+server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.resetAllMocks();
  sessions.delete('PICKER88');
  sessions.delete('QUICK6');
});

describe('/vtt lobby load', () => {
  const emptyList = { items: [], total: 0, page: 1, pageCount: 1, q: '', includeArchived: false };

  it('lists memberships only, even for an admin, and ignores ?archived=1', async () => {
    svc.listCampaigns.mockResolvedValue(emptyList);
    const url = new URL('http://x/vtt?q=dragons&page=2&archived=1');
    const result = await lobby.load({ locals: { user: { id: ME, role: 'admin', displayName: 'Ada' } }, url } as never);
    expect(svc.listCampaigns).toHaveBeenCalledWith(ME, { q: 'dragons', page: 2, includeArchived: false, membersOnly: true });
    expect(result.me).toEqual({ id: ME, name: 'Ada' });
  });

  it('does not redirect any more (Quick rooms are a link on the page)', async () => {
    svc.listCampaigns.mockResolvedValue(emptyList);
    const locals = { user: { id: ME, role: 'user', displayName: 'Me' } };
    await expect(lobby.load({ locals, url: new URL('http://x/vtt') } as never)).resolves.toBeTruthy();
  });
});

describe('GET /vtt/api/characters', () => {
  const call = (roomId?: string) =>
    picker.GET({ locals: { user: { id: ME } }, url: new URL(`http://x/vtt/api/characters${roomId ? `?roomId=${roomId}` : ''}`) } as never);

  it('no roomId: the caller own list, as before', async () => {
    listCharacters.mockResolvedValue([{ id: 'c1' }]);
    expect(await (await call()).json()).toEqual([{ id: 'c1' }]);
    expect(listCharacters).toHaveBeenCalledWith(ME);
    expect(svc.listCampaignPickerCharacters).not.toHaveBeenCalled();
  });

  it('a Quick room: the caller own list', async () => {
    sessions.set('QUICK6', createSession('QUICK6'));
    listCharacters.mockResolvedValue([{ id: 'c1' }]);
    await call('quick6');
    expect(listCharacters).toHaveBeenCalledWith(ME);
    expect(svc.listCampaignPickerCharacters).not.toHaveBeenCalled();
  });

  it('a room that is not live falls back to the own list', async () => {
    listCharacters.mockResolvedValue([]);
    await call('NOPE1234');
    expect(listCharacters).toHaveBeenCalledWith(ME);
  });

  it('the room GM asks for the whole party', async () => {
    sessions.set('PICKER88', createSession('PICKER88', { campaignId: CAMPAIGN }));
    isRoomGm.mockReturnValue(true);
    svc.listCampaignPickerCharacters.mockResolvedValue([{ id: 'c9', ownerUserId: 'u2' }]);
    expect(await (await call('PICKER88')).json()).toEqual([{ id: 'c9', ownerUserId: 'u2' }]);
    expect(svc.listCampaignPickerCharacters).toHaveBeenCalledWith(CAMPAIGN, ME, true);
    expect(listCharacters).not.toHaveBeenCalled();
  });

  it('a player, a viewer, or a DM who is not seated asks for their own only', async () => {
    sessions.set('PICKER88', createSession('PICKER88', { campaignId: CAMPAIGN }));
    isRoomGm.mockReturnValue(false);
    svc.listCampaignPickerCharacters.mockResolvedValue([]);
    await call('PICKER88');
    expect(svc.listCampaignPickerCharacters).toHaveBeenCalledWith(CAMPAIGN, ME, false);
  });
});

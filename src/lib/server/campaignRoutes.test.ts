import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real campaign route load functions and form actions with the services mocked out.
// The permission rules themselves are tested in access.test.ts and the gated DB test; here we
// check the routes forward the signed-in user (never a posted one), pass service errors back as
// inline form errors, redirect where the plan says, and never join on a GET.

const svc = {
  createCampaign: vi.fn(),
  joinCampaignByInviteCode: vi.fn(),
  listCampaigns: vi.fn(),
  findCampaignByInviteCode: vi.fn(),
  getCampaignPage: vi.fn(),
  regenerateInviteCode: vi.fn(),
  updateCampaignDetails: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  leaveCampaign: vi.fn(),
  archiveCampaign: vi.fn(),
  addCharacterToCampaign: vi.fn(),
  removeCharacterFromCampaign: vi.fn(),
  setCharacterPartyActive: vi.fn()
};
const getCampaignAccess = vi.fn();

vi.mock('$lib/server/services/campaigns', () => svc);
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...args: unknown[]) => getCampaignAccess(...args)
}));
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
// Voice eject is fire-and-forget; the routes only need to call it (voiceEject itself is tested in voiceEject.test.ts).
const ejectFromCampaignVoice = vi.fn(async () => {});
const ejectAllFromCampaignVoice = vi.fn(async () => {});
vi.mock('$lib/server/voice/voiceEject', () => ({
  ejectFromCampaignVoice: (...a: unknown[]) => (ejectFromCampaignVoice as any)(...a),
  ejectAllFromCampaignVoice: (...a: unknown[]) => (ejectAllFromCampaignVoice as any)(...a)
}));
// The campaign page's "Find tables: N active" line (DMs and admins only) reads the forage service.
const countActiveFindTables = vi.fn();
vi.mock('$lib/server/services/resource-pools', () => ({ listUnreviewedOverrides: async () => [], reviewOverride: vi.fn() }));
vi.mock('$lib/server/vttCostGate', () => ({ announceCostUndo: vi.fn() }));
// The campaign page's Decks section (decks unit 9): the deck service and the table announcements are mocked.
class MockDeckError extends Error { constructor(public code: string, message: string) { super(message); } }
const deckSvc = {
  DeckError: MockDeckError,
  listCampaignDecks: vi.fn(async () => []), listAvailableDecks: vi.fn(async () => []), listDrawsForCampaign: vi.fn(async () => []),
  listOpenDmTasks: vi.fn(async () => []), revertDraw: vi.fn(), setCampaignDeck: vi.fn(), setDrawTaskDone: vi.fn()
};
vi.mock('$lib/server/services/decks', () => deckSvc);
const announceDeck = vi.fn(async () => {});
const announceDmTasks = vi.fn(async () => {});
vi.mock('$lib/server/vttDeckAnnounce', () => ({ announceDeck: (...a: unknown[]) => (announceDeck as any)(...a), announceDmTasks: (...a: unknown[]) => (announceDmTasks as any)(...a) }));
vi.mock('$lib/server/services/forage', () => ({ countActiveFindTables: (...args: unknown[]) => countActiveFindTables(...args) }));

const { CampaignError } = await import('$lib/server/campaignError');
const list = await import('../../routes/campaigns/+page.server');
const join = await import('../../routes/campaigns/join/[code]/+page.server');
const detail = await import('../../routes/campaigns/[id]/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const user = { id: ME, role: 'user', displayName: 'Me' };
const ADMIN = '33333333-3333-4333-8333-333333333333';
const admin = { id: ADMIN, role: 'admin', displayName: 'Root' };

function formRequest(fields: Record<string, string>) {
  return { formData: async () => new URLSearchParams(fields) } as unknown as Request;
}
const call = (action: any, locals: any, fields: Record<string, string>, params: Record<string, string> = { id: CAMPAIGN }) =>
  action({ request: formRequest(fields), params, locals: { user: locals } });

// SvelteKit's redirect() throws; capture it.
async function redirected(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { status: error.status, location: error.location };
  }
  return null;
}

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks drops the default implementations, so the deck list calls get theirs back.
  deckSvc.listCampaignDecks.mockResolvedValue([]);
  deckSvc.listAvailableDecks.mockResolvedValue([]);
  deckSvc.listDrawsForCampaign.mockResolvedValue([]);
  deckSvc.listOpenDmTasks.mockResolvedValue([]);
});

describe('/campaigns load', () => {
  it('parses the search and page, and only lets admins ask for archived', async () => {
    svc.listCampaigns.mockResolvedValue({ items: [], total: 0, page: 1, pageCount: 1, q: '', includeArchived: false });
    await list.load({ locals: { user }, url: new URL('http://x/campaigns?q=%20dragon%20&page=3&archived=1') } as any);
    expect(svc.listCampaigns).toHaveBeenLastCalledWith(ME, { q: 'dragon', page: 3, includeArchived: false });

    await list.load({ locals: { user: admin }, url: new URL('http://x/campaigns?archived=1') } as any);
    expect(svc.listCampaigns).toHaveBeenLastCalledWith(ADMIN, { q: '', page: 1, includeArchived: true });
  });
});

describe('/campaigns actions', () => {
  it('create redirects to the new campaign, as the signed-in user', async () => {
    svc.createCampaign.mockResolvedValue(CAMPAIGN);
    const out = await redirected(call(list.actions.create, user, { name: 'Dragon Keep', description: 'd' }));
    expect(out).toEqual({ status: 303, location: `/campaigns/${CAMPAIGN}` });
    expect(svc.createCampaign).toHaveBeenCalledWith(ME, 'Dragon Keep', 'd');
  });

  it('create shows the service error inline and keeps what was typed', async () => {
    svc.createCampaign.mockRejectedValue(new CampaignError('Give the campaign a name.'));
    const out: any = await call(list.actions.create, user, { name: ' ' });
    expect(out.status).toBe(400);
    expect(out.data.error).toBe('Give the campaign a name.');
  });

  it('join by code redirects on success and fails on a bad code', async () => {
    svc.joinCampaignByInviteCode.mockResolvedValueOnce(CAMPAIGN);
    expect(await redirected(call(list.actions.join, user, { code: 'abcde-fghjk' }))).toEqual({ status: 303, location: `/campaigns/${CAMPAIGN}` });
    expect(svc.joinCampaignByInviteCode).toHaveBeenCalledWith(ME, 'abcde-fghjk');

    svc.joinCampaignByInviteCode.mockRejectedValueOnce(new CampaignError("That invite code wasn't found."));
    const bad: any = await call(list.actions.join, user, { code: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("That invite code wasn't found.");
  });
});

describe('/campaigns/join/[code]', () => {
  it('GET shows the confirm page and never joins', async () => {
    svc.findCampaignByInviteCode.mockResolvedValue({ id: CAMPAIGN, name: 'Dragon Keep', dmName: 'Sam' });
    getCampaignAccess.mockResolvedValue({ role: null });
    const data: any = await join.load({ params: { code: 'ABCDEFGHJK' }, locals: { user } } as any);
    expect(data.campaign.name).toBe('Dragon Keep');
    expect(svc.joinCampaignByInviteCode).not.toHaveBeenCalled();
  });

  it('GET sends an existing member straight to the campaign', async () => {
    svc.findCampaignByInviteCode.mockResolvedValue({ id: CAMPAIGN, name: 'Dragon Keep', dmName: 'Sam' });
    getCampaignAccess.mockResolvedValue({ role: 'player' });
    expect(await redirected(join.load({ params: { code: 'ABCDEFGHJK' }, locals: { user } } as any) as any)).toEqual({
      status: 303,
      location: `/campaigns/${CAMPAIGN}`
    });
  });

  it('GET with a dead code says so instead of erroring', async () => {
    svc.findCampaignByInviteCode.mockResolvedValue(null);
    const data: any = await join.load({ params: { code: 'OLDCODE' }, locals: { user } } as any);
    expect(data.campaign).toBeNull();
  });

  it('POST joins with the code from the URL, then redirects', async () => {
    svc.joinCampaignByInviteCode.mockResolvedValue(CAMPAIGN);
    const out = await redirected(join.actions.join({ params: { code: 'ABCDEFGHJK' }, locals: { user } } as any));
    expect(out).toEqual({ status: 303, location: `/campaigns/${CAMPAIGN}` });
    expect(svc.joinCampaignByInviteCode).toHaveBeenCalledWith(ME, 'ABCDEFGHJK');
  });

  it('POST with a dead code fails inline', async () => {
    svc.joinCampaignByInviteCode.mockRejectedValue(new CampaignError("That invite code wasn't found."));
    const out: any = await join.actions.join({ params: { code: 'OLD' }, locals: { user } } as any);
    expect(out.status).toBe(400);
  });
});

describe('/campaigns/[id] load', () => {
  const page = (role: 'dm' | 'co_dm' | 'player' | null, isAdmin = false) => ({
    campaign: { id: CAMPAIGN, isArchived: false, inviteCode: null },
    access: { role, isAdmin, archived: false, canView: true, canManage: role === 'dm' || role === 'co_dm' || isAdmin, isDm: role === 'dm' || role === 'co_dm', isPrimaryDm: role === 'dm' },
    members: [
      { userId: 'dm', displayName: 'Sam', role: 'dm' },
      { userId: ME, displayName: 'Me', role: 'player' }
    ],
    characters: [],
    myCharacters: []
  });

  it('404s when the user cannot view it', async () => {
    svc.getCampaignPage.mockResolvedValue(null);
    await expect(detail.load({ params: { id: CAMPAIGN }, locals: { user } } as any)).rejects.toMatchObject({ status: 404 });
  });

  it('a plain player gets no member controls and a Leave button', async () => {
    svc.getCampaignPage.mockResolvedValue(page('player'));
    const data: any = await detail.load({ params: { id: CAMPAIGN }, locals: { user } } as any);
    expect(Object.values(data.controls.dm).some(Boolean)).toBe(false);
    expect(data.leave).toMatchObject({ show: true, allowed: true });
    expect(data.viaAdmin).toBe(false);
    // The forage line is for DMs and admins: a player gets null and the count isn't even queried.
    expect(data.findTableCount).toBeNull();
    expect(countActiveFindTables).not.toHaveBeenCalled();
  });

  it('a DM sees how many active find tables the campaign has', async () => {
    svc.getCampaignPage.mockResolvedValue(page('co_dm'));
    countActiveFindTables.mockResolvedValue(2);
    const data: any = await detail.load({ params: { id: CAMPAIGN }, locals: { user } } as any);
    expect(data.findTableCount).toBe(2);
    expect(countActiveFindTables).toHaveBeenCalledWith(CAMPAIGN);
  });

  it('an admin who is not a DM sees the override banner and can make a primary DM', async () => {
    svc.getCampaignPage.mockResolvedValue(page(null, true));
    const data: any = await detail.load({ params: { id: CAMPAIGN }, locals: { user: admin } } as any);
    expect(data.viaAdmin).toBe(true);
    expect(data.controls[ME]).toMatchObject({ makePrimary: true, remove: true });
    expect(data.controls.dm.remove).toBe(true);
  });
});

describe('/campaigns/[id] actions', () => {
  it('forward the signed-in user and the URL campaign, never a posted identity', async () => {
    svc.setMemberRole.mockResolvedValue(undefined);
    await call(detail.actions.setRole, user, { userId: 'target', role: 'co_dm', actingUserId: 'someone-else' });
    expect(svc.setMemberRole).toHaveBeenCalledWith(ME, CAMPAIGN, 'target', 'co_dm');

    svc.removeMember.mockResolvedValue({ roomCode: 'R', targetUserId: 'target' });
    await call(detail.actions.removeMember, user, { userId: 'target' });
    expect(svc.removeMember).toHaveBeenCalledWith(ME, CAMPAIGN, 'target');

    svc.regenerateInviteCode.mockResolvedValue('X');
    await call(detail.actions.regenerate, user, {});
    expect(svc.regenerateInviteCode).toHaveBeenCalledWith(ME, CAMPAIGN);
  });

  it('a service refusal comes back as a 400 with the message (permissions are enforced by the service)', async () => {
    svc.setMemberRole.mockRejectedValue(new CampaignError('Only the DM can change roles.'));
    const out: any = await call(detail.actions.setRole, user, { userId: 'target', role: 'co_dm' });
    expect(out.status).toBe(400);
    expect(out.data.error).toBe('Only the DM can change roles.');

    svc.removeMember.mockRejectedValue(new CampaignError("A co-DM can't remove the DM."));
    const removed: any = await call(detail.actions.removeMember, user, { userId: 'dm' });
    expect(removed.data.error).toBe("A co-DM can't remove the DM.");
  });

  it('ejects from voice on removal, leave and archive, and never for a role change', async () => {
    svc.setMemberRole.mockResolvedValueOnce({ roomCode: 'R', demotedToPlayer: ['someone'] });
    await call(detail.actions.setRole, user, { userId: 'someone', role: 'player' });
    expect(ejectFromCampaignVoice).not.toHaveBeenCalled();

    svc.removeMember.mockResolvedValueOnce({ roomCode: 'R', targetUserId: 'target' });
    expect(await call(detail.actions.removeMember, user, { userId: 'target' })).toEqual({ saved: 'removed' });
    expect(ejectFromCampaignVoice).toHaveBeenCalledWith(CAMPAIGN, 'target');

    svc.leaveCampaign.mockResolvedValueOnce({ roomCode: 'R' });
    await redirected(call(detail.actions.leave, user, {}));
    expect(ejectFromCampaignVoice).toHaveBeenCalledWith(CAMPAIGN, ME);

    svc.archiveCampaign.mockResolvedValueOnce({ roomCode: 'R' });
    await redirected(call(detail.actions.archive, user, {}));
    expect(ejectAllFromCampaignVoice).toHaveBeenCalledWith(CAMPAIGN);
  });

  it('rejects an unknown role without calling the service', async () => {
    const out: any = await call(detail.actions.setRole, user, { userId: 'target', role: 'owner' });
    expect(out.status).toBe(400);
    expect(svc.setMemberRole).not.toHaveBeenCalled();
  });

  it('leave and archive redirect to the list; a refusal stays on the page', async () => {
    svc.leaveCampaign.mockResolvedValueOnce({ roomCode: 'R' });
    expect(await redirected(call(detail.actions.leave, user, {}))).toEqual({ status: 303, location: '/campaigns' });

    svc.leaveCampaign.mockRejectedValueOnce(new CampaignError('Hand over or archive the campaign instead.'));
    const refused: any = await call(detail.actions.leave, user, {});
    expect(refused.data.error).toBe('Hand over or archive the campaign instead.');

    svc.archiveCampaign.mockResolvedValueOnce({ roomCode: 'R' });
    expect(await redirected(call(detail.actions.archive, user, {}))).toEqual({ status: 303, location: '/campaigns' });
    svc.archiveCampaign.mockRejectedValueOnce(new CampaignError('Only the DM can archive this campaign.'));
    const nope: any = await call(detail.actions.archive, user, {});
    expect(nope.status).toBe(400);
  });

  it('character actions pass the posted character id with the signed-in user', async () => {
    await call(detail.actions.addCharacter, user, { characterId: 'c1' });
    expect(svc.addCharacterToCampaign).toHaveBeenCalledWith(ME, 'c1', CAMPAIGN);
    await call(detail.actions.removeCharacter, user, { characterId: 'c1' });
    expect(svc.removeCharacterFromCampaign).toHaveBeenCalledWith(ME, 'c1', CAMPAIGN);
    await call(detail.actions.setActive, user, { characterId: 'c1', active: '0' });
    expect(svc.setCharacterPartyActive).toHaveBeenLastCalledWith(ME, 'c1', false, CAMPAIGN);
    await call(detail.actions.setActive, user, { characterId: 'c1', active: '1' });
    expect(svc.setCharacterPartyActive).toHaveBeenLastCalledWith(ME, 'c1', true, CAMPAIGN);

    svc.addCharacterToCampaign.mockRejectedValue(new CampaignError('Join the campaign before adding a character.'));
    const out: any = await call(detail.actions.addCharacter, user, { characterId: 'c1' });
    expect(out.data.error).toBe('Join the campaign before adding a character.');
  });
});

describe('error handling', () => {
  it('shows CampaignError messages but never echoes an unexpected error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.regenerateInviteCode.mockRejectedValue(new Error('connection to db-host.internal:5432 refused'));
    const out: any = await call(detail.actions.regenerate, user, {});
    expect(out.status).toBe(500);
    expect(out.data.error).toBe('Something went wrong, please try again.');
    expect(JSON.stringify(out)).not.toContain('db-host');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('campaign page character actions are tied to the URL campaign', () => {
  it('pass params.id so the service can refuse a character from another campaign', async () => {
    svc.removeCharacterFromCampaign.mockRejectedValue(new CampaignError('That character is not in this campaign.'));
    const out: any = await call(detail.actions.removeCharacter, user, { characterId: 'c1' });
    expect(svc.removeCharacterFromCampaign).toHaveBeenCalledWith(ME, 'c1', CAMPAIGN);
    expect(out.status).toBe(400);
    expect(out.data.error).toBe('That character is not in this campaign.');

    svc.setCharacterPartyActive.mockRejectedValue(new CampaignError('That character is not in this campaign.'));
    const toggled: any = await call(detail.actions.setActive, user, { characterId: 'c1', active: '0' });
    expect(svc.setCharacterPartyActive).toHaveBeenCalledWith(ME, 'c1', false, CAMPAIGN);
    expect(toggled.status).toBe(400);
  });
});

describe('campaign page deck actions (decks unit 9)', () => {
  it('setDeck forwards the signed-in user and the URL campaign, never a posted one', async () => {
    deckSvc.setCampaignDeck.mockResolvedValue(undefined);
    const out: any = await call(detail.actions.setDeck, user, { deckId: 'd1', enabled: '1', userId: 'someone-else' });
    expect(deckSvc.setCampaignDeck).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, deckId: 'd1', enabled: true });
    expect(out).toEqual({ saved: 'decks' });
    await call(detail.actions.setDeck, user, { deckId: 'd1', enabled: '0' });
    expect(deckSvc.setCampaignDeck).toHaveBeenLastCalledWith({ userId: ME, campaignId: CAMPAIGN, deckId: 'd1', enabled: false });
  });
  it('a player is refused (403) with the service message', async () => {
    deckSvc.setCampaignDeck.mockRejectedValue(new MockDeckError('forbidden', 'Only the DM can change the campaign\'s decks.'));
    const out: any = await call(detail.actions.setDeck, user, { deckId: 'd1', enabled: '1' });
    expect(out.status).toBe(403);
    expect(out.data.error).toMatch(/Only the DM/);
  });
  it('undoDraw announces an undo, but not a cancelled Ace', async () => {
    deckSvc.revertDraw.mockResolvedValue({ id: 'x', status: 'reverted', revertNote: 'Restored.' });
    const out: any = await call(detail.actions.undoDraw, user, { drawId: 'x' });
    expect(deckSvc.revertDraw).toHaveBeenCalledWith({ userId: ME, drawId: 'x' });
    expect(announceDeck).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ saved: 'draws', note: 'Restored.' });
    deckSvc.revertDraw.mockResolvedValue({ id: 'y', status: 'cancelled', revertNote: '' });
    await call(detail.actions.undoDraw, user, { drawId: 'y' });
    expect(announceDeck).toHaveBeenCalledTimes(1);
  });
  it('load only asks for open tasks and disabled decks when the viewer can manage', async () => {
    svc.getCampaignPage.mockResolvedValue({
      campaign: { id: CAMPAIGN, isArchived: false }, members: [], characters: [], myCharacters: [], access: { canManage: false, role: 'player', isAdmin: false, isDm: false }
    });
    const out: any = await detail.load({ params: { id: CAMPAIGN }, locals: { user } } as any);
    expect(deckSvc.listCampaignDecks).toHaveBeenCalledWith(CAMPAIGN, { includeDisabled: false });
    expect(deckSvc.listOpenDmTasks).not.toHaveBeenCalled();
    expect(out.deckTasks).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  canLeave,
  canRemoveMember,
  canSetRole,
  decideCampaignAccess,
  decideCharacterAccess,
  getCharacterAccess,
  isDmRole,
  type AccessFacts,
  type CampaignRole
} from './access';

const base: AccessFacts = {
  userId: 'me', isAdmin: false, ownerUserId: 'owner', campaignId: 'camp', campaignArchived: false, memberRole: null
};
const facts = (extra: Partial<AccessFacts>): AccessFacts => ({ ...base, ...extra });

describe('decideCharacterAccess', () => {
  it('no campaign: owner gets everything, admin gets view/edit only, others nothing', () => {
    const owner = decideCharacterAccess(facts({ userId: 'owner', campaignId: null }));
    expect(owner).toMatchObject({ canView: true, canEdit: true, canAct: true, isOwner: true, viaAdmin: false });
    const admin = decideCharacterAccess(facts({ isAdmin: true, campaignId: null }));
    expect(admin).toMatchObject({ canView: true, canEdit: true, canAct: false, viaAdmin: true });
    const other = decideCharacterAccess(facts({ campaignId: null }));
    expect(other).toMatchObject({ canView: false, canEdit: false, canAct: false, viaAdmin: false });
  });

  it('campaign: players view only, DMs view/edit/act, non-members nothing', () => {
    expect(decideCharacterAccess(facts({ memberRole: 'player' }))).toMatchObject({ canView: true, canEdit: false, canAct: false, isCampaignDm: false });
    for (const memberRole of ['dm', 'co_dm'] as CampaignRole[]) {
      expect(decideCharacterAccess(facts({ memberRole }))).toMatchObject({ canView: true, canEdit: true, canAct: true, isCampaignDm: true });
    }
    expect(decideCharacterAccess(facts({ memberRole: null }))).toMatchObject({ canView: false, canEdit: false, canAct: false });
  });

  it('admin who is not a member: view/edit, no act, viaAdmin', () => {
    expect(decideCharacterAccess(facts({ isAdmin: true }))).toMatchObject({ canView: true, canEdit: true, canAct: false, isCampaignDm: false, viaAdmin: true });
  });

  it('admin who is also a plain member edits via admin; admin never counts as a DM', () => {
    const access = decideCharacterAccess(facts({ isAdmin: true, memberRole: 'player' }));
    expect(access.viaAdmin).toBe(true);
    expect(access.isCampaignDm).toBe(false);
    expect(access.canAct).toBe(false);
  });

  it('archived campaign: owner and admin keep access, members lose it', () => {
    expect(decideCharacterAccess(facts({ campaignArchived: true, userId: 'owner' }))).toMatchObject({ canView: true, canEdit: true, canAct: true });
    expect(decideCharacterAccess(facts({ campaignArchived: true, isAdmin: true }))).toMatchObject({ canView: true, canEdit: true });
    for (const memberRole of ['player', 'co_dm', 'dm'] as CampaignRole[]) {
      expect(decideCharacterAccess(facts({ campaignArchived: true, memberRole }))).toMatchObject({ canView: false, canEdit: false, canAct: false, isCampaignDm: false });
    }
  });
});

describe('decideCampaignAccess', () => {
  it('admin can manage but is not a DM', () => {
    expect(decideCampaignAccess({ isAdmin: true, memberRole: null, archived: false })).toEqual({ canView: true, canManage: true, isDm: false, isPrimaryDm: false });
  });
  it('co-DM can manage but is not the primary; primary is both', () => {
    expect(decideCampaignAccess({ isAdmin: false, memberRole: 'co_dm', archived: false })).toEqual({ canView: true, canManage: true, isDm: true, isPrimaryDm: false });
    expect(decideCampaignAccess({ isAdmin: false, memberRole: 'dm', archived: false })).toMatchObject({ isDm: true, isPrimaryDm: true });
  });
  it('players view but do not manage; non-members see nothing', () => {
    expect(decideCampaignAccess({ isAdmin: false, memberRole: 'player', archived: false })).toMatchObject({ canView: true, canManage: false, isDm: false });
    expect(decideCampaignAccess({ isAdmin: false, memberRole: null, archived: false })).toMatchObject({ canView: false, canManage: false });
  });
  it('archived: members lose view and manage, admin keeps both', () => {
    expect(decideCampaignAccess({ isAdmin: false, memberRole: 'dm', archived: true })).toMatchObject({ canView: false, canManage: false });
    expect(decideCampaignAccess({ isAdmin: true, memberRole: null, archived: true })).toMatchObject({ canView: true, canManage: true });
  });
  it('isDmRole', () => {
    expect(isDmRole('dm')).toBe(true);
    expect(isDmRole('co_dm')).toBe(true);
    expect(isDmRole('player')).toBe(false);
    expect(isDmRole(null)).toBe(false);
  });
});

const primary = { userId: 'p', role: 'dm' as const, isAdmin: false };
const coDm = { userId: 'c', role: 'co_dm' as const, isAdmin: false };
const admin = { userId: 'a', role: null, isAdmin: true };
const player1 = { userId: 'p1', role: 'player' as const };
const player2 = { userId: 'p2', role: 'player' as const };

describe('canSetRole', () => {
  it('primary promotes a player to co-DM only when the slot is free', () => {
    expect(canSetRole(primary, player1, 'co_dm', ['dm', 'player'])).toEqual({ ok: true });
    expect(canSetRole(primary, player2, 'co_dm', ['dm', 'co_dm', 'player', 'player'])).toMatchObject({ ok: false, reason: 'This campaign already has a co-DM.' });
  });
  it('primary can demote the co-DM', () => {
    expect(canSetRole(primary, { userId: 'c', role: 'co_dm' }, 'player', ['dm', 'co_dm'])).toEqual({ ok: true });
  });
  it('primary can swap with the existing co-DM, and only with them', () => {
    expect(canSetRole(primary, { userId: 'c', role: 'co_dm' }, 'dm', ['dm', 'co_dm', 'player'])).toEqual({ ok: true, demoteOldPrimaryTo: 'co_dm' });
    expect(canSetRole(primary, player1, 'dm', ['dm', 'co_dm', 'player']).ok).toBe(false);
  });
  it('co-DM cannot take the primary role for themselves', () => {
    expect(canSetRole(coDm, { userId: 'c', role: 'co_dm' }, 'dm', ['dm', 'co_dm']).ok).toBe(false);
  });
  it('primary cannot hand the role to a plain player or change their own', () => {
    expect(canSetRole(primary, player1, 'dm', ['dm', 'player']).ok).toBe(false);
    expect(canSetRole(primary, { userId: 'p', role: 'dm' }, 'player', ['dm']).ok).toBe(false);
  });
  it('co-DM cannot promote, demote or touch the primary', () => {
    expect(canSetRole(coDm, player1, 'co_dm', ['dm', 'co_dm', 'player']).ok).toBe(false);
    expect(canSetRole(coDm, { userId: 'c', role: 'co_dm' }, 'player', ['dm', 'co_dm']).ok).toBe(false);
    expect(canSetRole(coDm, { userId: 'p', role: 'dm' }, 'player', ['dm', 'co_dm']).ok).toBe(false);
  });
  it('players and non-members cannot change roles', () => {
    expect(canSetRole({ userId: 'p1', role: 'player', isAdmin: false }, player2, 'co_dm', ['dm', 'player']).ok).toBe(false);
    expect(canSetRole({ userId: 'x', role: null, isAdmin: false }, player2, 'co_dm', ['dm', 'player']).ok).toBe(false);
  });
  it('changing to the role they already have is refused', () => {
    expect(canSetRole(primary, player1, 'player', ['dm', 'player']).ok).toBe(false);
  });
  it('admin make-primary: old primary becomes co-DM when the slot is free', () => {
    expect(canSetRole(admin, player1, 'dm', ['dm', 'player'])).toEqual({ ok: true, demoteOldPrimaryTo: 'co_dm' });
  });
  it('admin make-primary: old primary becomes a player when the co-DM slot is full', () => {
    expect(canSetRole(admin, player1, 'dm', ['dm', 'co_dm', 'player'])).toEqual({ ok: true, demoteOldPrimaryTo: 'player' });
  });
  it('admin make-primary on the co-DM: old primary takes the slot the co-DM is leaving', () => {
    expect(canSetRole(admin, { userId: 'c', role: 'co_dm' }, 'dm', ['dm', 'co_dm'])).toEqual({ ok: true, demoteOldPrimaryTo: 'co_dm' });
  });
  it('admin make-primary with no primary needs no demotion', () => {
    expect(canSetRole(admin, player1, 'dm', ['player'])).toEqual({ ok: true });
  });
  it('admin still respects the single co-DM slot and will not strand a campaign without a primary', () => {
    expect(canSetRole(admin, player1, 'co_dm', ['dm', 'co_dm', 'player']).ok).toBe(false);
    expect(canSetRole(admin, { userId: 'p', role: 'dm' }, 'player', ['dm', 'player']).ok).toBe(false);
  });
});

describe('canRemoveMember', () => {
  it('co-DM cannot remove the primary but can remove players', () => {
    expect(canRemoveMember(coDm, { userId: 'p', role: 'dm' }, ['dm', 'co_dm']).ok).toBe(false);
    expect(canRemoveMember(coDm, player1, ['dm', 'co_dm', 'player'])).toEqual({ ok: true });
  });
  it('primary can remove the co-DM and players', () => {
    expect(canRemoveMember(primary, { userId: 'c', role: 'co_dm' }, ['dm', 'co_dm'])).toEqual({ ok: true });
    expect(canRemoveMember(primary, player1, ['dm', 'player'])).toEqual({ ok: true });
  });
  it('nobody removes themselves', () => {
    expect(canRemoveMember(primary, { userId: 'p', role: 'dm' }, ['dm']).ok).toBe(false);
    expect(canRemoveMember(admin, { userId: 'a', role: 'player' }, ['player']).ok).toBe(false);
  });
  it('players cannot remove anyone', () => {
    expect(canRemoveMember({ userId: 'p1', role: 'player', isAdmin: false }, player2, ['dm', 'player', 'player']).ok).toBe(false);
  });
  it('admin removing the primary with a co-DM present promotes the co-DM', () => {
    expect(canRemoveMember(admin, { userId: 'p', role: 'dm' }, ['dm', 'co_dm'])).toEqual({ ok: true, promoteCoDm: true });
    expect(canRemoveMember(admin, { userId: 'p', role: 'dm' }, ['dm'])).toEqual({ ok: true });
  });
});

describe('canLeave', () => {
  it('players and co-DMs can always leave', () => {
    expect(canLeave({ userId: 'p1', role: 'player' }, ['dm', 'player'])).toEqual({ ok: true });
    expect(canLeave({ userId: 'c', role: 'co_dm' }, ['dm', 'co_dm'])).toEqual({ ok: true });
  });
  it('primary with a co-DM leaves and the co-DM is promoted', () => {
    expect(canLeave({ userId: 'p', role: 'dm' }, ['dm', 'co_dm'])).toEqual({ ok: true, promoteCoDm: true });
  });
  it('the only DM cannot leave a live campaign (admin or not, the rule has no admin flag)', () => {
    expect(canLeave({ userId: 'p', role: 'dm' }, ['dm', 'player'])).toEqual({ ok: false, reason: 'Hand over or archive the campaign instead.' });
  });
  it('anyone, including the only DM, can leave an archived campaign', () => {
    expect(canLeave({ userId: 'p', role: 'dm' }, ['dm', 'player'], true)).toEqual({ ok: true });
    expect(canLeave({ userId: 'p', role: 'dm' }, ['dm', 'co_dm'], true)).toEqual({ ok: true });
  });
});

describe('getCharacterAccess', () => {
  it('treats a malformed id as not found without querying', async () => {
    const db = { query: async () => { throw new Error('should not query'); } };
    expect(await getCharacterAccess(db, 'not-a-uuid', 'also-bad')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { leaveState, memberControls } from './campaignControls';

const members = [
  { userId: 'dm', role: 'dm' as const },
  { userId: 'co', role: 'co_dm' as const },
  { userId: 'p1', role: 'player' as const },
  { userId: 'p2', role: 'player' as const }
];
const as = (userId: string, role: 'dm' | 'co_dm' | 'player' | null, isAdmin = false) => ({ userId, role, isAdmin });
const anyTrue = (c: object) => Object.values(c).some((v) => v === true);

describe('memberControls', () => {
  it('primary DM: promote only while the co-DM slot is free, swap with the co-DM, remove others', () => {
    const c = memberControls(as('dm', 'dm'), members, false);
    expect(c.co).toMatchObject({ makePlayer: true, makePrimary: true, remove: true, demoteOldPrimaryTo: 'co_dm', makeCoDm: false });
    expect(c.p1).toMatchObject({ makeCoDm: false, makePrimary: false, remove: true });
    expect(anyTrue(c.dm)).toBe(false);

    const free = memberControls(as('dm', 'dm'), members.filter((m) => m.userId !== 'co'), false);
    expect(free.p1.makeCoDm).toBe(true);
  });

  it('co-DM: can only remove players', () => {
    const c = memberControls(as('co', 'co_dm'), members, false);
    expect(c.p1).toMatchObject({ remove: true, makeCoDm: false, makePrimary: false });
    expect(c.dm.remove).toBe(false);
  });

  it('player sees nothing', () => {
    const c = memberControls(as('p1', 'player'), members, false);
    for (const key of ['dm', 'co', 'p2']) expect(anyTrue(c[key])).toBe(false);
  });

  it('admin (not a member): can make a player primary, old primary becomes player while the co-DM slot is taken', () => {
    const c = memberControls(as('admin', null, true), members, false);
    expect(c.p1).toMatchObject({ makePrimary: true, remove: true, demoteOldPrimaryTo: 'player' });
    expect(c.dm.remove).toBe(true);
  });

  it('admin who joined as a player can make themselves DM of a campaign with no DM, but gets no other self controls', () => {
    const noDm = [{ userId: 'admin', role: 'player' as const }, { userId: 'p1', role: 'player' as const }];
    const c = memberControls(as('admin', 'player', true), noDm, false);
    expect(c.admin).toMatchObject({ makePrimary: true, remove: false, makeCoDm: false, makePlayer: false });
    // A non-admin never gets controls on themselves.
    expect(anyTrue(memberControls(as('p1', 'player'), noDm, false).p1)).toBe(false);
    // Nor does an admin on an archived campaign.
    expect(anyTrue(memberControls(as('admin', 'player', true), noDm, true).admin)).toBe(false);
  });

  it('nothing is offered on an archived campaign or on yourself', () => {
    expect(anyTrue(memberControls(as('dm', 'dm'), members, true).p1)).toBe(false);
    expect(memberControls(as('dm', 'dm'), members, false).dm.remove).toBe(false);
  });
});

describe('leaveState', () => {
  it('hidden for non-members', () => {
    expect(leaveState(as('admin', null, true), members, false).show).toBe(false);
  });
  it('primary DM with a co-DM hands over', () => {
    expect(leaveState(as('dm', 'dm'), members, false)).toMatchObject({ show: true, allowed: true, coDmInherits: true });
  });
  it('lone primary DM is blocked with a reason', () => {
    const solo = [members[0], members[2]];
    const s = leaveState(as('dm', 'dm'), solo, false);
    expect(s.allowed).toBe(false);
    expect(s.reason).toMatch(/Hand over or archive/);
  });
  it('players and archived campaigns are always free to leave', () => {
    expect(leaveState(as('p1', 'player'), members, false).allowed).toBe(true);
    expect(leaveState(as('dm', 'dm'), [members[0]], true).allowed).toBe(true);
  });
});

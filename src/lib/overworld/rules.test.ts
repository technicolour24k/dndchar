import { describe, expect, it } from 'vitest';
import {
  canChangeVisibility,
  canCreate,
  canEditItem,
  canManageMaps,
  canOpenOverworld,
  canSeeItem,
  canSeeMap,
  dmLockedOnCreate,
  type ItemFacts,
  type OverworldViewer
} from './rules';

// The site admin flag is not part of the viewer at all (Rev 2, least privilege): an admin is
// whatever their campaign role says, so a "non-member" here covers an admin who is not in the campaign.
const camp = (extra: Partial<OverworldViewer>): OverworldViewer => ({
  userId: 'me', role: null, campaignArchived: false, ...extra
});

// Viewers. 'creator' is the player who made the player items.
const viewers = {
  primaryDm: camp({ userId: 'dm1', role: 'dm' }),
  coDm: camp({ userId: 'dm2', role: 'co_dm' }),
  creator: camp({ userId: 'pc', role: 'player' }),
  otherPlayer: camp({ userId: 'pc2', role: 'player' }),
  nonMember: camp({ userId: 'out', role: null }),
  archivedPlayer: camp({ userId: 'pc', role: 'player', campaignArchived: true }),
  archivedDm: camp({ userId: 'dm1', role: 'dm', campaignArchived: true })
};

// Items. DM items are created by 'dm1' and locked; player items by 'pc'.
const items: Record<string, ItemFacts> = {
  playerPublic: { visibility: 'everyone', dmLocked: false, createdByUserId: 'pc' },
  playerPrivate: { visibility: 'private', dmLocked: false, createdByUserId: 'pc' },
  dmPublic: { visibility: 'everyone', dmLocked: true, createdByUserId: 'dm1' },
  dmPrivate: { visibility: 'private', dmLocked: true, createdByUserId: 'dm1' },
  party: { kind: 'party', visibility: 'everyone', dmLocked: true, createdByUserId: 'dm1' }
};

type Row = { see: boolean; edit: boolean; vis: boolean };
const no: Row = { see: false, edit: false, vis: false };
const yes: Row = { see: true, edit: true, vis: true };
const seeOnly: Row = { see: true, edit: false, vis: false };

// Expected [see, edit, change visibility] for every viewer x item.
const expected: Record<keyof typeof viewers, Record<string, Row>> = {
  primaryDm: { playerPublic: yes, playerPrivate: yes, dmPublic: yes, dmPrivate: yes, party: yes },
  coDm: { playerPublic: yes, playerPrivate: yes, dmPublic: yes, dmPrivate: yes, party: yes },
  creator: { playerPublic: yes, playerPrivate: yes, dmPublic: seeOnly, dmPrivate: no, party: seeOnly },
  // Edits another player's public item (anyone may); cannot change its visibility.
  otherPlayer: {
    playerPublic: { see: true, edit: true, vis: false },
    playerPrivate: no,
    dmPublic: seeOnly,
    dmPrivate: no,
    party: seeOnly
  },
  // A non-member sees public items by the pure item rule but cannot write; map access is what stops them.
  nonMember: { playerPublic: seeOnly, playerPrivate: no, dmPublic: seeOnly, dmPrivate: no, party: seeOnly },
  // Archived campaign: sees by the pure item rule, never writes (DMs included).
  archivedPlayer: { playerPublic: seeOnly, playerPrivate: seeOnly, dmPublic: seeOnly, dmPrivate: no, party: seeOnly },
  archivedDm: { playerPublic: seeOnly, playerPrivate: seeOnly, dmPublic: seeOnly, dmPrivate: seeOnly, party: seeOnly }
};

describe('item matrix: see / edit / change visibility', () => {
  for (const [vName, v] of Object.entries(viewers)) {
    for (const [iName, item] of Object.entries(items)) {
      const want = expected[vName as keyof typeof viewers][iName];
      it(`${vName} x ${iName}`, () => {
        expect(canSeeItem(v, item)).toBe(want.see);
        expect(canEditItem(v, item)).toBe(want.edit);
        expect(canChangeVisibility(v, item)).toBe(want.vis);
      });
    }
  }
});

describe('named rules from the plan', () => {
  it("other player can't see a player-private pin", () => {
    expect(canSeeItem(viewers.otherPlayer, items.playerPrivate)).toBe(false);
  });
  it("co-DM sees the DM's private pin", () => {
    expect(canSeeItem(viewers.coDm, items.dmPrivate)).toBe(true);
  });
  it("DMs see a player's private pin (creator and DMs only)", () => {
    expect(canSeeItem(viewers.primaryDm, items.playerPrivate)).toBe(true);
    expect(canSeeItem(viewers.coDm, items.playerPrivate)).toBe(true);
  });
  it("player can delete (edit) another player's public pin", () => {
    expect(canEditItem(viewers.otherPlayer, items.playerPublic)).toBe(true);
  });
  it('a player cannot touch a DM-locked pin even if they created it', () => {
    const forged: ItemFacts = { visibility: 'everyone', dmLocked: true, createdByUserId: 'pc' };
    expect(canEditItem(viewers.creator, forged)).toBe(false);
  });
});

describe('creating', () => {
  it('any writer may create a pin, only a DM a party pin', () => {
    expect(canCreate(viewers.creator, 'pin')).toBe(true);
    expect(canCreate(viewers.creator, 'party')).toBe(false);
    expect(canCreate(viewers.primaryDm, 'party')).toBe(true);
    expect(canCreate(viewers.coDm, 'party')).toBe(true);
  });
  it('non-members and archived-campaign members (DMs included) cannot create', () => {
    expect(canCreate(viewers.nonMember, 'pin')).toBe(false);
    expect(canCreate(viewers.nonMember, 'party')).toBe(false);
    expect(canCreate(viewers.archivedPlayer, 'pin')).toBe(false);
    expect(canCreate(viewers.archivedDm, 'pin')).toBe(false);
    expect(canCreate(viewers.archivedDm, 'party')).toBe(false);
  });
  it('dmLockedOnCreate: DMs and party pins lock; players do not', () => {
    expect(dmLockedOnCreate(viewers.primaryDm, 'pin')).toBe(true);
    expect(dmLockedOnCreate(viewers.coDm, 'pin')).toBe(true);
    expect(dmLockedOnCreate(viewers.creator, 'pin')).toBe(false);
    expect(dmLockedOnCreate(viewers.creator, 'party')).toBe(true);
  });
});

describe('maps: granted / ungranted / archived x see / manage', () => {
  const granted = { grantedAt: '2026-01-01', archivedAt: null };
  const ungranted = { grantedAt: null, archivedAt: null };
  const archived = { grantedAt: '2026-01-01', archivedAt: '2026-02-01' };
  const archivedUngranted = { grantedAt: null, archivedAt: '2026-02-01' };

  it('granted map: members see it, non-members and archived-campaign members do not', () => {
    for (const k of ['primaryDm', 'coDm', 'creator', 'otherPlayer'] as const) {
      expect(canSeeMap(viewers[k], granted)).toBe(true);
    }
    expect(canSeeMap(viewers.nonMember, granted)).toBe(false);
    expect(canSeeMap(viewers.archivedPlayer, granted)).toBe(false);
    expect(canSeeMap(viewers.archivedDm, granted)).toBe(false);
  });
  it('ungranted map: DMs only', () => {
    expect(canSeeMap(viewers.primaryDm, ungranted)).toBe(true);
    expect(canSeeMap(viewers.coDm, ungranted)).toBe(true);
    expect(canSeeMap(viewers.creator, ungranted)).toBe(false);
    expect(canSeeMap(viewers.otherPlayer, ungranted)).toBe(false);
    expect(canSeeMap(viewers.nonMember, ungranted)).toBe(false);
  });
  it('archived map: nobody sees it, whatever the role', () => {
    for (const v of Object.values(viewers)) {
      expect(canSeeMap(v, archived)).toBe(false);
      expect(canSeeMap(v, archivedUngranted)).toBe(false);
    }
  });
  it('manage: DMs only, never players or non-members, never in an archived campaign', () => {
    expect(canManageMaps(viewers.primaryDm)).toBe(true);
    expect(canManageMaps(viewers.coDm)).toBe(true);
    expect(canManageMaps(viewers.creator)).toBe(false);
    expect(canManageMaps(viewers.otherPlayer)).toBe(false);
    expect(canManageMaps(viewers.nonMember)).toBe(false);
    expect(canManageMaps(viewers.archivedDm)).toBe(false);
    expect(canManageMaps(viewers.archivedPlayer)).toBe(false);
  });
  it('open: members of a live campaign only', () => {
    expect(canOpenOverworld(viewers.creator)).toBe(true);
    expect(canOpenOverworld(viewers.primaryDm)).toBe(true);
    expect(canOpenOverworld(viewers.nonMember)).toBe(false);
    expect(canOpenOverworld(viewers.archivedPlayer)).toBe(false);
    expect(canOpenOverworld(viewers.archivedDm)).toBe(false);
  });
});

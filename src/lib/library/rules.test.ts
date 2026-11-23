import { describe, expect, it } from 'vitest';
import {
  canAuthorMechanics, canReference, catalogueSourceLabel, describeFork, enabledLibraryOwners, forageSourceLabel, forkContentKey,
  isVisibleForNewUse, planFork, remapRulesKeys, splitLibraryFields, ForkPlanError, MEMBER_LIBRARY_DEFAULT_ENABLED,
  type EntryFacts, type ForkEntry, type ForkInput, type VisibleScope
} from './rules';
import type { ContentType } from '$lib/types/content';

const DM = 'user-dm';
const BOB = 'user-bob';
const OUT = 'user-outsider';
const C1 = 'camp-1';
const C2 = 'camp-2';

const entry = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  scope: 'global', ownerUserId: null, campaignId: null, hiddenFromPlayers: false, isArchived: false, type: 'item', ...over
});
const scopeOf = (over: Partial<VisibleScope> = {}): VisibleScope => ({
  campaignId: C1, ownerIds: [], hiddenOkOwnerIds: [], hiddenOkCampaign: false, ...over
});

describe('enabledLibraryOwners', () => {
  it('is off by default', () => {
    expect(MEMBER_LIBRARY_DEFAULT_ENABLED).toBe(false);
    expect(enabledLibraryOwners([DM, BOB], [])).toEqual([]);
  });
  it('turns on members with a true row only', () => {
    const settings = [{ ownerUserId: BOB, isEnabled: true }, { ownerUserId: DM, isEnabled: false }];
    expect(enabledLibraryOwners([DM, BOB], settings)).toEqual([BOB]);
  });
  it('ignores a row for someone who is not a member', () => {
    expect(enabledLibraryOwners([DM], [{ ownerUserId: OUT, isEnabled: true }])).toEqual([]);
  });
});

describe('isVisibleForNewUse', () => {
  it('always offers live global entries', () => {
    expect(isVisibleForNewUse(entry(), scopeOf())).toBe(true);
  });
  it('never offers archived entries', () => {
    expect(isVisibleForNewUse(entry({ isArchived: true }), scopeOf())).toBe(false);
    expect(isVisibleForNewUse(entry({ scope: 'personal', ownerUserId: BOB, isArchived: true }), scopeOf({ ownerIds: [BOB] }))).toBe(false);
  });
  it('offers your own library on your own pages', () => {
    const own = entry({ scope: 'personal', ownerUserId: BOB });
    expect(isVisibleForNewUse(own, scopeOf({ campaignId: null, ownerIds: [BOB] }))).toBe(true);
  });
  it('offers a member library only when it is in the enabled set (off, or no row, is out)', () => {
    const theirs = entry({ scope: 'personal', ownerUserId: BOB });
    expect(isVisibleForNewUse(theirs, scopeOf({ ownerIds: [BOB] }))).toBe(true); // on
    expect(isVisibleForNewUse(theirs, scopeOf({ ownerIds: [] }))).toBe(false); // off, or no row
  });
  it('never offers a non-member library', () => {
    const outsiders = entry({ scope: 'personal', ownerUserId: OUT });
    expect(isVisibleForNewUse(outsiders, scopeOf({ ownerIds: [BOB, DM] }))).toBe(false);
  });
  it('hides "hidden from players" entries from players but not from the owner, DM or admin', () => {
    const hidden = entry({ scope: 'personal', ownerUserId: BOB, hiddenFromPlayers: true });
    expect(isVisibleForNewUse(hidden, scopeOf({ ownerIds: [BOB] }))).toBe(false); // a player
    expect(isVisibleForNewUse(hidden, scopeOf({ ownerIds: [BOB], hiddenOkOwnerIds: [BOB] }))).toBe(true); // the owner
    expect(isVisibleForNewUse(hidden, scopeOf({ ownerIds: [BOB], hiddenOkOwnerIds: [BOB] }))).toBe(true); // DM or admin get every owner
  });
  it('offers a campaign entry to that campaign only', () => {
    const copy = entry({ scope: 'campaign', campaignId: C1 });
    expect(isVisibleForNewUse(copy, scopeOf({ campaignId: C1 }))).toBe(true);
    expect(isVisibleForNewUse(copy, scopeOf({ campaignId: C2 }))).toBe(false);
    expect(isVisibleForNewUse(copy, scopeOf({ campaignId: null }))).toBe(false);
  });
  it('hides a hidden campaign entry from players', () => {
    const copy = entry({ scope: 'campaign', campaignId: C1, hiddenFromPlayers: true });
    expect(isVisibleForNewUse(copy, scopeOf())).toBe(false);
    expect(isVisibleForNewUse(copy, scopeOf({ hiddenOkCampaign: true }))).toBe(true);
  });
});

describe('canReference', () => {
  const global = { scope: 'global' as const, ownerUserId: null, campaignId: null };
  const personal = (owner: string) => ({ scope: 'personal' as const, ownerUserId: owner, campaignId: null });
  const campaign = (id: string) => ({ scope: 'campaign' as const, ownerUserId: null, campaignId: id });

  it('keeps a global entry from pointing at a personal one', () => {
    expect(canReference(global, entry({ scope: 'personal', ownerUserId: BOB }))).toBe(false);
    expect(canReference(global, entry())).toBe(true);
  });
  it('lets a personal entry point at global and the same owner only', () => {
    expect(canReference(personal(BOB), entry())).toBe(true);
    expect(canReference(personal(BOB), entry({ scope: 'personal', ownerUserId: BOB }))).toBe(true);
    expect(canReference(personal(BOB), entry({ scope: 'personal', ownerUserId: DM }))).toBe(false);
  });
  it('lets a campaign entry point at its own campaign, not another', () => {
    expect(canReference(campaign(C1), entry({ scope: 'campaign', campaignId: C1 }))).toBe(true);
    expect(canReference(campaign(C1), entry({ scope: 'campaign', campaignId: C2 }))).toBe(false);
  });
  it('lets a campaign entry use an enabled library condition, but not its feat or a disabled library condition', () => {
    const condition = entry({ scope: 'personal', ownerUserId: BOB, type: 'condition' });
    const feat = entry({ scope: 'personal', ownerUserId: BOB, type: 'feat' });
    expect(canReference(campaign(C1), condition, [BOB])).toBe(true);
    expect(canReference(campaign(C1), feat, [BOB])).toBe(false);
    expect(canReference(campaign(C1), condition, [])).toBe(false);
  });
  it('refuses archived targets', () => {
    expect(canReference(global, entry({ isArchived: true }))).toBe(false);
    expect(canReference(personal(BOB), entry({ scope: 'personal', ownerUserId: BOB, isArchived: true }))).toBe(false);
  });
});

describe('canAuthorMechanics', () => {
  it('is for admins and DMs of at least one live campaign', () => {
    expect(canAuthorMechanics({ isAdmin: true, dmCampaignCount: 0 })).toBe(true);
    expect(canAuthorMechanics({ isAdmin: false, dmCampaignCount: 1 })).toBe(true);
    expect(canAuthorMechanics({ isAdmin: false, dmCampaignCount: 0 })).toBe(false);
  });
});

describe('splitLibraryFields', () => {
  it('counts costJson and item numbers as mechanics', () => {
    const { descriptive, mechanics } = splitLibraryFields('item', { name: 'Ring', description: 'Shiny', acBonus: 2, costJson: '[]', category: 'gear' });
    expect(descriptive).toEqual({ name: 'Ring', description: 'Shiny', category: 'gear' });
    expect(mechanics).toEqual({ costJson: '[]', acBonus: 2 });
  });
  it('treats spell damage and saves as mechanics, and flavour as descriptive', () => {
    const { descriptive, mechanics } = splitLibraryFields('spell', { name: 'Zap', school: 'evocation', baseDice: '1d6', saveAbility: 'dex' });
    expect(descriptive).toEqual({ name: 'Zap', school: 'evocation' });
    expect(mechanics).toEqual({ baseDice: '1d6', saveAbility: 'dex' });
  });
  it('drops unknown keys', () => {
    const { descriptive, mechanics } = splitLibraryFields('feat', { name: 'Tough', sneaky: 'x', scope: 'global' });
    expect(descriptive).toEqual({ name: 'Tough' });
    expect(mechanics).toEqual({});
  });
  it('treats deck rules and condition timing as mechanics', () => {
    expect(splitLibraryFields('deck', { name: 'D', rulesText: '{}' }).mechanics).toEqual({ rulesText: '{}' });
    expect(splitLibraryFields('condition', { name: 'C', durationRounds: 3 }).mechanics).toEqual({ durationRounds: 3 });
  });
});

describe('catalogueSourceLabel', () => {
  const base = { sourceKind: 'homebrew' as const, ownerName: null, forkedFromOwnerName: null };
  it('labels each scope', () => {
    expect(catalogueSourceLabel({ ...base, sourceKind: 'srd', scope: 'global' })).toBe('SRD');
    expect(catalogueSourceLabel({ ...base, scope: 'global' })).toBe('Homebrew');
    expect(catalogueSourceLabel({ ...base, scope: 'personal', ownerName: 'Bob' })).toBe("Bob's homebrew");
    expect(catalogueSourceLabel({ ...base, scope: 'campaign' })).toBe('Campaign');
    expect(catalogueSourceLabel({ ...base, scope: 'campaign', forkedFromOwnerName: 'Bob' })).toBe("Campaign copy (from Bob's library)");
  });
});

describe('planFork', () => {
  const mk = (id: string, type: ForkEntry['type'], over: Partial<ForkEntry> = {}): ForkEntry => ({
    id, key: `library:${BOB}:${id}`, type, name: id, scope: 'personal', ownerUserId: BOB, isArchived: false, ...over
  });
  const counter = () => { let n = 0; return () => `new-${++n}`; };
  const input = (over: Partial<ForkInput> = {}): ForkInput => ({
    campaignId: C1, ownerUserId: BOB, reason: 'left',
    entries: [], roots: [], edges: [], existingCopies: [], originalResources: [], copyResources: [], newId: counter(), ...over
  });

  it('follows grants, spell access, actions and deck keys to the whole closure', () => {
    const entries = [mk('item', 'item'), mk('feat', 'feat'), mk('spell', 'spell'), mk('action', 'action'), mk('cond', 'condition'), mk('deck', 'deck'), mk('unused', 'item')];
    const edges = [
      { from: 'item', to: 'feat' }, { from: 'feat', to: 'spell' }, { from: 'item', to: 'action' },
      { from: 'action', to: 'cond' }, { from: 'deck', to: 'cond' }
    ];
    const plan = planFork(input({ entries, edges, roots: ['item', 'deck'] }));
    expect(plan.copies.map((copy) => copy.originalId).sort()).toEqual(['action', 'cond', 'deck', 'feat', 'item', 'spell']);
    expect(plan.idRemap.unused).toBeUndefined();
    expect(plan.copies.find((copy) => copy.originalId === 'item')!.copyKey).toBe(`fork:${C1}:item`);
  });

  it('reuses an existing copy and never plans a new one for it', () => {
    const plan = planFork(input({
      entries: [mk('item', 'item')], roots: ['item'],
      existingCopies: [{ originalId: 'item', copyId: 'old-copy', copyKey: `fork:${C1}:item` }]
    }));
    expect(plan.copies).toEqual([]);
    expect(plan.reused).toEqual([{ originalId: 'item', copyId: 'old-copy' }]);
    expect(plan.idRemap.item).toBe('old-copy');
  });

  it('remaps resource ids, for new copies and for existing ones by key', () => {
    const plan = planFork(input({
      entries: [mk('wand', 'item'), mk('ring', 'item')], roots: ['wand', 'ring'],
      existingCopies: [{ originalId: 'ring', copyId: 'ring-copy', copyKey: `fork:${C1}:ring` }],
      originalResources: [{ contentId: 'wand', id: 'r-wand', key: 'charges' }, { contentId: 'ring', id: 'r-ring', key: 'charges' }],
      copyResources: [{ contentId: 'ring-copy', id: 'r-ring-copy', key: 'charges' }]
    }));
    expect(plan.resourceRemap['r-ring']).toBe('r-ring-copy');
    const wandCopy = plan.idRemap.wand;
    expect(plan.newResources).toEqual([{ originalId: 'r-wand', copyId: plan.resourceRemap['r-wand'], copyContentId: wandCopy }]);
  });

  it('rewrites deck condition keys to the copies', () => {
    const cond = mk('cond', 'condition', { key: `condition:homebrew:${BOB}:burning:1` });
    const plan = planFork(input({ entries: [cond, mk('deck', 'deck')], roots: ['deck'], edges: [{ from: 'deck', to: 'cond' }] }));
    // A condition copy keeps the "condition:" prefix (snapshots and restore look conditions up by it).
    expect(plan.keyRemap[cond.key]).toBe(`condition:fork:${C1}:cond`);
  });

  it('keeps archived originals archived on the copy', () => {
    const plan = planFork(input({ entries: [mk('old', 'item', { isArchived: true })], roots: ['old'] }));
    expect(plan.copies[0].isArchived).toBe(true);
  });

  it('refuses over the cap', () => {
    const entries = Array.from({ length: 6 }, (_, i) => mk(`e${i}`, 'item'));
    expect(() => planFork(input({ entries, roots: entries.map((e) => e.id), cap: 5 }))).toThrow(ForkPlanError);
    expect(() => planFork(input({ entries, roots: entries.map((e) => e.id), cap: 6 }))).not.toThrow();
  });

  it("never includes another owner's entries, global entries or foreign roots", () => {
    const entries = [mk('mine', 'item'), mk('theirs', 'item', { ownerUserId: DM }), mk('global', 'item', { scope: 'global', ownerUserId: null })];
    const plan = planFork(input({
      entries, roots: ['mine', 'theirs', 'global'],
      edges: [{ from: 'mine', to: 'theirs' }, { from: 'mine', to: 'global' }]
    }));
    expect(plan.copies.map((copy) => copy.originalId)).toEqual(['mine']);
    expect(plan.skipped.map((row) => row.id).sort()).toEqual(['global', 'theirs']);
  });

  it('only adds: the plan has no delete', () => {
    const plan = planFork(input({ entries: [mk('item', 'item')], roots: ['item'] }));
    expect(Object.keys(plan).filter((key) => /delete|remove|drop/i.test(key))).toEqual([]);
  });

  it('is repeatable: a second plan with the copies present plans nothing new', () => {
    const first = planFork(input({ entries: [mk('item', 'item'), mk('feat', 'feat')], roots: ['item'], edges: [{ from: 'item', to: 'feat' }] }));
    const second = planFork(input({
      entries: [mk('item', 'item'), mk('feat', 'feat')], roots: ['item'], edges: [{ from: 'item', to: 'feat' }],
      existingCopies: first.copies.map((copy) => ({ originalId: copy.originalId, copyId: copy.copyId, copyKey: copy.copyKey }))
    }));
    expect(second.copies).toEqual([]);
    expect(second.idRemap).toEqual(first.idRemap);
  });
});

describe('fork keys, deck key rewriting and the summary line', () => {
  it('builds deterministic keys, with the condition prefix only on conditions', () => {
    expect(forkContentKey(C1, 'x', 'item')).toBe(`fork:${C1}:x`);
    expect(forkContentKey(C1, 'x', 'condition')).toBe(`condition:fork:${C1}:x`);
    // The anchored strip the sheet uses gives back a key the lookup ('condition:' || key) resolves.
    expect(forkContentKey(C1, 'x', 'condition').replace(/^condition:/, '')).toBe(`fork:${C1}:x`);
  });

  it('rewrites only exact key strings, deeply, without changing the input', () => {
    const rules = { outcomes: [{ steps: [{ type: 'condition', conditionKey: 'condition:library:u:burn:1' }, { text: 'condition:library:u:burn:1 is mentioned' }] }] };
    const out = remapRulesKeys(rules, { 'condition:library:u:burn:1': 'condition:fork:c:id' }) as typeof rules;
    expect(out.outcomes[0].steps[0]).toEqual({ type: 'condition', conditionKey: 'condition:fork:c:id' });
    expect(out.outcomes[0].steps[1]).toEqual({ text: 'condition:library:u:burn:1 is mentioned' });
    expect(rules.outcomes[0].steps[0]).toEqual({ type: 'condition', conditionKey: 'condition:library:u:burn:1' });
  });

  it('describes a fork in plain words', () => {
    expect(describeFork('Bob', [])).toBe("Nothing new to copy from Bob's library.");
    expect(describeFork('Bob', [{ type: 'action' }])).toBe("Nothing new to copy from Bob's library.");
    const many = [{ type: 'item' }, { type: 'item' }, { type: 'item' }, { type: 'deck' }, { type: 'condition' }, { type: 'condition' }, { type: 'action' }] as Array<{ type: ContentType }>;
    expect(describeFork('Bob', many)).toBe("Kept campaign copies of 3 items, 1 deck and 2 conditions from Bob's library.");
    expect(describeFork('Bob', [{ type: 'spell' }])).toBe("Kept campaign copies of 1 spell from Bob's library.");
  });
});

describe('forageSourceLabel', () => {
  it('labels find table entries by where the item came from', () => {
    const base = { ownerName: 'Bob', ownerEnabled: true, forkedFromOwnerName: null };
    expect(forageSourceLabel({ ...base, scope: 'global' })).toBe('');
    expect(forageSourceLabel({ ...base, scope: 'personal' })).toBe("From Bob's library");
    expect(forageSourceLabel({ ...base, scope: 'personal', ownerEnabled: false })).toBe('From a library not enabled here');
    expect(forageSourceLabel({ ...base, scope: 'campaign', forkedFromOwnerName: 'Bob' })).toBe("Campaign copy (from Bob's library)");
    expect(forageSourceLabel({ ...base, scope: 'campaign' })).toBe('Campaign');
  });
});

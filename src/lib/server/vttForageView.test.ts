import { describe, expect, it } from 'vitest';
// The same file the browser loads (the VTT client is unbundled), tested from here.
import { FORAGE_SELF_SKILLS } from '$lib/rules/skills';
import { CHANCE_OPTIONS } from '$lib/rules/forage';
import {
  SELF_SKILL_KEYS, canSubmitSelf, defaultSelfPicks, selfAreas, selfCategories, tagLabel,
  addLine, addableEntries, areaOptions, canApprove, canSubmitPicks, categoryOptions, chosenTable, defaultPicks,
  errorText, forageButtonLabel, parseQty, parseSavedPicks, removeLine, requestSignature, resolveTable,
  resultHeadline, selfResult, setLineQty, sortedRequests, tableLineText,
  forageUnavailableReason, forageUnavailableText,
  approvedHaulKey, forageBlocker, haulDecision, canShareRecent, forageAdvReadout, forageBadgeText, lastDmFor, recentFindItemsText, recentFindStatusText, chanceLabel
} from '../../../static/vtt-app/shared/forageView.js';

const tables = [
  { id: 't1', name: 'Meadow - plants', areaType: 'meadow', category: 'plant', pickableCount: 4 },
  { id: 't2', name: 'Cave - ores', areaType: 'cave', category: 'ore', pickableCount: 4 },
  { id: 't3', name: 'Swamp - gems', areaType: 'swamp', category: 'gem', pickableCount: 0 }
];
const skills = [{ key: 'nature', name: 'Nature' }, { key: 'survival', name: 'Survival' }];

describe('pickers', () => {
  it('lists areas and categories (defaults first, then extras)', () => {
    expect(areaOptions(tables)).toEqual(['cave', 'meadow', 'swamp']);
    expect(categoryOptions([...tables, { areaType: 'x', category: 'bone' }])).toEqual(['plant', 'ore', 'gem', 'scroll', 'misc', 'bone']);
  });

  it('resolves a table, preferring a manual pick', () => {
    expect(resolveTable(tables, 'cave', 'ore')?.id).toBe('t2');
    expect(resolveTable(tables, 'cave', 'plant')).toBeNull();
    expect(chosenTable(tables, { areaType: 'cave', category: 'plant', manualTableId: 't1' })?.id).toBe('t1');
    expect(chosenTable(tables, { areaType: 'cave', category: 'plant', manualTableId: 'gone' })).toBeNull();
  });

  it('only allows submitting a table with something pickable', () => {
    expect(canSubmitPicks(tables, { skillKey: 'nature', areaType: 'meadow', category: 'plant', manualTableId: '' })).toBe(true);
    expect(canSubmitPicks(tables, { skillKey: 'nature', areaType: 'swamp', category: 'gem', manualTableId: '' })).toBe(false);
    expect(canSubmitPicks(tables, { skillKey: 'nature', areaType: 'cave', category: 'plant', manualTableId: '' })).toBe(false);
    expect(canSubmitPicks(tables, { skillKey: '', areaType: 'meadow', category: 'plant', manualTableId: '' })).toBe(false);
  });

  it('words the table line for a hit, a miss and an empty table', () => {
    expect(tableLineText(tables[0], {})).toBe('Meadow - plants · 4 pickable');
    expect(tableLineText(null, { areaType: 'cave', category: 'plant' })).toBe('No table for cave + plant. Pick one below.');
    expect(tableLineText(tables[2], {})).toContain('empty');
  });

  it('starts from the saved picks where valid, else the first option', () => {
    expect(defaultPicks(skills, tables, { skillKey: 'survival', areaType: 'cave', category: 'ore' })).toEqual({
      skillKey: 'survival', areaType: 'cave', category: 'ore', manualTableId: ''
    });
    expect(defaultPicks(skills, tables, { skillKey: 'nope', areaType: 'nowhere', category: 'nothing' })).toEqual({
      skillKey: 'nature', areaType: 'cave', category: 'plant', manualTableId: ''
    });
  });

  it('reads the shared saved value defensively', () => {
    expect(parseSavedPicks('{"skillKey":"nature","areaType":"cave","category":"ore"}')).toEqual({ skillKey: 'nature', areaType: 'cave', category: 'ore' });
    expect(parseSavedPicks('not json')).toEqual({});
    expect(parseSavedPicks(null)).toEqual({});
    expect(parseSavedPicks('{"skillKey":5}')).toEqual({ skillKey: '', areaType: '', category: '' });
  });
});

describe('haul editing', () => {
  const lines = [{ itemId: 'a', name: 'Moonleaf', qty: 2 }, { itemId: 'b', name: 'Bitterroot', qty: 1 }];

  it('parses quantities as whole numbers 1..999', () => {
    expect(parseQty('3')).toBe(3);
    expect(parseQty('0')).toBeNull();
    expect(parseQty('1.5')).toBeNull();
    expect(parseQty('')).toBeNull();
    expect(parseQty('5000')).toBe(999);
  });

  it('edits without mutating', () => {
    expect(setLineQty(lines, 'a', 7)[0].qty).toBe(7);
    expect(lines[0].qty).toBe(2);
    expect(removeLine(lines, 'a')).toHaveLength(1);
  });

  it('adds only addable entries (not present, not archived)', () => {
    const entries = [
      { itemId: 'a', name: 'Moonleaf', archived: false },
      { itemId: 'c', name: 'Glowcap', archived: false },
      { itemId: 'd', name: 'Withered Stalk', archived: true }
    ];
    expect(addableEntries(entries, lines).map((e: { itemId: string }) => e.itemId)).toEqual(['c']);
    expect(addLine(lines, entries[1])).toHaveLength(3);
    expect(addLine(lines, entries[0])).toBe(lines);
  });

  it('approves valid quantities, and an empty haul (a pass can find nothing)', () => {
    expect(canApprove(lines)).toBe(true);
    expect(canApprove([])).toBe(true);
    expect(canApprove([{ itemId: 'a', name: 'x', qty: 0 }])).toBe(false);
  });
});

describe('results, labels and errors', () => {
  it('normalises a self-serve mark response', () => {
    const lines = [{ itemId: 'a', name: 'Moonleaf', qty: 2 }];
    expect(selfResult({ status: 'found', lines, check: { total: 14 } }, 'f1', 'c1')).toMatchObject({ outcome: 'approved', findId: 'f1', characterId: 'c1', mode: 'self' });
    expect(selfResult({ status: 'failed', lines: [] }, 'f1').outcome).toBe('failed');
  });

  it('words each outcome', () => {
    expect(resultHeadline({ outcome: 'cancelled' })).toBe('The DM cancelled the forage.');
    expect(resultHeadline({ outcome: 'failed' })).toBe("You didn't find anything.");
    expect(resultHeadline({ outcome: 'approved', lines: [] })).toBe("You didn't find anything.");
    expect(resultHeadline({ outcome: 'approved', lines: [{}] })).toBe('You found something.');
  });

  it('labels the Forage button', () => {
    expect(forageButtonLabel({ pending: true, hasResult: true })).toBe('Forage (waiting)');
    expect(forageButtonLabel({ pending: false, hasResult: true })).toBe('Forage (result)');
    expect(forageButtonLabel({ pending: false, hasResult: false })).toBe('Forage');
    expect(forageButtonLabel({ pending: false, hasResult: false, unavailable: 'no_tables' })).toBe('Forage (unavailable)');
    // Something already in flight wins over "unavailable", so it can still be finished.
    expect(forageButtonLabel({ pending: true, hasResult: false, unavailable: 'no_tables' })).toBe('Forage (waiting)');
  });

  it('maps error codes to friendly text', () => {
    expect(errorText({ error: 'not_gm' })).toContain('VTT link');
    expect(errorText({ error: 'invalid_lines', message: 'Moonleaf appears twice.' })).toBe('Moonleaf appears twice.');
    expect(errorText({ error: 'whatever' })).toBe('Something went wrong.');
    expect(errorText(undefined)).toBe('Something went wrong.');
  });
});

describe('GM queue', () => {
  it('orders oldest first and ignores junk', () => {
    const map = { b: { id: 'rb', createdAt: 2 }, a: { id: 'ra', createdAt: 1 }, c: null, d: {} };
    expect(sortedRequests(map).map((r: { id: string }) => r.id)).toEqual(['ra', 'rb']);
  });

  it('changes the signature on a stage change or a new haul, not on a repeat', () => {
    const base = { id: 'r', stage: 'preview', check: { total: 12 }, preview: { tableId: 't', lines: [{ itemId: 'a', qty: 2 }] } };
    expect(requestSignature(base)).toBe(requestSignature({ ...base }));
    expect(requestSignature(base)).not.toBe(requestSignature({ ...base, stage: 'approving' }));
    expect(requestSignature(base)).not.toBe(requestSignature({ ...base, preview: { tableId: 't', lines: [{ itemId: 'a', qty: 3 }] } }));
  });
});

describe('self-serve pickers (Rev 4)', () => {
  const options = { areas: ['cave', 'meadow'], categories: ['ore', 'plant'] };
  const skills = [{ key: 'nature', name: 'Nature' }, { key: 'survival', name: 'Survival' }];

  it('keeps the client skill shortlist in step with the server constant', () => {
    expect([...SELF_SKILL_KEYS].sort()).toEqual([...FORAGE_SELF_SKILLS].sort());
  });

  it('labels tags in plain language', () => {
    expect(tagLabel('cave')).toBe('Cave');
    expect(tagLabel('ore')).toBe('Ores');
    expect(tagLabel('plant')).toBe('Plants');
    expect(tagLabel('dark_forest')).toBe('Dark Forest');
  });

  it('reads the area and category lists as given', () => {
    expect(selfAreas(options)).toEqual(['cave', 'meadow']);
    expect(selfCategories(options)).toEqual(['ore', 'plant']);
    expect(selfAreas(null)).toEqual([]);
  });

  it('starts from saved picks where still listed, else the first of each list', () => {
    expect(defaultSelfPicks(skills, options, { skillKey: 'survival', areaType: 'meadow', category: 'plant' })).toEqual({ skillKey: 'survival', areaType: 'meadow', category: 'plant' });
    expect(defaultSelfPicks(skills, options, { areaType: 'swamp' })).toEqual({ skillKey: 'nature', areaType: 'cave', category: 'ore' });
  });

  it('submits any listed area + category with a shortlisted skill, whether or not a table is behind it', () => {
    expect(canSubmitSelf(options, { skillKey: 'nature', areaType: 'cave', category: 'ore' })).toBe(true);
    expect(canSubmitSelf(options, { skillKey: 'nature', areaType: 'cave', category: 'plant' })).toBe(true);
    expect(canSubmitSelf(options, { skillKey: 'stealth', areaType: 'cave', category: 'ore' })).toBe(false);
    expect(canSubmitSelf(options, { skillKey: 'nature', areaType: '', category: 'ore' })).toBe(false);
  });
});

// Unit E: the character sheet's helpers (the badge, which DM result is this character's, and the list).
describe('character sheet forage helpers', () => {
  const lastDm = { requestId: 'r1', characterId: 'c1', outcome: 'approved', check: null, lines: [{ name: 'Moonleaf', qty: 2 }], closedAt: 1 };

  it('badges waiting, then mark check, then result, else nothing', () => {
    expect(forageBadgeText(null, 'c1')).toBe('');
    expect(forageBadgeText({ pending: { id: 'p' }, unmarkedSelf: { findId: 'f', characterId: 'c1' }, lastDm }, 'c1')).toBe('waiting');
    expect(forageBadgeText({ pending: null, unmarkedSelf: { findId: 'f', characterId: 'c1' }, lastDm }, 'c1')).toBe('mark check');
    expect(forageBadgeText({ pending: null, unmarkedSelf: null, lastDm }, 'c1')).toBe('result');
    expect(forageBadgeText({ pending: null, unmarkedSelf: null, lastDm: null }, 'c1')).toBe('');
  });

  it('only treats a DM result as belonging to the character it was for', () => {
    expect(lastDmFor({ lastDm }, 'c1')).toBe(lastDm);
    expect(lastDmFor({ lastDm }, 'c2')).toBeNull();
    expect(forageBadgeText({ pending: null, unmarkedSelf: null, lastDm }, 'c2')).toBe('');
  });

  it('keys an approved haul with items by request id, and nothing else', () => {
    expect(approvedHaulKey({ lastDm }, 'c1')).toBe('r1');
    expect(approvedHaulKey({ lastDm: { ...lastDm, lines: [] } }, 'c1')).toBeNull();
    expect(approvedHaulKey({ lastDm: { ...lastDm, outcome: 'failed' } }, 'c1')).toBeNull();
    expect(approvedHaulKey({ lastDm }, 'c2')).toBeNull();
    expect(approvedHaulKey(null, 'c1')).toBeNull();
  });

  it('reads the net adv/dis the same way the VTT panel does', () => {
    const sources = [{ id: 'a', kind: 'advantage' }, { id: 'b', kind: 'disadvantage' }];
    expect(forageAdvReadout({ sources: [], disabled: [], adv: 0, dis: 0 })).toBe('Flat roll');
    expect(forageAdvReadout({ sources, disabled: [], adv: 0, dis: 0 })).toBe('Net 0 (1 adv, 1 dis): flat roll');
    expect(forageAdvReadout({ sources, disabled: ['b'], adv: 1, dis: 0 })).toBe('Net +2 (2 adv, 0 dis): roll 3d20, keep highest');
    expect(forageAdvReadout({ sources, disabled: ['a'], adv: 0, dis: 1 })).toBe('Net -2 (0 adv, 2 dis): roll 3d20, keep lowest');
  });

  it('words the recent finds list and only offers Share on an unshared standing find', () => {
    const find = { id: 'f', status: 'found', mode: 'self', shared: false, items: [{ name: 'Moonleaf', qty: 3 }, { name: 'Iron Ore', qty: 2 }], revertNote: '' };
    expect(recentFindItemsText(find)).toBe('3x Moonleaf, 2x Iron Ore');
    expect(recentFindItemsText({ items: [] })).toBe('Nothing recorded');
    expect(canShareRecent(find)).toBe(true);
    expect(canShareRecent({ ...find, shared: true })).toBe(false);
    expect(canShareRecent({ ...find, items: [] })).toBe(false); // an empty find has nothing to share
    expect(canShareRecent({ ...find, status: 'reverted' })).toBe(false);
    expect(recentFindStatusText(find)).toBe('self-served');
    expect(recentFindStatusText({ ...find, shared: true, mode: 'dm' })).toBe('DM-approved · shared with the party');
    expect(recentFindStatusText({ ...find, status: 'reverted', revertNote: 'Moonleaf: reduced 5 -> 2' })).toBe('self-served · undone by the DM (Moonleaf: reduced 5 -> 2)');
  });

  it('scopes the badge to this character, and names the character that is blocking', () => {
    const other = { pending: { id: 'p' }, pendingCharacter: { id: 'c2', name: 'Thorne' }, unmarkedSelf: null, lastDm: null };
    expect(forageBadgeText(other, 'c1')).toBe('');
    expect(forageBlocker(other, 'c1')).toMatchObject({ kind: 'pending', characterName: 'Thorne', isThisCharacter: false });
    expect(forageBadgeText(other, 'c2')).toBe('waiting');
    const unmarked = { pending: null, unmarkedSelf: { findId: 'f', characterId: 'c2', characterName: 'Thorne' }, lastDm: null };
    expect(forageBadgeText(unmarked, 'c1')).toBe('');
    expect(forageBlocker(unmarked, 'c1')).toMatchObject({ kind: 'unmarked', characterName: 'Thorne', isThisCharacter: false });
    expect(forageBlocker({ pending: null, unmarkedSelf: null }, 'c1')).toBeNull();
  });

  describe('haulDecision (should a DM approval reload the sheet)', () => {
    const mine = (closedAt: number, requestId = 'r1') => ({ lastDm: { requestId, characterId: 'c1', outcome: 'approved', lines: [{ name: 'Moonleaf', qty: 2 }], closedAt } });
    const base = { characterId: 'c1', mountedAt: 1000, hasUnsavedChanges: false };

    it('does not reload for a result that closed before the sheet mounted', () => {
      expect(haulDecision({ ...base, mine: mine(999), handled: new Set() })).toEqual({ key: 'r1', action: 'none' });
    });

    it('reloads a new result exactly once', () => {
      const handled = new Set<string>();
      const first = haulDecision({ ...base, mine: mine(2000), handled });
      expect(first).toEqual({ key: 'r1', action: 'reload' });
      handled.add(first.key as string);
      expect(haulDecision({ ...base, mine: mine(2000), handled })).toEqual({ key: null, action: 'none' });
    });

    it('defers with unsaved edits', () => {
      expect(haulDecision({ ...base, hasUnsavedChanges: true, mine: mine(2000), handled: new Set() }).action).toBe('defer');
    });

    it('still reloads for an approval after a failed first fetch (nothing was ever recorded)', () => {
      // The first fetch failed, so no baseline was taken. The later one sees an approval closed after mount.
      expect(haulDecision({ ...base, mine: mine(5000), handled: new Set() }).action).toBe('reload');
    });

    it('ignores other characters, failed outcomes and empty hauls', () => {
      expect(haulDecision({ ...base, characterId: 'c2', mine: mine(2000), handled: new Set() }).action).toBe('none');
      expect(haulDecision({ ...base, mine: { lastDm: { ...mine(2000).lastDm, outcome: 'failed' } }, handled: new Set() }).action).toBe('none');
      expect(haulDecision({ ...base, mine: null, handled: new Set() }).action).toBe('none');
    });
  });
});

describe('unavailable forage (find tables belong to campaigns)', () => {
  const CHAR = 'c1';
  const off = (reason: string, extra: object = {}) => ({ available: false, unavailableReason: reason, pending: null, unmarkedSelf: null, lastDm: null, ...extra });

  it('words each reason at campaign level only, never about tables', () => {
    expect(forageUnavailableText('no_campaign')).toBe('Add this character to a campaign to forage.');
    expect(forageUnavailableText('wrong_room')).toBe("Foraging isn't available in this room.");
    expect(forageUnavailableText('no_tables')).toBe("Your DM hasn't set up foraging for this campaign yet.");
    expect(forageUnavailableText('whatever')).toBe("Foraging isn't available right now.");
    for (const reason of ['no_campaign', 'wrong_room', 'no_tables']) expect(forageUnavailableText(reason)).not.toMatch(/\d|table name/i);
  });

  it('gives the reason only when unavailable and nothing is in flight', () => {
    expect(forageUnavailableReason(null, CHAR)).toBe('');
    expect(forageUnavailableReason({ available: true }, CHAR)).toBe('');
    expect(forageUnavailableReason({}, CHAR)).toBe(''); // an older server says nothing
    expect(forageUnavailableReason(off('no_tables'), CHAR)).toBe('no_tables');
    expect(forageUnavailableReason(off('no_campaign'), CHAR)).toBe('no_campaign');
  });

  it('stays live while a forage can still be finished (pending, unmarked check or a waiting result)', () => {
    expect(forageUnavailableReason(off('no_tables', { pending: { id: 'r' }, pendingCharacter: { id: CHAR, name: 'A' } }), CHAR)).toBe('');
    expect(forageUnavailableReason(off('no_tables', { unmarkedSelf: { findId: 'f', characterId: CHAR, check: {} } }), CHAR)).toBe('');
    expect(forageUnavailableReason(off('no_tables', { lastDm: { requestId: 'q', characterId: CHAR, outcome: 'failed', closedAt: 1 } }), CHAR)).toBe('');
  });

  it('turns the server refusal into the same plain text', () => {
    expect(errorText({ error: 'forage_unavailable', reason: 'wrong_room' })).toBe("Foraging isn't available in this room.");
    expect(errorText({ error: 'forage_unavailable' })).toBe("Foraging isn't available right now.");
  });
});

describe('chanceLabel', () => {
  // The client's copy of the names has to stay in step with the editor's CHANCE_OPTIONS.
  it('matches every CHANCE_OPTIONS entry', () => {
    for (const option of CHANCE_OPTIONS) {
      const name = option.label.replace(/ \(.*\)$/, '');
      expect(chanceLabel(option.percent)).toBe(option.percent === 0 ? 'Off' : `${name} ${option.percent}%`);
    }
  });
});

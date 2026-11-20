import { describe, expect, it } from 'vitest';
// The same file the browser loads (the VTT client is unbundled), tested from here.
import { FORAGE_SELF_SKILLS } from '$lib/rules/skills';
import {
  SELF_SKILL_KEYS, canSubmitSelf, defaultSelfPicks, selfAreas, selfCategories, selfPairExists, tagLabel,
  addLine, addableEntries, areaOptions, canApprove, canSubmitPicks, categoryOptions, chosenTable, defaultPicks,
  errorText, forageButtonLabel, parseQty, parseSavedPicks, removeLine, requestSignature, resolveTable,
  resultHeadline, selfResult, setLineQty, sortedRequests, tableLineText
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

  it('only approves a non-empty list of valid quantities', () => {
    expect(canApprove(lines)).toBe(true);
    expect(canApprove([])).toBe(false);
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
    expect(resultHeadline({ outcome: 'failed' })).toBe('You find nothing of note.');
    expect(resultHeadline({ outcome: 'approved', lines: [] })).toBe('You find nothing of note.');
    expect(resultHeadline({ outcome: 'approved', lines: [{}] })).toBe('You found something.');
  });

  it('labels the Forage button', () => {
    expect(forageButtonLabel({ pending: true, hasResult: true })).toBe('Forage (waiting)');
    expect(forageButtonLabel({ pending: false, hasResult: true })).toBe('Forage (result)');
    expect(forageButtonLabel({ pending: false, hasResult: false })).toBe('Forage');
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
  const options = [{ areaType: 'meadow', category: 'plant' }, { areaType: 'cave', category: 'ore' }];
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

  it('builds areas and categories from the pairs, and knows which combinations exist', () => {
    expect(selfAreas(options)).toEqual(['cave', 'meadow']);
    expect(selfCategories(options)).toEqual(['ore', 'plant']);
    expect(selfPairExists(options, 'cave', 'ore')).toBe(true);
    expect(selfPairExists(options, 'cave', 'plant')).toBe(false);
  });

  it('starts from saved picks where valid, else the first area with a paired category', () => {
    expect(defaultSelfPicks(skills, options, { skillKey: 'survival', areaType: 'meadow', category: 'plant' })).toEqual({ skillKey: 'survival', areaType: 'meadow', category: 'plant' });
    expect(defaultSelfPicks(skills, options, {})).toEqual({ skillKey: 'nature', areaType: 'cave', category: 'ore' });
  });

  it('only submits a shortlisted skill with an existing area + category', () => {
    expect(canSubmitSelf(options, { skillKey: 'nature', areaType: 'cave', category: 'ore' })).toBe(true);
    expect(canSubmitSelf(options, { skillKey: 'stealth', areaType: 'cave', category: 'ore' })).toBe(false);
    expect(canSubmitSelf(options, { skillKey: 'nature', areaType: 'cave', category: 'plant' })).toBe(false);
  });
});

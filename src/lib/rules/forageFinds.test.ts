import { describe, expect, it } from 'vitest';
import {
  findCheckSummary, redactedFindText, shapeFindForViewer, shareLogMessage, undoLogMessage, type FindForViewer
} from './forage';

// The per-viewer rule for finds: full detail for the DM, the finder and (once shared) everyone;
// everyone else gets one line with a count and nothing else.

const find = (over: Partial<FindForViewer> = {}): FindForViewer => ({
  id: 'f1', createdAt: '2026-11-20T10:00:00Z', status: 'found', mode: 'self', shared: false,
  characterName: 'Thorne', finderUserId: 'finder', characterOwnerId: 'finder',
  check: { skillLabel: 'Nature', total: 17, nat20: false, nat1: false },
  tableName: 'Secret Meadow Table', items: [{ name: 'Moonleaf', qty: 3 }, { name: 'Iron Ore', qty: 2 }], revertNote: '', ...over
});

const dm = { id: 'dm', isDm: true };
const finder = { id: 'finder', isDm: false };
const bystander = { id: 'other', isDm: false };

describe('shapeFindForViewer', () => {
  it('never offers Share on a find with no items', () => {
    expect(shapeFindForViewer(find({ items: [] }), finder)).toMatchObject({ view: 'full', canShare: false, itemCount: 0 });
  });

  it('gives the DM the full row, without a Share button', () => {
    const row = shapeFindForViewer(find(), dm);
    expect(row).toMatchObject({ view: 'full', mode: 'self', checkSummary: 'Nature 17', tableName: 'Secret Meadow Table', itemCount: 5, canShare: false });
    expect((row as any).items).toEqual([{ name: 'Moonleaf', qty: 3 }, { name: 'Iron Ore', qty: 2 }]);
  });

  it('hides the table name from everyone but the DM (Rev 4), even on their own find and after a share', () => {
    expect((shapeFindForViewer(find(), finder) as any).tableName).toBe('');
    expect((shapeFindForViewer(find({ shared: true }), bystander) as any).tableName).toBe('');
    expect((shapeFindForViewer(find(), dm) as any).tableName).toBe('Secret Meadow Table');
  });

  it('gives the finder the full row with Share, until it is shared', () => {
    expect(shapeFindForViewer(find(), finder)).toMatchObject({ view: 'full', canShare: true });
    expect(shapeFindForViewer(find({ shared: true }), finder)).toMatchObject({ view: 'full', canShare: false });
  });

  it("treats the character's owner as the finder too", () => {
    expect(shapeFindForViewer(find({ finderUserId: 'someone', characterOwnerId: 'other' }), bystander)).toMatchObject({ view: 'full', canShare: true });
  });

  it('gives a bystander one counted line and no names, table or check', () => {
    const row = shapeFindForViewer(find(), bystander);
    expect(row).toMatchObject({ view: 'redacted', text: 'Thorne foraged and found 5 items.' });
    const json = JSON.stringify(row);
    for (const secret of ['Moonleaf', 'Iron Ore', 'Secret Meadow Table', 'Nature', 'self', 'items"']) expect(json).not.toContain(secret);
  });

  it('shows a shared, standing find in full to everyone, but never offers Share to them', () => {
    expect(shapeFindForViewer(find({ shared: true }), bystander)).toMatchObject({ view: 'full', canShare: false, shared: true });
  });

  it('redacts a reverted find for a bystander even if it was shared, and shows the note to full viewers', () => {
    const reverted = find({ status: 'reverted', shared: true, revertNote: 'Moonleaf: removed' });
    expect(shapeFindForViewer(reverted, bystander)).toEqual({
      view: 'redacted', id: 'f1', createdAt: '2026-11-20T10:00:00Z', status: 'reverted', text: "Thorne's find was undone by the DM."
    });
    expect(shapeFindForViewer(reverted, dm)).toMatchObject({ view: 'full', status: 'reverted', revertNote: 'Moonleaf: removed', canShare: false });
    expect(shapeFindForViewer(reverted, finder)).toMatchObject({ view: 'full', canShare: false });
  });

  it('never offers Share on a failed find, and a failed find has nothing to hide', () => {
    const failed = find({ status: 'failed', items: [] });
    expect(shapeFindForViewer(failed, finder)).toMatchObject({ view: 'full', canShare: false });
    expect(shapeFindForViewer(failed, bystander)).toMatchObject({ view: 'redacted', text: 'Thorne foraged and found nothing of note.' });
  });

  it('keeps a fake item id readable as Unknown item (the service fills the name)', () => {
    const row = shapeFindForViewer(find({ items: [{ name: 'Unknown item', qty: 1 }] }), dm);
    expect((row as any).items[0].name).toBe('Unknown item');
  });
});

describe('wording', () => {
  it('counts one item singularly', () => {
    expect(redactedFindText('found', 'Thorne', 1)).toBe('Thorne foraged and found 1 item.');
  });
  it('summarises the check, with nat badges', () => {
    expect(findCheckSummary({ skillLabel: 'Nature', total: 22, nat20: true })).toBe('Nature natural 20');
    expect(findCheckSummary({ skillLabel: 'Nature', total: 2, nat1: true })).toBe('Nature natural 1');
    expect(findCheckSummary(null)).toBe('');
  });
  it('puts item names on the share line only, and none on the undo line', () => {
    expect(shareLogMessage('Thorne', [{ name: 'Moonleaf', qty: 3 }, { name: 'Iron Ore', qty: 2 }])).toBe('Thorne shared their find: Moonleaf x3, Iron Ore x2.');
    expect(undoLogMessage('Thorne')).toBe("The DM undid Thorne's find.");
  });
});

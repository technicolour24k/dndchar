import { describe, expect, it } from 'vitest';
import { ledgerBadge, undoLogMessage, undoMessage } from './cost';

describe('ledger badges', () => {
  it('names each kind of override and review state', () => {
    expect(ledgerBadge({ overrideKind: null, reviewOutcome: null, reason: 'cost' })).toBeNull();
    expect(ledgerBadge({ overrideKind: 'dm_approved', reviewOutcome: null })).toBe('DM approved');
    expect(ledgerBadge({ overrideKind: 'dm_self', reviewOutcome: null })).toBe("DM's call");
    expect(ledgerBadge({ overrideKind: 'self_override', reviewOutcome: null })).toBe("Player said DM OK'd - not yet reviewed");
    expect(ledgerBadge({ overrideKind: 'self_override', reviewOutcome: 'ok' })).toBe("Player said DM OK'd it - DM marked OK");
    expect(ledgerBadge({ overrideKind: 'self_override', reviewOutcome: 'undone' })).toBe('Undone by DM');
    expect(ledgerBadge({ overrideKind: null, reviewOutcome: null, reason: 'refund' })).toBe('Refund');
  });
});

describe('undo wording', () => {
  it('summarises what was refunded and always says the effects need fixing by hand', () => {
    expect(undoMessage(['1 Level 2 Spell Slot'], [])).toBe('Refunded 1 Level 2 Spell Slot. Anything it did (damage, conditions) needs fixing by hand.');
    expect(undoMessage(['1 Vowfire', '1 Level 3 Spell Slot'], ["Couldn't refund 1 Item quantity (it's gone)"]))
      .toBe("Refunded 1 Vowfire, 1 Level 3 Spell Slot. Couldn't refund 1 Item quantity (it's gone). Anything it did (damage, conditions) needs fixing by hand.");
    expect(undoMessage([], [])).toContain('Nothing needed refunding.');
  });

  it('words the roll-log line', () => {
    expect(undoLogMessage('Aria', 'Fireball', ['1 Level 3 Spell Slot'])).toBe("The DM undid Aria's over-budget Fireball - refunded 1 Level 3 Spell Slot.");
    expect(undoLogMessage('Aria', 'Fireball', [])).toBe("The DM undid Aria's over-budget Fireball - nothing to refund.");
  });
});

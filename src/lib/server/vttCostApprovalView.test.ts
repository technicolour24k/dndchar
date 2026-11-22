import { describe, expect, it } from 'vitest';
// The same file the browser loads (the VTT client is unbundled and the sheet imports it too).
import {
  APPROVAL_TTL_MS as VIEW_TTL, CAPACITY_SENTENCE, applyCostMessage, approvalErrorText, approvalMsLeft, bannerText, closedMessage,
  formForActivation, gmRequestText, isInsufficient, mineStep, modeFrom, pendingQueue, promptSpec, shortfallLines
} from '../../../static/vtt-app/shared/costApproval.js';
import { APPROVAL_TTL_MS } from './vttCostApproval';
import { activationFromCastForm, parseActivation } from './vttCostApproval';

const SHORT = [{ label: 'Vowfire', needed: 1, available: 0 }];
const ID = '33333333-3333-4333-8333-333333333333';

describe('prompt wording (settled 2026-11-22)', () => {
  it('asks the DM when one is connected', () => {
    const spec = promptSpec('ask_dm');
    expect(spec.question).toBe("It doesn't look like you've got the capacity to do that. Do you want to ask the DM?");
    expect(spec.primary.id).toBe('ask');
    expect(spec.escape).toBe('cancel');
  });

  it('with no DM, "No - cancel" is the default and Escape choice, and going ahead is the deliberate second button', () => {
    const spec = promptSpec('no_dm');
    expect(spec.question).toContain('Did your DM OK this?');
    expect(spec.question.startsWith(CAPACITY_SENTENCE)).toBe(true);
    expect(spec.primary).toEqual({ id: 'cancel', label: 'No - cancel' });
    expect(spec.secondary).toEqual({ id: 'self', label: "Yes, the DM OK'd it" });
    expect(spec.escape).toBe('cancel');
    expect(spec.note).toBe("It'll be logged for your DM to review.");
  });

  it('with the DM gone while waiting, the safe choice withdraws the request', () => {
    const spec = promptSpec('no_dm_pending');
    expect(spec.primary).toEqual({ id: 'withdraw', label: 'No - withdraw' });
    expect(spec.escape).toBe('withdraw');
    expect(spec.secondary.id).toBe('self');
  });

  it('the DM acting is asked whether to go ahead anyway', () => {
    const spec = promptSpec('dm_self');
    expect(spec.question).toContain('go ahead anyway?');
    expect(spec.primary.id).toBe('go_ahead');
    expect(spec.escape).toBe('cancel');
  });

  it('an unknown mode falls back to asking the DM, never to the way past', () => {
    expect(promptSpec('whatever').primary.id).toBe('ask');
  });

  it('words the shortfall and recognises the server answers', () => {
    expect(shortfallLines(SHORT)).toEqual(['Needs 1 Vowfire, you have 0']);
    expect(shortfallLines(undefined)).toEqual([]);
    expect(modeFrom({ mode: 'no_dm' })).toBe('no_dm');
    expect(modeFrom({ error: 'dm_self' })).toBe('dm_self');
    expect(modeFrom({ error: 'pending' })).toBeNull();
    expect(isInsufficient({ error: 'insufficient', shortfalls: SHORT })).toBe(true);
    expect(isInsufficient({ error: 'insufficient' })).toBe(false);
  });
});

describe('outcomes', () => {
  it('words each way a request can end', () => {
    expect(closedMessage('denied')).toBe('The DM said no - nothing was spent.');
    expect(closedMessage('expired')).toContain('15 minutes');
    expect(closedMessage('withdrawn')).toContain('nothing was spent');
    expect(closedMessage('used')).toBeNull();
    expect(approvalErrorText({ error: 'approval_invalid', reason: 'expired' })).toContain('15 minutes');
    expect(approvalErrorText({ error: 'approval_invalid', reason: 'wrong_activation' })).toContain('different');
    expect(approvalErrorText({ error: 'forbidden' })).toContain('Only the DM');
    expect(bannerText({ activationLabel: 'Fireball' })).toBe('The DM approved Fireball.');
  });

  it('keeps the approval window in step with the server', () => {
    expect(VIEW_TTL).toBe(APPROVAL_TTL_MS);
    expect(approvalMsLeft({ status: 'approved', approvedAt: 1000 }, 1000 + 1000)).toBe(APPROVAL_TTL_MS - 1000);
    expect(approvalMsLeft({ status: 'approved', approvedAt: 1000 }, 1000 + APPROVAL_TTL_MS + 5)).toBe(0);
    expect(approvalMsLeft({ status: 'pending' }, 5)).toBe(0);
  });
});

describe('mineStep', () => {
  const request = (status: string) => ({ request: { id: 'r1', status }, dmPresent: true });
  it('picks what to show from the latest /mine answer', () => {
    expect(mineStep({ request: null, dmPresent: true }, null)).toBe('none');
    expect(mineStep(request('pending'), 'r1')).toBe('waiting');
    expect(mineStep({ ...request('pending'), dmPresent: false }, 'r1')).toBe('no_dm_pending');
    expect(mineStep(request('approved'), 'r1')).toBe('resume');
    // The held click is gone (a reload) or belongs to a different request: offer the banner.
    expect(mineStep(request('approved'), null)).toBe('banner');
    expect(mineStep(request('approved'), 'other')).toBe('banner');
    expect(mineStep(request('used'), 'r1')).toBe('none');
  });
});

describe('re-running an approved activation', () => {
  it('builds the same form the server derives its activation from', () => {
    const activations = [
      { kind: 'spell', instanceId: ID, slotType: 'standard', slotLevel: 3 },
      { kind: 'spell', instanceId: ID },
      { kind: 'spell_access', spellAccessId: ID, inventoryItemId: ID, slotLevel: 2 },
    ] as const;
    for (const activation of activations) {
      const built = formForActivation(activation)!;
      expect(built.action).toBe('castSpell');
      const form = new FormData();
      for (const [key, value] of built.entries) form.set(key, value);
      expect(activationFromCastForm(form)).toEqual(activation);
      expect(parseActivation(activation)).toEqual(activation);
    }
    expect(formForActivation({ kind: 'item', inventoryId: ID })).toEqual({ action: 'useItem', entries: [['inventoryId', ID]] });
    expect(formForActivation({ kind: 'content', instanceId: ID })).toEqual({ action: 'triggerContent', entries: [['instanceId', ID]] });
    expect(formForActivation(null)).toBeNull();
  });
});

describe('the GM queue', () => {
  const req = (characterId: string, createdAt: number, status = 'pending') => ({
    id: `r-${characterId}`, characterId, characterName: characterId.toUpperCase(), activationLabel: 'Fireball', shortfalls: SHORT, status, createdAt
  });

  it('lists only pending requests, oldest first', () => {
    const map = { b: req('b', 20), a: req('a', 10), c: req('c', 5, 'approved') };
    expect(pendingQueue(map).map((r) => r.characterId)).toEqual(['a', 'b']);
    expect(pendingQueue(undefined)).toEqual([]);
  });

  it('words a card line', () => {
    expect(gmRequestText(req('a', 1))).toBe('A - Fireball (short 1 Vowfire)');
    expect(gmRequestText({ characterName: 'Aria', activationLabel: 'Fireball', shortfalls: [{ label: 'Level 3 Spell Slot', needed: 1, available: 0 }, { label: 'Vowfire', needed: 3, available: 1 }] }))
      .toBe('Aria - Fireball (short 1 Level 3 Spell Slot, 2 Vowfire)');
  });

  it('applies cost:update and cost:closed to the map', () => {
    const map: Record<string, any> = {};
    applyCostMessage(map, { type: 'cost:update', request: req('a', 1) });
    applyCostMessage(map, { type: 'cost:update', request: { ...req('a', 1), status: 'approved' } });
    expect(map.a.status).toBe('approved');
    applyCostMessage(map, { type: 'cost:update', request: req('b', 2) });
    applyCostMessage(map, { type: 'cost:closed', requestId: 'r-a' });
    expect(Object.keys(map)).toEqual(['b']);
  });
});

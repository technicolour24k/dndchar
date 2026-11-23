import { describe, expect, it } from 'vitest';
import { cardTitle, choiceOptions, drawnTitle, errorText, gmTaskLine, lastDrawLine, undoneTitle, recentLine, resultLines, rollLines, statusTag, taskLines } from '../../../static/vtt-app/shared/deckView.js';

const draw: any = {
  drawerName: 'Aria', success: false, chosenValue: null, status: 'resolved',
  card: { label: '3 of Clubs', tags: { back: 'gold' }, valueOptions: undefined },
  results: [{ text: 'Aria loses 3 AC for 10 rounds' }, { text: 'Brom loses 5 gp', note: 'Had 2 gp, lost 2, 3 short.' }],
  dmTasks: [{ text: 'The party finds a cursed item', done: false }, { text: 'Old', done: true }],
  outcome: { rolls: [{ name: 'party_roll', text: '4 + 7 = 11' }] }
};

describe('deckView', () => {
  it('words the card, the result lines (with clamp notes), roll breakdowns and open DM tasks', () => {
    expect(cardTitle(draw.card)).toBe('3 of Clubs - gold back');
    expect(cardTitle({ label: 'Red Joker', tags: {} })).toBe('Red Joker');
    expect(resultLines(draw)).toEqual(['Aria loses 3 AC for 10 rounds', 'Brom loses 5 gp (Had 2 gp, lost 2, 3 short.)']);
    expect(rollLines(draw)).toEqual(['party roll: 4 + 7 = 11']);
    expect(taskLines(draw)).toEqual(['Waiting on the DM: The party finds a cursed item']);
    expect(taskLines(draw, true)).toHaveLength(2);
  });
  it('builds the Ace choices with their previews', () => {
    const ace: any = { card: { valueOptions: [1, 11] }, previews: { 1: 'Aria gains 1 gp', 11: 'Aria gains 11 gp' } };
    expect(choiceOptions(ace)).toEqual([
      { value: 1, label: 'Count it as 1', preview: 'Aria gains 1 gp' },
      { value: 11, label: 'Count it as 11', preview: 'Aria gains 11 gp' }
    ]);
    expect(choiceOptions({ card: {} })).toEqual([]);
  });
  it('words recent draws, status tags and errors', () => {
    expect(recentLine(draw)).toBe('Aria drew the 3 of Clubs - gold back: Failure');
    expect(recentLine({ ...draw, success: true, chosenValue: 11 })).toBe('Aria drew the 3 of Clubs - gold back (as 11): Success');
    expect(statusTag({ status: 'reverted' })).toBe('Undone by the DM');
    expect(statusTag(draw)).toBe('');
    expect(errorText('choosing')).toMatch(/Finish the card/);
    expect(errorText('mystery')).toBe('Something went wrong.');
  });
  it('words the VTT toasts and the GM block', () => {
    const named = { ...draw, outcome: { name: "Defender's Aura" } };
    expect(drawnTitle(named)).toBe("Aria drew the 3 of Clubs - gold back - failure: Defender's Aura");
    expect(drawnTitle({ ...draw, success: true })).toBe('Aria drew the 3 of Clubs - gold back - success');
    expect(undoneTitle(draw)).toBe("The DM undid Aria's draw of the 3 of Clubs");
    expect(gmTaskLine({ cardLabel: 'Red Joker', text: 'The party gains a high-powered magic item' })).toBe('Red Joker: The party gains a high-powered magic item');
    expect(lastDrawLine(draw)).toBe('Last draw: Aria drew the 3 of Clubs - gold back (failure)');
  });
});

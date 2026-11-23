// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure wording/view helpers for the deck popups (decks plan, unit 7), shared by the sheet and, later, the VTT.
// These return plain UNESCAPED strings: callers must use textContent (or escape) when putting them in the page.
// No DOM, no fetch, so they can be unit tested from src/ (see src/lib/server/deckView.test.ts).

/** "3 of Clubs - gold back" (the card label already reads "3 of Clubs"; jokers have no suit). */
export function cardTitle(card) {
  const back = card?.tags?.back;
  return `${card?.label ?? 'A card'}${back ? ` - ${back} back` : ''}`;
}

export function successLabel(success) {
  return success ? 'Success' : 'Failure';
}

/** One line per applied change, with any clamp note: "Aria loses 3 AC for 10 rounds". */
export function resultLines(draw) {
  return (draw?.results ?? []).map((line) => (line.note ? `${line.text} (${line.note})` : line.text));
}

/** What is still waiting on the DM (open tasks only, or every task when `all`). */
export function taskLines(draw, all = false) {
  return (draw?.dmTasks ?? []).filter((task) => all || !task.done).map((task) => `Waiting on the DM: ${task.text}`);
}

/** The roll breakdowns, e.g. "party_roll: 4 + 7 + 2 = 13". */
export function rollLines(draw) {
  return (draw?.outcome?.rolls ?? []).map((roll) => `${String(roll.name).replace(/_/g, ' ')}: ${roll.text}`);
}

/** The Ace choice buttons: "Count it as 11" with what it would do. */
export function choiceOptions(draw) {
  const options = draw?.card?.valueOptions ?? [];
  return options.map((value) => ({ value, label: `Count it as ${value}`, preview: draw?.previews?.[String(value)] ?? '' }));
}

/** The tag on a recent-draws row. */
export function statusTag(draw) {
  if (draw?.status === 'reverted') return 'Undone by the DM';
  if (draw?.status === 'cancelled') return 'Cancelled';
  if (draw?.status === 'choosing') return 'Choosing';
  return '';
}

/** A one-line recent draw: "Aria drew the 3 of Clubs - gold back: Failure". */
export function recentLine(draw) {
  return `${draw.drawerName} drew the ${cardTitle(draw.card)}${draw.chosenValue != null ? ` (as ${draw.chosenValue})` : ''}: ${successLabel(draw.success)}`;
}

/** Player-facing text for an error body from the deck endpoints. */
export function errorText(error) {
  switch (error) {
    case 'choosing': return 'Finish the card you drew first.';
    case 'not_enabled': return 'That deck is not enabled for this campaign.';
    case 'forbidden': return 'You cannot do that for this character.';
    case 'not_found': return 'That deck or draw no longer exists.';
    case 'already_undone': return 'That draw was already undone.';
    case 'not_choosing': return 'That card has already been decided.';
    case 'bad_input': return 'That was not a valid choice.';
    case 'network': return 'Could not reach the server.';
    default: return 'Something went wrong.';
  }
}

/** The note under the Save status when a draw changed the sheet but unsaved edits stop an automatic reload. */
export const CHANGED_NOTE = 'A card changed this sheet (HP, gold or effects). Your Save keeps it.';

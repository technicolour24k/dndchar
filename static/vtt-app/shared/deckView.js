// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure wording/view helpers for the deck popups (decks plan, unit 7), shared by the sheet and, later, the VTT.
// These return plain UNESCAPED strings: callers must use textContent (or escape) when putting them in the page.
// No DOM, no fetch, so they can be unit tested from src/ (see src/lib/server/deckView.test.ts).

/** "3 of Clubs - gold back" (the card label already reads "3 of Clubs"; jokers have no suit). */
export function cardTitle(card) {
  const back = card?.tags?.back;
  return `${card?.label ?? 'A card'}${back ? ` - ${back} back` : ''}`;
}

/** null means this viewer is not told the result (a hidden joker), so it reads as the DM's call. */
export function successLabel(success) {
  if (success == null) return 'Up to the DM';
  return success ? 'Success' : 'Failure';
}


/** One line per applied change, with any clamp note: "Aria loses 3 AC for 10 rounds". */
export function resultLines(draw) {
  return (draw?.results ?? []).map((line) => (line.note ? `${line.text} (${line.note})` : line.text));
}

/** One task in words. A hidden task has empty text (the server blanked it), so it just says "Waiting on the DM.". */
export function taskLine(task) {
  return task?.text ? `Waiting on the DM: ${task.text}` : 'Waiting on the DM.';
}

/** What is still waiting on the DM (open tasks only, or every task when `all`). Hidden tasks collapse into one line. */
export function taskLines(draw, all = false) {
  const lines = (draw?.dmTasks ?? []).filter((task) => all || !task.done).map(taskLine);
  return lines.filter((line, index) => lines.indexOf(line) === index);
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

/** A one-line recent draw: "Aria drew the 3 of Clubs - gold back: Failure" (no result part when it is hidden). */
export function recentLine(draw) {
  const result = draw.success == null ? '' : `: ${successLabel(draw.success)}`;
  return `${draw.drawerName} drew the ${cardTitle(draw.card)}${draw.chosenValue != null ? ` (as ${draw.chosenValue})` : ''}${result}`;
}

/** The VTT toast headline: "Aria drew the 3 of Clubs - gold back - failure: Defender's Aura". */
export function drawnTitle(draw) {
  const outcome = draw?.outcome?.name ? `: ${draw.outcome.name}` : '';
  const result = draw?.success == null ? '' : ` - ${successLabel(draw.success).toLowerCase()}`;
  return `${draw?.drawerName} drew the ${cardTitle(draw?.card)}${result}${outcome}`;
}

/** The VTT toast headline when the DM undoes a draw. */
export function undoneTitle(draw) {
  return `The DM undid ${draw?.drawerName}'s draw of the ${draw?.card?.label ?? 'card'}`;
}

/** An open DM task in the GM's sidebar: "Red Joker: The party gains a high-powered magic item". */
export function gmTaskLine(task) {
  return `${task?.cardLabel ?? 'Card'}: ${task?.text ?? ''}`;
}

/** The GM's "last draw" line (the draw Undo applies to). */
export function lastDrawLine(draw) {
  const result = draw?.success == null ? '' : ` (${successLabel(draw.success).toLowerCase()})`;
  return `Last draw: ${draw?.drawerName} drew the ${cardTitle(draw?.card)}${result}`;
}

/** The sticky GM toast headline for a draw that leaves the DM something to do: "Waiting on you: Red Joker: <task>". */
export function waitingOnYouTitle(draw) {
  const open = (draw?.dmTasks ?? []).filter((task) => !task.done && task.text).map((task) => task.text);
  return `Waiting on you: ${draw?.card?.label ?? 'Card'}${open.length ? `: ${open.join('; ')}` : ''}`;
}

/** What to store when the GM dismisses the Deck box (or re-dismisses it after an undo): the draw and tasks seen now. */
export function hiddenState(last, tasks) {
  return { lastDrawId: last?.id ?? null, taskIds: (tasks ?? []).map((task) => task.taskId ?? task.id) };
}

/**
 * Is the GM's Deck box dismissed? `storedRaw` is what localStorage held (a JSON string, or null/garbage).
 * It stays hidden only while nothing NEW has arrived: the last draw is the one that was dismissed, and every
 * open task was already there. A new draw or a new task shows it again; ticking a task off or an undo never does.
 */
export function deckBlockHidden(storedRaw, last, tasks) {
  let stored;
  try { stored = JSON.parse(storedRaw); } catch { return false; }
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.taskIds)) return false;
  if ((last?.id ?? null) !== (stored.lastDrawId ?? null)) return false;
  return (tasks ?? []).every((task) => stored.taskIds.includes(task.taskId ?? task.id));
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

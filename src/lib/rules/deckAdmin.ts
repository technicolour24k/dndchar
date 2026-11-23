// Pure helpers for the admin deck page (decks plan, unit 9): the read-only summary under the rules editor and the
// condition keys a deck refers to. No DB, no DOM.
import type { DeckStep, ExpandedDeckRules } from '$lib/types/decks';

const tagsText = (tags: Record<string, string>) => {
  const entries = Object.entries(tags);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(', ') : 'any card';
};

const TARGET_TEXT = { drawer: 'the drawer', each_party_member: 'each party member', party_split: 'the party (split)' } as const;

/** One step in words for the outcomes table, e.g. "gp 10 + {party_roll} to each party member". */
export function stepText(step: DeckStep): string {
  const target = TARGET_TEXT[(step as { target?: keyof typeof TARGET_TEXT }).target ?? 'drawer'] ?? 'the drawer';
  switch (step.type) {
    case 'currency': return `${step.coin} ${step.amount} to ${target}`;
    case 'heal': return `heal ${step.amount} for ${target}`;
    case 'damage': return `damage ${step.amount} to ${target}`;
    case 'temp_hp': return `temp HP ${step.amount} for ${target}`;
    case 'condition': {
      const params = Object.entries(step.params ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
      const rounds = step.durationRounds ? `, ${step.durationRounds} rounds` : '';
      return `${step.conditionKey}${params ? ` (${params}${rounds})` : rounds ? ` (${rounds.slice(2)})` : ''} on ${target}`;
    }
    default: return `DM prompt: ${step.text}`;
  }
}

/** Every condition key the deck can apply, including inverse swaps (deduplicated, sorted). */
export function collectConditionKeys(rules: Pick<ExpandedDeckRules, 'outcomes'>): string[] {
  const keys = new Set<string>();
  for (const outcome of rules.outcomes) {
    for (const step of outcome.steps) {
      if (step.type !== 'condition') continue;
      keys.add(step.conditionKey);
      if (step.inverse?.conditionKey) keys.add(step.inverse.conditionKey);
    }
  }
  return [...keys].sort();
}

export type DeckSummary = {
  cardCount: number;
  byBack: Array<{ back: string; count: number }>;
  success: string[];
  outcomes: Array<{ id: string; when: string; name: string; steps: string[] }>;
};

/** The read-only summary: card count by back, the success table, and one row per outcome. */
export function summariseDeck(rules: ExpandedDeckRules): DeckSummary {
  const backs = new Map<string, number>();
  for (const card of rules.cards) {
    const back = card.tags.back ?? '(no back)';
    backs.set(back, (backs.get(back) ?? 0) + (card.copies ?? 1));
  }
  return {
    cardCount: rules.cards.length,
    byBack: [...backs].map(([back, count]) => ({ back, count })),
    success: [
      ...rules.success.rules.map((rule) => `${tagsText(rule.when)} = ${rule.result}`),
      `anything else = ${rules.success.otherwise}`
    ],
    outcomes: rules.outcomes.map((outcome) => ({
      id: outcome.id, when: tagsText(outcome.when), name: outcome.name, steps: outcome.steps.map(stepText)
    }))
  };
}

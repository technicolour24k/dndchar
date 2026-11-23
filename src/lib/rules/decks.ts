import type {
  CardTags, DeckCard, DeckOutcome, DeckStep, DeckTarget, DrawPlan, DrawSummaryInput, ExpandedDeckRules,
  DrawView, PlannedLine, PlannedRoll, PlannedTask
} from '$lib/types/decks';

// Pure deck rules: parsing, tag matching, amount maths, outcome planning and the appliers.
// No DB; randomness is injected (rollDie).

export const DECK_LIMITS = {
  cards: 500, outcomes: 100, steps: 20, copies: 10, amount: 999, minRounds: 1, maxRounds: 600, text: 500,
  cardSets: 10, rolls: 10, params: 10, terms: 10, expression: 100, errors: 50, options: 20
};

export type RollDie = (sides: number) => number;
const defaultRollDie: RollDie = (sides) => Math.floor(Math.random() * sides) + 1;

const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];
const TARGETS = ['drawer', 'each_party_member', 'party_split'];
const NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;
// Names that would hit Object.prototype if used as keys. Rejected everywhere a key comes from authored JSON.
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const isForbiddenKey = (key: string) => FORBIDDEN_KEYS.includes(key.trim().toLowerCase());
const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------- tags and cards

function lowerTags(tags: CardTags): CardTags {
  const out: CardTags = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!isForbiddenKey(key)) out[key.trim().toLowerCase()] = String(value).trim().toLowerCase();
  }
  return out;
}

/** A `when` matches when every key/value equals the card's tag (case-insensitive). `{}` matches everything. */
export function matchesTags(when: CardTags, tags: CardTags): boolean {
  // A `when` with a forbidden key must never quietly become {} (which matches everything).
  if (Object.keys(when).some(isForbiddenKey)) return false;
  const have = lowerTags(tags);
  return Object.entries(lowerTags(when)).every(([key, value]) => has(have, key) && have[key] === value);
}

/** First matching success rule wins, else `otherwise`. */
export function cardSuccess(rules: Pick<ExpandedDeckRules, 'success'>, card: Pick<DeckCard, 'tags'>): boolean {
  const hit = rules.success.rules.find((rule) => matchesTags(rule.when, card.tags));
  return (hit ? hit.result : rules.success.otherwise) === 'success';
}

/** First matching outcome wins, or null. */
export function findOutcome(rules: Pick<ExpandedDeckRules, 'outcomes'>, card: Pick<DeckCard, 'tags'>): DeckOutcome | null {
  return rules.outcomes.find((outcome) => matchesTags(outcome.when, card.tags)) ?? null;
}

export function needsValueChoice(card: Pick<DeckCard, 'valueOptions'>): boolean {
  return Array.isArray(card.valueOptions) && card.valueOptions.length > 0;
}

/** The card's value for `{value}`. Throws when a choice is needed and `chosen` isn't one of the options. */
export function cardValue(card: Pick<DeckCard, 'value' | 'valueOptions' | 'label'>, chosen?: number | null): number {
  if (needsValueChoice(card)) {
    if (chosen == null || !card.valueOptions!.includes(chosen)) {
      throw new Error(`${card.label} must be counted as one of: ${card.valueOptions!.join(', ')}.`);
    }
    return chosen;
  }
  return card.value ?? 0;
}

// ---------------------------------------------------------------- amount expressions

type AmountTerm = { sign: 1 | -1 } & (
  | { kind: 'num'; n: number }
  | { kind: 'dice'; count: number; sides: number }
  | { kind: 'var'; name: string }
);

/** Integers, NdM, {name}, joined by + and -. Returns the terms or an error message. */
function tokeniseAmount(expression: string): AmountTerm[] | string {
  const text = String(expression ?? '').replace(/\s+/g, '');
  if (!text) return 'is empty';
  if (text.length > DECK_LIMITS.expression) return `is longer than ${DECK_LIMITS.expression} characters`;
  const raw = text.match(/[+-]?[^+-]+/g) ?? [];
  if (raw.join('') !== text) return `"${expression}" is not a valid expression`;
  if (raw.length > DECK_LIMITS.terms) return `has more than ${DECK_LIMITS.terms} terms`;
  const terms: AmountTerm[] = [];
  for (const piece of raw) {
    const sign: 1 | -1 = piece.startsWith('-') ? -1 : 1;
    const body = piece.replace(/^[+-]/, '');
    let match: RegExpMatchArray | null;
    if (/^\d+$/.test(body)) {
      if (body.length > 4 || Number(body) > DECK_LIMITS.amount) return `"${body}" is over ${DECK_LIMITS.amount}`;
      terms.push({ sign, kind: 'num', n: Number(body) });
    } else if ((match = body.match(/^(\d*)d(\d+)$/i))) {
      const count = match[1] === '' ? 1 : Number(match[1]);
      const sides = Number(match[2]);
      if (count < 1 || count > 50 || sides < 2 || sides > 1000 || count * sides > DECK_LIMITS.amount) {
        return `"${body}" is out of range (1-50 dice, 2-1000 sides, at most ${DECK_LIMITS.amount} in total)`;
      }
      terms.push({ sign, kind: 'dice', count, sides });
    } else if ((match = body.match(/^\{([a-z_][a-z0-9_]*)\}$/i))) {
      terms.push({ sign, kind: 'var', name: match[1].toLowerCase() });
    } else {
      return `"${body}" is not a number, dice term or {placeholder}`;
    }
  }
  return terms;
}

/** Returns an error message, or null when the expression is fine. Placeholders must be in `allowed`. */
function checkAmount(expression: string, allowed: string[], opts: { requireNoVars?: boolean } = {}): string | null {
  const terms = tokeniseAmount(expression);
  if (typeof terms === 'string') return terms;
  let max = 0;
  let hasVar = false;
  for (const term of terms) {
    if (term.kind === 'var') {
      hasVar = true;
      if (opts.requireNoVars) return 'cannot use {placeholders} here';
      if (!allowed.includes(term.name)) return `unknown placeholder {${term.name}}`;
    } else {
      const top = term.kind === 'num' ? term.n : term.count * term.sides;
      if (term.sign === 1) max += top;
    }
  }
  if (!hasVar && max > DECK_LIMITS.amount) return `can exceed ${DECK_LIMITS.amount}`;
  return null;
}

/**
 * Substitutes {name} and rolls dice. Text is a breakdown, e.g. "10 + 13 = 23" or "2d10[7,3] + 5 = 15".
 * A negative total is floored at 0 unless `floor` is false (used for condition params).
 */
export function evaluateAmount(
  expression: string, vars: Record<string, number>, rollDie: RollDie = defaultRollDie, opts: { floor?: boolean } = {}
): { total: number; text: string } {
  const terms = tokeniseAmount(expression);
  if (typeof terms === 'string') throw new Error(`Bad amount: ${terms}`);
  let raw = 0;
  let text = '';
  terms.forEach((term, index) => {
    let value: number;
    let part: string;
    if (term.kind === 'num') { value = term.n; part = String(term.n); }
    else if (term.kind === 'var') {
      if (!has(vars, term.name)) throw new Error(`Unknown placeholder {${term.name}}`);
      const given = vars[term.name];
      value = Number.isFinite(given) ? Math.max(-DECK_LIMITS.amount, Math.min(DECK_LIMITS.amount, given)) : 0;
      part = String(value);
    } else {
      const dice = Array.from({ length: term.count }, () => rollDie(term.sides));
      value = dice.reduce((sum, die) => sum + die, 0);
      part = `${term.count}d${term.sides}[${dice.join(',')}]`;
    }
    raw += term.sign * value;
    text += index === 0 ? (term.sign < 0 ? `-${part}` : part) : ` ${term.sign < 0 ? '-' : '+'} ${part}`;
  });
  raw = Math.max(-DECK_LIMITS.amount, Math.min(DECK_LIMITS.amount, raw));
  const floored = opts.floor !== false && raw < 0;
  const total = floored ? 0 : raw;
  const plain = terms.length === 1 && terms[0].kind !== 'dice';
  const out = plain ? String(raw) : `${text} = ${raw}`;
  return { total, text: floored ? `${out} (counts as 0)` : out };
}

// ---------------------------------------------------------------- parser

type Reader = { errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTags(raw: unknown, path: string, r: Reader): CardTags {
  if (!isRecord(raw)) { r.errors.push(`${path}: must be an object of tags`); return {}; }
  const tags: CardTags = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isForbiddenKey(key)) r.errors.push(`${path}: "${key}" is not allowed as a tag name`);
    else if (typeof value !== 'string' || !key.trim() || !value.trim()) {
      r.errors.push(`${path}.${key}: tag keys and values must be non-empty text`);
    } else tags[key.trim().toLowerCase()] = value.trim().toLowerCase();
  }
  return tags;
}

function readText(raw: unknown, path: string, r: Reader): string {
  if (typeof raw !== 'string' || !raw.trim()) { r.errors.push(`${path}: must be text`); return ''; }
  if (raw.length > DECK_LIMITS.text) r.errors.push(`${path}: over ${DECK_LIMITS.text} characters`);
  return raw;
}

/** An optional true/false field. Anything else is an error. */
function readFlag(raw: unknown, path: string, r: Reader): boolean | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'boolean') { r.errors.push(`${path}: must be true or false`); return undefined; }
  return raw;
}

function readValue(raw: unknown, path: string, r: Reader): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || Math.abs(raw) > DECK_LIMITS.amount) {
    r.errors.push(`${path}: must be a whole number from -${DECK_LIMITS.amount} to ${DECK_LIMITS.amount}, or null`); return null;
  }
  return raw;
}

function readOptions(raw: unknown, path: string, r: Reader): number[] | undefined {
  if (raw == null) return undefined;
  if (
    !Array.isArray(raw) || !raw.length || raw.length > DECK_LIMITS.options
    || raw.some((n) => typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > DECK_LIMITS.amount)
  ) {
    r.errors.push(`${path}: must be a list of 1 to ${DECK_LIMITS.options} whole numbers within +-${DECK_LIMITS.amount}`);
    return undefined;
  }
  return raw as number[];
}

function readSuccess(raw: unknown, r: Reader): ExpandedDeckRules['success'] {
  const fallback: ExpandedDeckRules['success'] = { rules: [], otherwise: 'failure' };
  if (!isRecord(raw)) { r.errors.push('success: missing'); return fallback; }
  const isResult = (v: unknown): v is 'success' | 'failure' => v === 'success' || v === 'failure';
  if (!isResult(raw.otherwise)) r.errors.push('success.otherwise: must be "success" or "failure"');
  const rules: ExpandedDeckRules['success']['rules'] = [];
  if (!Array.isArray(raw.rules)) r.errors.push('success.rules: must be a list');
  else raw.rules.forEach((rule, i) => {
    const path = `success.rules[${i}]`;
    if (!isRecord(rule) || !isResult(rule.result)) { r.errors.push(`${path}: needs when and result`); return; }
    rules.push({ when: readTags(rule.when, `${path}.when`, r), result: rule.result });
  });
  return { rules, otherwise: isResult(raw.otherwise) ? raw.otherwise : 'failure' };
}

function expandCardSet(raw: unknown, index: number, r: Reader): DeckCard[] {
  const path = `cardSets[${index}]`;
  if (!isRecord(raw)) { r.errors.push(`${path}: must be an object`); return []; }
  const base = readTags(raw.tags ?? {}, `${path}.tags`, r);
  const prefix = base.back ?? `set${index}`;
  const cards: DeckCard[] = [];
  const suits = Array.isArray(raw.suits) ? raw.suits : [];
  const ranks = Array.isArray(raw.ranks) ? raw.ranks : [];
  if (!Array.isArray(raw.suits) || !Array.isArray(raw.ranks)) r.errors.push(`${path}: needs suits and ranks lists`);
  suits.forEach((suit, si) => {
    if (!isRecord(suit) || typeof suit.suit !== 'string' || typeof suit.colour !== 'string' || typeof suit.label !== 'string') {
      r.errors.push(`${path}.suits[${si}]: needs suit, colour and label text`); return;
    }
    const suitName = suit.suit as string;
    const suitColour = suit.colour as string;
    const suitLabel = suit.label as string;
    ranks.forEach((rank, ri) => {
      const rp = `${path}.ranks[${ri}]`;
      if (!isRecord(rank) || typeof rank.rank !== 'string' || typeof rank.kind !== 'string' || typeof rank.label !== 'string') {
        if (si === 0) r.errors.push(`${rp}: needs rank, kind and label text`);
        return;
      }
      const value = readValue(rank.value, `${rp}.value`, r);
      const valueOptions = readOptions(rank.valueOptions, `${rp}.valueOptions`, r);
      cards.push({
        id: `${prefix}:${suitName.toLowerCase()}:${rank.rank}`,
        label: `${rank.label} of ${suitLabel}`,
        tags: lowerTags({ ...base, suit: suitName, colour: suitColour, kind: rank.kind, rank: rank.rank }),
        value, ...(valueOptions ? { valueOptions } : {})
      });
    });
  });
  let extras: unknown[] = [];
  if (raw.extras != null) {
    if (Array.isArray(raw.extras)) extras = raw.extras;
    else r.errors.push(`${path}.extras: must be a list`);
  }
  extras.forEach((extra, ei) => {
    const ep = `${path}.extras[${ei}]`;
    if (!isRecord(extra) || typeof extra.key !== 'string' || typeof extra.label !== 'string') {
      r.errors.push(`${ep}: needs key and label text`); return;
    }
    cards.push({
      id: `${prefix}:${extra.key}`, label: extra.label,
      tags: { ...base, ...readTags(extra.tags ?? {}, `${ep}.tags`, r) }, value: readValue(extra.value, `${ep}.value`, r)
    });
  });
  return cards;
}

function readCard(raw: unknown, index: number, r: Reader): DeckCard | null {
  const path = `cards[${index}]`;
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) { r.errors.push(`${path}: needs an id`); return null; }
  const valueOptions = readOptions(raw.valueOptions, `${path}.valueOptions`, r);
  const card: DeckCard = {
    id: raw.id, label: readText(raw.label, `${path}.label`, r), tags: readTags(raw.tags ?? {}, `${path}.tags`, r),
    value: readValue(raw.value, `${path}.value`, r), ...(valueOptions ? { valueOptions } : {})
  };
  if (raw.copies != null) {
    if (typeof raw.copies !== 'number' || !Number.isInteger(raw.copies) || raw.copies < 1 || raw.copies > DECK_LIMITS.copies) {
      r.errors.push(`${path}.copies: must be 1 to ${DECK_LIMITS.copies}`);
    } else card.copies = raw.copies;
  }
  return card;
}

function readStep(raw: unknown, path: string, allowed: string[], r: Reader): DeckStep | null {
  if (!isRecord(raw)) { r.errors.push(`${path}: must be an object`); return null; }
  const amount = (): string => {
    const text = typeof raw.amount === 'string' ? raw.amount : '';
    const problem = checkAmount(text, allowed);
    if (problem) r.errors.push(`${path}.amount: ${problem}`);
    return text;
  };
  const target = (required: boolean): DeckTarget | undefined => {
    if (raw.target == null && !required) return undefined;
    if (typeof raw.target !== 'string' || !TARGETS.includes(raw.target)) {
      r.errors.push(`${path}.target: must be one of ${TARGETS.join(', ')}`); return 'drawer';
    }
    return raw.target as DeckTarget;
  };
  switch (raw.type) {
    case 'currency': {
      if (typeof raw.coin !== 'string' || !COINS.includes(raw.coin)) r.errors.push(`${path}.coin: must be one of ${COINS.join(', ')}`);
      return { type: 'currency', coin: raw.coin as 'gp', amount: amount(), target: target(true)! };
    }
    case 'heal': case 'damage': case 'temp_hp':
      return { type: raw.type, amount: amount(), target: target(true)! };
    case 'condition': {
      const key = typeof raw.conditionKey === 'string' ? raw.conditionKey.trim() : '';
      if (!key || key.length > 100) r.errors.push(`${path}.conditionKey: must be 1 to 100 characters`);
      const params: Record<string, string> = {};
      if (raw.params != null) {
        if (!isRecord(raw.params)) r.errors.push(`${path}.params: must be an object`);
        else if (Object.keys(raw.params).length > DECK_LIMITS.params) r.errors.push(`${path}.params: more than ${DECK_LIMITS.params}`);
        else for (const [name, expr] of Object.entries(raw.params)) {
          const problem = !NAME_PATTERN.test(name) || isForbiddenKey(name) ? 'bad parameter name' : typeof expr !== 'string' ? 'must be text' : checkAmount(expr, allowed);
          if (problem) r.errors.push(`${path}.params.${name}: ${problem}`); else params[name] = expr as string;
        }
      }
      let durationRounds: number | null | undefined;
      if (raw.durationRounds != null) {
        const d = raw.durationRounds;
        if (typeof d !== 'number' || !Number.isInteger(d) || d < DECK_LIMITS.minRounds || d > DECK_LIMITS.maxRounds) {
          r.errors.push(`${path}.durationRounds: must be ${DECK_LIMITS.minRounds} to ${DECK_LIMITS.maxRounds}`);
        } else durationRounds = d;
      }
      let inverse: { conditionKey?: string; negateParams?: boolean } | undefined;
      if (raw.inverse != null) {
        if (!isRecord(raw.inverse)) r.errors.push(`${path}.inverse: must be an object`);
        else {
          inverse = {};
          if (raw.inverse.conditionKey != null) {
            if (typeof raw.inverse.conditionKey === 'string' && raw.inverse.conditionKey.trim()) inverse.conditionKey = raw.inverse.conditionKey.trim();
            else r.errors.push(`${path}.inverse.conditionKey: must be text`);
          }
          if (raw.inverse.negateParams != null) {
            if (typeof raw.inverse.negateParams === 'boolean') inverse.negateParams = raw.inverse.negateParams;
            else r.errors.push(`${path}.inverse.negateParams: must be true or false`);
          }
        }
      }
      return {
        type: 'condition', conditionKey: key, ...(Object.keys(params).length ? { params } : {}),
        ...(durationRounds !== undefined ? { durationRounds } : {}), target: target(true)!, ...(inverse ? { inverse } : {})
      };
    }
    case 'dm_prompt': {
      const text = readText(raw.text, `${path}.text`, r);
      const inverseText = raw.inverseText == null ? undefined : readText(raw.inverseText, `${path}.inverseText`, r);
      const hideFromPlayers = readFlag(raw.hideFromPlayers, `${path}.hideFromPlayers`, r);
      return {
        type: 'dm_prompt', text, ...(inverseText ? { inverseText } : {}), ...(raw.target != null ? { target: target(false) } : {}),
        ...(hideFromPlayers !== undefined ? { hideFromPlayers } : {})
      };
    }
    default:
      r.errors.push(`${path}.type: unknown step type`);
      return null;
  }
}

function readOutcome(raw: unknown, index: number, r: Reader): DeckOutcome | null {
  const path = `outcomes[${index}]`;
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()) { r.errors.push(`${path}: needs an id`); return null; }
  const rolls: NonNullable<DeckOutcome['rolls']> = [];
  const names = new Set<string>();
  if (raw.rolls != null) {
    if (!Array.isArray(raw.rolls)) r.errors.push(`${path}.rolls: must be a list`);
    else if (raw.rolls.length > DECK_LIMITS.rolls) r.errors.push(`${path}.rolls: more than ${DECK_LIMITS.rolls}`);
    else raw.rolls.forEach((roll, i) => {
      const rp = `${path}.rolls[${i}]`;
      if (!isRecord(roll) || typeof roll.name !== 'string' || !NAME_PATTERN.test(roll.name) || roll.name.toLowerCase() === 'value' || isForbiddenKey(roll.name)) {
        r.errors.push(`${rp}.name: must be a simple name other than "value"`); return;
      }
      const name = roll.name.toLowerCase();
      if (names.has(name)) r.errors.push(`${rp}.name: duplicate roll name "${name}"`);
      names.add(name);
      const problem = typeof roll.dice === 'string' ? checkAmount(roll.dice, [], { requireNoVars: true }) : 'must be text';
      if (problem) r.errors.push(`${rp}.dice: ${problem}`);
      if (roll.per !== 'once' && roll.per !== 'party_member') r.errors.push(`${rp}.per: must be "once" or "party_member"`);
      rolls.push({ name, dice: String(roll.dice), per: roll.per === 'party_member' ? 'party_member' : 'once' });
    });
  }
  const allowed = ['value', ...names];
  const steps: DeckStep[] = [];
  if (!Array.isArray(raw.steps)) r.errors.push(`${path}.steps: must be a list`);
  else {
    if (raw.steps.length > DECK_LIMITS.steps) r.errors.push(`${path}.steps: more than ${DECK_LIMITS.steps}`);
    else raw.steps.forEach((step, i) => {
      const parsed = readStep(step, `${path}.steps[${i}]`, allowed, r);
      if (parsed) steps.push(parsed);
    });
  }
  const inverseText = raw.inverseText == null ? undefined : readText(raw.inverseText, `${path}.inverseText`, r);
  const playerText = raw.playerText == null ? undefined : readText(raw.playerText, `${path}.playerText`, r);
  const hideSuccess = readFlag(raw.hideSuccess, `${path}.hideSuccess`, r);
  return {
    id: raw.id, when: readTags(raw.when ?? {}, `${path}.when`, r), name: readText(raw.name, `${path}.name`, r),
    text: readText(raw.text, `${path}.text`, r), ...(inverseText ? { inverseText } : {}),
    ...(playerText ? { playerText } : {}), ...(hideSuccess !== undefined ? { hideSuccess } : {}),
    ...(rolls.length ? { rolls } : {}), steps
  };
}

function capErrors(errors: string[]): string[] {
  if (errors.length <= DECK_LIMITS.errors) return errors;
  return [...errors.slice(0, DECK_LIMITS.errors), `... and ${errors.length - DECK_LIMITS.errors} more`];
}

/**
 * Validates the authored JSON, expands cardSets + cards, and enforces the limits.
 * `rules` is null when there are errors. Warnings never refuse (cards with no outcome, an empty deck).
 */
export function parseDeckRules(json: unknown): { rules: ExpandedDeckRules | null; errors: string[]; warnings: string[] } {
  const r: Reader = { errors: [] };
  const warnings: string[] = [];
  if (!isRecord(json)) return { rules: null, errors: ['Deck rules must be a JSON object.'], warnings };
  if (json.version !== 1) r.errors.push('version: must be 1');

  // Size checks come before any expansion or iteration, so a huge input is refused cheaply.
  const cards: DeckCard[] = [];
  let planned = 0;
  const listLength = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  if (Array.isArray(json.cardSets)) {
    for (const set of json.cardSets) {
      planned += isRecord(set) ? listLength(set.suits) * listLength(set.ranks) + listLength(set.extras) : 0;
    }
  }
  planned += listLength(json.cards);
  const sizeErrors: string[] = [];
  if (planned > DECK_LIMITS.cards) sizeErrors.push(`The deck would have ${planned} cards (limit ${DECK_LIMITS.cards}).`);
  if (listLength(json.cardSets) > DECK_LIMITS.cardSets) sizeErrors.push(`cardSets: more than ${DECK_LIMITS.cardSets}`);
  if (listLength(json.outcomes) > DECK_LIMITS.outcomes) sizeErrors.push(`outcomes: more than ${DECK_LIMITS.outcomes}`);
  if (isRecord(json.success) && listLength(json.success.rules) > DECK_LIMITS.outcomes) {
    sizeErrors.push(`success.rules: more than ${DECK_LIMITS.outcomes}`);
  }
  if (sizeErrors.length) return { rules: null, errors: sizeErrors, warnings };

  if (json.cardSets != null) {
    if (!Array.isArray(json.cardSets)) r.errors.push('cardSets: must be a list');
    else json.cardSets.forEach((set, i) => cards.push(...expandCardSet(set, i, r)));
  }
  if (json.cards != null) {
    if (!Array.isArray(json.cards)) r.errors.push('cards: must be a list');
    else json.cards.forEach((card, i) => { const parsed = readCard(card, i, r); if (parsed) cards.push(parsed); });
  }
  const cardIds = new Set<string>();
  for (const card of cards) {
    if (cardIds.has(card.id)) r.errors.push(`Duplicate card id "${card.id}".`);
    cardIds.add(card.id);
  }

  const success = readSuccess(json.success, r);

  const outcomes: DeckOutcome[] = [];
  if (!Array.isArray(json.outcomes)) r.errors.push('outcomes: must be a list');
  else {
    const seen = new Set<string>();
    json.outcomes.forEach((raw, i) => {
      const outcome = readOutcome(raw, i, r);
      if (!outcome) return;
      if (seen.has(outcome.id)) r.errors.push(`Duplicate outcome id "${outcome.id}".`);
      seen.add(outcome.id);
      outcomes.push(outcome);
    });
  }

  if (r.errors.length) return { rules: null, errors: capErrors(r.errors), warnings };
  if (!cards.length) warnings.push('The deck has no cards.');
  const orphans = cards.filter((card) => !findOutcome({ outcomes }, card));
  if (orphans.length) {
    const sample = orphans.slice(0, 5).map((card) => card.id).join(', ');
    warnings.push(`${orphans.length} card(s) match no outcome (${sample}${orphans.length > 5 ? ', ...' : ''}).`);
  }
  return { rules: { version: 1, cards, success, outcomes }, errors: [], warnings };
}

// ---------------------------------------------------------------- planning a draw

export type PlanDrawInput = {
  rules: Pick<ExpandedDeckRules, 'outcomes'>;
  card: DeckCard;
  success: boolean;
  chosenValue?: number | null;
  drawerId: string;
  partyIds: string[];
  rollDie?: RollDie;
};

const KIND_OF_STEP = { currency: 'coin', heal: 'hp', damage: 'hp', temp_hp: 'temp_hp' } as const;

/** Turns a drawn card into per-character lines and DM tasks. Failure inverts everything. */
export function planDraw(input: PlanDrawInput): DrawPlan {
  const { rules, card, success, drawerId } = input;
  const rollDie = input.rollDie ?? defaultRollDie;
  const party = Array.from(new Set([...input.partyIds, drawerId])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const value = cardValue(card, input.chosenValue);
  const sourceLabel = success ? card.label : `${card.label}, failed`;
  const outcome = findOutcome(rules, card);

  if (!outcome) {
    const text = `No outcome for ${card.label}`;
    return { lines: [], tasks: [{ text, characterIds: [drawerId] }], outcome: { id: 'none', name: 'No outcome', text, rolls: [] } };
  }

  // Named rolls first, in party order, so shared dice are fixed before any step reads them.
  const vars: Record<string, number> = { value };
  const rolls: PlannedRoll[] = [];
  for (const roll of outcome.rolls ?? []) {
    if (roll.per === 'once') {
      const result = evaluateAmount(roll.dice, vars, rollDie);
      vars[roll.name] = result.total;
      rolls.push({ name: roll.name, total: result.total, text: result.text });
    } else {
      const totals = party.map(() => evaluateAmount(roll.dice, vars, rollDie).total);
      const total = Math.min(DECK_LIMITS.amount, totals.reduce((sum, n) => sum + n, 0));
      vars[roll.name] = total;
      rolls.push({ name: roll.name, total, text: `${totals.join(' + ')} = ${total}` });
    }
  }

  const targets = (target: DeckTarget | undefined) => (target === 'drawer' ? [drawerId] : party);
  const lines: PlannedLine[] = [];
  const tasks: PlannedTask[] = [];
  const flip = (n: number) => (success ? n : 0 - n);

  for (const step of outcome.steps) {
    if (step.type === 'dm_prompt') {
      tasks.push({
        text: success ? step.text : (step.inverseText ?? `Inverted: ${step.text}`), characterIds: targets(step.target),
        ...(step.hideFromPlayers ? { hidden: true } : {})
      });
    } else if (step.type === 'condition') {
      const key = !success && step.inverse?.conditionKey ? step.inverse.conditionKey : step.conditionKey;
      const negate = !success && step.inverse?.negateParams !== false;
      for (const characterId of targets(step.target)) {
        const params: Record<string, number> = {};
        for (const [name, expr] of Object.entries(step.params ?? {})) {
          const total = evaluateAmount(expr, vars, rollDie, { floor: false }).total;
          params[name] = negate ? 0 - total : total;
        }
        lines.push({
          characterId, kind: 'condition', amount: 0, conditionKey: key, params,
          durationRounds: step.durationRounds ?? null, sourceLabel
        });
      }
    } else {
      const sign = step.type === 'damage' ? -1 : 1;
      const kind = KIND_OF_STEP[step.type];
      const push = (characterId: string, amount: number, detail: string) => {
        if (amount === 0) return;
        lines.push({
          characterId, kind, amount: flip(sign * amount), sourceLabel, detail,
          ...(step.type === 'currency' ? { coin: step.coin } : {})
        });
      };
      if (step.target === 'party_split') {
        // One roll, split evenly; the remainder goes to the drawer.
        const result = evaluateAmount(step.amount, vars, rollDie);
        const share = Math.floor(result.total / party.length);
        const remainder = result.total - share * party.length;
        for (const characterId of party) {
          const own = share + (characterId === drawerId ? remainder : 0);
          push(characterId, own, `${result.text}, split ${party.length} ways`);
        }
      } else {
        for (const characterId of targets(step.target)) {
          const result = evaluateAmount(step.amount, vars, rollDie);
          push(characterId, result.total, result.text);
        }
      }
    }
  }

  const shown = success ? outcome.text : (outcome.inverseText ?? `Inverted: ${outcome.text}`);
  return {
    lines, tasks,
    outcome: {
      id: outcome.id, name: outcome.name, text: shown, rolls,
      ...(outcome.playerText ? { playerText: outcome.playerText } : {}),
      ...(outcome.hideSuccess ? { hideSuccess: true } : {})
    }
  };
}

// ---------------------------------------------------------------- pure appliers

/** Coins never go below 0 (no debt, no change-making). `shortfall` is how much of a loss couldn't be taken. */
export function applyCoin(before: number, delta: number): { after: number; shortfall: number } {
  const after = Math.max(0, before + delta);
  return { after, shortfall: delta < 0 ? Math.max(0, -delta - before) : 0 };
}

/** Heal caps at max HP; damage takes temp HP first, then HP, floored at 0. */
export function applyHp(
  state: { hp: number; max: number; temp: number }, delta: number
): { hp: number; temp: number; absorbed: number; note?: string } {
  if (delta >= 0) {
    return { hp: Math.max(state.hp, Math.min(state.max, state.hp + delta)), temp: state.temp, absorbed: 0 };
  }
  const damage = -delta;
  const absorbed = Math.min(state.temp, damage);
  const hp = Math.max(0, state.hp - (damage - absorbed));
  return {
    hp, temp: state.temp - absorbed, absorbed,
    ...(hp === 0 && state.hp > 0 ? { note: 'Dropped to 0 HP.' } : {})
  };
}

/** Deck temp HP STACKS (adds on top, no keep-the-higher rule). A loss floors at 0. */
export function applyTempHp(temp: number, delta: number): { temp: number; note?: string } {
  const after = Math.max(0, temp + delta);
  const short = delta < 0 ? Math.max(0, -delta - temp) : 0;
  return { temp: after, ...(short ? { note: `Only had ${temp} temp HP (${short} short).` } : {}) };
}

// ---------------------------------------------------------------- roll-log wording

const CONDITION_STATS: Record<string, string> = {
  'condition:deck_fate_ac': 'AC',
  'condition:deck_fate_hit': 'to hit'
};

function durationText(rounds: number | null | undefined): string {
  if (!rounds) return '';
  if (rounds % 10 === 0) return ` for ${rounds / 10} minute${rounds === 10 ? '' : 's'}`;
  return ` for ${rounds} round${rounds === 1 ? '' : 's'}`;
}

/** One planned line in words, e.g. "Thorne loses 3 AC for 1 minute". */
export function describeLine(line: PlannedLine, names: Record<string, string>): string {
  const who = names[line.characterId] ?? 'Someone';
  const n = Math.abs(line.amount);
  switch (line.kind) {
    case 'coin': return `${who} ${line.amount < 0 ? 'loses' : 'gains'} ${n} ${line.coin ?? 'gp'}`;
    case 'hp': return line.amount < 0 ? `${who} takes ${n} damage` : `${who} heals ${n} HP`;
    case 'temp_hp': return `${who} ${line.amount < 0 ? 'loses' : 'gains'} ${n} temp HP`;
    default: {
      const stat = CONDITION_STATS[line.conditionKey ?? ''];
      const amount = line.params?.value;
      const when = durationText(line.durationRounds);
      if (stat && typeof amount === 'number') return `${who} ${amount < 0 ? 'loses' : 'gains'} ${Math.abs(amount)} ${stat}${when}`;
      return `${who} is affected by ${(line.conditionKey ?? 'a condition').replace(/^condition:/, '').replace(/_/g, ' ')}${when}`;
    }
  }
}

/**
 * What a non-DM may see of a draw. Pure, so the server and the tests share it.
 * The outcome text becomes the player wording, success may be hidden, and hidden task text is blanked
 * (the task keeps its id, done flag and characters so the UI can still say "Waiting on the DM.").
 */
export function playerDrawView(view: DrawView): DrawView {
  const { playerText, hideSuccess, ...outcome } = view.outcome;
  return {
    ...view,
    success: hideSuccess ? null : view.success,
    outcome: { ...outcome, ...(playerText ? { text: playerText } : {}) },
    dmTasks: view.dmTasks.map((task) => (task.hidden ? { ...task, text: '' } : task))
  };
}

/**
 * The roll-log line, e.g. "Thorne drew the 3 of Clubs (gold back): failure. Thorne loses 3 AC for 1 minute."
 * A null success leaves the result out, and an empty task text reads "Waiting on the DM." (said once).
 */
export function drawSummary(draw: DrawSummaryInput, names: Record<string, string>): string {
  const back = draw.card.tags.back ? ` (${draw.card.tags.back} back)` : '';
  const counted = draw.chosenValue != null ? `, counted as ${draw.chosenValue}` : '';
  const result = draw.success == null ? '' : `: ${draw.success ? 'success' : 'failure'}`;
  const head = `${names[draw.drawerId] ?? 'Someone'} drew the ${draw.card.label}${back}${counted}${result}.`;
  const text = draw.text?.trim() ? [draw.text.trim().replace(/[^.!?]$/, '$&.')] : [];
  const hiddenTask = draw.tasks.some((task) => !task.text);
  const parts = [
    ...text,
    ...draw.lines.map((line) => `${describeLine(line, names)}.`),
    ...draw.tasks.filter((task) => task.text).map((task) => `Waiting on the DM: ${task.text}.`),
    ...(hiddenTask ? ['Waiting on the DM.'] : [])
  ];
  return [head, ...parts].join(' ');
}

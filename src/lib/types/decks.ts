// Types for data-driven card decks. Rules are pure data; see docs/plans (decks) for the model.

/** Lower-case keys and values: kind, rank, suit, colour, back, ... */
export type CardTags = Record<string, string>;

export type DeckCard = {
  id: string;
  label: string;
  tags: CardTags;
  value: number | null;
  /** When present the drawer picks one of these (e.g. an Ace is 1 or 11). */
  valueOptions?: number[];
  /** Weight for the random pick (default 1). */
  copies?: number;
};

/** Shorthand the parser expands into DeckCard[] (suits x ranks, plus extras such as jokers). */
export type CardSet = {
  tags: CardTags;
  suits: Array<{ suit: string; colour: string; label: string }>;
  ranks: Array<{ rank: string; kind: string; label: string; value: number | null; valueOptions?: number[] }>;
  extras?: Array<{ key: string; label: string; tags: CardTags; value?: number | null }>;
};

export type DeckCoin = 'cp' | 'sp' | 'ep' | 'gp' | 'pp';
export type DeckTarget = 'drawer' | 'each_party_member' | 'party_split';

export type DeckStep =
  | { type: 'currency'; coin: DeckCoin; amount: string; target: DeckTarget }
  | { type: 'heal'; amount: string; target: DeckTarget }
  | { type: 'damage'; amount: string; target: DeckTarget }
  | { type: 'temp_hp'; amount: string; target: DeckTarget }
  | {
      type: 'condition'; conditionKey: string; params?: Record<string, string>; durationRounds?: number | null;
      target: DeckTarget; inverse?: { conditionKey?: string; negateParams?: boolean };
    }
  | {
      type: 'dm_prompt'; text: string; inverseText?: string; target?: DeckTarget;
      /** Non-DMs see "Waiting on the DM." instead of the task text. */
      hideFromPlayers?: boolean;
    };

export type DeckRoll = { name: string; dice: string; per: 'once' | 'party_member' };

export type DeckOutcome = {
  id: string;
  when: CardTags;
  name: string;
  text: string;
  inverseText?: string;
  /** What non-DMs see instead of text / inverseText (success or failure). Presentation only. */
  playerText?: string;
  /** Non-DMs see neither Success nor Failure for this outcome. */
  hideSuccess?: boolean;
  rolls?: DeckRoll[];
  steps: DeckStep[];
};

export type DeckSuccessRules = {
  rules: Array<{ when: CardTags; result: 'success' | 'failure' }>;
  otherwise: 'success' | 'failure';
};

/** The authored JSON. */
export type DeckRules = {
  version: 1;
  cardSets?: CardSet[];
  cards?: DeckCard[];
  success: DeckSuccessRules;
  outcomes: DeckOutcome[];
};

/** What the parser returns: card sets already expanded into `cards`. */
export type ExpandedDeckRules = {
  version: 1;
  cards: DeckCard[];
  success: DeckSuccessRules;
  outcomes: DeckOutcome[];
};

export type PlannedLineKind = 'coin' | 'hp' | 'temp_hp' | 'condition';

export type PlannedLine = {
  characterId: string;
  kind: PlannedLineKind;
  coin?: DeckCoin;
  /** Signed. Zero for conditions (their values live in params). */
  amount: number;
  conditionKey?: string;
  /** Evaluated, and already negated on failure. */
  params?: Record<string, number>;
  durationRounds?: number | null;
  sourceLabel: string;
  /** Roll breakdown text, e.g. "2d10[7,3] + 5 = 15". */
  detail?: string;
};

export type PlannedTask = { text: string; characterIds: string[]; hidden?: boolean };

export type PlannedRoll = { name: string; total: number; text: string };

export type DrawPlan = {
  lines: PlannedLine[];
  tasks: PlannedTask[];
  outcome: { id: string; name: string; text: string; rolls: PlannedRoll[]; playerText?: string; hideSuccess?: boolean };
};

/** Input to drawSummary: what was drawn and what it did. */
export type DrawSummaryInput = {
  drawerId: string;
  card: Pick<DeckCard, 'label' | 'tags'>;
  /** null = hidden from this viewer (the line omits success/failure). */
  success: boolean | null;
  chosenValue?: number | null;
  lines: PlannedLine[];
  /** An empty text means a hidden task ("Waiting on the DM."). */
  tasks: Array<{ text: string }>;
  /** Extra wording after the head, used for the player version of an outcome. */
  text?: string;
};

// ---- Draw records (what the service stores and returns). Mechanics are never stored, only what was applied.

export type DrawStatus = 'choosing' | 'resolved' | 'reverted' | 'cancelled';

/** One change that was ACTUALLY applied (clamps included). Undo reverses exactly this. */
export type DrawResultLine = {
  characterId: string;
  kind: PlannedLineKind;
  coin?: DeckCoin;
  /** The planned signed amount (conditions: 0). */
  requested: number;
  before: number;
  after: number;
  /** hp lines only: temp HP before/after (damage is absorbed by temp HP first). */
  tempBefore?: number;
  tempAfter?: number;
  /** condition lines: the active_character_effects row, and what was applied. */
  effectRowId?: string;
  conditionKey?: string;
  /** Planned wording, e.g. "Thorne loses 3 AC for 1 minute". */
  text: string;
  /** hp lines: what each live VTT token (by token id) actually took, so undo reverses each by its own amount. */
  tokenHpDeltas?: Record<string, number>;
  note?: string;
};

export type DmTask = {
  id: string; text: string; characterIds: string[]; done: boolean; doneByUserId: string | null; doneAt: string | null;
  /** Hidden from players: their view carries an empty text. */
  hidden?: boolean;
};

export type DrawView = {
  id: string;
  deckId: string;
  deckName: string;
  campaignId: string;
  drawerCharacterId: string;
  drawerName: string;
  card: Pick<DeckCard, 'id' | 'label' | 'tags' | 'value' | 'valueOptions'>;
  /** null = hidden from this viewer (only the player view sets it). */
  success: boolean | null;
  chosenValue: number | null;
  status: DrawStatus;
  outcome: { id?: string; name?: string; text?: string; rolls?: PlannedRoll[]; playerText?: string; hideSuccess?: boolean };
  results: DrawResultLine[];
  dmTasks: DmTask[];
  createdAt: string;
  resolvedAt: string | null;
  revertedAt: string | null;
  revertNote: string;
  /** Only while choosing: the effect of each option, so the player can pick. */
  previews?: Record<string, string>;
};

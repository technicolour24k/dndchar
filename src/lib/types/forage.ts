// Types for the forage / loot finder (docs: vtt-forage plan). Find tables only point at existing
// item Containers, so there is no item vocabulary here beyond ids and display fields.

export type FindMode = 'dm' | 'self';
export type FindStatus = 'checked' | 'failed' | 'found' | 'reverted';

export type FindTableEntry = {
  itemId: string;
  itemName: string;
  itemCategory: string;
  /** Percent chance (0 = Off, never found), rolled on its own: d100 <= chance. */
  chance: number;
  qtyDie: number;
  itemArchived: boolean;
  sortOrder: number;
  /** Where a homebrew item came from (authoring view only; '' for core items). */
  sourceLabel?: string;
};

export type FindTable = {
  id: string;
  /** The campaign this table belongs to (every table belongs to exactly one). */
  campaignId: string;
  /** Only filled by the authoring list; the cached catalogue leaves it blank. */
  campaignName: string;
  name: string;
  areaType: string;
  category: string;
  /** DM-side reminder only. Never sent to players (Q9). */
  suggestedCheck: string;
  isArchived: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  entryCount: number;
  pickableCount: number;
};

/** A table plus its entries, as the cached catalogue holds them (active tables only). */
// Player-safe by design (Q9): no suggestedCheck. That DM-side reminder is read separately.
export type ForageCatalogueTable = Omit<FindTable, 'ownerName' | 'entryCount' | 'suggestedCheck' | 'campaignName'> & { entries: FindTableEntry[] };
export type ForageCatalogue = { tables: ForageCatalogueTable[] };

/** One rolled or approved result line. */
export type FindLine = { itemId: string; qty: number };

export type ForageChoice = { skillKey: string; areaType: string; category: string; tableId: string };

/** A rolled skill check, as stored in finds.check_json and shown to the finder and the DM. */
export type ForageCheck = {
  skillKey: string;
  skillLabel: string;
  total: number;
  /** The kept d20 (after any advantage or disadvantage pool). */
  natural: number;
  nat20: boolean;
  nat1: boolean;
  /** Source-attributed audit text from rollWithModifiers. */
  text: string;
  poolSummary: string;
};

/** One haul line once it has reached an inventory row. `qty` is what this find added. */
export type FindResult = { item_id: string; qty: number; inventory_id: string };

/**
 * Why a character can't forage right now. Campaign-level facts only: never anything about individual
 * tables (Rev 4), so a player learns "your campaign has none" and nothing more.
 */
export type ForageUnavailableReason = 'no_campaign' | 'wrong_room' | 'no_tables';

/** GET /vtt/api/forage/mine: the finder's private forage state (what the character sheet reads). */
export type ForageMine = {
  /** Can this character forage right now? Absent on an old server (treated as available). */
  available?: boolean;
  unavailableReason?: ForageUnavailableReason | null;
  /** Server clock at response time (ms), for comparing lastDm.closedAt without trusting the client clock. */
  serverNow?: number;
  roomId: string | null;
  inRoom: boolean;
  dmPresent: boolean;
  pending: { id: string; stage: string; source: string; check: ForageCheck | null } | null;
  pendingRoomId: string | null;
  pendingCharacter?: { id: string; name: string } | null;
  lastDm: {
    requestId: string; characterId: string; outcome: 'failed' | 'approved' | 'cancelled'; check: ForageCheck | null;
    lines?: Array<{ name: string; qty: number }>; findId?: string; shared?: boolean; closedAt: number;
  } | null;
  unmarkedSelf: { findId: string; characterId: string; characterName?: string; check: ForageCheck; roomCode: string | null } | null;
};

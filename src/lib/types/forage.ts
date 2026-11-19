// Types for the forage / loot finder (docs: vtt-forage plan). Find tables only point at existing
// item Containers, so there is no item vocabulary here beyond ids and display fields.

export type FindMode = 'dm' | 'self';
export type FindStatus = 'checked' | 'failed' | 'found' | 'reverted';

export type FindTableEntry = {
  itemId: string;
  itemName: string;
  itemCategory: string;
  weight: number;
  qtyDie: number;
  itemArchived: boolean;
  sortOrder: number;
};

export type FindTable = {
  id: string;
  name: string;
  areaType: string;
  category: string;
  typeDie: number;
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
export type ForageCatalogueTable = Omit<FindTable, 'ownerName' | 'entryCount' | 'suggestedCheck'> & { entries: FindTableEntry[] };
export type ForageCatalogue = { tables: ForageCatalogueTable[] };

/** One rolled or approved result line. */
export type FindLine = { itemId: string; qty: number };

export type ForageChoice = { skillKey: string; areaType: string; category: string; tableId: string };

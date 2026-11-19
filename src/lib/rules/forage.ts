import type { FindTableEntry, ForageCatalogue, ForageCatalogueTable } from '$lib/types/forage';

// Pure helpers for find tables. No DB, no randomness here yet (the roll lands in unit B).

/** Suggestions for the area/category inputs. Free text still wins, so homebrew stays easy. */
export const DEFAULT_FORAGE_CATEGORIES = ['plant', 'ore', 'gem', 'scroll', 'misc'];

/** Area types and categories are stored trimmed, lower-cased, with inner whitespace collapsed. */
export function normaliseTag(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value ?? '').trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

export type ParsedTableInput = {
  name: string;
  areaType: string;
  category: string;
  typeDie: number;
  suggestedCheck: string;
};

/** Validates the table form fields. Throws an Error with a user-facing message. */
export function parseTableInput(raw: {
  name?: unknown; areaType?: unknown; category?: unknown; typeDie?: unknown; suggestedCheck?: unknown;
}): ParsedTableInput {
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Table name must be 1 to 80 characters.');
  const areaType = normaliseTag(raw.areaType);
  if (!areaType || areaType.length > 40) throw new Error('Area type must be 1 to 40 characters.');
  const category = normaliseTag(raw.category);
  if (!category || category.length > 40) throw new Error('Category must be 1 to 40 characters.');
  const typeDie = parseInteger(raw.typeDie);
  if (typeDie === null || typeDie < 1 || typeDie > 100) throw new Error('Type die must be a whole number from 1 to 100.');
  const suggestedCheck = String(raw.suggestedCheck ?? '').trim();
  if (suggestedCheck.length > 80) throw new Error('Suggested check must be 80 characters or fewer.');
  return { name, areaType, category, typeDie, suggestedCheck };
}

export type ParsedEntryInput = { weight: number; qtyDie: number };

/** Validates one entry's weight and quantity die. Throws an Error with a user-facing message. */
export function parseEntryInput(raw: { weight?: unknown; qtyDie?: unknown }): ParsedEntryInput {
  const weight = parseInteger(raw.weight);
  if (weight === null || weight < 0 || weight > 1000) throw new Error('Weight must be a whole number from 0 to 1000.');
  const qtyDie = parseInteger(raw.qtyDie);
  if (qtyDie === null || qtyDie < 1) throw new Error('Quantity die must be 1 or more (1 means always one).');
  if (qtyDie > 100) throw new Error('Quantity die must be 100 or fewer.');
  return { weight, qtyDie };
}

/** An entry can be rolled if it has weight and its item is not archived. */
export function isPickable(entry: Pick<FindTableEntry, 'weight' | 'itemArchived'>): boolean {
  return entry.weight > 0 && !entry.itemArchived;
}

export function pickableEntries<T extends Pick<FindTableEntry, 'weight' | 'itemArchived'>>(entries: T[]): T[] {
  return entries.filter(isPickable);
}

/** The active table for an area type + category, or null. Archived tables never match. */
export function resolveTable(
  catalogue: ForageCatalogue,
  areaType: string,
  category: string
): ForageCatalogueTable | null {
  const area = normaliseTag(areaType);
  const cat = normaliseTag(category);
  return catalogue.tables.find((table) => !table.isArchived && table.areaType === area && table.category === cat) ?? null;
}

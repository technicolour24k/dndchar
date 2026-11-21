// Parsing and validation for form / JSON input from the overworld client. Pure, no I/O, so the server
// actions stay thin and the rules are unit tested. Every parser returns { ok: true, ... } or
// { ok: false, reason } with a short message that is safe to show to the user.
import {
  COLOUR_KEYS,
  ICON_KEYS,
  MAX_LABEL,
  MAX_MAP_NAME,
  MAX_MILES_ACROSS,
  MAX_NOTE,
  MAX_ROUTE_POINTS,
  MIN_ROUTE_POINTS,
  type OverworldColour,
  type OverworldIcon
} from './palette';
import type { OverworldVisibility, PinKind, Pt } from '$lib/types/overworld';

export type Parsed<T> = ({ ok: true } & T) | { ok: false; reason: string };

// Anything with a FormData-style get(): FormData itself, or a Map-like stub in tests.
export type FormLike = { get(name: string): unknown };

// Two points closer than this (in 0..1 units) count as the same point.
const SAME_POINT = 1e-6;

// Longest route JSON we will parse.
const MAX_ROUTE_JSON_CHARS = 50_000;

function text(form: FormLike, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' ? value : null;
}

// Strict plain-decimal parse: rejects empty / whitespace-only text and anything Number() would accept
// that a user did not mean as a decimal (0x1, 1e3, Infinity). Null when it is not a plain number.
function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// C0 control characters (and DEL). Notes may keep tab, newline and carriage return (textareas send
// CRLF); labels and names allow none.
const CONTROL_ANY = /[\u0000-\u001F\u007F]/;
const CONTROL_NOTE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function inUnit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

// A route's points, as JSON text (from a form field) or an already-parsed array. 2..201 points, each
// {x, y} finite and within 0..1; consecutive duplicates are dropped and at least 2 must remain.
export function parseRoutePoints(raw: unknown): Parsed<{ points: Pt[] }> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    // A real route is a few KB at most (201 points); refuse huge text before parsing it.
    if (raw.length > MAX_ROUTE_JSON_CHARS) return { ok: false, reason: 'The route is too long.' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'The route points could not be read.' };
    }
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'The route points must be a list.' };
  if (value.length < MIN_ROUTE_POINTS) return { ok: false, reason: 'A route needs at least two points.' };
  if (value.length > MAX_ROUTE_POINTS) {
    return { ok: false, reason: `A route can have at most ${MAX_ROUTE_POINTS - 1} legs.` };
  }

  const points: Pt[] = [];
  for (const item of value) {
    const p = item as { x?: unknown; y?: unknown } | null;
    if (!p || typeof p !== 'object' || !inUnit(p.x) || !inUnit(p.y)) {
      return { ok: false, reason: 'A route point is outside the map.' };
    }
    const last = points[points.length - 1];
    if (last && Math.abs(last.x - p.x) < SAME_POINT && Math.abs(last.y - p.y) < SAME_POINT) continue;
    points.push({ x: p.x, y: p.y });
  }
  if (points.length < MIN_ROUTE_POINTS) return { ok: false, reason: 'A route needs at least two different points.' };
  return { ok: true, points };
}

// What a pin form can carry. Which fields are present depends on the mode (see parsePinInput).
export type PinFields = {
  kind?: PinKind;
  x?: number;
  y?: number;
  label?: string;
  note?: string;
  colour?: OverworldColour;
  icon?: OverworldIcon;
  visibility?: OverworldVisibility;
};

// Modes:
//  'create' - x and y required; kind optional (default 'pin'); other fields optional (the database
//             defaults apply to anything left out).
//  'update' - x, y and kind are ignored; every other field is optional, and a missing field is left
//             unchanged (so the result only has the keys the form actually sent).
//  'move'   - only x and y are read, and both are required.
export function parsePinInput(form: FormLike, mode: 'create' | 'update' | 'move'): Parsed<{ fields: PinFields }> {
  const fields: PinFields = {};

  if (mode === 'create' || mode === 'move') {
    const x = parseNumber(text(form, 'x'));
    const y = parseNumber(text(form, 'y'));
    if (x === null || y === null || !inUnit(x) || !inUnit(y)) {
      return { ok: false, reason: 'Pick a spot on the map.' };
    }
    fields.x = x;
    fields.y = y;
    if (mode === 'move') return { ok: true, fields };
  }

  if (mode === 'create') {
    const kind = text(form, 'kind');
    if (kind !== null && kind !== '') {
      if (kind !== 'pin' && kind !== 'party') return { ok: false, reason: 'Unknown pin type.' };
      fields.kind = kind;
    }
  }

  const label = text(form, 'label');
  if (label !== null) {
    const trimmed = label.trim();
    if (CONTROL_ANY.test(trimmed)) return { ok: false, reason: 'Labels cannot contain control characters.' };
    if (trimmed.length > MAX_LABEL) return { ok: false, reason: `Labels can be up to ${MAX_LABEL} characters.` };
    fields.label = trimmed;
  }

  const note = text(form, 'note');
  if (note !== null) {
    const trimmed = note.trim();
    if (CONTROL_NOTE.test(trimmed)) return { ok: false, reason: 'Notes cannot contain control characters.' };
    if (trimmed.length > MAX_NOTE) return { ok: false, reason: `Notes can be up to ${MAX_NOTE} characters.` };
    fields.note = trimmed;
  }

  const colour = text(form, 'colour');
  if (colour !== null && colour !== '') {
    if (!(COLOUR_KEYS as readonly string[]).includes(colour)) return { ok: false, reason: 'Unknown colour.' };
    fields.colour = colour as OverworldColour;
  }

  const icon = text(form, 'icon');
  if (icon !== null && icon !== '') {
    if (!(ICON_KEYS as readonly string[]).includes(icon)) return { ok: false, reason: 'Unknown icon.' };
    fields.icon = icon as OverworldIcon;
  }

  const visibility = text(form, 'visibility');
  if (visibility !== null && visibility !== '') {
    if (visibility !== 'everyone' && visibility !== 'private') return { ok: false, reason: 'Unknown visibility.' };
    fields.visibility = visibility;
  }

  return { ok: true, fields };
}

// Map name and the optional typed scale. The image comes separately, as a File. A blank or missing
// scale means "no scale" (null), which on an update clears it.
export function parseMapFields(form: FormLike): Parsed<{ name: string; milesAcross: number | null }> {
  const name = (text(form, 'name') ?? '').trim();
  if (CONTROL_ANY.test(name)) return { ok: false, reason: 'Map names cannot contain control characters.' };
  if (name.length < 1) return { ok: false, reason: 'Give the map a name.' };
  if (name.length > MAX_MAP_NAME) return { ok: false, reason: `Map names can be up to ${MAX_MAP_NAME} characters.` };

  const rawScale = (text(form, 'milesAcross') ?? '').trim();
  if (rawScale === '') return { ok: true, name, milesAcross: null };
  const milesAcross = parseNumber(rawScale);
  if (milesAcross === null || milesAcross <= 0 || milesAcross > MAX_MILES_ACROSS) {
    return { ok: false, reason: `The scale must be a number of miles above zero, up to ${MAX_MILES_ACROSS}.` };
  }
  return { ok: true, name, milesAcross };
}

// What a route form can carry. Only the keys the form actually sent are returned, so on an update a
// missing field is left unchanged and on create the database defaults apply.
export type RouteFields = { label?: string; colour?: OverworldColour; visibility?: OverworldVisibility };

export function parseRouteFields(form: FormLike): Parsed<{ fields: RouteFields }> {
  const fields: RouteFields = {};

  const label = text(form, 'label');
  if (label !== null) {
    const trimmed = label.trim();
    if (CONTROL_ANY.test(trimmed)) return { ok: false, reason: 'Labels cannot contain control characters.' };
    if (trimmed.length > MAX_LABEL) return { ok: false, reason: `Labels can be up to ${MAX_LABEL} characters.` };
    fields.label = trimmed;
  }

  const colour = text(form, 'colour');
  if (colour !== null && colour !== '') {
    if (!(COLOUR_KEYS as readonly string[]).includes(colour)) return { ok: false, reason: 'Unknown colour.' };
    fields.colour = colour as OverworldColour;
  }

  const visibility = text(form, 'visibility');
  if (visibility !== null && visibility !== '') {
    if (visibility !== 'everyone' && visibility !== 'private') return { ok: false, reason: 'Unknown visibility.' };
    fields.visibility = visibility;
  }

  return { ok: true, fields };
}

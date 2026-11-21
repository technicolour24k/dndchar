// Overworld colours, icons and limits. The colour and icon keys MUST match the CHECK constraints in
// migration 040_overworld_maps.sql. Safe to import from client code (no server imports).

export const COLOUR_KEYS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'white'] as const;
export type OverworldColour = (typeof COLOUR_KEYS)[number];

export const COLOURS: Record<OverworldColour, { label: string; hex: string }> = {
  red: { label: 'Red', hex: '#e5484d' },
  orange: { label: 'Orange', hex: '#f76b15' },
  yellow: { label: 'Yellow', hex: '#f5d90a' },
  green: { label: 'Green', hex: '#30a46c' },
  teal: { label: 'Teal', hex: '#12a594' },
  blue: { label: 'Blue', hex: '#3e63dd' },
  purple: { label: 'Purple', hex: '#8e4ec6' },
  white: { label: 'White', hex: '#ffffff' }
};

export const ICON_KEYS = ['dot', 'star', 'flag', 'cross', 'question', 'exclaim', 'camp', 'tower'] as const;
export type OverworldIcon = (typeof ICON_KEYS)[number];

// A single character per icon keeps the first version cheap; the pin layer can swap in SVG paths later.
export const ICONS: Record<OverworldIcon, { label: string; glyph: string }> = {
  dot: { label: 'Dot', glyph: '●' },
  star: { label: 'Star', glyph: '★' },
  flag: { label: 'Flag', glyph: '⚑' },
  cross: { label: 'Cross', glyph: '✖' },
  question: { label: 'Question mark', glyph: '?' },
  exclaim: { label: 'Exclamation mark', glyph: '!' },
  camp: { label: 'Camp', glyph: '▲' },
  tower: { label: 'Tower', glyph: '♜' }
};

// Party pins use a fixed glyph and ignore the icon choice.
export const PARTY_GLYPH = '⚔';

export const DEFAULT_PIN_COLOUR: OverworldColour = 'red';
export const DEFAULT_PIN_ICON: OverworldIcon = 'dot';
export const DEFAULT_ROUTE_COLOUR: OverworldColour = 'white';

// Largest scale a DM can set (miles across the full width); mirrors the migration CHECK.
export const MAX_MILES_ACROSS = 100_000;

// 5e normal travel pace.
export const MILES_PER_DAY_NORMAL = 24;

// Limits. Text and count limits mirror the migration's CHECKs where there is one.
export const MAX_MAP_NAME = 80;
export const MAX_LABEL = 60;
export const MAX_NOTE = 1000;
export const MAX_PINS_PER_MAP = 500;
export const MAX_ROUTES_PER_MAP = 200;
export const MAX_LEGS_PER_ROUTE = 200;
// A route of N legs has N + 1 points.
export const MAX_ROUTE_POINTS = MAX_LEGS_PER_ROUTE + 1;
export const MIN_ROUTE_POINTS = 2;

// Uploads: the browser downscales to the CLIENT_* limits, the server allows a little slack in case a
// browser rounds differently.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const CLIENT_MAX_EDGE = 5000;
export const CLIENT_MAX_PIXELS = 16_000_000;
export const SERVER_MAX_EDGE = 6000;
export const SERVER_MAX_PIXELS = 20_000_000;

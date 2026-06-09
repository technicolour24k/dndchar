import pg from 'pg';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const apiBase = process.env.SRD_API_BASE_URL || 'https://www.dnd5eapi.co/api/2014';
const defaultEndpoints = ['conditions', 'features', 'spells', 'traits'] as const;
const requestedEndpoints = (process.env.SRD_IMPORT_ENDPOINTS || '')
  .split(',')
  .map((endpoint) => endpoint.trim())
  .filter(Boolean);
const endpoints = (requestedEndpoints.length ? requestedEndpoints : defaultEndpoints).filter(
  (endpoint): endpoint is (typeof defaultEndpoints)[number] =>
    defaultEndpoints.includes(endpoint as (typeof defaultEndpoints)[number])
);
const requestDelayMs = Math.max(0, Number(process.env.SRD_IMPORT_DELAY_MS) || 200);
const maxRetries = Math.max(1, Number(process.env.SRD_IMPORT_MAX_RETRIES) || 6);

type ApiReference = {
  index: string;
  name: string;
  url: string;
};

type ApiListResponse = {
  results: ApiReference[];
};

type ApiDetail = {
  index: string;
  name: string;
  desc?: string[];
  duration?: string;
  concentration?: boolean;
  level?: number;
};

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

function effectKey(endpoint: (typeof endpoints)[number], index: string) {
  if (endpoint === 'conditions') return `condition_${index.replaceAll('-', '_')}`;
  if (endpoint === 'features' && index.includes('ability-score-improvement')) return 'feature_ability_score_improvement';
  if (endpoint === 'features' && index === 'rage') return 'rage';
  if (endpoint === 'spells' && index === 'bless') return 'bless';
  if (endpoint === 'spells' && index === 'haste') return 'haste';
  if (endpoint === 'spells' && index === 'shield') return 'shield_spell';
  return `${endpoint.slice(0, -1)}_${index.replaceAll('-', '_')}`;
}

function sourceRef(endpoint: (typeof endpoints)[number], index: string) {
  return `${endpoint}.${index}`;
}

function sourceType(endpoint: (typeof endpoints)[number]) {
  if (endpoint === 'conditions') return 'condition';
  if (endpoint === 'features') return 'class_feature';
  if (endpoint === 'spells') return 'spell';
  return 'trait';
}

function durationType(detail: ApiDetail) {
  if (detail.concentration) return 'concentration';
  if (!detail.duration) return 'variable';
  const duration = detail.duration.toLowerCase();
  if (duration.includes('instantaneous')) return 'instantaneous';
  if (duration.includes('round')) return 'timed';
  if (duration.includes('minute') || duration.includes('hour') || duration.includes('day')) return 'timed';
  return 'variable';
}

const alwaysSelectableKeys = new Set([
  'bless',
  'haste',
  'rage',
  'shield_spell'
]);

const neverSelectableIndexes = new Set([
  'ability-score-improvement'
]);

const ongoingEffectTerms = [
  'advantage',
  'disadvantage',
  'resistance',
  'immune',
  'immunity',
  'speed',
  'armor class',
  'ac ',
  'saving throw',
  'attack roll',
  'damage roll',
  'temporary hit points',
  'hit point maximum',
  'condition',
  'charmed',
  'frightened',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
  'concentration',
  'spellcasting',
  'can\'t cast',
  'cannot cast',
  'bonus to',
  'penalty'
];

const directDamageTerms = [
  'takes ',
  'take ',
  'damage immediately',
  'on a hit',
  'on a failed save'
];

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function isSelectableModifier(endpoint: (typeof endpoints)[number], detail: ApiDetail) {
  const key = effectKey(endpoint, detail.index);
  if (alwaysSelectableKeys.has(key)) return true;
  if (endpoint === 'conditions') return true;
  if (neverSelectableIndexes.has(detail.index) || detail.index.includes('ability-score-improvement')) return false;

  const description = detail.desc?.join('\n').toLowerCase() || '';
  if (endpoint === 'spells') {
    if (durationType(detail) === 'instantaneous') return false;
    if (hasAny(description, ongoingEffectTerms)) return true;
    if (hasAny(description, directDamageTerms)) return false;
    return Boolean(detail.concentration);
  }

  if (endpoint === 'features' || endpoint === 'traits') {
    return hasAny(description, ongoingEffectTerms);
  }

  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  return Math.min(30_000, 1_000 * 2 ** attempt);
}

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    if (response.status === 429 && attempt < maxRetries - 1) {
      const waitMs = retryAfterMs(response, attempt);
      console.warn(`rate limited, retrying ${url} in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  throw new Error(`Failed to fetch ${url}`);
}

async function importEndpoint(endpoint: (typeof endpoints)[number]) {
  const list = await fetchJson<ApiListResponse>(`${apiBase}/${endpoint}`);
  let imported = 0;

  for (const item of list.results) {
    if (requestDelayMs) await sleep(requestDelayMs);
    const detail = await fetchJson<ApiDetail>(`${apiBase}/${endpoint}/${item.index}`);
    const key = effectKey(endpoint, detail.index);
    await pool.query(
      `
        INSERT INTO effect_definitions (
          effect_key,
          name,
          source_type,
          source_ref,
          description,
          duration_type,
          requires_concentration,
          is_condition,
          is_selectable,
          sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (effect_key) DO UPDATE
        SET name = EXCLUDED.name,
            source_type = EXCLUDED.source_type,
            source_ref = EXCLUDED.source_ref,
            description = COALESCE(NULLIF(EXCLUDED.description, ''), effect_definitions.description),
            duration_type = EXCLUDED.duration_type,
            requires_concentration = EXCLUDED.requires_concentration,
            is_condition = EXCLUDED.is_condition,
            is_selectable = EXCLUDED.is_selectable
      `,
      [
        key,
        detail.name,
        sourceType(endpoint),
        sourceRef(endpoint, detail.index),
        detail.desc?.join('\n\n') || '',
        durationType(detail),
        Boolean(detail.concentration),
        endpoint === 'conditions',
        isSelectableModifier(endpoint, detail),
        endpoint === 'conditions' ? 10 : endpoint === 'features' ? 200 : endpoint === 'spells' ? 400 : 600
      ]
    );
    await pool.query(
      `
        UPDATE effect_definitions
        SET is_selectable = true
        WHERE effect_key = $1
          AND EXISTS (
            SELECT 1
            FROM effect_modifier_links
            WHERE effect_modifier_links.effect_id = effect_definitions.id
          )
      `,
      [key]
    );
    await pool.query(
      `
        INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name)
        SELECT id, $2, $3, $4
        FROM effect_definitions
        WHERE effect_key = $1
        ON CONFLICT (effect_id, source_ref) DO UPDATE
        SET source_name = EXCLUDED.source_name
      `,
      [key, sourceType(endpoint), sourceRef(endpoint, detail.index), detail.name]
    );
    imported += 1;
  }

  console.log(`imported ${imported} ${endpoint}`);
}

async function main() {
  for (const endpoint of endpoints) {
    await importEndpoint(endpoint);
  }
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

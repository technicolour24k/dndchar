// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { filterTokenForPlayer } from '../store.js';
import { TARGET_WINDOW_MS } from './target.js';
import { pickRandomCreatureSoundFile, creatureSoundUrl } from '../creatureSoundLibrary.js';
import { postRollLog } from './dice.js';
// Shared with the browser client (static/vtt-app/main.js) so the drag ghost, the path label and
// this server deduction can never disagree. See that file's header.
import { pathFt, chebyshevFt } from '../../../static/vtt-app/shared/gridDistance.js';

// A path move is at most 50 points including the final one, so 49 intermediate waypoints.
const MAX_MOVE_WAYPOINTS = 49;

// Must match the fallback in src/routes/vtt/api/log/+server.ts - see that
// file's comment for why this is a shared-secret header rather than a normal
// authenticated request.
const INTERNAL_API_SECRET = process.env.VTT_INTERNAL_SECRET || 'vtt-internal-dev-secret';

// Persists one combat-log line (if combat has been started for this session).
// The live broadcast to connected clients now happens server-side inside
// logCombatEvent itself (src/lib/server/services/combatLog.ts), which scans
// for any session with a matching encounterId - doing it here too would
// double-broadcast every line. Fire-and-forget by design - a dropped log
// write shouldn't ever block or fail the attack/spell resolution that
// triggered it.
function logCombatLine(context, session, message, details) {
  if (!session.encounterId || !message) return;
  fetch(`${context.internalApiBaseUrl()}/vtt/api/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vtt-internal-secret': INTERNAL_API_SECRET },
    body: JSON.stringify({ encounterId: session.encounterId, message, details }),
  }).catch((err) => console.error('[VTT] combat log write failed', err));
}

// The client sends back the d20 pool the server rolled (attackPool from the roll endpoints). It is
// only used to word the logs, so it is validated hard: anything odd and it is dropped, and the log
// falls back to the plain to-hit text. Never trusted for anything mechanical.
function validatePool(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const { size, net, rolls, kept, manualAdvantage, manualDisadvantage } = pool;
  if (!Number.isInteger(size) || size < 1 || size > 11) return null;
  if (!Array.isArray(rolls) || rolls.length !== size) return null;
  if (!rolls.every((roll) => Number.isInteger(roll) && roll >= 1 && roll <= 20)) return null;
  if (!Number.isInteger(kept) || !rolls.includes(kept)) return null;
  if (!Number.isInteger(net) || Math.abs(net) !== size - 1) return null;
  if (!Number.isInteger(manualAdvantage) || manualAdvantage < 0 || manualAdvantage > 5) return null;
  if (!Number.isInteger(manualDisadvantage) || manualDisadvantage < 0 || manualDisadvantage > 5) return null;
  return { size, net, rolls: [...rolls], kept, manualAdvantage, manualDisadvantage };
}

// JS twin of poolSummary() in src/lib/rules/attackRoll.ts - keep the wording in step. Empty for a
// plain single die with no manual points.
function poolSummaryText(pool) {
  const manual = [
    pool.manualAdvantage ? `manual +${pool.manualAdvantage} adv` : '',
    pool.manualDisadvantage ? `manual +${pool.manualDisadvantage} dis` : '',
  ].filter(Boolean);
  if (pool.size <= 1 && manual.length === 0) return '';
  const base = pool.size <= 1 ? '1d20 flat' : `${pool.size}d20 ${pool.net > 0 ? 'adv' : 'dis'} x${Math.abs(pool.net)}, keeps ${pool.kept}`;
  return manual.length ? `${base}; ${manual.join(', ')}` : base;
}

// The " (21: 3d20 adv x2, keeps 17)" part of an attack's combat-log line. Without a (valid) pool,
// or for a plain single die, this is the old text: " (21)" or " (natural 1)". A natural 1 never
// shows the total (e.g. "(25)" on a fumble would read as "AC is above 25"). AC is never used here.
export function formatAttackRollText(outcome, toHit, pool) {
  const valid = validatePool(pool);
  const summary = valid ? poolSummaryText(valid) : '';
  const total = typeof toHit === 'number' && Number.isFinite(toHit) ? toHit : null;
  const lead = outcome === 'critical_miss' ? 'natural 1' : total !== null ? String(total) : '';
  if (!summary) return lead ? ` (${lead})` : '';
  return ` (${lead ? `${lead}: ` : ''}${summary})`;
}

// INTERIM: clamps the client-sent manual damage-dice delta to a whole number in -5..5 (anything
// else is 0). Done once at the top of each handler so the stored log details always match the text.
function clampManualDamage(value) {
  return Number.isInteger(value) ? Math.max(-5, Math.min(5, value)) : 0;
}

// INTERIM: the manual damage-dice delta, appended after the damage in hit/crit and spell lines.
// Only the server-returned (already clamped) value is meaningful; anything else is ignored.
export function formatManualDamageText(delta) {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 5) return '';
  return ` (manual ${delta > 0 ? '+' : ''}${delta} damage ${Math.abs(delta) === 1 ? 'die' : 'dice'})`;
}

// Damage taken (modifier-primacy: damage_taken.* modifiers on the DEFENDER). Only a PC token that
// is linked to a character sheet has any; enemy/npc tokens are untouched, which also keeps their
// resistances out of the table-wide log. The server can't load a character itself (plain JS outside
// SvelteKit), so it asks POST /vtt/api/damage-taken, same loopback pattern as logCombatLine. Tests
// (and anything else in-process) may supply context.resolveDamageTaken(characterId, amount, type)
// instead. Never throws: on any failure the damage simply lands unreduced and an error is logged.
const PHYSICAL_TYPES = new Set(['bludgeoning', 'piercing', 'slashing']);

// The real damage type if the client knows one (a spell's SRD type, a GM action's typed damage),
// else the physical type guessed from the weapon's name (msg.damageType, see inferDamageType in
// main.js). The sound bucket 'magic' is not a real type, so it counts as untyped.
export function damageTypeOfMessage(msg) {
  const label = typeof msg.damageLabel === 'string' ? msg.damageLabel.trim().toLowerCase() : '';
  if (label) return label;
  return PHYSICAL_TYPES.has(msg.damageType) ? msg.damageType : null;
}

async function resolveDamageForTarget(context, session, target, amount, damageType) {
  const unchanged = { final: amount, steps: [], breakdown: '' };
  if (target.type !== 'pc' || !target.characterId || !(amount > 0)) return unchanged;
  try {
    let result;
    if (context.resolveDamageTaken) {
      result = await context.resolveDamageTaken(target.characterId, amount, damageType, { campaignId: session.campaignId || null, ownerId: target.ownerId || null });
    } else {
      const res = await fetch(`${context.internalApiBaseUrl()}/vtt/api/damage-taken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vtt-internal-secret': INTERNAL_API_SECRET },
        // campaignId/ownerId let the route check the character really belongs at this table.
        body: JSON.stringify({ characterId: target.characterId, amount, damageType, campaignId: session.campaignId || null, ownerId: target.ownerId || null }),
        // A hung lookup falls back to unreduced damage exactly like an error does.
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      result = await res.json();
    }
    if (!result || !Number.isFinite(result.final)) return unchanged;
    return { final: Math.max(0, result.final), steps: result.steps || [], breakdown: result.breakdown || '' };
  } catch (err) {
    console.error('[VTT] damage taken lookup failed, applying unreduced', err);
    return unchanged;
  }
}

// After an await: is this still the same room and the same token object?
function stillThere(context, meta, session, target) {
  return context.sessions.get(meta.sessionId) === session && session.tokens[target.id] === target;
}

// The " (rolled 7; 7 - 2 (Half Cover) = 5; halved (Rage: ...) = 2)" tail of a log line. Empty when
// no damage_taken modifier did anything.
export function formatDamageTakenText(rolled, breakdown) {
  return breakdown ? ` (rolled ${rolled}; ${breakdown})` : '';
}

// Flavor-text pools for the combat log, picked at random each time so it
// doesn't read as a flat, repetitive damage ticker. {attacker}/{target} are
// always token names; {damage}/{damageType} only apply to the critical-hit
// pool (a miss deals no damage, so there's nothing to interpolate there).
// {roll} is the attacker's to-hit total as " (17)" (or " (natural 1)"), or an
// empty string if the total is missing - it sits right after the attack verb.
// damageType already carries its own trailing space when present (see
// damageTypeText below) so "{damageType}damage" reads correctly either way.
const MISS_PHRASES = [
  '{attacker} attacks{roll} {target}, but is parried!',
  '{target} dodges an attack{roll} from {attacker}.',
  "{attacker}'s attack{roll} glances off {target}'s armour.",
  '{target} narrowly avoids a strike{roll} from {attacker}!',
  '{attacker} swings{roll} at {target} and misses completely.',
  "{target} deflects {attacker}'s attack{roll} at the last moment.",
];

const CRITICAL_HIT_PHRASES = [
  "[Critical] {attacker}'s attack{roll} strikes true! Dealing {damage} {damageType}damage{manual}!",
  "[Critical] {attacker} strikes{roll} just between the folds of {target}'s armour, dealing {damage} {damageType}damage{manual}!",
  '[Critical] A devastating blow{roll} from {attacker} tears into {target} for {damage} {damageType}damage{manual}!',
  '[Critical] {attacker} finds the perfect opening, striking{roll} {target} for a brutal {damage} {damageType}damage{manual}!',
];

function pickLine(pool, vars) {
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

function canEditToken(meta, token) {
  if (meta.role === 'gm') return true;
  return token.ownerId === meta.playerId;
}

// token:stat:update writes into token.stats[stat] by default (arbitrary,
// free-form combat stats). These fields are top-level token properties
// instead - condition is set alongside HP by the GM (Section 5), the vision*
// fields are token-level traits, imageUrl is how the token-image picker
// changes a token's art post-creation, and speedFt/speedRemainingFt drive the
// movement-range highlight (speedFt is the base/reset value, speedRemainingFt
// is what +/- and Reset actually adjust during play).
const TOKEN_LEVEL_STAT_FIELDS = new Set([
  'condition',
  'conditions',
  'imageUrl',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
  'speedFt',
  'speedRemainingFt',
  // GM-set on enemy/npc tokens (Add Token form / token card) - which
  // assets/creature-sounds/ folder to pull a random clip from whenever this
  // token attacks. Not secret info, but GM-only to edit (absent from
  // PLAYER_EDITABLE_FIELDS below).
  'soundFolder',
  // Character-sheet pull-through fields (Section 1) - populated once at
  // token:add time from the source character, not otherwise mutated except
  // spellSlots (consumed during play via the mini-sheet, Section 2).
  'characterId',
  'ac',
  'saves',
  'actions',
  'spellSlots',
  'preparedSpells',
  // Resource pools (Soulfire, Vowfire...): a DISPLAY copy of the database truth, pushed by the character
  // resync like preparedSpells. Every change goes through POST /vtt/api/characters/[id]/pool, never
  // through the token. The vtt server has no database access, so the owner's client has to be the one
  // to write the copy (see PLAYER_EDITABLE_FIELDS).
  'pools',
  // This turn's actions (Attack 1/2, Extra Attack...): a DISPLAY copy, like pools. Every change goes through
  // the /vtt/api/characters/[id]/turn routes; the owner's client pushes it after character:changed.
  'turn',
  // The lowest attack roll that has actually hit this token. Set by
  // attack:resolve, or manually via the dedicated token:knownAc:set event (any
  // role, any visible token - deliberately not in PLAYER_EDITABLE_FIELDS, so
  // the generic token:stat:update path still can't write it). Top-level so it
  // survives filterTokenForPlayer (unlike the real `ac`, which is stripped for
  // enemy/npc) - it's the deliberately-revealed upper bound players discover.
  'knownAc',
]);

// Top-level fields that are still secret from players on enemy/npc tokens even
// though they live outside the `stats` bucket. `ac` is the true Armor Class -
// filterTokenForPlayer strips it from the token object, but a token:stat:update
// event's raw `value` would otherwise leak it, same class of leak the stats.*
// fields already guard against below.
const ENEMY_HIDDEN_TOKEN_FIELDS = new Set(['ac']);

// Fields a player may write on their own token via token:stat:update.
// hp/maxHp/imageUrl/speedFt are included deliberately - players self-tracking
// their own HP, changing their own token's art via "Change Image...", and
// editing their own base Speed field are all existing, already-shipped
// behavior (see ownTokenListHtml/wirePlayerSidebar in main.js), not the risk
// this allowlist closes. ac/saves/actions/preparedSpells and the vision*
// fields are here so the character-resync poller (main.js's
// syncOwnedCharacterTokens) can push updated reference data from the source
// character sheet onto a player's own token - same trust boundary as
// token:add already extending full client-constructed data for an owned
// token, not a new risk. What stays GM-only even on a player's own token is
// defeated/condition (a GM narrative-timing call, per the original POC
// spec's "never auto-derive death from HP" rule) and characterId (never
// needs rewriting post-creation). spellSlots is added beyond the phase-2
// spec's example list since self-service spell casting needs to decrement
// the player's own slots - but hp and spellSlots are deliberately the two
// fields the resync poller never touches, since both are VTT-session-
// authoritative once pulled (current combat HP, spent slots) and a poll
// landing mid-session shouldn't silently overwrite them with the sheet's
// at-rest values. conditions (the standard 5e status-effect array - Poisoned,
// Prone, etc.) is included since these are observable battlefield state, not
// secret like HP - a player marking their own token Poisoned after failing a
// save is the same self-service pattern as self-tracking HP, distinct from
// the singular `condition` field above (the GM's coarse health-severity
// signal), which stays GM-only regardless of ownership.
const PLAYER_EDITABLE_FIELDS = new Set([
  'hp',
  'maxHp',
  'speedFt',
  'speedRemainingFt',
  'visionNormalFt',
  'visionDarkFt',
  'ac',
  'saves',
  'actions',
  'preparedSpells',
  'pools',
  'turn',
  'conditions',
  'x',
  'y',
  'spellSlots',
  'imageUrl',
]);

// token.pools is a client-written DISPLAY copy of a character's resource pools (the truth is in the
// database). It is rebuilt here, never stored raw: at most 20 entries, each { key, label, current, max }
// with capped strings and integers clamped to 0..999. Anything malformed rejects the whole update (null).
export const MAX_TOKEN_POOLS = 20;
export function sanitizePools(value) {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_POOLS) return null;
  const clean = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { key, label, current, max } = entry;
    if (typeof key !== 'string' || typeof label !== 'string' || key.length === 0 || key.length > 40 || label.length > 80) return null;
    if (!Number.isInteger(current) || !Number.isInteger(max)) return null;
    const rebuilt = { key, label, current: Math.min(999, Math.max(0, current)), max: Math.min(999, Math.max(0, max)) };
    if (typeof entry.rechargePeriod === 'string' && entry.rechargePeriod.length <= 20) rebuilt.rechargePeriod = entry.rechargePeriod;
    clean.push(rebuilt);
  }
  return clean;
}

// token.turn is a client-written DISPLAY copy of a character's turn view (the truth is character_turn_state).
// Rebuilt here, never stored raw: { profileKey, turnSeq, pools (max 6), followups (max 4) } with capped
// strings and integers clamped to 0..99 (turnSeq to 0..1e9). Anything malformed rejects the update (null).
export const MAX_TURN_POOLS = 6;
export const MAX_TURN_FOLLOWUPS = 4;
export function sanitizeTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { profileKey, turnSeq, pools, followups } = value;
  if (typeof profileKey !== 'string' || profileKey.length === 0 || profileKey.length > 40 || !Number.isInteger(turnSeq)) return null;
  if (!Array.isArray(pools) || pools.length > MAX_TURN_POOLS || !Array.isArray(followups) || followups.length > MAX_TURN_FOLLOWUPS) return null;
  const cleanPools = [];
  for (const entry of pools) {
    if (!entry || typeof entry !== 'object') return null;
    const { key, label, current, max } = entry;
    if (typeof key !== 'string' || typeof label !== 'string' || key.length === 0 || key.length > 40 || label.length > 80) return null;
    if (!Number.isInteger(current) || !Number.isInteger(max)) return null;
    cleanPools.push({ key, label, current: Math.min(99, Math.max(0, current)), max: Math.min(99, Math.max(0, max)) });
  }
  const cleanFollowups = [];
  for (const entry of followups) {
    if (!entry || typeof entry !== 'object') return null;
    const { cls, label, remaining } = entry;
    if (typeof cls !== 'string' || typeof label !== 'string' || cls.length === 0 || cls.length > 20 || label.length > 80) return null;
    if (!Number.isInteger(remaining)) return null;
    cleanFollowups.push({ cls, label, remaining: Math.min(99, Math.max(0, remaining)) });
  }
  return { profileKey, turnSeq: Math.min(1e9, Math.max(0, turnSeq)), pools: cleanPools, followups: cleanFollowups };
}

function isFieldEditAllowed(role, isOwner, field) {
  if (role === 'gm') return true;
  if (!isOwner) return false;
  return PLAYER_EDITABLE_FIELDS.has(field);
}

// A player may update `hp` on a token they don't own if it's currently a
// valid target - present in the targetTokenIds from their own most recent
// target:select, within a short window. This is a deliberate, narrow
// exception (hp only, target-select-gated) rather than a general loosening
// of ownership - defeated/condition stay untouched by this path entirely, so
// a player's attack can lower an enemy's HP but never itself flag a kill.
function isValidHpTarget(meta, token, stat) {
  if (meta.role !== 'player' || stat !== 'hp') return false;
  if (!meta.lastTargetTokenIds || !meta.lastTargetTokenIds.includes(token.id)) return false;
  return Date.now() - (meta.lastTargetAt || 0) < TARGET_WINDOW_MS;
}

// Broadcasts a token-bearing event: GM always gets the raw token; players get
// it filtered, and not at all if the token is GM-hidden (Section 5) OR the
// map itself is unrevealed (Phase 10) - an unrevealed map is a hard gate
// ahead of per-token visibility, same rule filterSessionForRole applies to
// the join/reconnect snapshot, extended here so it also covers the
// continuous per-event broadcasts (a GM populating an unrevealed map via
// Token Manager must not leak real token data over the wire just because
// nothing currently renders it). `extra` may be a plain object (same for
// every recipient) or a function of `recipient` - the latter exists for
// token:stat:update, which needs to omit the raw value for player recipients
// when it's landing on a filtered field.
function broadcastToken(context, session, sessionId, eventType, token, extra = {}) {
  const extraFor = typeof extra === 'function' ? extra : () => extra;
  const mapHidden = session.map && !session.map.revealed;
  context.broadcast(sessionId, (recipient) => {
    if (recipient.role === 'gm') return { type: eventType, ...extraFor(recipient), token };
    if (token.hidden || mapHidden) return null;
    return { type: eventType, ...extraFor(recipient), token: filterTokenForPlayer(token) };
  });
}

// Random per-attack flavor cue (e.g. a dragon's roar), keyed off the
// attacker's soundFolder (see TOKEN_LEVEL_STAT_FIELDS above) - distinct from
// the hit-only damage-type cue below since this should play whenever the
// creature attacks at all, hit or miss, same as a roar accompanying a claw
// swipe regardless of whether it connects. The server picks the random file
// (rather than the client) so every listener hears the same clip.
function broadcastCreatureSound(context, session, sessionId, sourceTokenId) {
  const folder = session.tokens[sourceTokenId]?.soundFolder;
  if (!folder) return;
  const filename = pickRandomCreatureSoundFile(folder);
  if (!filename) return;
  context.broadcast(sessionId, () => ({
    type: 'fx:play',
    creatureSoundUrl: creatureSoundUrl(folder, filename),
  }));
}

// Validates a client-supplied list of points: an array of minLen..maxLen entries, each with
// finite x and y. Returns a fresh array of plain { x, y } (nothing else copied), or null.
function parsePoints(list, minLen, maxLen) {
  if (!Array.isArray(list) || list.length < minLen || list.length > maxLen) return null;
  const out = [];
  for (const p of list) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

// Relays a move-preview payload ({ type, tokenId, points? } only - never the token object, so no
// stat filtering is needed). Same two visibility gates as broadcastToken: GM-role recipients
// always get it, everyone else gets nothing if the token is hidden or the map unrevealed.
// `gmOnly` (a private GM plan) drops every non-GM recipient. The sender is skipped, it already
// draws its own plan. The builder is also called with { role: 'watcher', playerId: null } (no
// ws), so it must not touch recipient.ws. These types are deliberately NOT in store.js's
// WATCHABLE_BROADCAST_TYPES, so watchers never receive them anyway.
function broadcastMovePreview(broadcast, session, sessionId, token, payload, senderMeta, gmOnly) {
  const mapHidden = session.map && !session.map.revealed;
  broadcast(sessionId, (recipient) => {
    if (recipient === senderMeta) return null;
    if (recipient.role === 'gm') return payload;
    if (gmOnly || token.hidden || mapHidden) return null;
    return payload;
  });
}

// Called when a socket closes: if it had a plan in progress, tell everyone else to drop it.
export function clearMovePreviewForSocket(meta, session, broadcast) {
  const tokenId = meta.movePreviewTokenId;
  meta.movePreviewTokenId = null;
  const token = tokenId ? session.tokens[tokenId] : null;
  if (!token) return;
  // A private plan was never sent to players, so a clear to them is a harmless no-op.
  broadcastMovePreview(broadcast, session, meta.sessionId, token,
    { type: 'token:move:preview:clear', tokenId }, meta, false);
}

async function handleTokenEvent(meta, msg, context) {
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  switch (msg.type) {
    case 'token:add': {
      const token = msg.token;
      if (!token || !token.id) return;
      // GM can add anything, for anyone. A player can only add a PC token
      // for themselves (Section 1a: picking a character creates their own
      // token) - never an NPC/enemy, never on another player's behalf.
      const isSelfPcToken = meta.role === 'player' && token.type === 'pc' && token.ownerId === meta.playerId;
      if (meta.role !== 'gm' && !isSelfPcToken) return;
      // token.turn is display-only and rebuilt server-side; a bad or missing copy is dropped, the owner re-pushes it.
      if (token.turn !== undefined) {
        const cleanTurn = sanitizeTurn(token.turn);
        if (cleanTurn) token.turn = cleanTurn; else delete token.turn;
      }
      session.tokens[token.id] = token;
      broadcastToken(context, session, meta.sessionId, 'token:add', token);
      break;
    }

    case 'token:remove': {
      if (meta.role !== 'gm') return;
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      delete session.tokens[msg.tokenId];
      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') return { type: 'token:remove', tokenId: msg.tokenId };
        if (token.hidden) return null; // player never knew it existed
        return { type: 'token:remove', tokenId: msg.tokenId };
      });
      break;
    }

    case 'token:move': {
      const token = session.tokens[msg.tokenId];
      if (!token || !canEditToken(meta, token)) return;
      // Reject malformed coordinates outright (a NaN would poison speedRemainingFt).
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
      // Optional intermediate waypoints for a planned path move. Absent means a plain drag
      // (a one-leg path). Anything malformed rejects the whole move.
      let waypoints = [];
      if (msg.waypoints !== undefined) {
        const parsed = parsePoints(msg.waypoints, 0, MAX_MOVE_WAYPOINTS);
        if (!parsed) return;
        waypoints = parsed;
      }
      const prevX = token.x;
      const prevY = token.y;
      token.x = msg.x;
      token.y = msg.y;
      // Decrement speedRemainingFt by the path's distance: Chebyshev (a diagonal square costs
      // 5 ft), nearest foot per leg, legs summed - the same shared helper the client drag ghost
      // and path label use, so they never disagree. Never blocks the move (product philosophy:
      // automate/suggest, never hard-enforce) - just clamps the remaining budget at 0 and lets
      // the overage show visually client-side. Waypoints are only used for the sum, they are not
      // echoed in the broadcast. Rides on the existing token:move broadcast rather than a separate
      // token:stat:update, which would trigger a full sidebar rebuild on
      // every connected client on every single drag (see item 7).
      // Props omit speed fields entirely (see main.js's readTokenFormFields),
      // and a session with no map set has no gridSizePx to convert by - skip
      // the decrement rather than deriving a bogus number in either case.
      const gridSizePx = session.map?.gridSizePx;
      if (typeof token.speedRemainingFt === 'number' && typeof gridSizePx === 'number' && gridSizePx > 0) {
        const pathDistanceFt = pathFt([{ x: prevX, y: prevY }, ...waypoints, { x: msg.x, y: msg.y }], gridSizePx);
        // Never charge less than the straight start-to-end distance: per-leg rounding means a
        // spam of sub-foot waypoints would otherwise round every leg down to 0 ft.
        const straightFt = chebyshevFt(prevX, prevY, msg.x, msg.y, gridSizePx);
        const distanceFt = pathDistanceFt === null || straightFt === null ? null : Math.max(pathDistanceFt, straightFt);
        if (distanceFt !== null) token.speedRemainingFt = Math.max(0, token.speedRemainingFt - distanceFt);
      }
      if (meta.movePreviewTokenId === token.id) meta.movePreviewTokenId = null;
      broadcastToken(context, session, meta.sessionId, 'token:move', token, {
        tokenId: token.id,
        x: token.x,
        y: token.y,
        speedRemainingFt: token.speedRemainingFt,
      });
      break;
    }

    // Recenter on Map: a rescue for a token stuck somewhere unreachable. A dedicated event
    // (not a flag on token:move) so a client can never make an arbitrary free move - the server
    // picks the target (the map centre) itself and does NOT deduct speedRemainingFt. Same
    // permission rule as token:move. Broadcasts as a normal token:move so every client's
    // existing handler just works.
    case 'token:recenter': {
      const token = session.tokens[msg.tokenId];
      if (!token || !canEditToken(meta, token)) return;
      const map = session.map;
      if (!map || !Number.isFinite(map.widthPx) || !Number.isFinite(map.heightPx)) return;
      token.x = map.widthPx / 2;
      token.y = map.heightPx / 2;
      if (meta.movePreviewTokenId === token.id) meta.movePreviewTokenId = null;
      broadcastToken(context, session, meta.sessionId, 'token:move', token, {
        tokenId: token.id,
        x: token.x,
        y: token.y,
        speedRemainingFt: token.speedRemainingFt,
      });
      break;
    }

    // Movement path preview (ephemeral, never stored in session). The sender plans a path
    // client-side and we just relay it to everyone who could see the token. See
    // broadcastMovePreview for the visibility rules. A GM may flag a preview `private`, which
    // then reaches GM-role recipients only (enforced here, not just in the client).
    case 'token:move:preview': {
      const token = session.tokens[msg.tokenId];
      if (!token || !canEditToken(meta, token) || !session.map) return;
      const points = parsePoints(msg.points, 1, MAX_MOVE_WAYPOINTS + 1);
      if (!points) return;
      // One plan per socket: starting on a different token clears the old one first.
      const previous = meta.movePreviewTokenId;
      if (previous && previous !== token.id && session.tokens[previous]) {
        broadcastMovePreview(context.broadcast, session, meta.sessionId, session.tokens[previous],
          { type: 'token:move:preview:clear', tokenId: previous }, meta, false);
      }
      meta.movePreviewTokenId = token.id;
      broadcastMovePreview(context.broadcast, session, meta.sessionId, token,
        { type: 'token:move:preview', tokenId: token.id, points }, meta, msg.private === true && meta.role === 'gm');
      break;
    }

    case 'token:move:preview:clear': {
      const token = session.tokens[msg.tokenId];
      if (!token || !canEditToken(meta, token)) return;
      broadcastMovePreview(context.broadcast, session, meta.sessionId, token,
        { type: 'token:move:preview:clear', tokenId: token.id }, meta, false);
      if (meta.movePreviewTokenId === token.id) meta.movePreviewTokenId = null;
      break;
    }

    // GM-only bulk counterpart to the per-token Reset button - there's no
    // turn tracker in the VTT to hang an automatic reset on (see
    // vtt-sheet-punch-list item 4), so this is a deliberate manual "everyone
    // is back to full movement" action instead. speedRemainingFt isn't a
    // secret field (players already see it and the +5/-5/Reset control for
    // their own token), so every recipient gets every update - the only
    // filtering needed is dropping updates for tokens a player was never
    // sent in the first place (hidden tokens / an unrevealed map).
    case 'token:move:resetAll': {
      if (meta.role !== 'gm') return;
      const mapHidden = session.map && !session.map.revealed;
      const updates = [];
      for (const token of Object.values(session.tokens)) {
        if (typeof token.speedRemainingFt !== 'number') continue;
        token.speedRemainingFt = token.speedFt || 0;
        updates.push(token);
      }
      context.broadcast(meta.sessionId, (recipient) => {
        const visible = recipient.role === 'gm'
          ? updates
          : updates.filter((token) => !token.hidden && !mapHidden);
        if (!visible.length) return null;
        return {
          type: 'token:move:resetAll',
          updates: visible.map((token) => ({ tokenId: token.id, speedRemainingFt: token.speedRemainingFt })),
        };
      });
      break;
    }

    case 'token:stat:update': {
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      // isValidHpTarget (Section 3b) is a deliberate OR-branch, not a
      // narrowing of canEditToken - it exists specifically to allow a write
      // on a token the sender does NOT own (an enemy they've targeted), so it
      // must not sit behind the ownership gate below.
      const isOwner = token.ownerId === meta.playerId;
      const ownerAllowed = canEditToken(meta, token) && isFieldEditAllowed(meta.role, isOwner, msg.stat);
      if (!ownerAllowed && !isValidHpTarget(meta, token, msg.stat)) {
        meta.ws.send(JSON.stringify({
          type: 'token:stat:update:error',
          tokenId: msg.tokenId,
          stat: msg.stat,
          reason: 'field_not_editable',
        }));
        return;
      }
      // A player attacking a non-owned target (isValidHpTarget) never learns
      // that token's real HP - it's never sent to them (see isSensitiveStat
      // below) - so they can't compute a new absolute value the way the GM's
      // direct HP input does. `delta` lets them say "this hits for 8" without
      // ever knowing the number before or after; `value` (absolute set)
      // still works exactly as before for every other case, including the
      // GM editing an enemy directly or a player editing their own HP.
      let appliedValue = msg.value;
      if (msg.stat === 'turn') {
        const clean = sanitizeTurn(msg.value);
        if (!clean) return;
        appliedValue = clean;
      }
      if (msg.stat === 'pools') {
        // Rebuilt from validated parts, never msg.value itself. A malformed array is ignored.
        const clean = sanitizePools(msg.value);
        if (!clean) return;
        appliedValue = clean;
      }
      if (!ownerAllowed && msg.stat === 'hp' && typeof msg.delta === 'number') {
        const current = Number(token.stats?.hp) || 0;
        appliedValue = Math.max(0, current + msg.delta);
      }
      if (TOKEN_LEVEL_STAT_FIELDS.has(msg.stat)) {
        token[msg.stat] = appliedValue;
      } else {
        token.stats = token.stats || {};
        token.stats[msg.stat] = appliedValue;
      }
      // Writing the real AC invalidates any previously-discovered knownAc
      // bound (a stale "Known AC <=" would otherwise outlive the correction
      // and persist for the life of the in-memory session) - clear it and
      // broadcast the reset the same way attack:resolve broadcasts a new one.
      let knownAcCleared = false;
      if (msg.stat === 'ac' && token.knownAc != null) {
        token.knownAc = null;
        knownAcCleared = true;
      }
      // Enemy/npc stats.* fields (hp, maxHp, etc.) are never sent to players -
      // filterTokenForPlayer already strips `stats` from the token object
      // above, but the raw `value` on the event itself would otherwise leak
      // the same number straight past that filter. This was dormant before
      // Section 3b (only the GM could ever trigger a stat:update on an enemy
      // token), and is reachable by players now that a valid-target hp
      // update is allowed - worth being deliberate about, not just trusting
      // the token-level filter to cover it.
      const isSensitiveStat = (token.type === 'enemy' || token.type === 'npc')
        && (!TOKEN_LEVEL_STAT_FIELDS.has(msg.stat) || ENEMY_HIDDEN_TOKEN_FIELDS.has(msg.stat));
      broadcastToken(context, session, meta.sessionId, 'token:stat:update', token, (recipient) => {
        if (recipient.role === 'gm' || !isSensitiveStat) {
          return { tokenId: token.id, stat: msg.stat, value: appliedValue };
        }
        return { tokenId: token.id, stat: msg.stat };
      });
      // knownAc is the intentionally-public discovered bound - the reset goes
      // to everyone, same as attack:resolve's knownAc broadcast.
      if (knownAcCleared) {
        broadcastToken(context, session, meta.sessionId, 'token:stat:update', token, {
          tokenId: token.id, stat: 'knownAc', value: null,
        });
      }
      break;
    }

    case 'token:hidden:toggle': {
      if (meta.role !== 'gm') return;
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      token.hidden = !token.hidden;
      const mapHidden = session.map && !session.map.revealed;
      // Players never see a hidden:toggle event itself (that would leak the
      // token's existence) - instead they see it appear/disappear. While the
      // map itself is unrevealed (Phase 10), a player never had this token in
      // the first place (broadcastToken already withholds it), so the
      // un-hide branch's real token:add would leak it early - skip entirely.
      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') {
          return { type: 'token:hidden:toggle', tokenId: token.id, hidden: token.hidden };
        }
        if (mapHidden) return null;
        return token.hidden
          ? { type: 'token:remove', tokenId: token.id }
          : { type: 'token:add', token: filterTokenForPlayer(token) };
      });
      break;
    }

    // Manual known AC: any player or the GM can note "this token's AC is at
    // most X" for a visible token (the table's own bookkeeping, no ownership
    // check). IMPORTANT: this case must never read token.ac / token.stats.ac.
    // No clamping against it, no rejection, no reply that differs by it -
    // any of those would turn this endpoint into an oracle for the hidden AC.
    case 'token:knownAc:set': {
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      // A player can't act on a token they can't see (never knew it existed).
      if (meta.role !== 'gm' && (token.hidden || (session.map && !session.map.revealed))) return;

      let value = null;
      if (msg.value !== null) {
        const n = typeof msg.value === 'number' || typeof msg.value === 'string' ? Number(msg.value) : NaN;
        value = Math.round(n);
        if (msg.value === '' || (typeof msg.value === 'string' && msg.value.trim() === '') || !Number.isFinite(n) || value < 0 || value > 99) {
          meta.ws.send(JSON.stringify({
            type: 'token:stat:update:error',
            tokenId: msg.tokenId,
            stat: 'knownAc',
            reason: 'invalid_value',
          }));
          return;
        }
      }
      token.knownAc = value;
      broadcastToken(context, session, meta.sessionId, 'token:stat:update', token, {
        tokenId: token.id, stat: 'knownAc', value,
      });
      break;
    }

    // token:vision:sync - pushes the character sheet's resolved vision (darkvision etc.) onto a
    // token WITHOUT clobbering manual VTT edits. The token remembers the last sheet values it took
    // in `sheetVision`; a vision field only follows the sheet if its current value still equals
    // that remembered value. If a human changed it (Darkvision checkbox, Advanced Vision modal,
    // Token Manager), it's an override and stays put. The remembered value is always updated.
    // visionTrueFt/visionDevilFt stay out of PLAYER_EDITABLE_FIELDS, so the normal edit controls
    // can't hand-set truesight. Note this path TRUSTS the client's resolved values (the VTT
    // server can't fetch the character to check them) - an owner could send made-up numbers
    // from the console. Accepted gap for a trusted group, same as token:add storing a player's
    // own PC token verbatim. Gated on canEditToken (owner or GM) plus a linked character.
    case 'token:vision:sync': {
      const token = session.tokens[msg.tokenId];
      if (!token || !token.characterId) return;
      if (!canEditToken(meta, token)) return;

      const incoming = msg.vision;
      const keys = ['normalFt', 'darkFt', 'trueFt', 'devilFt'];
      const vision = {};
      for (const key of keys) {
        const raw = incoming && (typeof incoming[key] === 'number' || typeof incoming[key] === 'string') ? incoming[key] : NaN;
        const n = Math.round(Number(raw));
        if (raw === '' || !Number.isFinite(n) || n < 0 || n > 1000) {
          meta.ws.send(JSON.stringify({
            type: 'token:stat:update:error',
            tokenId: msg.tokenId,
            stat: 'sheetVision',
            reason: 'invalid_value',
          }));
          return;
        }
        vision[key] = n;
      }

      const fieldFor = { normalFt: 'visionNormalFt', darkFt: 'visionDarkFt', trueFt: 'visionTrueFt', devilFt: 'visionDevilFt' };
      const previous = token.sheetVision;
      // A token made before sheetVision existed has no baseline to compare against, so its
      // fields are never touched (it just starts remembering from now on).
      if (previous && typeof previous === 'object') {
        for (const key of keys) {
          const field = fieldFor[key];
          if (token[field] === previous[key] && token[field] !== vision[key]) {
            token[field] = vision[key];
            broadcastToken(context, session, meta.sessionId, 'token:stat:update', token, {
              tokenId: token.id, stat: field, value: vision[key],
            });
          }
        }
      }

      if (JSON.stringify(previous ?? null) !== JSON.stringify(vision)) {
        token.sheetVision = vision;
        broadcastToken(context, session, meta.sessionId, 'token:stat:update', token, {
          tokenId: token.id, stat: 'sheetVision', value: vision,
        });
      }
      break;
    }

    // token:update (Phase 10) - the Token Manager's multi-field edit form,
    // GM-only. Deliberately gated on role alone, not canEditToken - that
    // helper also passes for a token's own owner, which would let a player
    // bypass PLAYER_EDITABLE_FIELDS' carefully-maintained allowlist via one
    // unrestricted patch. `hidden` is stripped rather than assigned: toggling
    // it here would silently desync a connected player (token:hidden:toggle
    // exists specifically to synthesize the add/remove that retracts/reveals
    // a token already sitting in their local state - a bare field write does
    // not). id/x/y aren't form fields; stripped defensively so a malformed
    // patch can't relocate or re-identify a token through this path.
    case 'token:update': {
      if (meta.role !== 'gm') return;
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      const patch = { ...(msg.patch || {}) };
      delete patch.hidden;
      delete patch.id;
      delete patch.x;
      delete patch.y;
      const prevAc = token.ac;
      Object.assign(token, patch);
      // Writing a changed real AC invalidates any previously-discovered
      // knownAc bound, same reasoning as token:stat:update above - the full
      // token already rides on the broadcast below, so no extra message
      // is needed to carry the reset.
      if (patch.ac !== undefined && patch.ac !== prevAc && token.knownAc != null) {
        token.knownAc = null;
      }
      // No `extra` here (unlike token:stat:update) - the patch itself must
      // never ride along on the broadcast, since filterTokenForPlayer only
      // strips `stats`/`ac` off the `token` object, not off an arbitrary
      // side-channel value (the exact leak class ENEMY_HIDDEN_TOKEN_FIELDS/
      // isSensitiveStat above already guards against for stat:update).
      broadcastToken(context, session, meta.sessionId, 'token:update', token, { tokenId: token.id });
      break;
    }

    // token:remove:bulk (Phase 10, Token Manager) - GM-only multi-token
    // cleanup (e.g. clearing defeated enemies post-combat) as one broadcast
    // instead of N. No target-window cleanup needed: every consumer of
    // meta.lastTargetTokenIds (isValidHpTarget, attack:resolve, spell:resolve)
    // already resolves session.tokens[id] first and bails if it's gone, so a
    // stale reference to a removed id is already inert.
    case 'token:remove:bulk': {
      if (meta.role !== 'gm') return;
      const tokenIds = Array.isArray(msg.tokenIds) ? msg.tokenIds : [];
      const removed = tokenIds.filter((id) => session.tokens[id]);
      removed.forEach((id) => delete session.tokens[id]);
      if (!removed.length) return;
      context.broadcast(meta.sessionId, () => ({ type: 'token:remove:bulk', tokenIds: removed }));
      break;
    }

    // attack:resolve - the server decides hit/miss against the target's HIDDEN
    // AC, applies damage on a hit, and (for enemy/npc) reveals only the lowest
    // roll that has genuinely cleared AC (`knownAc`) - never the AC itself. This
    // is why hit/miss resolution moved server-side (Phase 2.5 follow-up): a
    // player attacking an enemy must never receive that enemy's AC to compare
    // against locally. Both players (target-window gated, like isValidHpTarget)
    // and the GM (any token, for enemy attacks) use this same path.
    case 'attack:resolve': {
      const target = session.tokens[msg.targetTokenId];
      if (!target) return;
      const targetWindowOk = meta.lastTargetTokenIds
        && meta.lastTargetTokenIds.includes(target.id)
        && Date.now() - (meta.lastTargetAt || 0) < TARGET_WINDOW_MS;
      if (meta.role !== 'gm' && !targetWindowOk) return;

      const toHit = Number(msg.toHit) || 0;
      const manualDamageDice = clampManualDamage(msg.manualDamageDice); // INTERIM
      const damage = Math.max(0, Number(msg.damage) || 0);
      const outcome = msg.outcome || null; // 'critical_hit' | 'critical_miss' | null
      const ac = typeof target.ac === 'number' ? target.ac
        : typeof target.stats?.ac === 'number' ? target.stats.ac : null;

      let hit;
      if (outcome === 'critical_miss') hit = false;
      else if (outcome === 'critical_hit') hit = true;
      else if (ac == null) hit = true; // no AC configured -> can't determine a miss, treat as hit
      else hit = toHit >= ac;

      // PC targets: run the rolled damage through their damage_taken modifiers first. Awaited
      // BEFORE any state is read or written, so the HP update below stays one synchronous step.
      const taken = hit ? await resolveDamageForTarget(context, session, target, damage, damageTypeOfMessage(msg)) : { final: damage, steps: [], breakdown: '' };
      // The lookup awaited: the token (or the whole room) may have been removed meanwhile.
      if (!stillThere(context, meta, session, target)) return;
      const dealt = taken.final; // what the target actually takes (== damage for everyone but a PC)

      let damageApplied = 0;
      let knownAcChanged = false;
      if (hit) {
        const currentHp = Number(target.stats?.hp) || 0;
        const newHp = Math.max(0, currentHp - dealt);
        target.stats = target.stats || {};
        target.stats.hp = newHp;
        damageApplied = currentHp - newHp;
        // AC discovery: reveal the lowest roll that actually *cleared* AC. A crit
        // that auto-hit below AC must NOT reveal a misleadingly low bound, so gate
        // this on the real comparison, not on `hit`.
        if (ac != null && toHit >= ac && (target.knownAc == null || toHit < target.knownAc)) {
          target.knownAc = toHit;
          knownAcChanged = true;
        }
      }

      // Verdict goes only to the attacker - hit/miss + the damage they rolled,
      // never the AC. We deliberately report the *rolled* `damage`, not the
      // capped `damageApplied`: reporting the capped amount would leak an
      // enemy's exact remaining HP on an overkill hit (roll 20, 5 applied ->
      // they had 5 left), which defeats the point of hiding enemy stats.
      meta.ws.send(JSON.stringify({
        type: 'attack:result',
        targetTokenId: target.id,
        hit,
        critical: outcome === 'critical_hit',
        fumble: outcome === 'critical_miss',
        acKnown: ac != null,
        // For a PC target this is the damage after their damage_taken modifiers, with the
        // audit trail (a PC's HP is public, so nothing secret). Enemies: the rolled number as before.
        damage: hit ? dealt : 0,
        ...(taken.breakdown ? { damageRolled: damage, breakdown: taken.breakdown } : {}),
      }));

      // Broadcast the resulting HP (value stripped for players on enemy/npc, same
      // rule as a direct stat:update) so everyone's token state stays in sync.
      if (hit) {
        broadcastToken(context, session, meta.sessionId, 'token:stat:update', target, (recipient) => {
          const sensitive = target.type === 'enemy' || target.type === 'npc';
          if (recipient.role === 'gm' || !sensitive) return { tokenId: target.id, stat: 'hp', value: target.stats.hp };
          return { tokenId: target.id, stat: 'hp' };
        });
      }
      // knownAc is the intentionally-public discovered bound - value goes to all.
      if (knownAcChanged) {
        broadcastToken(context, session, meta.sessionId, 'token:stat:update', target, {
          tokenId: target.id, stat: 'knownAc', value: target.knownAc,
        });
      }
      // Hit-sound cue, everyone at the table - unlike attack:result (attacker
      // only, since it carries the rolled damage), this leaks nothing secret,
      // just "an attack landed, play its damage-type sound." damageType is
      // client-derived - a spell's real SRD damage type where one exists, a
      // best-effort guess from the weapon's name otherwise (see
      // inferDamageType in main.js) - trusted as-is, same posture as the rest
      // of a GM/attacker-authored message like map:set's map object.
      if (hit) {
        context.broadcast(meta.sessionId, () => ({ type: 'fx:play', damageType: msg.damageType || null }));
      }
      // Creature attack cue - fires on the attack itself (hit or miss), not
      // gated on `hit` like the damage-type cue above.
      broadcastCreatureSound(context, session, meta.sessionId, msg.sourceTokenId);

      // Log line, combat-log only (not the attack:result/token:stat:update
      // broadcasts above). sourceTokenId already rides on the incoming
      // message (client sends it to build attack:resolve/spell:resolve
      // payloads); resolving it to a token name here (rather than
      // meta.playerName) means this also works for a GM-controlled monster's
      // attack, which has no playerName. Misses get logged too (flavor text
      // only - no damage to report), and a critical hit gets its own "epic"
      // phrasing instead of the plain hit line.
      //
      // Reports the *rolled* `damage`, not the capped `damageApplied` - same
      // reason attack:result above does: this is broadcast to the whole
      // table, and showing the capped amount would leak an enemy's exact
      // remaining HP whenever overkill trims the number down (roll 10,
      // 3 applied -> "hits for 3" tells everyone only 3 HP was left). A hit
      // is logged unconditionally now too (not gated on damageApplied>0) for
      // the same reason - a hit landing is worth announcing regardless of how
      // much HP was actually left to remove.
      {
        // To-hit total for the log. Never the target's real AC. A nat 1 shows
        // "(natural 1)" rather than the total, since e.g. "(25)" on a fumble
        // would read as "AC is above 25".
        const toHitTotal = typeof msg.toHit === 'number' && Number.isFinite(msg.toHit) ? msg.toHit : null;
        const pool = validatePool(msg.pool);
        const rollText = formatAttackRollText(outcome, toHitTotal, pool);
        const manualText = formatManualDamageText(manualDamageDice) + formatDamageTakenText(damage, taken.breakdown);
        const logDetails = { pool, manualDamageDice, ...(taken.breakdown ? { damageRolled: damage, damageTaken: taken.steps } : {}) };
        const attackerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
        const targetName = target.name || 'something';
        // damageLabel is the real type (fire, acid...); damageType is the sound-clip bucket.
        const damageTypeText = (msg.damageLabel || msg.damageType) ? `${msg.damageLabel || msg.damageType} ` : '';
        if (!hit) {
          logCombatLine(context, session,
            pickLine(MISS_PHRASES, { attacker: attackerName, target: targetName, roll: rollText }),
            { ...logDetails, kind: 'attack', outcome: 'miss', toHit: toHitTotal, sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, title: msg.title || null });
        } else if (outcome === 'critical_hit') {
          logCombatLine(context, session,
            pickLine(CRITICAL_HIT_PHRASES, { attacker: attackerName, target: targetName, damage: dealt, damageType: damageTypeText, roll: rollText, manual: manualText }),
            { ...logDetails, kind: 'attack', outcome: 'critical', toHit: toHitTotal, sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage: dealt, damageType: msg.damageLabel || msg.damageType || null, title: msg.title || null });
        } else {
          logCombatLine(context, session,
            `${attackerName} hits${rollText} ${targetName} for ${dealt} ${damageTypeText}damage${manualText}.`,
            { ...logDetails, kind: 'attack', outcome: 'hit', toHit: toHitTotal, sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage: dealt, damageType: msg.damageLabel || msg.damageType || null, title: msg.title || null });
        }
      }

      // One PUBLIC roll-log line per VTT attack, whether or not an encounter is running (the
      // combat log above only exists during combat). Dice only: no to-hit bonus breakdown and no
      // hit/miss. A natural 1 says so instead of showing the total, for the same reason as above.
      {
        const toHitForLog = typeof msg.toHit === 'number' && Number.isFinite(msg.toHit) ? msg.toHit : null;
        if (toHitForLog !== null) {
          const pool = validatePool(msg.pool);
          const attackerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
          const title = msg.title || 'an attack';
          const poolPart = pool ? poolSummaryText(pool) : '';
          const rolled = outcome === 'critical_miss' ? 'a natural 1' : String(toHitForLog);
          postRollLog(
            context, meta.sessionId,
            `${attackerName} rolled ${rolled} to hit ${target.name || 'something'} with ${title}${poolPart ? ` (${poolPart})` : ''}.`,
            { label: `${title} to hit`, pool, breakdown: pool ? `d20 [${pool.rolls.join(', ')}], kept ${pool.kept}` : undefined },
            'public'
          );
        }
      }
      break;
    }

    // spell:resolve - for save/auto spells (attack-resolution spells reuse
    // attack:resolve above unchanged - a spell attack roll vs. AC is mechanically
    // identical to a weapon attack once you have a to-hit total), plus (Phase 8)
    // ALL heal traffic regardless of source kind (weapon/spell/item) and all item
    // rolls under Attack intent, since items have no attack-roll concept either -
    // this is generically "apply a pre-rolled amount, no hidden gate", not spell-
    // specific despite the message name. Unlike attack:resolve, there is no hidden
    // value being compared here: a caster's own Spell Save DC isn't secret from
    // them, so saveSuccess is computed client-side (against the DC the roll-spell
    // endpoint already returned to the caster) and simply trusted - the server's
    // job is purely "is this write authorized" (same target-window/GM gate as
    // every other HP mutation path), not secrecy of a comparison.
    case 'spell:resolve': {
      const target = session.tokens[msg.targetTokenId];
      if (!target) return;
      const targetWindowOk = meta.lastTargetTokenIds
        && meta.lastTargetTokenIds.includes(target.id)
        && Date.now() - (meta.lastTargetAt || 0) < TARGET_WINDOW_MS;
      if (meta.role !== 'gm' && !targetWindowOk) return;

      const manualDamageDice = clampManualDamage(msg.manualDamageDice); // INTERIM

      // Heal (Phase 8) - always lands (no save/attack layer), adds instead of
      // subtracts, and caps at maxHp instead of flooring at 0. Mirrors the
      // damage-side enemy/npc leak discipline below (report the rolled, not the
      // capped, amount) - PC targets already have visible HP (see
      // vtt-fix-restore-pc-hp-visibility), so the real capped amount is not a
      // leak there.
      if (msg.resolution === 'heal') {
        const rolled = Math.max(0, Number(msg.damage) || 0);
        const currentHp = Number(target.stats?.hp) || 0;
        const maxHp = Number(target.stats?.maxHp) || currentHp;
        const newHp = Math.min(maxHp, currentHp + rolled);
        target.stats = target.stats || {};
        target.stats.hp = newHp;
        const healApplied = newHp - currentHp;
        const sensitive = target.type === 'enemy' || target.type === 'npc';
        const reportedAmount = sensitive ? rolled : healApplied;

        meta.ws.send(JSON.stringify({
          type: 'spell:result',
          targetTokenId: target.id,
          resolution: 'heal',
          saveSuccess: null,
          damageApplied: reportedAmount,
        }));

        broadcastToken(context, session, meta.sessionId, 'token:stat:update', target, (recipient) => {
          if (recipient.role === 'gm' || !sensitive) return { tokenId: target.id, stat: 'hp', value: target.stats.hp };
          return { tokenId: target.id, stat: 'hp' };
        });

        const healerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
        logCombatLine(context, session,
          `${healerName} uses ${msg.title || 'a heal'} — ${target.name || 'something'} recovers ${reportedAmount} HP${formatManualDamageText(manualDamageDice)}.`,
          { kind: 'heal', manualDamageDice, sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage: reportedAmount, title: msg.title || null });

        broadcastCreatureSound(context, session, meta.sessionId, msg.sourceTokenId);
        break;
      }

      const rolledDamage = Math.max(0, Number(msg.damage) || 0);
      const appliedDamage = msg.resolution === 'save' && msg.saveSuccess
        ? (msg.saveEffect === 'negate' ? 0 : Math.floor(rolledDamage / 2))
        : rolledDamage;

      // Save halving has already happened above (5e order: save, then resistance and the rest).
      const taken = await resolveDamageForTarget(context, session, target, appliedDamage, damageTypeOfMessage(msg));
      if (!stillThere(context, meta, session, target)) return;
      const dealt = taken.final;

      const currentHp = Number(target.stats?.hp) || 0;
      const newHp = Math.max(0, currentHp - dealt);
      target.stats = target.stats || {};
      target.stats.hp = newHp;

      // Verdict goes only to the caster, mirroring attack:result's shape - reports the
      // intended (pre-cap) damage, not currentHp-newHp, for the same reason attack:resolve
      // reports rolled rather than capped damage: capped would leak exact remaining HP
      // on an overkill (e.g. an enemy with 5 hp left would reveal itself via a 20-damage
      // hit only applying 5).
      meta.ws.send(JSON.stringify({
        type: 'spell:result',
        targetTokenId: target.id,
        resolution: msg.resolution,
        saveSuccess: msg.saveSuccess ?? null,
        // Was a bare "damageApplied" with no such variable in this case (a ReferenceError after
        // the HP write): now the damage dealt, after a PC target's damage_taken modifiers.
        damageApplied: dealt,
        ...(taken.breakdown ? { damageRolled: appliedDamage, breakdown: taken.breakdown } : {}),
      }));

      broadcastToken(context, session, meta.sessionId, 'token:stat:update', target, (recipient) => {
        const sensitive = target.type === 'enemy' || target.type === 'npc';
        if (recipient.role === 'gm' || !sensitive) return { tokenId: target.id, stat: 'hp', value: target.stats.hp };
        return { tokenId: target.id, stat: 'hp' };
      });
      // Same hit-sound cue as attack:resolve, gated on actual damage rather
      // than "resolved" - a negated save deals nothing, so nothing to hear.
      if (dealt > 0) {
        context.broadcast(meta.sessionId, () => ({ type: 'fx:play', damageType: msg.damageType || 'magic' }));
      }
      if (appliedDamage > 0) {

        const attackerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
        const spellTitle = msg.title || 'a spell';
        // damageLabel is the real type (fire, acid...); damageType is the sound-clip bucket.
        const damageTypeText = (msg.damageLabel || msg.damageType) ? `${msg.damageLabel || msg.damageType} ` : '';
        logCombatLine(context, session,
          `${attackerName} uses ${spellTitle} — ${target.name || 'something'} takes ${dealt} ${damageTypeText}damage${formatManualDamageText(manualDamageDice)}${formatDamageTakenText(appliedDamage, taken.breakdown)}.`,
          { kind: 'spell', manualDamageDice, ...(taken.breakdown ? { damageRolled: appliedDamage, damageTaken: taken.steps } : {}), sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage: dealt, damageType: msg.damageLabel || msg.damageType || null, title: msg.title || null });
      }
      // Creature attack cue - casting the spell is the attack, so this fires
      // regardless of whether the save negated all damage (same rationale as
      // attack:resolve's version not being gated on `hit`).
      broadcastCreatureSound(context, session, meta.sessionId, msg.sourceTokenId);
      break;
    }

    default:
      break;
  }
}

export default handleTokenEvent;

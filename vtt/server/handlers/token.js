// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { filterTokenForPlayer } from '../store.js';
import { TARGET_WINDOW_MS } from './target.js';
import { pickRandomCreatureSoundFile, creatureSoundUrl } from '../creatureSoundLibrary.js';

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

// Flavor-text pools for the combat log, picked at random each time so it
// doesn't read as a flat, repetitive damage ticker. {attacker}/{target} are
// always token names; {damage}/{damageType} only apply to the critical-hit
// pool (a miss deals no damage, so there's nothing to interpolate there).
// damageType already carries its own trailing space when present (see
// damageTypeText below) so "{damageType}damage" reads correctly either way.
const MISS_PHRASES = [
  '{attacker} attacks {target}, but is parried!',
  '{target} dodges an attack from {attacker}.',
  "{attacker}'s attack glances off {target}'s armour.",
  '{target} narrowly avoids a strike from {attacker}!',
  '{attacker} swings at {target} and misses completely.',
  "{target} deflects {attacker}'s attack at the last moment.",
];

const CRITICAL_HIT_PHRASES = [
  "[Critical] {attacker}'s attack strikes true! Dealing {damage} {damageType}damage!",
  "[Critical] {attacker} strikes just between the folds of {target}'s armour, dealing {damage} {damageType}damage!",
  '[Critical] A devastating blow from {attacker} tears into {target} for {damage} {damageType}damage!',
  '[Critical] {attacker} finds the perfect opening, striking {target} for a brutal {damage} {damageType}damage!',
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
  // The lowest attack roll that has actually hit this token - server-set only
  // (attack:resolve), never written directly by a client. Top-level so it
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
  'conditions',
  'x',
  'y',
  'spellSlots',
  'imageUrl',
]);

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
// it filtered, and not at all if the token is GM-hidden (Section 5). `extra`
// may be a plain object (same for every recipient) or a function of
// `recipient` - the latter exists for token:stat:update, which needs to omit
// the raw value for player recipients when it's landing on a filtered field.
function broadcastToken(context, sessionId, eventType, token, extra = {}) {
  const extraFor = typeof extra === 'function' ? extra : () => extra;
  context.broadcast(sessionId, (recipient) => {
    if (recipient.role === 'gm') return { type: eventType, ...extraFor(recipient), token };
    if (token.hidden) return null;
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

function handleTokenEvent(meta, msg, context) {
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
      session.tokens[token.id] = token;
      broadcastToken(context, meta.sessionId, 'token:add', token);
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
      token.x = msg.x;
      token.y = msg.y;
      broadcastToken(context, meta.sessionId, 'token:move', token, {
        tokenId: token.id,
        x: token.x,
        y: token.y,
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
      broadcastToken(context, meta.sessionId, 'token:stat:update', token, (recipient) => {
        if (recipient.role === 'gm' || !isSensitiveStat) {
          return { tokenId: token.id, stat: msg.stat, value: appliedValue };
        }
        return { tokenId: token.id, stat: msg.stat };
      });
      break;
    }

    case 'token:hidden:toggle': {
      if (meta.role !== 'gm') return;
      const token = session.tokens[msg.tokenId];
      if (!token) return;
      token.hidden = !token.hidden;
      // Players never see a hidden:toggle event itself (that would leak the
      // token's existence) - instead they see it appear/disappear.
      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') {
          return { type: 'token:hidden:toggle', tokenId: token.id, hidden: token.hidden };
        }
        return token.hidden
          ? { type: 'token:remove', tokenId: token.id }
          : { type: 'token:add', token: filterTokenForPlayer(token) };
      });
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
      const damage = Math.max(0, Number(msg.damage) || 0);
      const outcome = msg.outcome || null; // 'critical_hit' | 'critical_miss' | null
      const ac = typeof target.ac === 'number' ? target.ac
        : typeof target.stats?.ac === 'number' ? target.stats.ac : null;

      let hit;
      if (outcome === 'critical_miss') hit = false;
      else if (outcome === 'critical_hit') hit = true;
      else if (ac == null) hit = true; // no AC configured -> can't determine a miss, treat as hit
      else hit = toHit >= ac;

      let damageApplied = 0;
      let knownAcChanged = false;
      if (hit) {
        const currentHp = Number(target.stats?.hp) || 0;
        const newHp = Math.max(0, currentHp - damage);
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
        damage: hit ? damage : 0,
      }));

      // Broadcast the resulting HP (value stripped for players on enemy/npc, same
      // rule as a direct stat:update) so everyone's token state stays in sync.
      if (hit) {
        broadcastToken(context, meta.sessionId, 'token:stat:update', target, (recipient) => {
          const sensitive = target.type === 'enemy' || target.type === 'npc';
          if (recipient.role === 'gm' || !sensitive) return { tokenId: target.id, stat: 'hp', value: target.stats.hp };
          return { tokenId: target.id, stat: 'hp' };
        });
      }
      // knownAc is the intentionally-public discovered bound - value goes to all.
      if (knownAcChanged) {
        broadcastToken(context, meta.sessionId, 'token:stat:update', target, {
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
        const attackerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
        const targetName = target.name || 'something';
        const damageTypeText = msg.damageType ? `${msg.damageType} ` : '';
        if (!hit) {
          logCombatLine(context, session,
            pickLine(MISS_PHRASES, { attacker: attackerName, target: targetName }),
            { kind: 'attack', outcome: 'miss', sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, title: msg.title || null });
        } else if (outcome === 'critical_hit') {
          logCombatLine(context, session,
            pickLine(CRITICAL_HIT_PHRASES, { attacker: attackerName, target: targetName, damage, damageType: damageTypeText }),
            { kind: 'attack', outcome: 'critical', sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage, damageType: msg.damageType || null, title: msg.title || null });
        } else {
          logCombatLine(context, session,
            `${attackerName} hits ${targetName} for ${damage} ${damageTypeText}damage.`,
            { kind: 'attack', outcome: 'hit', sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage, damageType: msg.damageType || null, title: msg.title || null });
        }
      }
      break;
    }

    // spell:resolve - for save/auto spells only (attack-resolution spells reuse
    // attack:resolve above unchanged - a spell attack roll vs. AC is mechanically
    // identical to a weapon attack once you have a to-hit total). Unlike attack:resolve,
    // there is no hidden value being compared here: a caster's own Spell Save DC isn't
    // secret from them, so saveSuccess is computed client-side (against the DC the
    // roll-spell endpoint already returned to the caster) and simply trusted - the
    // server's job is purely "is this write authorized" (same target-window/GM gate as
    // every other HP mutation path), not secrecy of a comparison.
    case 'spell:resolve': {
      const target = session.tokens[msg.targetTokenId];
      if (!target) return;
      const targetWindowOk = meta.lastTargetTokenIds
        && meta.lastTargetTokenIds.includes(target.id)
        && Date.now() - (meta.lastTargetAt || 0) < TARGET_WINDOW_MS;
      if (meta.role !== 'gm' && !targetWindowOk) return;

      const rolledDamage = Math.max(0, Number(msg.damage) || 0);
      const appliedDamage = msg.resolution === 'save' && msg.saveSuccess
        ? (msg.saveEffect === 'negate' ? 0 : Math.floor(rolledDamage / 2))
        : rolledDamage;

      const currentHp = Number(target.stats?.hp) || 0;
      const newHp = Math.max(0, currentHp - appliedDamage);
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
        damageApplied,
      }));

      broadcastToken(context, meta.sessionId, 'token:stat:update', target, (recipient) => {
        const sensitive = target.type === 'enemy' || target.type === 'npc';
        if (recipient.role === 'gm' || !sensitive) return { tokenId: target.id, stat: 'hp', value: target.stats.hp };
        return { tokenId: target.id, stat: 'hp' };
      });
      // Same hit-sound cue as attack:resolve, gated on actual damage rather
      // than "resolved" - a negated save deals nothing, so nothing to hear.
      if (appliedDamage > 0) {
        context.broadcast(meta.sessionId, () => ({ type: 'fx:play', damageType: msg.damageType || 'magic' }));

        const attackerName = session.tokens[msg.sourceTokenId]?.name || 'Something';
        const spellTitle = msg.title || 'a spell';
        const damageTypeText = msg.damageType ? `${msg.damageType} ` : '';
        logCombatLine(context, session,
          `${attackerName} uses ${spellTitle} — ${target.name || 'something'} takes ${appliedDamage} ${damageTypeText}damage.`,
          { kind: 'spell', sourceTokenId: msg.sourceTokenId, targetTokenId: target.id, damage: appliedDamage, damageType: msg.damageType || null, title: msg.title || null });
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

// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { filterTokenForPlayer } from '../store.js';
import { TARGET_WINDOW_MS } from './target.js';

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
  'imageUrl',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
  'speedFt',
  'speedRemainingFt',
  // Character-sheet pull-through fields (Section 1) - populated once at
  // token:add time from the source character, not otherwise mutated except
  // spellSlots (consumed during play via the mini-sheet, Section 2).
  'characterId',
  'ac',
  'saves',
  'actions',
  'spellSlots',
  'preparedSpells',
]);

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
// at-rest values.
const PLAYER_EDITABLE_FIELDS = new Set([
  'hp',
  'maxHp',
  'speedFt',
  'speedRemainingFt',
  'visionNormalFt',
  'visionDarkFt',
  'visionTrueFt',
  'visionDevilFt',
  'ac',
  'saves',
  'actions',
  'preparedSpells',
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
      const isSensitiveStat = (token.type === 'enemy' || token.type === 'npc') && !TOKEN_LEVEL_STAT_FIELDS.has(msg.stat);
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

    default:
      break;
  }
}

export default handleTokenEvent;

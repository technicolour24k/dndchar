// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { filterTokenForPlayer } from '../store.js';

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
]);

// Broadcasts a token-bearing event: GM always gets the raw token; players get
// it filtered, and not at all if the token is GM-hidden (Section 5).
function broadcastToken(context, sessionId, eventType, token, extra = {}) {
  context.broadcast(sessionId, (recipient) => {
    if (recipient.role === 'gm') return { type: eventType, ...extra, token };
    if (token.hidden) return null;
    return { type: eventType, ...extra, token: filterTokenForPlayer(token) };
  });
}

function handleTokenEvent(meta, msg, context) {
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  switch (msg.type) {
    case 'token:add': {
      if (meta.role !== 'gm') return;
      const token = msg.token;
      if (!token || !token.id) return;
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
      if (!token || !canEditToken(meta, token)) return;
      if (TOKEN_LEVEL_STAT_FIELDS.has(msg.stat)) {
        token[msg.stat] = msg.value;
      } else {
        token.stats = token.stats || {};
        token.stats[msg.stat] = msg.value;
      }
      broadcastToken(context, meta.sessionId, 'token:stat:update', token, {
        tokenId: token.id,
        stat: msg.stat,
        value: msg.value,
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

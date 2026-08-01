// @ts-nocheck - plain untyped JS by design, see vtt/README.md.

// Phase 9 - standalone freeform dice roller, independent of any specific
// check (attack rolls/saves/etc already resolve elsewhere). Results are
// rolled client-side (same trust model as the character sheet's ability/
// skill/save rolls - see CharacterSheetForm.svelte's rollDie - this is a
// small hobby app for a trusted group, not an anti-cheat surface) and sent
// here for structural validation, message-building, and logging only.

// Must match the fallback in src/routes/vtt/api/roll-log/+server.ts - see
// that file's comment for why this is a shared-secret header rather than a
// normal authenticated request.
const INTERNAL_API_SECRET = process.env.VTT_INTERNAL_SECRET || 'vtt-internal-dev-secret';

const DIE_SIDES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };
// Sanity guard against a malformed/absurd payload, not an anti-cheat limit -
// nothing in the modal UI can produce more than this in normal use.
const MAX_DICE_PER_ROLL = 200;

function isValidDiceRequest(dice, results) {
  if (!Array.isArray(dice) || !dice.length) return false;
  let totalCount = 0;
  for (const d of dice) {
    if (!DIE_SIDES[d?.type] || !Number.isInteger(d.count) || d.count <= 0) return false;
    totalCount += d.count;
  }
  if (totalCount > MAX_DICE_PER_ROLL) return false;
  if (!Array.isArray(results) || results.length !== totalCount) return false;
  return results.every((r) => Number.isInteger(r) && r >= 1);
}

// Persists (unless GM-private) and broadcasts via /vtt/api/roll-log, same
// fire-and-forget loopback pattern as token.js's logCombatLine - a dropped
// log write shouldn't block anything, and the live roll:log broadcast on the
// public path happens inside logRoll itself (see rollLog.ts), not here.
function postRollLog(context, sessionId, message, details, visibility) {
  fetch(`${context.internalApiBaseUrl()}/vtt/api/roll-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vtt-internal-secret': INTERNAL_API_SECRET },
    body: JSON.stringify({ sessionId, message, details, visibility }),
  }).catch((err) => console.error('[VTT] roll log write failed', err));
}

function handleDiceEvent(meta, msg, context) {
  // Must be a joined participant (join.js sets meta.sessionId on success).
  if (!meta.sessionId) return;
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  switch (msg.type) {
    case 'dice:roll': {
      const { dice, results } = msg;
      if (!isValidDiceRequest(dice, results)) return;

      const parts = [];
      let offset = 0;
      for (const d of dice) {
        const rolls = results.slice(offset, offset + d.count);
        offset += d.count;
        parts.push({ label: `${d.count}${d.type}`, rolls });
      }
      const total = results.reduce((sum, r) => sum + r, 0);
      const diceSummary = parts.map((p) => p.label).join(' + ');
      const breakdown = `${diceSummary}: ${parts.map((p) => `[${p.rolls.join(', ')}]`).join(' + ')} = ${total}`;

      const who = meta.role === 'gm' ? 'GM' : (meta.playerName || 'A player');
      const message = `${who} rolled ${total} (${diceSummary}).`;

      // Players: always public (no private-roll option this pass, see the
      // brief). GM: private unless the modal's toggle explicitly opted in.
      const visibility = meta.role === 'gm' && msg.public !== true ? 'gm' : 'public';

      postRollLog(context, meta.sessionId, message, { breakdown, total }, visibility);
      break;
    }
    default:
      break;
  }
}

export default handleDiceEvent;

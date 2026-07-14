// @ts-nocheck - plain untyped JS by design, see vtt/README.md.

// Thin pass-through per Phase 2 spec Section 3a: no server-side model beyond
// remembering the sender's most recent target set on their own `meta`
// (already the per-socket registry for sessionId/role/playerId), so Section
// 3b's narrower token:stat:update authorization can check "did this player
// just target this token" without a separate store.
const TARGET_WINDOW_MS = 5 * 60 * 1000; // one combat turn's worth of back-and-forth

function handleTargetEvent(meta, msg, context) {
  if (!meta.sessionId) return; // only reachable after a successful join anyway

  const targetTokenIds = msg.type === 'target:select' ? (Array.isArray(msg.targetTokenIds) ? msg.targetTokenIds : []) : [];
  meta.lastTargetTokenIds = targetTokenIds;
  meta.lastTargetAt = Date.now();

  context.broadcast(meta.sessionId, () => ({
    type: msg.type,
    sourceTokenId: msg.sourceTokenId ?? null,
    targetTokenIds,
  }));
}

export { TARGET_WINDOW_MS };
export default handleTargetEvent;

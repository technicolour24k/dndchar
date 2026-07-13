// @ts-nocheck — plain untyped JS by design, see vtt/README.md.
function handleMapEvent(meta, msg, context) {
  if (meta.role !== 'gm') return;
  const session = context.sessions.get(meta.sessionId);
  if (!session || !msg.map) return;

  session.map = msg.map;
  context.broadcast(meta.sessionId, () => ({ type: 'map:set', map: session.map }));
}

export default handleMapEvent;

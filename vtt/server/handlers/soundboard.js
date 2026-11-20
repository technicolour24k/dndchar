// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
//
// GM-only manual trigger for a random clip from a assets/creature-sounds/
// folder - same broadcast shape as the automatic per-attack cue in
// handlers/token.js (fx:play/creatureSoundUrl), just fired on demand instead
// of off an attack/spell resolution.
import { pickRandomCreatureSoundFile, creatureSoundUrl } from '../creatureSoundLibrary.js';

function handleSoundboardEvent(meta, msg, context) {
  if (meta.role !== 'gm') return;
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  switch (msg.type) {
    case 'soundboard:play': {
      const folder = msg.folder;
      if (!folder) return;
      const filename = pickRandomCreatureSoundFile(folder);
      if (!filename) return;
      context.broadcast(meta.sessionId, () => ({
        type: 'fx:play',
        creatureSoundUrl: creatureSoundUrl(folder, filename),
      }));
      break;
    }
    default:
      break;
  }
}

export default handleSoundboardEvent;

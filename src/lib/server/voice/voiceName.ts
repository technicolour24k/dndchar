// The name shown in voice: the character being played, with the player in brackets.
//   Thorne (Tony)       a player with a character
//   Tony                a player with no character in the campaign
//   DM (Tony)           the primary DM, whatever characters they own
//   Co-DM (Tony)        the co-DM
// Pure, so it is unit tested. The server builds this and bakes it into the Daily token: a name sent
// by the client is never used. Each part is capped so the whole stays well under Daily's 60 chars.

const clip = (s: string, n: number) => s.trim().replace(/\s+/g, ' ').slice(0, n);

export function voiceDisplayName(args: { role: 'dm' | 'co_dm' | 'player'; playerName: string; characterName?: string | null }): string {
  const player = clip(args.playerName || '', 24) || 'Guest';
  if (args.role === 'dm') return `DM (${player})`;
  if (args.role === 'co_dm') return `Co-DM (${player})`;
  const character = clip(args.characterName || '', 30);
  return character ? `${character} (${player})` : player;
}

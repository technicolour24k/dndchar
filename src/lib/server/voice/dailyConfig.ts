// Daily (daily.co) voice config and request bodies. Pure: no I/O, no env access (the caller passes
// the env in), so it is trivially testable.
//
// Daily REST property names below were checked against docs.daily.co on 2026-11-22 (rooms and
// meeting-tokens reference). Not verifiable from the docs alone: Daily's maximum length for user_id
// (we send a 36 char uuid), and the exact error body for "room already exists" (handled loosely in
// dailyClient.ts). enable_recording is an enum with no "off" value, so it is simply omitted (default off).

export type DailyConfig = {
  apiKey: string;
  domain: string;
  roomPrefix: string;
  maxParticipants: number;
  sessionCapSeconds: number;
};

/** A token can only be used to JOIN for this long (seconds). It does not limit the call length. */
export const TOKEN_JOIN_WINDOW_SECONDS = 600;

function intInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Null (voice off) when the key or domain is missing/invalid. Logs once per problem, never the key. */
export function readDailyConfig(env: Record<string, string | undefined>): DailyConfig | null {
  const apiKey = (env.DAILY_API_KEY ?? '').trim();
  let domain = (env.DAILY_DOMAIN ?? '').trim().toLowerCase();
  if (!apiKey || !domain) return null;

  // Accept a pasted URL or full hostname as well as the bare subdomain.
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.daily\.co$/, '');
  if (!/^[a-z0-9-]{1,63}$/.test(domain)) {
    console.error('[voice] DAILY_DOMAIN is not a valid Daily subdomain; voice is off');
    return null;
  }

  const roomPrefix = (env.DAILY_ROOM_PREFIX ?? '').trim();
  if (!/^[A-Za-z0-9_-]{0,10}$/.test(roomPrefix)) {
    console.error('[voice] DAILY_ROOM_PREFIX must be up to 10 of A-Z a-z 0-9 _ -; voice is off');
    return null;
  }

  return {
    apiKey,
    domain,
    roomPrefix,
    maxParticipants: intInRange(env.DAILY_MAX_PARTICIPANTS, 2, 50, 10),
    sessionCapSeconds: intInRange(env.DAILY_SESSION_CAP_HOURS, 1, 12, 6) * 3600
  };
}

export function voiceRoomName(prefix: string, campaignId: string): string {
  return `${prefix}${campaignId.replaceAll('-', '')}`;
}

export function voiceRoomUrl(domain: string, roomName: string): string {
  return `https://${domain}.daily.co/${roomName}`;
}

/** Body for POST /rooms (create) and POST /rooms/<name> (update). */
export function roomProperties(config: DailyConfig) {
  return {
    privacy: 'private',
    properties: {
      max_participants: config.maxParticipants,
      start_video_off: true,
      start_audio_off: false,
      enable_screenshare: false,
      enable_chat: false,
      eject_after_elapsed: config.sessionCapSeconds
    }
  };
}

/** Body for POST /meeting-tokens. Audio-only send permission is enforced here, not just in the UI. */
export function tokenProperties(
  config: DailyConfig,
  args: { roomName: string; userId: string; displayName: string; nowSeconds: number }
) {
  return {
    properties: {
      room_name: args.roomName,
      user_id: args.userId,
      user_name: args.displayName.trim().slice(0, 60),
      // Only limits when the token may be used to join. Deliberately no eject_at_token_exp.
      exp: args.nowSeconds + TOKEN_JOIN_WINDOW_SECONDS,
      is_owner: false,
      eject_after_elapsed: config.sessionCapSeconds,
      start_video_off: true,
      enable_screenshare: false,
      permissions: { canSend: ['audio'], hasPresence: true }
    }
  };
}

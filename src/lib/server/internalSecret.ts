import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

// The shared secret for the VTT ws process calling back into SvelteKit over loopback
// (/vtt/api/log, /roll-log, /damage-taken). The ws side (vtt/server/handlers) reads the same
// VTT_INTERNAL_SECRET env var and falls back to the same dev string, so it works out of the box
// locally. In production the variable should be set: the fallback string is public in the repo.
const DEV_FALLBACK = 'vtt-internal-dev-secret';

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

// `strict`: with no secret configured in production, refuse everything (used where the call can
// change game state, i.e. damage). Non-strict keeps working on the dev fallback but warns once.
export function internalSecretValid(
  header: string | null,
  options: { strict?: boolean; route: string; nodeEnv?: string; secret?: string }
): boolean {
  const configured = (options.secret ?? env.VTT_INTERNAL_SECRET ?? '').trim();
  const production = (options.nodeEnv ?? process.env.NODE_ENV) === 'production';
  if (!configured && production) {
    if (options.strict) {
      warnOnce(options.route, `[VTT] VTT_INTERNAL_SECRET is not set in production: ${options.route} is refusing requests (damage falls back to unreduced). Set it on the host.`);
      return false;
    }
    warnOnce(options.route, `[VTT] VTT_INTERNAL_SECRET is not set in production: ${options.route} is using the public dev fallback secret. Set it on the host.`);
  }
  const expected = Buffer.from(configured || DEV_FALLBACK);
  const given = Buffer.from(header ?? '');
  // timingSafeEqual needs equal lengths; a length mismatch is a plain rejection.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

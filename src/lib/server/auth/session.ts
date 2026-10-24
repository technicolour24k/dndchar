import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Cookies } from '@sveltejs/kit';
import { query } from '$lib/server/db';
import type { SessionUser } from '$lib/types/auth';

const cookieName = 'dndchar_session';
const sessionDays = 14;

// db-traffic-reduction Phase 1: every single HTTP request runs
// getUserForToken (see hooks.server.ts), so this was previously a guaranteed
// query per request - polls, __data.json navigations, VTT asset fetches, all
// of it. Cache the lookup in memory for up to 60s, keyed by the token's hash
// (never the raw token). Single Node process, small trusted group - a plain
// module-level Map is enough, no need for a shared cache service.
const sessionCacheTtlMs = 60_000;
const maxSessionCacheEntries = 500;

type CachedSession = { value: { user: SessionUser; sessionId: string }; expiresAt: number };
const sessionCache = new Map<string, CachedSession>();

// Sweeps out expired entries so a long-running process with many distinct
// tokens (e.g. lots of short-lived logins over time) doesn't grow the map
// forever. Only called opportunistically once the map gets large, not on a
// timer - see the size check in getUserForToken below.
function sweepExpiredSessions(now: number): void {
  for (const [key, entry] of sessionCache) {
    if (entry.expiresAt <= now) sessionCache.delete(key);
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);

  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt]
  );

  return token;
}

export async function loginWithPassword(email: string, password: string): Promise<string | null> {
  const result = await query<{
    id: string;
    email: string;
    display_name: string;
    role: 'user' | 'admin';
    password_hash: string;
  }>('SELECT id, email, display_name, password_hash FROM users WHERE email = lower($1)', [email]);

  const user = result.rows[0];
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  return createSession(user.id);
}

export async function registerWithPassword(email: string, password: string, displayName: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query<{ id: string }>(
    `
      INSERT INTO users (email, display_name, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [normalizedEmail, displayName.trim() || normalizedEmail, passwordHash]
  );

  return createSession(result.rows[0].id);
}

export async function getUserForToken(token: string | undefined): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const now = Date.now();
  const cached = sessionCache.get(tokenHash);
  if (cached && cached.expiresAt > now) return cached.value;

  const result = await query<{
    session_id: string;
    session_expires_at: Date;
    id: string;
    email: string;
    display_name: string;
    role: 'user' | 'admin';
    theme_background_color: string;
    theme_panel_color: string;
    theme_text_color: string;
  }>(
    `
      SELECT
        sessions.id AS session_id,
        sessions.expires_at AS session_expires_at,
        users.id,
        users.email,
        users.display_name,
        users.role,
        COALESCE(users.theme_background_color, '#14161b') AS theme_background_color,
        COALESCE(users.theme_panel_color, '#292929') AS theme_panel_color,
        COALESCE(users.theme_text_color, '#f4f4f4') AS theme_text_color
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1 AND sessions.expires_at > now()
    `,
    [hashToken(token)]
  );

  const row = result.rows[0];
  // Deliberately not cached: a wrong/expired/logged-out token should be
  // rejected on the very next request, not remembered as a miss for 60s.
  if (!row) return null;

  const value = {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      themeBackgroundColor: row.theme_background_color,
      themePanelColor: row.theme_panel_color,
      themeTextColor: row.theme_text_color
    }
  };

  // Cache expiry is the sooner of the TTL and the session's own expiry, so a
  // session that's about to expire naturally doesn't get handed out for
  // another 60s past that point.
  const expiresAt = Math.min(now + sessionCacheTtlMs, new Date(row.session_expires_at).getTime());
  if (sessionCache.size >= maxSessionCacheEntries) sweepExpiredSessions(now);
  sessionCache.set(tokenHash, { value, expiresAt });

  return value;
}

// Called on logout (see deleteSession below) and available for any other
// path that ends a specific session. Treat the cached user object as
// read-only everywhere it's handed out - nothing should mutate
// locals.user/sessionId in place, since that would silently corrupt the
// cached copy for the session's remaining TTL.
export function invalidateSession(sessionId: string): void {
  for (const [key, entry] of sessionCache) {
    if (entry.value.sessionId === sessionId) sessionCache.delete(key);
  }
}

// Called whenever a user's cached fields change (display name, theme
// colours - see updateProfile) so every session they're logged in under
// picks up the change on its next request rather than waiting out the TTL.
//
// Role changes (user <-> admin) have no in-app path - they only happen via
// direct SQL/scripts - so there's no invalidation hook for them. The 60s TTL
// bounds how long a manually-demoted admin keeps admin access; that's an
// accepted risk for this single-replica, small-trusted-group app.
export function invalidateSessionsForUser(userId: string): void {
  for (const [key, entry] of sessionCache) {
    if (entry.value.user.id === userId) sessionCache.delete(key);
  }
}

export async function deleteSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  invalidateSession(sessionId);
}

export function setSessionCookie(cookies: Cookies, token: string): void {
  cookies.set(cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDays * 24 * 60 * 60
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(cookieName, { path: '/' });
}

export function readSessionCookie(cookies: Cookies): string | undefined {
  return cookies.get(cookieName);
}

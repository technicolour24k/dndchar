import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Cookies } from '@sveltejs/kit';
import { query } from '$lib/server/db';
import type { SessionUser } from '$lib/types/auth';

const cookieName = 'dndchar_session';
const sessionDays = 14;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function loginWithPassword(email: string, password: string): Promise<string | null> {
  const result = await query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
  }>('SELECT id, email, display_name, password_hash FROM users WHERE email = lower($1)', [email]);

  const user = result.rows[0];
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);

  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, hashToken(token), expiresAt]
  );

  return token;
}

export async function getUserForToken(token: string | undefined): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;

  const result = await query<{
    session_id: string;
    id: string;
    email: string;
    display_name: string;
  }>(
    `
      SELECT sessions.id AS session_id, users.id, users.email, users.display_name
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1 AND sessions.expires_at > now()
    `,
    [hashToken(token)]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name
    }
  };
}

export async function deleteSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
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

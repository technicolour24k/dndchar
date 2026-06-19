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

  const result = await query<{
    session_id: string;
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
        users.id,
        users.email,
        users.display_name,
        users.role,
        COALESCE(users.theme_background_color, '#f1f1f1') AS theme_background_color,
        COALESCE(users.theme_panel_color, '#292929') AS theme_panel_color,
        COALESCE(users.theme_text_color, '#f4f4f4') AS theme_text_color
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
      displayName: row.display_name,
      role: row.role,
      themeBackgroundColor: row.theme_background_color,
      themePanelColor: row.theme_panel_color,
      themeTextColor: row.theme_text_color
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

import { error } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types/auth';

export function requireAdmin(user: SessionUser | null): SessionUser {
  if (!user || user.role !== 'admin') throw error(403, 'Administrator access required.');
  return user;
}

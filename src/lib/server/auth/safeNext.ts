// Where to send someone after login or register. The "next" value comes from the URL, so it is
// untrusted: only same-origin relative paths are allowed (no open redirect). Anything else, or
// a path back into the login/register pages (which could loop), falls back to the dashboard.

export const DEFAULT_NEXT = '/dashboard';

// Longer than any real in-app path, so a huge value can't be bounced around in URLs and cookies.
const MAX_LENGTH = 2000;

export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_LENGTH) return DEFAULT_NEXT;
  // Must be a path: one leading slash, not "//host" (protocol-relative) and not "/\host"
  // (browsers treat the backslash as a slash).
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return DEFAULT_NEXT;
  // No backslashes or control characters anywhere (browsers strip tabs and newlines, which can
  // turn "/<tab>/evil.example" into "//evil.example").
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT;
  // Trailing slashes are dropped first so "/login/" is caught too.
  const pathname = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  if (pathname === '/login' || pathname === '/register') return DEFAULT_NEXT;
  return raw;
}

/** "?next=..." for links between login and register, or '' when there is nothing to carry. */
export function nextQuery(next: string): string {
  return next && next !== DEFAULT_NEXT ? `?next=${encodeURIComponent(next)}` : '';
}

// Pure helpers for the /campaigns list: reading ?q= / ?page= / ?archived= and building pager
// links that keep the search. No server imports, so the page and the load function share them.

export type ListParams = { q: string; page: number; includeArchived: boolean };

/** Same cap as the service (80 characters), so the box and the query agree. */
export const MAX_SEARCH_LENGTH = 80;

export function parseListParams(params: URLSearchParams, isAdmin: boolean): ListParams {
  const q = (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  // The service clamps a too-high page to the last one; here we only need a sane positive integer.
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  // Only admins can see archived campaigns, so everyone else's flag is ignored.
  const includeArchived = isAdmin && params.get('archived') === '1';
  return { q, page, includeArchived };
}

/** A /campaigns link for the given page, keeping the search and the archived flag. */
export function listHref(opts: ListParams): string {
  const search = new URLSearchParams();
  if (opts.q) search.set('q', opts.q);
  if (opts.includeArchived) search.set('archived', '1');
  if (opts.page > 1) search.set('page', String(opts.page));
  const text = search.toString();
  return text ? `/campaigns?${text}` : '/campaigns';
}

/** "ABCDEFGHJK" -> "ABCDE-FGHJK" (the form people read out and type). */
export function formatInviteCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

export function roleLabel(role: 'dm' | 'co_dm' | 'player' | null): string {
  if (role === 'dm') return 'DM';
  if (role === 'co_dm') return 'Co-DM';
  if (role === 'player') return 'Player';
  return 'Admin';
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorText } from '../../../static/vtt-app/shared/forageView.js';

// Contract drift guard: every error code the forage routes can return must have friendly client
// text. The codes are scraped from the route and helper sources, so adding a code on the server
// without an ERROR_TEXT entry in static/vtt-app/shared/forageView.js fails here.
const SOURCES = [
  'src/routes/vtt/api/forage/+server.ts',
  'src/routes/vtt/api/forage/mine/+server.ts',
  'src/routes/vtt/api/forage/tables/+server.ts',
  'src/routes/vtt/api/session/[id]/forage/+server.ts',
  'src/lib/server/vttForageApi.ts',
  'src/lib/server/vttForageRoll.ts',
  'src/lib/server/services/forage.ts'
];

// Codes the client deliberately doesn't show as text: 'resume' reopens the existing forage, and
// 'invalid_action' can only come from a programming error.
const NOT_SHOWN = new Set(['resume', 'invalid_action', 'unmarked_check']); // unmarked_check: service-internal, the route turns it into 'resume'

function codesIn(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/\berr\('([a-z_]+)'/g, /\berror: '([a-z_]+)'/g, /conflict: '([a-z_]+)'/g, /code: '([a-z_]+)'/g, /'(bad_skill|character_not_found)'/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

describe('forage error codes', () => {
  const codes = [...new Set(SOURCES.flatMap((file) => codesIn(readFileSync(file, 'utf8'))))].filter((code) => !NOT_SHOWN.has(code));

  it('finds the codes it should (so the scrape itself cannot rot silently)', () => {
    for (const known of ['not_found', 'stale_request', 'wrong_stage', 'busy', 'table_empty', 'not_gm', 'stale', 'bad_skill']) {
      expect(codes).toContain(known);
    }
  });

  it('has client text for every code', () => {
    const missing = codes.filter((code) => errorText({ error: code }) === 'Something went wrong.');
    // 'server_error' and 'network' have their own text, anything listed here needs an ERROR_TEXT entry.
    expect(missing).toEqual([]);
  });
});

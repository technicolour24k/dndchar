import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the creature template edit path. SKIPPED unless CAMPAIGN_DB_TEST=1 (same
// switch as campaignsDb.integration.test.ts). LOCAL dev database only: it inserts throwaway users
// (never sessions) with their templates and deletes the users in afterAll (templates cascade).
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   CAMPAIGN_DB_TEST=1 npx vitest run src/lib/server/creatureTemplatesDb.integration.test.ts
const enabled = process.env.CAMPAIGN_DB_TEST === '1';

const { query } = await import('$lib/server/db');
const svc = await import('./services/creatureTemplates');

const tag = `zzcreat${crypto.randomBytes(4).toString('hex')}`;
const userIds: string[] = [];

async function makeUser(key: string) {
  const result = await query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`${tag}-${key}@example.invalid`, `IT ${key}`]
  );
  userIds.push(result.rows[0].id);
  return result.rows[0].id;
}

beforeAll(async () => {
  if (!enabled) return;
  const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
  if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
  if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
  }
});

afterAll(async () => {
  if (!enabled || userIds.length === 0) return;
  await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
});

describe.skipIf(!enabled)('creature template editing (local DB)', () => {
  it('edits only the whitelisted fields, keeps the rest, and is owner-scoped', async () => {
    const owner = await makeUser('owner');
    const other = await makeUser('other');
    const id = await svc.createCreatureTemplate(owner, 'Goblin', {
      type: 'enemy', ac: 15, stats: { hp: 7, maxHp: 7 }, speedFt: 30, visionNormalFt: 30, visionDarkFt: 60,
      imageUrl: 'http://example.invalid/g.png', soundFolder: null, actions: [{ name: 'Scimitar' }]
    });

    const values: Record<string, string> = { name: 'Goblin Boss', hp: '20', maxHp: '25', ac: '17' };
    const patch = svc.sanitiseTemplatePatch({ get: (k: string) => values[k] ?? null });
    expect(await svc.updateCreatureTemplate(other, id, patch)).toBe(false);
    expect(await svc.updateCreatureTemplate(owner, id, patch)).toBe(true);

    const [row] = await svc.listCreatureTemplates(owner);
    expect(row.name).toBe('Goblin Boss');
    expect(row.tokenJson).toMatchObject({
      type: 'enemy', ac: 17, stats: { hp: 20, maxHp: 25 }, speedFt: 30, visionDarkFt: 60,
      imageUrl: 'http://example.invalid/g.png', actions: [{ name: 'Scimitar' }]
    });
    expect(await svc.listCreatureTemplates(other)).toEqual([]);

    // Someone else's delete is a no-op; the owner's removes it.
    await svc.deleteCreatureTemplate(other, id);
    expect(await svc.listCreatureTemplates(owner)).toHaveLength(1);
    await svc.deleteCreatureTemplate(owner, id);
    expect(await svc.listCreatureTemplates(owner)).toEqual([]);
  });
});

import pg from 'pg';
import './load-env';
import { forkFormerMembersContent } from '../src/lib/server/services/libraryFork';
import { describeFork } from '../src/lib/library/rules';

// Repair script for the homebrew library (plans/dndchar/homebrew-library, unit G).
//
// A member who left a campaign BEFORE fork-on-leave shipped left references to their personal library behind: held
// items, known spells, applied conditions, enabled decks, find table entries. They still resolve, but they follow the
// former member's edits and archives. This forks every such campaign's use into campaign copies, the same code as the
// leave flow ('repair' as the reason). It only adds and re-points: nothing is deleted, and it is safe to run again
// (an existing copy is reused, never overwritten).
//
//   npx tsx scripts/fork-former-members.ts --dry-run     (prints what it would copy, writes nothing)
//   npx tsx scripts/fork-former-members.ts               (does it, one transaction per campaign)
//   --campaign <id>                                      (just one campaign)
//   --allow-remote                                       (needed for a non-local database; prod uses
//                                                         npx tsx --env-file=.env.prod scripts/fork-former-members.ts ...)
//
// Afterwards the app's 60 s picker cache clears itself and open sheets pick the change up on their next load. The
// check query "Unforked leavers" in scripts/sql/check-library.sql should then return no rows.

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowRemote = args.includes('--allow-remote');
const only = args.includes('--campaign') ? args[args.indexOf('--campaign') + 1] : null;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '');
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !allowRemote) {
  throw new Error(`Refusing to run against "${host}", which is not local. Pass --allow-remote if you really mean it.`);
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

async function main() {
  console.log(`${dryRun ? 'DRY RUN. ' : ''}Database host: ${host}`);
  const campaigns = (await pool.query(
    'SELECT id, name FROM campaigns WHERE ($1::uuid IS NULL OR id = $1::uuid) ORDER BY created_at, id', [only])).rows;
  let total = 0;
  for (const campaign of campaigns) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same order as the leave flow: the campaign's member rows first, then (inside the fork) its characters.
      await client.query('SELECT user_id FROM campaign_members WHERE campaign_id = $1 ORDER BY user_id FOR UPDATE', [campaign.id]);
      const summaries = await forkFormerMembersContent(client, campaign.id, { dryRun });
      if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
      for (const summary of summaries) {
        total += 1;
        console.log(`${campaign.name} (${campaign.id}): ${describeFork(summary.ownerName, summary.copies)}`);
        console.log(`  reused copies: ${summary.reused}; re-pointed: ${JSON.stringify(summary.repointed)}`);
        for (const note of summary.skipped) console.log(`  note: ${note}`);
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`${campaign.name} (${campaign.id}): FAILED, nothing changed for this campaign.`, error);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  }
  console.log(total ? `Done: ${total} former member${total === 1 ? '' : 's'} handled.` : 'Nothing to repair.');
}

main().finally(() => pool.end());

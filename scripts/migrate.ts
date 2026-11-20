import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

const migrationsDir = path.resolve('src/lib/server/db/migrations');

// `--to <migration_id>` stops after applying that migration (inclusive), so
// local dev can build the DB up to a point in schema history, run the
// pre-content-unification seed/import scripts, then run the rest. See
// docs/db-traffic-reduction Step B for why this ordering matters.
function parseStopAtArg(argv: string[]): string | undefined {
  const index = argv.indexOf('--to');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) {
    throw new Error('--to requires a migration id, e.g. --to 018_inventory_resource_backfill');
  }
  return value;
}

const stopAtId = parseStopAtArg(process.argv.slice(2));

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  if (stopAtId && !files.some((file) => file.replace(/\.sql$/, '') === stopAtId)) {
    throw new Error(`--to ${stopAtId}: no such migration in ${migrationsDir}`);
  }

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const existing = await pool.query('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    if (existing.rowCount) {
      console.log(`skip ${file}`);
      if (stopAtId && id === stopAtId) {
        console.log(`stopping at --to ${stopAtId}`);
        break;
      }
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await pool.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

    if (stopAtId && id === stopAtId) {
      console.log(`stopping at --to ${stopAtId}`);
      break;
    }
  }
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

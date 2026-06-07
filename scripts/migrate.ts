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

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const existing = await pool.query('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    if (existing.rowCount) {
      console.log(`skip ${file}`);
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
  }
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

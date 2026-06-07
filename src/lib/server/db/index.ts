import pg from 'pg';
import { env } from '$env/dynamic/private';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 5,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
    });
  }

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

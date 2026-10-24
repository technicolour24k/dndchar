import pg from 'pg';
import { env } from '$env/dynamic/private';
import { recordQuery, statsEnabled } from './queryStats';

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
  const result = await getPool().query<T>(text, params);
  if (statsEnabled()) recordQuery(result);
  return result;
}

// Wraps a transaction's client so every client.query(...) call inside run()
// is counted the same way query() above is - see queryStats.ts. Only the
// promise form (client.query(text, params), no callback) is used anywhere in
// this codebase, so that's all this wraps. BEGIN/COMMIT/ROLLBACK below use the
// raw client directly and aren't counted, matching what query() would show for
// a single-statement equivalent.
function wrapClientForStats(client: pg.PoolClient): pg.PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (...args: Parameters<pg.PoolClient['query']>) => {
          const result = await (target.query as (...a: unknown[]) => Promise<pg.QueryResult>)(...args);
          recordQuery(result);
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export async function withTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(statsEnabled() ? wrapClientForStats(client) : client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

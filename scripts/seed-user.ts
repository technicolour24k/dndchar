import bcrypt from 'bcryptjs';
import pg from 'pg';
import crypto from 'node:crypto';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.SEED_USER_EMAIL;
const password = process.env.SEED_USER_PASSWORD;
const displayName = process.env.SEED_USER_NAME || 'Admin';

if (!databaseUrl || !email || !password) {
  throw new Error('DATABASE_URL, SEED_USER_EMAIL, and SEED_USER_PASSWORD are required.');
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

async function main() {
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `
      INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES ($1, lower($2), $3, $4, 'admin')
      ON CONFLICT (email) DO UPDATE
      SET display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          role = 'admin',
          updated_at = now()
    `,
    [crypto.randomUUID(), email, displayName, passwordHash]
  );
  console.log(`seeded user ${email}`);
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

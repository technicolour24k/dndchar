import fs from 'node:fs';
import path from 'node:path';

// Loads .env.local, then .env. Never overrides a variable that's already set,
// so precedence is: real environment > .env.local > .env - the same order
// Vite uses for the dev server, so scripts and `npm run dev` agree.
//
// .env.prod (the Neon URL) is deliberately never loaded here - prod only ever
// gets targeted explicitly, via Node's --env-file flag, e.g.
// `npm run db:migrate:prod` or `npx tsx --env-file=.env.prod scripts/x.ts`.
// Anything --env-file sets is already in process.env by the time this runs,
// so it wins over the local files.
for (const file of ['.env.local', '.env']) {
  const envPath = path.resolve(file);
  if (!fs.existsSync(envPath)) continue;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

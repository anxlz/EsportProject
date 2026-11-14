/**
 * Applies pending SQL migrations from ./drizzle. Run with `bun run db:migrate`.
 * Migration bookkeeping lives in the `app` schema as well (app.__drizzle_migrations).
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { prepare: true, max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: 'app' });
  } finally {
    await handle.sql.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  await runMigrations(url);
  console.log('Migrations applied.');
}

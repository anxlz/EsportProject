import { defineConfig } from 'drizzle-kit';

// Only used for `drizzle-kit generate` (diffing the TypeScript schema into SQL migrations).
// Migrations are applied by src/db/migrate.ts, never by drizzle-kit push.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/db/schema.ts',
    './src/db/schema-finance.ts',
    './src/db/schema-contracts.ts',
    './src/db/schema-assistants.ts',
    './src/db/schema-meetings.ts',
  ],
  out: './drizzle',
  schemaFilter: ['app'],
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});

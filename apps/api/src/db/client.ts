import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as coreSchema from './schema.js';
import * as assistantsSchema from './schema-assistants.js';
import * as contractsSchema from './schema-contracts.js';
import * as financeSchema from './schema-finance.js';
import * as meetingsSchema from './schema-meetings.js';

const schema = {
  ...coreSchema,
  ...financeSchema,
  ...contractsSchema,
  ...assistantsSchema,
  ...meetingsSchema,
};

export type Database = PostgresJsDatabase<typeof schema>;
/** Either the root database handle or an open transaction. */
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
}

export function createDb(url: string, opts: { prepare: boolean; max: number }): DbHandle {
  const sql = postgres(url, {
    prepare: opts.prepare,
    max: opts.max,
    onnotice: () => undefined,
  });
  return { sql, db: drizzle(sql, { schema }) };
}

export const DB = Symbol('DB');
export const DB_HANDLE = Symbol('DB_HANDLE');

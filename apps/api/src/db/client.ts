import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

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

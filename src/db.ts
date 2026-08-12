import type Database from 'better-sqlite3';
import { config } from './config.js';
import { postgresStore } from './storage/postgres-store.js';

type SqliteModule = typeof import('./storage/sqlite-store.js');
type SqliteStore = SqliteModule['sqliteStore'];
type AsyncStore<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

function asyncAdapter<T extends Record<string, unknown>>(target: T): AsyncStore<T> {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => value.apply(object, args);
    },
  }) as AsyncStore<T>;
}

export const databaseBackend = config.databaseUrl ? 'postgresql' as const : 'sqlite' as const;
export let sqlite: Database.Database | undefined;
export let store: AsyncStore<SqliteStore>;

if (databaseBackend === 'postgresql') {
  store = postgresStore as unknown as AsyncStore<SqliteStore>;
} else {
  const sqliteModule = await import('./storage/sqlite-store.js');
  sqlite = sqliteModule.sqlite;
  store = asyncAdapter(sqliteModule.sqliteStore as unknown as Record<string, unknown>) as AsyncStore<SqliteStore>;
}

export async function closeDatabase(): Promise<void> {
  if (databaseBackend === 'postgresql') await postgresStore.close();
  else if (sqlite?.open) sqlite.close();
}

/**
 * Synchronous SQLite through Deno FFI. Set DENO_SQLITE_PATH to an absolute
 * SQLite shared library path and grant --allow-env=DENO_SQLITE_PATH --allow-ffi.
 *
 * @example
 * ```ts
 * import Database from '@bonakodo/sqlite';
 * using db = new Database(':memory:');
 * const row = db.prepare<{ answer: number }>('SELECT 42 AS answer').get();
 * console.assert(row?.answer === 42);
 * ```
 * @module
 */
export { Database, Database as default } from './api/database.ts';
export { Statement } from './api/statement.ts';
export { SqliteError } from './errors.ts';
export type {
  AggregateOptions,
  BackupOptions,
  BackupProgress,
  BindParameter,
  ColumnDefinition,
  DatabaseOptions,
  FunctionOptions,
  NamedParameters,
  PragmaOptions,
  Row,
  RunResult,
  SerializeOptions,
  SqlFunction,
  SqlValue,
  TableDefinition,
  TableFactory,
  Transaction,
} from './types.ts';

import type { Database } from './api/database.ts';

/** Values accepted as SQLite parameters. */
export type SqlValue = null | number | bigint | string | Uint8Array;
/** Named parameters use keys without SQLite's prefix character. */
export type NamedParameters = Record<string, SqlValue>;
/**
 * A positional value, readonly parameter array, or named parameter object.
 * Arrays may contain unknown values from query builders; execution validates
 * each value against SqlValue before passing it to SQLite.
 */
export type BindParameter = SqlValue | readonly unknown[] | NamedParameters;
/** Default object-shaped result row. */
export type Row = Record<string, SqlValue>;
/** Result of a statement's run method. */
export interface RunResult {
  /** Rows directly changed by the statement. */
  changes: number;
  /** Last inserted row ID; bigint when safe integers are enabled. */
  lastInsertRowid: number | bigint;
}
/** Description of a result column. */
export interface ColumnDefinition {
  /** Result name or alias. */
  name: string;
  /** Original column, or null for an expression. */
  column: string | null;
  /** Original table, or null for an expression. */
  table: string | null;
  /** Original database, or null for an expression. */
  database: string | null;
  /** Declared type, or null for an expression. */
  type: string | null;
}
/** Options for opening a database. */
export interface DatabaseOptions {
  /** Open without allowing writes. Defaults to false. */
  readonly?: boolean;
  /** Fail if a disk file does not already exist. */
  fileMustExist?: boolean;
  /** Lock wait in milliseconds. Defaults to 5000. */
  timeout?: number;
  /** Called with expanded SQL before each execution. */
  verbose?: ((sql: string) => void) | null;
}
/** Options shared by SQL callbacks. */
export interface FunctionOptions {
  /** Accept any number of arguments. */
  varargs?: boolean;
  /** Mark a function as deterministic. */
  deterministic?: boolean;
  /** Prevent invocation from schema objects such as triggers. */
  directOnly?: boolean;
  /** Convert integer arguments to bigint. */
  safeIntegers?: boolean;
}
/** JavaScript implementation of an SQL scalar function. */
export type SqlFunction = (...values: SqlValue[]) => SqlValue | undefined;
/** Definition of an aggregate or window function. */
export interface AggregateOptions<T = unknown> extends FunctionOptions {
  /** Initial state or a state factory. Defaults to null. */
  start?: T | (() => T);
  /** Update state for a row; undefined retains the current state. */
  step: (state: T, ...values: SqlValue[]) => T | void;
  /** Convert state to an SQLite value. */
  result?: (state: T) => SqlValue | undefined;
  /** Remove a row from a moving window. */
  inverse?: (state: T, ...values: SqlValue[]) => T | void;
}
/** Read-only virtual table definition. */
export interface TableDefinition {
  /** Names of visible columns. */
  columns: string[];
  /** Names of hidden input columns. Defaults to $1, $2, etc. */
  parameters?: string[];
  /** Produce object or array rows from the provided parameters. */
  rows: (
    ...parameters: (SqlValue | undefined)[]
  ) => Generator<Row | SqlValue[], void, unknown>;
  /** Prevent use in schema objects. */
  directOnly?: boolean;
  /** Convert integer inputs to bigint. */
  safeIntegers?: boolean;
}
/** Factory used by CREATE VIRTUAL TABLE statements. */
export type TableFactory = (...arguments_: string[]) => TableDefinition;
/** Current backup progress. */
export interface BackupProgress {
  /** Total source pages. */
  totalPages: number;
  /** Pages yet to copy. */
  remainingPages: number;
}
/** Options for incremental online backup. */
export interface BackupOptions {
  /** Source schema. Defaults to main. */
  attached?: string;
  /** Return a new pages-per-step count; zero pauses the backup. */
  progress?: ((progress: BackupProgress) => number | void) | null;
}
/** Options for serialization or deserialization-related schema selection. */
export interface SerializeOptions {
  /** Schema name. Defaults to main. */
  attached?: string;
}
/** Options for PRAGMA result conversion. */
export interface PragmaOptions {
  /** Return just the first column of the first row. */
  simple?: boolean;
}
/** Synchronous transaction wrapper preserving arguments and return type. */
export type Transaction<F extends (...args: never[]) => unknown> = F & {
  /** Database that owns the transaction. */
  readonly database: Database;
  /** Default BEGIN transaction. */
  readonly default: Transaction<F>;
  /** BEGIN DEFERRED transaction. */
  readonly deferred: Transaction<F>;
  /** BEGIN IMMEDIATE transaction. */
  readonly immediate: Transaction<F>;
  /** BEGIN EXCLUSIVE transaction. */
  readonly exclusive: Transaction<F>;
};

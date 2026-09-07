import type { Database } from './database.ts';
import {
  type Connection,
  iteratorFinalizer,
  statementFinalizer,
} from './connection.ts';
import { bind, type BindingLayout, bindingLayout, metadata } from './values.ts';
import { createRowReader, readOneRow, type RowMode } from './rows.ts';
import { string } from '../native/memory.ts';
import { requireCapability } from '../native/loader.ts';
import type {
  BindParameter,
  ColumnDefinition,
  Row,
  RunResult,
  SqlValue,
} from '../types.ts';
import { toggle } from './validation.ts';

/**
 * A reusable, synchronous SQLite statement. Create one with
 * {@link Database.prepare} and release it with a `using` declaration or by
 * closing its database.
 *
 * @typeParam T Result row shape; defaults to {@link Row}.
 *
 * @example
 * ```ts
 * import { Database } from '@bonakodo/sqlite';
 *
 * using db = new Database(':memory:');
 * using query = db.prepare<{ answer: number }>('SELECT $value AS answer');
 * console.assert(query.get({ value: 42 })?.answer === 42);
 * console.assert(query.get({ value: 7 })?.answer === 7);
 * ```
 */
export class Statement<T = Row> {
  /** Parent database. */
  readonly database: Database;
  /** Original SQL text. */
  readonly source: string;
  #connection: Connection;
  #pointer: Deno.PointerObject;
  #safe: boolean;
  #mode: RowMode = 'object';
  #bound = false;
  #busy = false;
  #reader: boolean;
  #readonly: boolean;
  #bindings: BindingLayout;
  #readRow: (() => T) | undefined;
  #hasRead = false;
  #rowVersion = -1;
  #firstRow = true;
  /** Internal constructor; use Database.prepare(). */
  constructor(
    database: Database,
    connection: Connection,
    pointer: Deno.PointerObject,
    source: string,
  ) {
    this.database = database;
    this.source = source;
    this.#connection = connection;
    this.#pointer = pointer;
    this.#safe = connection.safe;
    this.#reader = connection.sql.sqlite3_column_count(pointer) > 0;
    this.#readonly = connection.sql.sqlite3_stmt_readonly(pointer) !== 0;
    this.#bindings = bindingLayout(connection.sql, pointer);
    statementFinalizer.register(this, { connection, pointer }, this);
  }
  #assert(): void {
    this.#connection.assertIdle();
    if (!this.#connection.statements.has(this.#pointer)) {
      throw new TypeError('Statement has been finalized');
    }
    if (this.#busy) {
      throw new TypeError('This statement is busy executing a query');
    }
  }
  /** Whether this statement returns rows. */
  get reader(): boolean {
    return this.#reader;
  }
  /** Whether this statement can run without writing. */
  get readonly(): boolean {
    return this.#readonly;
  }
  /** Whether an iterator currently owns this statement. */
  get busy(): boolean {
    return this.#busy;
  }
  #start(parameters: BindParameter[], reader: boolean): void {
    this.#assert();
    if (reader && !this.reader) {
      throw new TypeError('This statement does not return data; use run()');
    }
    if (!this.#readonly) this.#connection.assertIdle(true);
    if (this.#bound && parameters.length) {
      throw new TypeError('This statement already has bound parameters');
    }
    try {
      if (!this.#bound && (this.#bindings.count || parameters.length)) {
        bind(this.#connection, this.#pointer, parameters, this.#bindings);
      }
      if (this.#connection.verbose) this.#connection.log(this.#pointer);
      this.#firstRow = true;
    } catch (error) {
      this.#reset();
      throw error;
    }
  }
  #reset(suppress = false, alreadyReset = false): void {
    if (!alreadyReset) this.#connection.reset(this.#pointer);
    if (!this.#bound && this.#bindings.count) {
      this.#connection.sql.sqlite3_clear_bindings(this.#pointer);
    }
    if (suppress) this.#connection.error = undefined;
    else this.#connection.check(0);
  }
  #step(): number {
    return this.#connection.step(this.#pointer);
  }
  #row(): T {
    if (this.#firstRow) {
      this.#firstRow = false;
      // SQLite may rebuild a prepared statement when its schema changes.
      const version = this.#connection.sql.sqlite3_stmt_status(
        this.#pointer,
        5, // SQLITE_STMTSTATUS_REPREPARE
        0,
      );
      if (!this.#readRow || version !== this.#rowVersion) {
        this.#readRow = createRowReader(
          this.#connection,
          this.#pointer,
          this.#mode,
          this.#safe,
        ) as () => T;
        this.#rowVersion = version;
      }
    }
    return this.#readRow!();
  }
  /**
   * Execute and discard any result rows.
   *
   * @param parameters Positional values, arrays, or named parameter objects.
   * Omit these after calling {@link Statement.bind}.
   * @returns The number of changed rows and last inserted row ID.
   */
  run(...parameters: BindParameter[]): RunResult {
    this.#start(parameters, false);
    let failed = true;
    let reset = false;
    try {
      const c = this.#connection;
      const s = c.sql;
      const before = s.sqlite3_total_changes(c.pointer);
      this.#step();
      const rc = c.reset(this.#pointer);
      reset = true;
      c.check(rc);
      const id = s.sqlite3_last_insert_rowid(c.pointer);
      const result = {
        changes: before === s.sqlite3_total_changes(c.pointer)
          ? 0
          : s.sqlite3_changes(c.pointer),
        lastInsertRowid: this.#safe ? id : Number(id),
      };
      failed = false;
      return result;
    } finally {
      this.#reset(failed, reset);
    }
  }
  /**
   * Retrieve the first row and reset the statement for reuse.
   *
   * @param parameters Positional values, arrays, or named parameter objects.
   * Omit these after calling {@link Statement.bind}.
   * @returns The first row in the selected row mode, or `undefined` if empty.
   * @throws {TypeError} If the statement does not return rows.
   */
  get(...parameters: BindParameter[]): T | undefined {
    this.#start(parameters, true);
    let failed = true;
    try {
      let row: T | undefined;
      if (this.#step() === 100) {
        // One-off reads avoid building a cached shape or compiling a factory.
        row = this.#hasRead || this.#readRow ? this.#row() : readOneRow(
          this.#connection,
          this.#pointer,
          this.#mode,
          this.#safe,
        ) as T;
        this.#hasRead = true;
      }
      failed = false;
      return row;
    } finally {
      this.#reset(failed);
    }
  }
  /**
   * Retrieve all result rows and reset the statement for reuse.
   *
   * @param parameters Positional values, arrays, or named parameter objects.
   * Omit these after calling {@link Statement.bind}.
   * @returns Rows in the selected row mode, or an empty array if none match.
   * @throws {TypeError} If the statement does not return rows.
   */
  all(...parameters: BindParameter[]): T[] {
    this.#start(parameters, true);
    let failed = true;
    const c = this.#connection;
    const s = c.sql;
    const pointer = this.#pointer;
    c.executing = true;
    try {
      const rows: T[] = [];
      let rc = s.sqlite3_step(pointer);
      c.check(rc);
      if (rc === 100) {
        rows.push(this.#row());
        const read = this.#readRow!;
        // No user code runs between rows; keep the connection guarded for the
        // whole scan and reuse the reader without checking its shape per row.
        while ((rc = s.sqlite3_step(pointer)) === 100) {
          c.check(rc);
          rows.push(read());
        }
        c.check(rc);
      }
      failed = false;
      return rows;
    } finally {
      c.executing = false;
      this.#reset(failed);
    }
  }
  /**
   * Iterate rows synchronously without collecting them in an array.
   *
   * Exhaust the iterator, call its `return()` method, or exit a `for...of` loop
   * to reset the statement. While the iterator is open, this statement is busy
   * and the database rejects writes and attempts to close it.
   *
   * @param parameters Positional values, arrays, or named parameter objects.
   * Omit these after calling {@link Statement.bind}.
   * @returns An iterator of rows in the selected row mode.
   */
  iterate(...parameters: BindParameter[]): IterableIterator<T> {
    this.#start(parameters, true);
    this.#busy = true;
    this.#connection.iterators++;
    let closed = false;
    const token = {};
    const close = (suppress = false) => {
      if (!closed) {
        iteratorFinalizer.unregister(token);
        closed = true;
        this.#busy = false;
        this.#connection.iterators--;
        this.#reset(suppress);
      }
    };
    const iterator: IterableIterator<T> = {
      [Symbol.iterator]() {
        return this;
      },
      next: () => {
        if (closed) return { value: undefined, done: true };
        try {
          if (this.#step() === 100) return { value: this.#row(), done: false };
          close();
          return { value: undefined, done: true };
        } catch (error) {
          close(true);
          throw error;
        }
      },
      return: () => {
        close();
        return { value: undefined, done: true };
      },
    };
    iteratorFinalizer.register(iterator, () => close(true), token);
    return iterator;
  }
  /**
   * Bind parameters permanently for all subsequent executions.
   *
   * Call this only once. Later calls to `run`, `get`, `all`,
   * and `iterate` must omit parameters.
   *
   * @param parameters Positional values, arrays, or named parameter objects.
   * Named keys omit SQLite's prefix: use `{ id: 1 }` for `$id`, `:id`, or `@id`.
   * @returns This statement.
   * @throws {TypeError} If this statement already has permanent bindings.
   */
  bind(...parameters: BindParameter[]): this {
    this.#assert();
    if (this.#bound) {
      throw new TypeError('The statement already has bound parameters');
    }
    try {
      bind(this.#connection, this.#pointer, parameters, this.#bindings);
      this.#bound = true;
    } catch (error) {
      this.#reset();
      throw error;
    }
    return this;
  }
  #setMode(mode: RowMode, enabled: boolean): void {
    this.#assert();
    if (!this.reader) {
      throw new TypeError('This statement does not return data');
    }
    this.#readRow = undefined;
    this.#mode = toggle(enabled)
      ? mode
      : this.#mode === mode
      ? 'object'
      : this.#mode;
  }
  /**
   * Return only the first column of each row.
   *
   * @param enabled Enable this mode (default true), replacing other row modes.
   * False restores object rows if this mode is active.
   * @returns This statement typed for single-value rows.
   */
  pluck(enabled = true): Statement<SqlValue> {
    this.#setMode('pluck', enabled);
    return this as unknown as Statement<SqlValue>;
  }
  /**
   * Return rows as arrays in result-column order.
   *
   * @param enabled Enable this mode (default true), replacing other row modes.
   * False restores object rows if this mode is active.
   * @returns This statement typed for array rows.
   */
  raw(enabled = true): Statement<SqlValue[]> {
    this.#setMode('raw', enabled);
    return this as unknown as Statement<SqlValue[]>;
  }
  /**
   * Group each row's columns by source table, using `$` for expressions.
   * Requires the native library's column metadata capability.
   *
   * @param enabled Enable this mode (default true), replacing other row modes.
   * False restores object rows if this mode is active.
   * @returns This statement typed for rows grouped by table.
   */
  expand(enabled = true): Statement<Record<string, Row>> {
    requireCapability('metadata');
    this.#setMode('expand', enabled);
    return this as unknown as Statement<Record<string, Row>>;
  }
  /**
   * Set integer conversion for result rows and the last inserted row ID.
   *
   * @param enabled Use `bigint` when true (the default). False uses `number`,
   * which can lose precision for large integers.
   * @returns This statement.
   */
  safeIntegers(enabled = true): this {
    this.#assert();
    this.#safe = toggle(enabled);
    this.#readRow = undefined;
    return this;
  }
  /** Describe the statement's result columns. */
  columns(): ColumnDefinition[] {
    this.#assert();
    if (!this.reader) {
      throw new TypeError('This statement does not return data');
    }
    return Array.from({
      length: this.#connection.sql.sqlite3_column_count(this.#pointer),
    }, (_, i) => metadata(this.#connection, this.#pointer, i));
  }
  /** Original SQL, expanded with permanent bindings when present. */
  toString(): string {
    this.#assert();
    if (!this.#bound) return this.source;
    const p = this.#connection.sql.sqlite3_expanded_sql(this.#pointer);
    try {
      return string(p)!;
    } finally {
      this.#connection.sql.sqlite3_free(p);
    }
  }
  /** Release this statement early. Database.close() also releases it. */
  [Symbol.dispose](): void {
    if (!this.#connection.statements.has(this.#pointer)) return;
    this.#assert();
    statementFinalizer.unregister(this);
    this.#connection.finalize(this.#pointer);
  }
}

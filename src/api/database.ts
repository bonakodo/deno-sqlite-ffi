import { NativeCapabilityError } from '../native/errors.ts';
import { requireCapability } from '../native/loader.ts';
import { allocate, copy, cstring, pointer, string } from '../native/memory.ts';
import type {
  AggregateOptions,
  BackupOptions,
  BackupProgress,
  DatabaseOptions,
  FunctionOptions,
  PragmaOptions,
  Row,
  SerializeOptions,
  SqlFunction,
  SqlValue,
  TableDefinition,
  TableFactory,
  Transaction,
} from '../types.ts';
import { SqliteError } from '../errors.ts';
import { Connection, databaseFinalizer } from './connection.ts';
import { Statement } from './statement.ts';
import { boolean, hasSql, options, text, toggle } from './validation.ts';
import { registerAggregate, registerFunction } from './functions.ts';
import { backup } from './backup.ts';
import { registerTable } from './tables.ts';

/**
 * Synchronous SQLite database, compatible with better-sqlite3's public API.
 *
 * Set `DENO_SQLITE_PATH` to an absolute SQLite shared library path and grant
 * `--allow-env=DENO_SQLITE_PATH --allow-ffi` before opening a database.
 * Use a `using` declaration or call {@link Database.close} to release resources.
 *
 * @example
 * ```ts
 * import { Database } from '@bonakodo/sqlite';
 *
 * using db = new Database(':memory:');
 * db.exec('CREATE TABLE users (name TEXT)');
 * db.prepare('INSERT INTO users VALUES (?)').run('Ada');
 * const user = db.prepare<{ name: string }>('SELECT name FROM users').get();
 * console.assert(user?.name === 'Ada');
 * ```
 */
export class Database {
  /** SQLite error constructor, also available as a named export. */
  static readonly SqliteError: typeof SqliteError = SqliteError;
  /** Original filename, or :memory: for deserialized databases. */
  readonly name: string;
  /** Whether the database is in memory or temporary. */
  readonly memory: boolean;
  /** Whether the database was opened readonly. */
  readonly readonly: boolean;
  #connection: Connection;
  #transactionDepth = 0;
  /**
   * Open a database and enable foreign key checks.
   *
   * @param filename Disk path, `:memory:`, or an image from
   * {@link Database.serialize}. An empty string (the default) opens a temporary
   * database. A byte array opens an independent in-memory copy.
   * @param config Open mode, lock timeout, and SQL logging options.
   * @throws {TypeError} If a filename or option has an invalid type or value.
   * @throws {SqliteError} If SQLite cannot open the database.
   */
  constructor(
    filename: string | Uint8Array = '',
    config: DatabaseOptions = {},
  ) {
    options(config);
    if ('nativeBinding' in config) {
      throw new TypeError('Use DENO_SQLITE_PATH instead of nativeBinding');
    }
    if ('readOnly' in config || 'memory' in config) {
      throw new TypeError('Use readonly and the :memory: filename');
    }
    for (const key of ['readonly', 'fileMustExist'] as const) {
      if (config[key] !== undefined) boolean(config[key], key);
    }
    const buffer = filename instanceof Uint8Array ? filename : undefined;
    if (buffer) filename = ':memory:';
    text(filename, 'Database filename');
    this.name = filename;
    const path = filename.trim();
    this.memory = !path || path === ':memory:';
    this.readonly = config.readonly ?? false;
    if (this.memory && this.readonly && !buffer) {
      throw new TypeError('In-memory/temporary databases cannot be readonly');
    }
    const timeout = config.timeout ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 0) {
      throw new TypeError('timeout must be a nonnegative integer');
    }
    if (timeout > 0x7fffffff) {
      throw new RangeError('timeout cannot exceed 2147483647');
    }
    const verbose = config.verbose ?? null;
    if (verbose !== null && typeof verbose !== 'function') {
      throw new TypeError('verbose must be a function');
    }
    const flags = buffer || this.memory
      ? 6
      : this.readonly
      ? 1
      : config.fileMustExist
      ? 2
      : 6;
    this.#connection = new Connection(path, flags, timeout, verbose);
    try {
      if (buffer) this.#deserialize(buffer);
      const saved = this.#connection.verbose;
      this.#connection.verbose = null;
      this.#connection.exec('PRAGMA foreign_keys=ON');
      this.#connection.verbose = saved;
    } catch (error) {
      this.#connection.close();
      throw error;
    }
    databaseFinalizer.register(this, this.#connection, this);
  }
  /** Whether the connection is open. */
  get open(): boolean {
    return this.#connection.pointer !== null;
  }
  /** Whether SQLite currently has an open transaction. */
  get inTransaction(): boolean {
    return this.open &&
      !this.#connection.sql.sqlite3_get_autocommit(this.#connection.pointer);
  }
  /**
   * Compile exactly one SQL statement for repeated execution.
   *
   * @typeParam T Result row shape. This type does not validate rows at runtime.
   * @param sql SQL text, optionally containing positional or named parameters.
   * @returns A statement owned by this database.
   * @throws {RangeError} If the SQL contains zero or more than one statement.
   */
  prepare<T = Row>(sql: string): Statement<T> {
    text(sql, 'SQL');
    const c = this.#connection;
    c.assertIdle();
    const first = c.prepare(sql);
    if (!first.statement) {
      throw new RangeError('The SQL string contains no statements');
    }
    try {
      if (hasSql(first.rest)) {
        throw new RangeError('The SQL string contains more than one statement');
      }
      return new Statement<T>(this, c, first.statement, sql);
    } catch (error) {
      c.finalize(first.statement);
      throw error;
    }
  }
  /**
   * Execute one or more SQL statements, discarding result rows.
   *
   * @param sql SQL text without bound parameters. Use {@link Database.prepare}
   * to bind values supplied by callers.
   * @returns This database.
   */
  exec(sql: string): this {
    text(sql, 'SQL');
    this.#connection.exec(sql);
    return this;
  }
  /**
   * Execute a PRAGMA, optionally returning only its first value.
   *
   * @param sql PRAGMA expression without the `PRAGMA` keyword, such as
   * `journal_mode = WAL`.
   * @param config Set `simple` to return the first column of the first row.
   * @returns Result rows, or a single value in simple mode. With no rows,
   * returns an empty array or `undefined`, respectively.
   */
  pragma(
    sql: string,
    config: PragmaOptions = {},
  ): Row[] | SqlValue | undefined {
    text(sql, 'PRAGMA');
    options(config);
    if (config.simple !== undefined) boolean(config.simple, 'simple');
    this.#connection.assertIdle(true);
    using stmt = this.prepare(`PRAGMA ${sql}`);
    if (!stmt.reader) {
      stmt.run();
      return config.simple ? undefined : [];
    }
    return config.simple ? stmt.pluck().get() : stmt.all();
  }
  /**
   * Explain a statement, leaving parameters unbound.
   *
   * @param sql One SQL statement without `EXPLAIN`. Prefix it with `QUERY PLAN`
   * to inspect the query plan instead of SQLite instructions.
   * @returns Explanation rows from SQLite.
   */
  explain(sql: string): Row[] {
    text(sql, 'SQL');
    const c = this.#connection;
    c.assertIdle();
    const compiled = c.prepare(`EXPLAIN ${sql}`);
    if (!compiled.statement) throw new RangeError('Expected an SQL statement');
    try {
      if (hasSql(compiled.rest)) {
        throw new RangeError('Expected one SQL statement');
      }
      const s = c.sql;
      const rows: Row[] = [];
      c.log(compiled.statement);
      while (true) {
        const rc = c.step(compiled.statement);
        if (rc !== 100) break;
        const row: Row = {};
        for (let i = 0; i < s.sqlite3_column_count(compiled.statement); i++) {
          const type = s.sqlite3_column_type(compiled.statement, i);
          row[string(s.sqlite3_column_name(compiled.statement, i))!] =
            type === 1
              ? Number(s.sqlite3_column_int64(compiled.statement, i))
              : string(s.sqlite3_column_text(compiled.statement, i));
        }
        rows.push(row);
      }
      return rows;
    } finally {
      c.finalize(compiled.statement);
    }
  }
  /**
   * Wrap a synchronous function in a transaction, nesting through savepoints.
   *
   * The wrapper commits when the callback returns and rolls back when it throws.
   * It preserves the caller's arguments, `this`, and return value. Call its
   * `deferred`, `immediate`, or `exclusive` variant to choose the BEGIN mode.
   *
   * @param fn Synchronous callback. Returning a promise causes a TypeError and
   * rollback; do not use async functions here.
   * @returns A callable transaction wrapper. Creating it does not run `fn`.
   *
   * @example
   * ```ts
   * import { Database } from '@bonakodo/sqlite';
   *
   * using db = new Database(':memory:');
   * db.exec('CREATE TABLE items (name TEXT)');
   * using insert = db.prepare('INSERT INTO items VALUES (?)');
   * const insertMany = db.transaction((names: string[]) => {
   *   for (const name of names) insert.run(name);
   *   return names.length;
   * });
   * console.assert(insertMany.immediate(['one', 'two']) === 2);
   * ```
   */
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    this.#connection.assertOpen();
    if (typeof fn !== 'function') {
      throw new TypeError('Expected a transaction function');
    }
    // The transaction callback receives its caller's this binding.
    // deno-lint-ignore no-this-alias
    const db = this;
    function wrap(mode: string) {
      const begin = mode ? `BEGIN ${mode}` : 'BEGIN';
      return function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const c = db.#connection;
        c.assertIdle(true);
        const nested = db.inTransaction;
        // Reuse controls at each depth while keeping recursive savepoints distinct.
        const savepoint = nested ? `deno_sqlite_${db.#transactionDepth}` : '';
        c.transactionControl(nested ? `SAVEPOINT ${savepoint}` : begin);
        db.#transactionDepth++;
        try {
          const value = fn.apply(this, args) as ReturnType<F>;
          if (
            value !== null &&
            (typeof value === 'object' || typeof value === 'function') &&
            'then' in value && typeof value.then === 'function'
          ) throw new TypeError('Transaction functions must be synchronous');
          c.transactionControl(nested ? `RELEASE ${savepoint}` : 'COMMIT');
          return value;
        } catch (error) {
          if (db.inTransaction) {
            if (nested) {
              c.transactionControl(`ROLLBACK TO ${savepoint}`);
              c.transactionControl(`RELEASE ${savepoint}`);
            } else c.transactionControl('ROLLBACK');
          }
          throw error;
        } finally {
          db.#transactionDepth--;
        }
      };
    }
    const wrappers = {
      default: wrap(''),
      deferred: wrap('DEFERRED'),
      immediate: wrap('IMMEDIATE'),
      exclusive: wrap('EXCLUSIVE'),
    };
    const properties = {
      default: { value: wrappers.default },
      deferred: { value: wrappers.deferred },
      immediate: { value: wrappers.immediate },
      exclusive: { value: wrappers.exclusive },
      database: { value: this, enumerable: true },
    };
    for (const wrapper of Object.values(wrappers)) {
      Object.defineProperties(wrapper, properties);
    }
    return wrappers.default as Transaction<F>;
  }
  /**
   * Set integer conversion for newly created statements and callbacks.
   *
   * @param enabled Use `bigint` for SQLite integers when true (the default).
   * False uses `number`, which can lose precision for large integers.
   * @returns This database. Existing statements and callbacks keep their setting.
   */
  defaultSafeIntegers(enabled = true): this {
    this.#connection.assertOpen();
    this.#connection.safe = toggle(enabled);
    return this;
  }
  /** Unsupported: stock SQLite configuration needs variadic calls unavailable in Deno FFI. */
  unsafeMode(_enabled = true): never {
    throw new NativeCapabilityError('unsafeMode/defensiveMode');
  }
  /**
   * Register a scalar SQL function with default options.
   *
   * @param name SQL function name.
   * @param fn Synchronous callback. Its declared parameter count sets the SQL
   * argument count. Returning `undefined` produces SQL NULL.
   * @returns This database.
   */
  function(name: string, fn: SqlFunction): this;
  /**
   * Register a scalar SQL function with options.
   *
   * @param name SQL function name.
   * @param config Argument count, integer conversion, and SQLite function flags.
   * @param fn Synchronous callback returning an SQLite value or `undefined`
   * for SQL NULL.
   * @returns This database.
   *
   * @example
   * ```ts
   * import { Database } from '@bonakodo/sqlite';
   *
   * using db = new Database(':memory:');
   * db.function('double', { deterministic: true }, (value) => Number(value) * 2);
   * console.assert(db.prepare('SELECT double(?)').pluck().get(21) === 42);
   * ```
   */
  function(name: string, config: FunctionOptions, fn: SqlFunction): this;
  function(
    name: string,
    config: FunctionOptions | SqlFunction,
    fn?: SqlFunction,
  ): this {
    registerFunction(
      this.#connection,
      name,
      typeof config === 'function' ? {} : config,
      typeof config === 'function' ? config : fn!,
    );
    return this;
  }
  /**
   * Register an aggregate, with `inverse` enabling window queries.
   *
   * @typeParam T Aggregate state passed between callbacks.
   * @param name SQL function name.
   * @param config State and callbacks. Use a `start` factory for mutable state
   * so each group has its own object.
   * @returns This database.
   */
  aggregate<T>(name: string, config: AggregateOptions<T>): this {
    registerAggregate(this.#connection, name, config);
    return this;
  }
  /**
   * Register a read-only virtual table whose rows come from a generator.
   *
   * @param name SQL module name.
   * @param definition A definition for direct queries, or a factory invoked by
   * `CREATE VIRTUAL TABLE ... USING name(...)`.
   * @returns This database.
   *
   * @example
   * ```ts
   * import { Database } from '@bonakodo/sqlite';
   *
   * using db = new Database(':memory:');
   * db.table('names', {
   *   columns: ['name'],
   *   rows: function* () {
   *     yield { name: 'Ada' };
   *     yield { name: 'Grace' };
   *   },
   * });
   * console.assert(db.prepare('SELECT name FROM names').all().length === 2);
   * ```
   */
  table(name: string, definition: TableDefinition | TableFactory): this {
    registerTable(this.#connection, name, definition);
    return this;
  }
  /**
   * Load a native SQLite extension, enabling loading only for this call.
   *
   * @param path Extension shared library path.
   * @param entryPoint Initialization symbol. When omitted, SQLite selects it.
   * @returns This database.
   */
  loadExtension(path: string, entryPoint?: string): this {
    text(path, 'Extension path', false);
    if (entryPoint !== undefined) {
      text(entryPoint, 'Extension entry point', false);
    }
    const c = this.#connection;
    c.assertIdle(true);
    requireCapability('extensions');
    const s = c.sql;
    c.check(s.sqlite3_enable_load_extension(c.pointer, 1));
    const error = new BigUint64Array(1);
    try {
      const rc = c.call(() =>
        s.sqlite3_load_extension(
          c.pointer,
          cstring(path),
          entryPoint === undefined ? null : cstring(entryPoint),
          error,
        )
      );
      if (rc) {
        throw new SqliteError(
          string(pointer(error)) ?? 'Unable to load extension',
          'SQLITE_ERROR',
        );
      }
    } finally {
      s.sqlite3_free(pointer(error));
      s.sqlite3_enable_load_extension(c.pointer, 0);
    }
    return this;
  }
  /**
   * Copy the database incrementally to a disk file, yielding between steps.
   *
   * Keep the source database open until the promise settles. Closing it cancels
   * the backup and rejects the promise.
   *
   * @param destination Disk path distinct from the source. The backup replaces
   * the contents of an existing destination database.
   * @param config Source schema and optional progress callback.
   * @returns Final page counts with `remainingPages` equal to zero.
   */
  backup(
    destination: string,
    config: BackupOptions = {},
  ): Promise<BackupProgress> {
    return backup(this.#connection, destination, config);
  }
  /**
   * Copy a schema into an owned Uint8Array database image.
   *
   * @param config Schema to copy; defaults to `main`.
   * @returns Independent bytes that remain valid after the database closes.
   * Pass them to the {@link Database} constructor to open an in-memory copy.
   */
  serialize(config: SerializeOptions = {}): Uint8Array {
    options(config);
    const attached = config.attached ?? 'main';
    text(attached, 'Attached database', false);
    const c = this.#connection;
    c.assertIdle();
    requireCapability('serialize');
    const size = new BigInt64Array(1);
    const p = c.sql.sqlite3_serialize(c.pointer, cstring(attached), size, 0);
    const length = size[0]!;
    if (length < 0n) {
      throw new SqliteError('Unable to serialize database', 'SQLITE_ERROR');
    }
    if (!p && length > 0n) {
      throw new SqliteError(
        'Unable to allocate serialized database',
        'SQLITE_NOMEM',
      );
    }
    try {
      return copy(p, Number(length));
    } finally {
      c.sql.sqlite3_free(p);
    }
  }
  #deserialize(bytes: Uint8Array): void {
    requireCapability('deserialize');
    const c = this.#connection;
    const p = allocate(bytes);
    const rc = c.sql.sqlite3_deserialize(
      c.pointer,
      cstring('main'),
      p,
      BigInt(bytes.length),
      BigInt(bytes.length),
      this.readonly ? 1 | 4 : 1 | 2,
    );
    // SQLite frees SQLITE_DESERIALIZE_FREEONCLOSE buffers even on failure.
    c.check(rc);
  }
  /**
   * Close the connection, finalize its statements, and cancel active backups.
   * Calling this again after closing has no effect.
   *
   * @returns This database.
   * @throws {TypeError} If a query or row iterator is active.
   */
  close(): this {
    if (!this.open) return this;
    this.#connection.assertIdle(true);
    databaseFinalizer.unregister(this);
    this.#connection.close();
    return this;
  }
  /** Close when leaving a using declaration's scope. */
  [Symbol.dispose](): void {
    this.close();
  }
}

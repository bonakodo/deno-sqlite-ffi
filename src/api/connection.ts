import { resultError } from '../errors.ts';
import type { Symbols } from '../native/symbols.ts';
import { native } from '../native/loader.ts';
import { cstring, pointer, string } from '../native/memory.ts';

export interface Resource {
  afterClose?: boolean;
  close(): void;
}
const SQLITE_OPEN_NOMUTEX = 0x8000;

export class Connection {
  readonly sql: Symbols = native();
  pointer: Deno.PointerValue = null;
  executing = false;
  iterators = 0;
  // Parameter getters may use other statements, but must not close the database.
  bindings = 0;
  safe = false;
  error: { value: unknown } | undefined;
  statements: Set<Deno.PointerObject> = new Set();
  #transactionStatements: Map<string, Deno.PointerObject> = new Map();
  resources: Set<Resource> = new Set();
  functions: Map<string, Resource> = new Map();
  verbose: ((sql: string) => void) | null;
  constructor(
    path: string,
    flags: number,
    timeout: number,
    verbose: ((sql: string) => void) | null,
  ) {
    this.verbose = verbose;
    const out = new BigUint64Array(1);
    // Each handle stays in one JS isolate, including backups and finalizers.
    // All FFI calls are synchronous; SQLite still locks its shared global state.
    const rc = this.sql.sqlite3_open_v2(
      cstring(path),
      out,
      flags | SQLITE_OPEN_NOMUTEX,
      null,
    );
    this.pointer = pointer(out);
    try {
      this.check(rc);
      this.check(this.sql.sqlite3_extended_result_codes(this.pointer, 1));
      this.check(this.sql.sqlite3_busy_timeout(this.pointer, timeout));
    } catch (error) {
      this.close();
      throw error;
    }
  }
  assertOpen(): void {
    if (!this.pointer) {
      throw new TypeError('The database connection is not open');
    }
  }
  assertIdle(write = false): void {
    this.assertOpen();
    if (this.executing || (write && this.iterators > 0)) {
      throw new TypeError('This database connection is busy executing a query');
    }
  }
  call<T>(operation: () => T): T {
    this.executing = true;
    try {
      return operation();
    } finally {
      this.executing = false;
    }
  }
  step(statement: Deno.PointerObject): number {
    this.executing = true;
    let rc: number;
    try {
      rc = this.sql.sqlite3_step(statement);
    } finally {
      this.executing = false;
    }
    this.check(rc);
    return rc;
  }
  reset(statement: Deno.PointerObject): number {
    this.executing = true;
    try {
      return this.sql.sqlite3_reset(statement);
    } finally {
      this.executing = false;
    }
  }
  check(rc: number): void {
    if (this.error) {
      const error = this.error;
      this.error = undefined;
      throw error.value;
    }
    if (rc !== 0 && rc !== 100 && rc !== 101) {
      throw resultError(
        string(this.sql.sqlite3_errmsg(this.pointer)) ?? 'SQLite error',
        rc,
      );
    }
  }
  log(statement: Deno.PointerObject): void {
    if (!this.verbose) return;
    const expanded = this.sql.sqlite3_expanded_sql(statement);
    this.executing = true;
    try {
      this.verbose(string(expanded)!);
    } finally {
      this.executing = false;
      this.sql.sqlite3_free(expanded);
    }
  }
  prepare(sql: string): { statement: Deno.PointerValue; rest: string } {
    const bytes = cstring(sql);
    const out = new BigUint64Array(1);
    const tail = new BigUint64Array(1);
    this.executing = true;
    let rc: number;
    try {
      rc = this.sql.sqlite3_prepare_v2(
        this.pointer,
        bytes,
        bytes.length,
        out,
        tail,
      );
    } finally {
      this.executing = false;
    }
    const statement = pointer(out);
    try {
      this.check(rc);
    } catch (error) {
      if (statement) this.sql.sqlite3_finalize(statement);
      throw error;
    }
    if (statement) this.statements.add(statement);
    return { statement, rest: string(pointer(tail)) ?? '' };
  }
  finalize(statement: Deno.PointerObject): void {
    if (this.statements.delete(statement)) {
      this.executing = true;
      try {
        this.sql.sqlite3_finalize(statement);
      } finally {
        this.executing = false;
      }
    }
  }
  exec(sql: string): void {
    this.assertIdle(true);
    while (sql.length) {
      const next = this.prepare(sql);
      sql = next.rest;
      if (!next.statement) continue;
      try {
        this.log(next.statement);
        let rc: number;
        do {
          rc = this.step(next.statement);
        } while (rc === 100);
      } finally {
        this.finalize(next.statement);
      }
    }
  }
  transactionControl(sql: string): void {
    this.assertIdle(true);
    let statement = this.#transactionStatements.get(sql);
    if (!statement) {
      statement = this.prepare(sql).statement!;
      this.#transactionStatements.set(sql, statement);
    }
    try {
      this.log(statement);
      this.step(statement);
    } finally {
      this.reset(statement);
    }
  }
  close(): void {
    for (const resource of [...this.resources]) {
      if (!resource.afterClose) resource.close();
    }
    for (const statement of this.statements) this.finalize(statement);
    this.#transactionStatements.clear();
    if (this.pointer) {
      this.sql.sqlite3_close_v2(this.pointer);
      this.pointer = null;
    }
    for (const resource of [...this.resources]) {
      if (resource.afterClose) resource.close();
    }
    this.resources.clear();
    this.functions.clear();
  }
}
export const databaseFinalizer = new FinalizationRegistry<Connection>((
  connection,
) => connection.close());
export const statementFinalizer = new FinalizationRegistry<
  { connection: Connection; pointer: Deno.PointerObject }
>((resource) => resource.connection.finalize(resource.pointer));
export const iteratorFinalizer = new FinalizationRegistry<() => void>((close) =>
  close()
);

export function retainFunction(
  connection: Connection,
  name: string,
  argc: number,
  resource: Resource,
): void {
  const key = `${
    name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  }/${argc}`;
  const previous = connection.functions.get(key);
  if (previous) {
    previous.close();
    connection.resources.delete(previous);
  }
  connection.functions.set(key, resource);
  connection.resources.add(resource);
}

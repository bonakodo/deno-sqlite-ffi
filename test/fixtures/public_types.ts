// Source-derived Kysely 0.29.5 SQLite contract, kept dependency-free.
// https://github.com/kysely-org/kysely/blob/v0.29.5/src/dialect/sqlite/sqlite-dialect-config.ts
// Kysely is MIT licensed; see NOTICE.
import type Database from '../../src/mod.ts';
import type { Statement, Transaction } from '../../src/mod.ts';

export interface KyselySqliteDatabase {
  close(): void;
  prepare(sql: string): KyselySqliteStatement;
}

export interface KyselySqliteStatement {
  readonly reader: boolean;
  all(parameters: readonly unknown[]): unknown[];
  run(parameters: readonly unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  iterate(parameters: readonly unknown[]): IterableIterator<unknown>;
}

interface Person {
  id: number;
  name: string;
}

// This function is checked with the test import graph, but never executed.
// Negative assertions must fail compilation if the API loses type precision.
export function checkPublicTypes(db: Database): void {
  const kysely: KyselySqliteDatabase = db;
  const parameters: readonly unknown[] = [1];
  kysely.prepare('SELECT ?').all(parameters);
  kysely.prepare('SELECT ?').run(parameters);
  kysely.prepare('SELECT ?').iterate(parameters);

  const statement: Statement<Person> = db.prepare<Person>(
    'SELECT * FROM users',
  );
  const row: Person | undefined = statement.get(parameters);
  const rows: Person[] = statement.all(parameters);
  const iterator: IterableIterator<Person> = statement.iterate(parameters);
  statement.bind(parameters);
  // @ts-expect-error An interface row cannot lose its selected shape.
  const wrongRow: { missing: boolean } = statement.get()!;
  // @ts-expect-error A row array cannot lose its selected shape.
  const wrongRows: { missing: boolean }[] = statement.all();
  // @ts-expect-error The iterator must preserve the selected row shape.
  const wrongIterator: IterableIterator<string> = statement.iterate();
  // @ts-expect-error Scalar parameters still reject unsupported types.
  statement.get(true);

  function transform(this: { prefix: string }, id: number, suffix: string) {
    return `${this.prefix}${id}${suffix}`;
  }
  const transaction: Transaction<typeof transform> = db.transaction(transform);
  const owner: Database = transaction.database;
  const result: string = transaction.call({ prefix: 'id:' }, 7, '!');
  const exclusive: string = transaction.exclusive.call({ prefix: '' }, 7, '!');
  // @ts-expect-error Transaction arguments follow the callback signature.
  transaction.call({ prefix: '' }, 'wrong', '!');
  // @ts-expect-error Each mode also retains argument types.
  transaction.immediate.call({ prefix: '' }, 7, false);
  // @ts-expect-error The callback this type must also survive wrapping.
  transaction.deferred.call({ prefix: 7 }, 7, '!');
  // @ts-expect-error The transaction return type follows the callback.
  const wrongResult: number = transaction.default.call({ prefix: '' }, 7, '!');
  // @ts-expect-error The owning database is immutable.
  transaction.database = db;
  // @ts-expect-error Mode references are immutable.
  transaction.default = transaction.deferred;

  void [
    row,
    rows,
    iterator,
    wrongRow,
    wrongRows,
    wrongIterator,
    owner,
    result,
    exclusive,
    wrongResult,
  ];
}

import '../setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database, { SqliteError } from '../../src/mod.ts';

Deno.test('recursive transactions recover each savepoint and remain reusable', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(value)');
  const insert = db.prepare('INSERT INTO t VALUES (?)');
  const recurse = db.transaction((depth: number): void => {
    insert.run(depth);
    if (depth > 0) {
      assertThrows(() => recurse(depth - 1), Error, 'nested rollback');
      insert.run(depth * 10);
    }
    if (depth < 3) throw new Error('nested rollback');
  });
  for (let i = 0; i < 3; i++) {
    recurse(3);
    assert(!db.inTransaction);
  }
  db.exec('BEGIN');
  recurse(3);
  assert(db.inTransaction);
  db.exec('COMMIT');
  assertEquals(db.prepare('SELECT value FROM t').pluck().all(), [
    3,
    30,
    3,
    30,
    3,
    30,
    3,
    30,
  ]);
});

Deno.test('a failed commit rolls back and permits reuse of all transaction controls', () => {
  using db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(parent REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    INSERT INTO parent VALUES (1);
  `);
  const insert = db.prepare('INSERT INTO child VALUES (?)');
  const transact = db.transaction((parent: number) => insert.run(parent));
  for (
    const mode of ['default', 'deferred', 'immediate', 'exclusive'] as const
  ) {
    assertThrows(() => transact[mode](2), SqliteError, 'FOREIGN KEY');
    assert(!db.inTransaction);
    assertEquals(transact[mode](1).changes, 1);
    assert(!db.inTransaction);
  }
  assertEquals(db.prepare('SELECT parent FROM child').pluck().all(), [
    1,
    1,
    1,
    1,
  ]);
});

Deno.test('transaction controls retain verbose errors and prevent callback reentry', () => {
  const failure = new Error('verbose failure');
  const logs: string[] = [];
  let fail = '';
  using db = new Database(':memory:', {
    verbose(sql) {
      assertThrows(() => db.exec('SELECT 1'), TypeError, 'busy');
      logs.push(sql);
      if (sql === fail) throw failure;
    },
  });
  const transact = db.transaction(() => 42);
  fail = 'BEGIN';
  assertEquals(assertThrows(transact), failure);
  assert(!db.inTransaction);
  fail = 'COMMIT';
  assertEquals(assertThrows(transact), failure);
  assert(!db.inTransaction);
  fail = '';
  assertEquals(transact(), 42);
  assertEquals(logs, [
    'BEGIN',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'BEGIN',
    'COMMIT',
  ]);
  const rows = db.prepare('SELECT 1').iterate();
  assertThrows(transact, TypeError, 'busy');
  rows.return!();
  assertEquals(transact(), 42);
});

Deno.test('transaction controls survive schema changes and close with the database', () => {
  const db = new Database(':memory:');
  const transact = db.transaction(() =>
    db.exec('CREATE TABLE IF NOT EXISTS t(x)')
  );
  transact();
  db.exec('DROP TABLE t');
  transact();
  assertEquals(db.prepare('SELECT count(*) FROM t').pluck().get(), 0);
  db.close();
  assertThrows(transact, TypeError, 'not open');
  db.close();
});

Deno.test('transaction controls recover from locked begin and commit operations', () => {
  const directory = Deno.makeTempDirSync();
  try {
    using db = new Database(`${directory}/locked.db`, { timeout: 0 });
    db.exec('CREATE TABLE t(value)');
    using other = new Database(`${directory}/locked.db`, { timeout: 0 });
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    const transact = db.transaction((value: number) => insert.run(value));
    other.exec('BEGIN IMMEDIATE');
    assertEquals(
      assertThrows(() => transact.immediate(1), SqliteError).code,
      'SQLITE_BUSY',
    );
    assert(!db.inTransaction);
    other.exec('ROLLBACK');
    assertEquals(transact.immediate(2).changes, 1);
    other.exec('BEGIN');
    assertEquals(other.prepare('SELECT value FROM t').pluck().all(), [2]);
    assertEquals(
      assertThrows(() => transact(3), SqliteError).code,
      'SQLITE_BUSY',
    );
    assert(!db.inTransaction);
    other.exec('ROLLBACK');
    assertEquals(transact(4).changes, 1);
    assertEquals(db.prepare('SELECT value FROM t').pluck().all(), [2, 4]);
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

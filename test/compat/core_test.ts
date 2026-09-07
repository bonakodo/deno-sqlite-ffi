import '../setup.ts';
// Behavioral cases adapted from better-sqlite3 13.0.3; see NOTICE.
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database, { SqliteError } from '../../src/mod.ts';

Deno.test('open, prepare, bind, query modes, metadata, and close', () => {
  const db = new Database(':memory:');
  assert(db.open && db.memory && !db.readonly && !db.inTransaction);
  db.exec('CREATE TABLE cats (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
  const insert = db.prepare('INSERT INTO cats (name, data) VALUES (@name, ?)');
  assertEquals(insert.run({ name: '猫' }, new Uint8Array([0, 255])), {
    changes: 1,
    lastInsertRowid: 1,
  });
  insert.run(new Uint8Array(), { name: 'a\0b' });
  const select = db.prepare('SELECT * FROM cats ORDER BY id');
  assertEquals(select.all(), [{
    id: 1,
    name: '猫',
    data: new Uint8Array([0, 255]),
  }, { id: 2, name: 'a\0b', data: new Uint8Array() }]);
  assertEquals(select.raw().get(), [1, '猫', new Uint8Array([0, 255])]);
  assertEquals(select.pluck().all(), [1, 2]);
  assertEquals(select.expand().get(), {
    cats: { id: 1, name: '猫', data: new Uint8Array([0, 255]) },
  });
  assertEquals(select.columns()[0], {
    name: 'id',
    column: 'id',
    table: 'cats',
    database: 'main',
    type: 'INTEGER',
  });
  assertEquals(db.prepare('SELECT ?').bind(42).toString(), 'SELECT 42.0');
  assertThrows(() => db.prepare('SELECT 1; SELECT 2'), RangeError);
  assertThrows(() => db.prepare('-- comment'), RangeError);
  assertThrows(() => insert.run('bad'), RangeError);
  db.close();
  assert(!db.open);
  assertThrows(() => select.get(), TypeError);
  db.close();
});

Deno.test('transactions preserve context, savepoints, modes and errors', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(x UNIQUE)');
  const insert = db.prepare('INSERT INTO t VALUES (?)');
  const inner = db.transaction((x: number) => {
    insert.run(x);
    throw new Error('rollback');
  });
  const outer = db.transaction(function (this: { x: number }, x: number) {
    insert.run(x);
    assertThrows(() => inner(x + 1));
    return this.x;
  });
  assertEquals(outer.call({ x: 7 }, 1), 7);
  for (
    const [mode, n] of [['deferred', 2], ['immediate', 3], [
      'exclusive',
      4,
    ]] as const
  ) db.transaction((x: number) => insert.run(x))[mode](n);
  assertEquals(db.prepare('SELECT x FROM t').pluck().all(), [1, 2, 3, 4]);
  assertThrows(() => db.transaction(() => insert.run(1))(), SqliteError);
  assert(!db.inTransaction);
  assertThrows(() => db.transaction(() => Promise.resolve())(), TypeError);
});

Deno.test('iterators reset after break and reject writes while busy', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3)');
  const stmt = db.prepare('SELECT x FROM t');
  const it = stmt.iterate();
  assert(stmt.busy);
  assertEquals(it.next(), { value: { x: 1 }, done: false });
  assertThrows(() => db.exec('DELETE FROM t'), TypeError);
  assertThrows(() => stmt.get(), TypeError);
  it.return!();
  assert(!stmt.busy);
  for (const _ of stmt.iterate()) break;
  assertEquals([...stmt.iterate()].length, 3);
  assertEquals(stmt.get(), { x: 1 });
});

Deno.test('integer and value round trips', () => {
  using db = new Database(':memory:');
  const stmt = db.prepare('SELECT ? AS value').safeIntegers();
  for (
    const value of [
      null,
      -9223372036854775808n,
      9223372036854775807n,
      2.5,
      'hello\0世界',
      new Uint8Array([7]),
    ]
  ) assertEquals(stmt.get(value), { value });
  assertThrows(() => stmt.get(9223372036854775808n), RangeError);
  assertThrows(() => stmt.get(true as never), TypeError);
  assertThrows(() => stmt.get(), RangeError);
  assertThrows(() => stmt.get(1, 2), RangeError);
  assertEquals(db.defaultSafeIntegers().prepare('SELECT 1').pluck().get(), 1n);
});

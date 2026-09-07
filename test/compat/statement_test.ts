import '../setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database, { SqliteError } from '../../src/mod.ts';

Deno.test('statement permanent bindings, modes, reuse, and disposal', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(id PRIMARY KEY, x); INSERT INTO t VALUES(1,10)');
  const stmt = db.prepare('SELECT ?, @a, :b, $c');
  assertEquals(stmt.raw().get([1], { a: 2, b: 3, c: 4 }), [1, 2, 3, 4]);
  assertThrows(() => stmt.get({ a: 1 }, { b: 2 }), TypeError);
  assertThrows(() => stmt.bind([], {}), RangeError);
  stmt.bind(1, { a: 2, b: 3, c: 4 });
  assertThrows(() => stmt.get(1), TypeError);
  assertThrows(() => stmt.bind(), TypeError);
  assertEquals(stmt.raw(false).pluck().get(), 1);
  assertEquals(stmt.pluck(false).expand().get(), {
    $: { '?': 1, '@a': 2, ':b': 3, '$c': 4 },
  });
  stmt.expand(false).safeIntegers(false);
  assertEquals(stmt.toString(), 'SELECT 1.0, 2.0, 3.0, 4.0');
  const noRows = db.prepare('SELECT * FROM t WHERE 0');
  assertEquals(noRows.get(), undefined);
  assertEquals(noRows.all(), []);
  assertEquals(noRows.toString(), noRows.source);
  assertEquals(noRows.run().changes, 0);
  assertEquals(db.prepare('SELECT 1 AS __proto__').get(), { ['__proto__']: 1 });
  const insert = db.prepare('INSERT INTO t VALUES(?,?)').safeIntegers();
  assertEquals(insert.run(2, null).lastInsertRowid, 2n);
  assertThrows(() => insert.run(2, null), SqliteError);
  for (
    const method of [
      () => insert.get(),
      () => insert.all(),
      () => insert.iterate(),
      () => insert.pluck(),
      () => insert.columns(),
    ]
  ) assertThrows(method, TypeError);
  assertThrows(() => noRows.raw('yes' as never), TypeError);
  const it = noRows.iterate();
  assertEquals(it.next(), { value: undefined, done: true });
  assertEquals(it.next(), { value: undefined, done: true });
  it.return!();
  noRows[Symbol.dispose]();
  noRows[Symbol.dispose]();
  assertThrows(() => noRows.get(), TypeError, 'finalized');
  assertEquals(noRows.reader, true);
  assertEquals(noRows.readonly, true);
});

Deno.test('execution errors reset statements and preserve callback identity', () => {
  using db = new Database(':memory:');
  let throws = true;
  const error = new Error('failure');
  db.function('sometimes', () => {
    if (throws) throw error;
    return 4;
  });
  const stmt = db.prepare('SELECT sometimes()');
  const it = stmt.iterate();
  assertEquals(assertThrows(() => it.next()), error);
  assert(!stmt.busy);
  throws = false;
  assertEquals(stmt.get(), { 'sometimes()': 4 });
  db.function('reentry', () => {
    db.prepare('SELECT 1');
    return 1;
  });
  assertThrows(() => db.prepare('SELECT reentry()').get(), TypeError, 'busy');
});

Deno.test('verbose exceptions release parameter bindings', () => {
  let throws = true;
  using db = new Database(':memory:', {
    verbose() {
      if (throws) throw new Error('verbose');
    },
  });
  const stmt = db.prepare('SELECT ?');
  assertThrows(() => stmt.get(1), Error, 'verbose');
  throws = false;
  assertEquals(stmt.get(2), { '?': 2 });
});

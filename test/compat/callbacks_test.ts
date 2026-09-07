import '../setup.ts';
import { assertEquals, assertThrows } from '@std/assert';
import Database from '../../src/mod.ts';

Deno.test('functions and aggregates marshal values and preserve exceptions', () => {
  using db = new Database(':memory:');
  db.function('echo', (x) => x);
  for (
    const value of [
      null,
      2,
      2.5,
      '猫\0x',
      new Uint8Array(),
      new Uint8Array([1, 2]),
    ]
  ) assertEquals(db.prepare('SELECT echo(?)').pluck().get(value), value);
  db.function('big', { safeIntegers: true, deterministic: true }, (x) => x);
  assertEquals(
    db.prepare('SELECT big(?)').safeIntegers().pluck().get(
      9223372036854775807n,
    ),
    9223372036854775807n,
  );
  const error = new Error('callback');
  db.function('fail', () => {
    throw error;
  });
  assertEquals(assertThrows(() => db.prepare('SELECT fail()').get()), error);
  db.function('echo', (x) => String(x) + '!');
  assertEquals(db.prepare('SELECT echo(1)').pluck().get(), '1!');
  db.aggregate('total', {
    start: 0,
    step: (sum, n) => sum + Number(n),
    inverse: (sum, n) => sum - Number(n),
  });
  assertEquals(
    db.prepare(
      'WITH t(x) AS (VALUES(1),(2),(3)) SELECT total(x) OVER (ROWS 1 PRECEDING) FROM t',
    ).pluck().all(),
    [1, 3, 5],
  );
  db.aggregate('collect', {
    start: () => [] as number[],
    step: (state, n) => {
      state.push(Number(n));
    },
    result: (state) => state.join(','),
  });
  assertEquals(
    db.prepare('WITH t(x) AS (VALUES(1),(2)) SELECT collect(x) FROM t').pluck()
      .get(),
    '1,2',
  );
});

Deno.test('virtual tables accept parameters and close generators', () => {
  using db = new Database(':memory:');
  let closed = 0;
  db.table('sequence', {
    columns: ['value'],
    parameters: ['count'],
    rows: function* (n = 3) {
      try {
        for (let i = 0; i < Number(n); i++) yield [i];
      } finally {
        closed++;
      }
    },
  });
  assertEquals(
    db.prepare('SELECT value, rowid, count FROM sequence(3)').raw().all(),
    [[0, 1, 3], [1, 2, 3], [2, 3, 3]],
  );
  assertEquals(
    db.prepare('SELECT value FROM sequence WHERE count=2').pluck().all(),
    [0, 1],
  );
  assertEquals(db.prepare('SELECT * FROM sequence LIMIT 1').get(), {
    value: 0,
  });
  assertEquals(closed, 3);
  db.table('factory', (value) => ({
    columns: ['x'],
    rows: function* () {
      yield { x: value };
    },
  }));
  db.exec('CREATE VIRTUAL TABLE made USING factory(hello)');
  assertEquals(db.prepare('SELECT * FROM made').get(), { x: 'hello' });
  db.exec('DROP TABLE made');
});

Deno.test('repeated callback calls, replacements, and connection lifetimes', () => {
  for (let i = 0; i < 100; i++) {
    using db = new Database(':memory:');
    db.function('identity', (value) => value);
    using stmt = db.prepare('SELECT identity(?)');
    assertEquals(stmt.pluck().get(i), i);
  }
  using db = new Database(':memory:');
  for (let i = 0; i < 1000; i++) db.function('identity', (value) => value);
  using stmt = db.prepare('SELECT identity(?)');
  const bytes = new Uint8Array([0, 1, 2, 255]);
  for (let i = 0; i < 5000; i++) assertEquals(stmt.pluck().get(bytes), bytes);
});

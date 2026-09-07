import '../setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database, {
  type AggregateOptions,
  type SqlFunction,
  SqliteError,
  type TableDefinition,
} from '../../src/mod.ts';

Deno.test('function option validation, arity, varargs, and directOnly', () => {
  using db = new Database(':memory:');
  for (
    const [name, config, fn] of [
      ['', {}, () => 1],
      ['x', null, () => 1],
      ['x', { safeIntegers: 1 }, () => 1],
      ['x', { directOnly: 'yes' }, () => 1],
      ['x', {}, 1],
    ] as const
  ) {
    assertThrows(
      () => db.function(name, config as never, fn as never),
      TypeError,
    );
  }
  const arity = () => 1;
  Object.defineProperty(arity, 'length', { value: 128 });
  assertThrows(() => db.function('arity', arity), RangeError);
  db.function('argc', { varargs: true }, (...args) => args.length);
  assertEquals(db.prepare('SELECT argc(1,2,3)').pluck().get(), 3);
  db.function('return_void', () => undefined);
  assertEquals(db.prepare('SELECT return_void()').pluck().get(), null);
  db.function('direct', { directOnly: true }, () => 42);
  db.exec('CREATE VIEW v AS SELECT direct()');
  assertThrows(() => db.prepare('SELECT * FROM v'), SqliteError);
  db.function('invalid', (() => ({})) as SqlFunction);
  assertThrows(() => db.prepare('SELECT invalid()').get(), TypeError);
  db.function('outofrange', () => 1n << 63n);
  assertThrows(() => db.prepare('SELECT outofrange()').get(), RangeError);
  assertThrows(() => db.function('x'.repeat(256), () => 1), SqliteError);
});

Deno.test('aggregate errors, empty groups, distinct state, and callback types', () => {
  using db = new Database(':memory:');
  for (
    const config of [{}, { step: 1 }, { step() {}, result: 1 }, {
      step() {},
      inverse: 1,
    }]
  ) {
    assertThrows(
      () => db.aggregate('bad', config as never),
      TypeError,
    );
  }
  db.aggregate('empty', { step: (sum: unknown, _x) => sum });
  assertEquals(db.prepare('SELECT empty(1) WHERE 0').pluck().get(), null);
  db.aggregate('groups', {
    start: () => [] as string[],
    step: (state, x) => {
      state.push(String(x));
    },
    result: (state) => state.join(','),
  });
  assertEquals(
    db.prepare(
      'WITH t(g,x) AS (VALUES(1,2),(1,3),(2,4)) SELECT groups(x) FROM t GROUP BY g',
    ).pluck().all(),
    ['2,3', '4'],
  );
  const error = new Error('aggregate');
  for (
    const config of [
      {
        step: () => {
          throw error;
        },
      },
      {
        start: () => {
          throw error;
        },
        step: () => {},
      },
      {
        step: () => {},
        result: () => {
          throw error;
        },
      },
      { step: () => ({}), result: () => ({} as never) },
    ]
  ) {
    db.aggregate('fail', config as AggregateOptions);
    assertThrows(() => db.prepare('SELECT fail()').get());
    assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
  }
  db.aggregate('badinverse', {
    start: 0,
    step: (sum, x) => sum + Number(x),
    inverse() {
      throw error;
    },
  });
  assertEquals(
    assertThrows(() =>
      db.prepare(
        'WITH t(x) AS (VALUES(1),(2),(3)) SELECT badinverse(x) OVER (ROWS 1 PRECEDING) FROM t',
      ).all()
    ),
    error,
  );
  db.aggregate('typed', {
    safeIntegers: true,
    start: 0n,
    step: (sum, x) => sum + BigInt(x as bigint),
  });
  assertEquals(db.prepare('SELECT typed(7)').safeIntegers().pluck().get(), 7n);
});

Deno.test('virtual table validation, defaults, joins, and thrown errors', () => {
  using db = new Database(':memory:');
  const rows = function* () {
    yield [1];
  };
  for (
    const definition of [
      null,
      {},
      { columns: [], rows },
      { columns: ['x'], rows: () => [] },
      { columns: ['x'], rows, parameters: 1 },
      { columns: ['x', 'X'], rows },
      { columns: ['x'], rows, directOnly: 1 },
    ]
  ) {
    assertThrows(
      () => db.table('bad', definition as TableDefinition),
      TypeError,
    );
  }
  db.table('defaults', {
    columns: ['x'],
    rows: function* (n = 3) {
      yield [n];
    },
  });
  assertEquals(db.prepare('SELECT * FROM defaults').get(), { x: 3 });
  db.table('params', {
    columns: ['x'],
    rows: function* (n) {
      yield [n ?? null];
    },
  });
  assertEquals(db.prepare('SELECT * FROM params(4)').get(), { x: 4 });
  assertEquals(db.prepare('SELECT * FROM params WHERE x > 2').all(), []);
  assertEquals(
    db.prepare('SELECT b.x FROM params(4) a JOIN params(a.x+1) b').get(),
    { x: 5 },
  );
  assertEquals(
    db.prepare('SELECT * FROM params WHERE "$1"=2 AND "$1"=2').get(),
    { x: 2 },
  );
  db.table('directtable', { columns: ['x'], directOnly: true, rows });
  assertEquals(db.prepare('SELECT * FROM directtable').get(), { x: 1 });
  db.exec('CREATE VIEW v AS SELECT * FROM directtable');
  assertThrows(() => db.prepare('SELECT * FROM v'), SqliteError);
  db.table('wrong', {
    columns: ['x'],
    rows: function* () {
      yield [] as never;
    },
  });
  assertThrows(() => db.prepare('SELECT * FROM wrong').all(), TypeError);
  db.table('wrong2', {
    columns: ['x'],
    rows: function* () {
      yield 1 as never;
    },
  });
  assertThrows(() => db.prepare('SELECT * FROM wrong2').all(), TypeError);
  db.table('wrong3', {
    columns: ['x'],
    rows: function* () {
      yield { x: {} } as never;
    },
  });
  assertThrows(() => db.prepare('SELECT * FROM wrong3').all(), TypeError);
  const error = new Error('factory');
  db.table('factoryfail', () => {
    throw error;
  });
  assertEquals(
    assertThrows(() => db.exec('CREATE VIRTUAL TABLE bad USING factoryfail')),
    error,
  );
  assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
  let ended = false;
  db.table('finish', {
    columns: ['x'],
    rows: function* () {
      try {
        yield [1];
        yield [2];
      } finally {
        ended = true;
      }
    },
  });
  for (const _ of db.prepare('SELECT * FROM finish').iterate()) break;
  assert(ended);
});

Deno.test('virtual table cleanup errors do not escape into a later query', () => {
  using db = new Database(':memory:');
  const error = new Error('generator cleanup');
  db.table('cleanup', {
    columns: ['x'],
    rows: function* () {
      try {
        yield [1];
        yield [2];
      } finally {
        // Exercise exceptions from a generator's return() cleanup.
        // deno-lint-ignore no-unsafe-finally
        throw error;
      }
    },
  });
  const stmt = db.prepare('SELECT * FROM cleanup');
  assertEquals(assertThrows(() => stmt.get()), error);
  assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
  const iterator = stmt.iterate();
  iterator.next();
  assertEquals(assertThrows(() => iterator.return!()), error);
  assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
  db.function('replacement', () => 1);
  db.aggregate('replacement', { step: () => 2 });
  assertEquals(db.prepare('SELECT replacement()').pluck().get(), 2);
  db.function('replacement', () => 3);
  assertEquals(db.prepare('SELECT replacement()').pluck().get(), 3);
});

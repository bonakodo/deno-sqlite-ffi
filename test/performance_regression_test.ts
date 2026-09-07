import './setup.ts';
import { assertEquals, assertStrictEquals } from '@std/assert';
import Database from '../src/mod.ts';

Deno.test('cached result columns follow automatic schema recompilation', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(old_name); INSERT INTO t VALUES(1)');
  const statement = db.prepare('SELECT * FROM t');
  assertEquals(statement.get(), { old_name: 1 });
  assertEquals(statement.all(), [{ old_name: 1 }]);
  db.exec('ALTER TABLE t RENAME COLUMN old_name TO new_name');
  assertEquals(statement.get(), { new_name: 1 });
  db.exec("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'added'");
  assertEquals([...statement.iterate()], [{ new_name: 1, extra: 'added' }]);
  const raw = statement.raw();
  assertEquals(raw.get(), [1, 'added']);
  db.exec('ALTER TABLE t DROP COLUMN extra');
  assertEquals(raw.get(), [1]);
  statement.raw(false);
  assertEquals(statement.get(), { new_name: 1 });
  assertEquals(statement.columns().map((column) => column.name), ['new_name']);
});

Deno.test('expanded result tables refresh after view replacement', () => {
  using db = new Database(':memory:');
  db.exec(`
    CREATE TABLE first_source(value);
    CREATE TABLE second_source(value);
    INSERT INTO first_source VALUES(1);
    INSERT INTO second_source VALUES(2);
    CREATE VIEW current_source AS SELECT value FROM first_source;
  `);
  const statement = db.prepare('SELECT * FROM current_source').expand();
  assertEquals(statement.get(), { first_source: { value: 1 } });
  db.exec(`
    DROP VIEW current_source;
    CREATE VIEW current_source AS SELECT value FROM second_source;
  `);
  assertEquals(statement.all(), [{ second_source: { value: 2 } }]);
  assertEquals(statement.columns().map((column) => column.table), [
    'second_source',
  ]);
});

Deno.test('result metadata updates even when the recompiled query has no rows', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(before_change); INSERT INTO t VALUES(1)');
  const statement = db.prepare('SELECT * FROM t WHERE before_change > ?');
  assertEquals(statement.get(0), { before_change: 1 });
  db.exec('ALTER TABLE t ADD COLUMN after_change');
  assertEquals(statement.all(10), []);
  assertEquals(statement.columns().map((column) => column.name), [
    'before_change',
    'after_change',
  ]);
  assertEquals(statement.get(0), { before_change: 1, after_change: null });
});

Deno.test('result factories preserve duplicate and special column names', () => {
  using db = new Database(':memory:');
  const names = [
    '__proto__',
    'constructor',
    'toString',
    'quote"slash\\line\n',
    'unicode\u2028separator\u2029',
    '__proto__',
  ];
  const sql = names.map((name, i) =>
    `${i + 1} AS "${name.replaceAll('"', '""')}"`
  ).join(', ');
  const statement = db.prepare(`SELECT ${sql}`);
  const expected = {
    ['__proto__']: 6,
    constructor: 2,
    toString: 3,
    'quote"slash\\line\n': 4,
    'unicode\u2028separator\u2029': 5,
  };
  for (
    const row of [statement.get(), ...statement.all(), ...statement.iterate()]
  ) {
    assertEquals(row, expected);
    assertStrictEquals(Object.getPrototypeOf(row), Object.prototype);
    assertEquals(Object.getOwnPropertyDescriptor(row, '__proto__'), {
      value: 6,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  assertEquals(statement.raw().get(), [1, 2, 3, 4, 5, 6]);
  assertEquals(statement.pluck().get(), 1);
  assertEquals(statement.expand().get(), { $: expected });
});

Deno.test('expanded result factories preserve special table names', () => {
  using db = new Database(':memory:');
  db.exec(`
    CREATE TABLE "__proto__"("__proto__", value);
    CREATE TABLE "constructor"(value);
    INSERT INTO "__proto__" VALUES(1, 2);
    INSERT INTO "constructor" VALUES(3);
  `);
  const statement = db.prepare(`
    SELECT "__proto__"."__proto__", "__proto__".value,
      "constructor".value, 4 AS value
    FROM "__proto__", "constructor"
  `).expand();
  const row = statement.get()!;
  assertEquals(row, {
    ['__proto__']: { ['__proto__']: 1, value: 2 },
    constructor: { value: 3 },
    $: { value: 4 },
  });
  assertStrictEquals(Object.getPrototypeOf(row), Object.prototype);
  assertStrictEquals(Object.getPrototypeOf(row['__proto__']), Object.prototype);
});

Deno.test('shared result factories keep connections and integer modes separate', () => {
  using first = new Database(':memory:');
  using second = new Database(':memory:');
  first.exec('CREATE TABLE t(value); INSERT INTO t VALUES(7)');
  second.exec('CREATE TABLE t(value); INSERT INTO t VALUES(9)');
  const firstQuery = first.prepare('SELECT value FROM t').safeIntegers();
  const secondQuery = second.prepare('SELECT value FROM t');
  assertEquals(firstQuery.all(), [{ value: 7n }]);
  assertEquals(secondQuery.all(), [{ value: 9 }]);
  assertEquals(firstQuery.safeIntegers(false).get(), { value: 7 });
  assertEquals(secondQuery.safeIntegers().get(), { value: 9n });
  first.close();
  assertEquals(second.prepare('SELECT value FROM t').all(), [{ value: 9 }]);
  assertEquals(second.prepare('SELECT value FROM t').raw().all(), [[9]]);
  assertEquals(second.prepare('SELECT value FROM t').expand().all(), [{
    t: { value: 9 },
  }]);
  second.exec("UPDATE t SET value='text'");
  assertEquals(secondQuery.get(), { value: 'text' });
});

Deno.test('result factories evict old shapes and handle long column names', () => {
  using db = new Database(':memory:');
  for (let i = 0; i < 130; i++) {
    const name = `cache_${i}`;
    using statement = db.prepare(`SELECT ${i} AS "${name}"`);
    assertEquals(statement.all(), [{ [name]: i }]);
  }
  assertEquals(db.prepare('SELECT 999 AS "cache_0"').all(), [{ cache_0: 999 }]);
  const name = 'long_name_'.repeat(1_700);
  for (let i = 0; i < 2; i++) {
    using statement = db.prepare(`SELECT ${i} AS "${name}"`);
    assertEquals(statement.all(), [{ [name]: i }]);
  }
});

Deno.test('disabled string code generation preserves row modes', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--v8-flags=--disallow-code-generation-from-strings',
      '--allow-ffi',
      '--allow-env=DENO_SQLITE_PATH',
      '--allow-read',
      // Run the factory cases above without running this subprocess test again.
      '--filter=result factories',
      import.meta.url,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(
    result.code,
    0,
    new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  );
});

Deno.test('row compiler failures propagate and allow the statement to recover', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--allow-ffi',
      '--allow-env=DENO_SQLITE_PATH',
      '--allow-read',
      new URL('./fixtures/row_factory_error.ts', import.meta.url).href,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assertEquals(
    result.code,
    0,
    new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
  );
});

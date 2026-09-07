import '../setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database, { type Statement } from '../../src/mod.ts';
import type { KyselySqliteDatabase } from '../fixtures/public_types.ts';

interface Person {
  id: number;
  name: string;
}

Deno.test('transactions retain their database, immutable modes, arguments and this', () => {
  using db = new Database(':memory:');
  function transform(this: { prefix: string }, id: number, suffix: string) {
    assert(db.inTransaction);
    return `${this.prefix}${id}${suffix}`;
  }
  const transaction = db.transaction(transform);
  const names = ['default', 'deferred', 'immediate', 'exclusive'] as const;
  assertEquals(transaction, transaction.default);
  assertEquals(new Set(names.map((name) => transaction[name])).size, 4);
  for (const wrapper of names.map((name) => transaction[name])) {
    assertEquals(wrapper.database, db);
    assertEquals(Object.keys(wrapper), ['database']);
    assertEquals(Object.getOwnPropertyDescriptor(wrapper, 'database'), {
      value: db,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    assertEquals(Reflect.set(wrapper, 'database', null), false);
    assertEquals(Reflect.deleteProperty(wrapper, 'database'), false);
    for (const name of names) {
      assertEquals(wrapper[name], transaction[name]);
      assertEquals(Object.getOwnPropertyDescriptor(wrapper, name), {
        value: transaction[name],
        enumerable: false,
        writable: false,
        configurable: false,
      });
      assertEquals(Reflect.set(wrapper, name, () => {}), false);
      assertEquals(Reflect.deleteProperty(wrapper, name), false);
    }
    const result: string = wrapper.call({ prefix: 'id:' }, 7, '!');
    assertEquals(result, 'id:7!');
    assert(!db.inTransaction);
  }
});

Deno.test('query builder contracts accept readonly unknown parameters and validate values', () => {
  using db = new Database(':memory:');
  const dialect: KyselySqliteDatabase = db;
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)');
  const parameters: readonly unknown[] = Object.freeze([1, '猫']);
  assertEquals(
    dialect.prepare('INSERT INTO users VALUES (?, ?)').run(parameters),
    {
      changes: 1,
      lastInsertRowid: 1,
    },
  );
  assertEquals(parameters, [1, '猫']);
  const select = dialect.prepare('SELECT * FROM users WHERE id = ?');
  const id: readonly unknown[] = Object.freeze([1]);
  assert(select.reader);
  assertEquals(select.all(id), [{ id: 1, name: '猫' }]);
  assertEquals([...select.iterate(id)], [{ id: 1, name: '猫' }]);
  const typed: Statement<Person> = db.prepare<Person>(
    'SELECT * FROM users WHERE id = ?',
  );
  const row: Person | undefined = typed.get(id);
  const rows: Person[] = typed.all(id);
  const iterator: IterableIterator<Person> = typed.iterate(id);
  assertEquals(row, { id: 1, name: '猫' });
  assertEquals(rows, [row]);
  assertEquals([...iterator], rows);
  typed.bind(id);
  assertEquals(typed.get(), row);

  const value = db.prepare('SELECT ? AS value');
  for (
    const invalid of [undefined, true, {}, [], Symbol('invalid'), () => {}]
  ) {
    const invalidParameters: readonly unknown[] = Object.freeze([invalid]);
    for (const method of ['get', 'all', 'run', 'iterate', 'bind'] as const) {
      assertThrows(() => value[method](invalidParameters), TypeError);
      assertEquals(value.get(Object.freeze([7])), { value: 7 });
    }
  }
});

Deno.test('bound iterators reuse parameters after early exit and isolate SQL values', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)');
  const injection = "'); DROP TABLE users; --";
  const insert = db.prepare('INSERT INTO users VALUES (?, ?)');
  insert.run(Object.freeze([1, injection]));
  insert.run([2, 'second']);
  const all: Person[] = [{ id: 1, name: injection }, { id: 2, name: 'second' }];
  assertEquals(
    db.prepare<Person>('SELECT * FROM users WHERE name = @name').all({
      name: injection,
    }),
    [all[0]],
  );
  const temporary = db.prepare<Person>(
    'SELECT * FROM users WHERE id > ? ORDER BY id',
  );
  assertEquals([...temporary.iterate(1)], [all[1]]);
  assertEquals([...temporary.iterate(Object.freeze([0]))], all);
  for (const row of temporary.iterate(0)) {
    assertEquals(row, all[0]);
    break;
  }
  assert(!temporary.busy);
  assertEquals([...temporary.iterate(1)], [all[1]]);
  const permanent = db.prepare<Person>(
    'SELECT * FROM users WHERE id > ? ORDER BY id',
  ).bind(Object.freeze([0]));
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const row of permanent.iterate()) {
      assertEquals(row, all[0]);
      break;
    }
    assert(!permanent.busy);
    assertEquals([...permanent.iterate()], all);
    assertEquals(permanent.get(), all[0]);
    assertEquals(permanent.all(), all);
  }
  assertThrows(() => permanent.iterate([1]), TypeError);
  assertEquals([...permanent.iterate()], all);
});

Deno.test('prepared statements refresh rows and metadata after schema changes', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER); INSERT INTO users VALUES (1),(2)');
  const statement = db.prepare('SELECT * FROM users ORDER BY id');
  assertEquals(statement.get(), { id: 1 });
  db.exec("ALTER TABLE users ADD COLUMN name TEXT DEFAULT 'new'");
  const rows = [{ id: 1, name: 'new' }, { id: 2, name: 'new' }];
  assertEquals(statement.get(), rows[0]);
  assertEquals(statement.all(), rows);
  assertEquals([...statement.iterate()], rows);
  assertEquals(statement.columns().map((column) => column.name), [
    'id',
    'name',
  ]);
  assertEquals(statement.raw().all(), [[1, 'new'], [2, 'new']]);
  assertEquals(statement.expand().all(), rows.map((row) => ({ users: row })));
});

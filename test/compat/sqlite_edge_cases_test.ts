import '../setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database from '../../src/mod.ts';
import { nativeStatus } from '../../src/native/mod.ts';

Deno.test('SQLite version, FTS5, RTree, JSON and math source-build features', () => {
  using db = new Database(':memory:');
  assertEquals(
    db.prepare('SELECT sqlite_version()').pluck().get(),
    nativeStatus().version,
  );
  assertMatchSourceId(db.prepare('SELECT sqlite_source_id()').pluck().get());
  db.exec('CREATE VIRTUAL TABLE search USING fts5(body)');
  const insert = db.prepare('INSERT INTO search VALUES (?)');
  insert.run('small striped cat');
  insert.run('large spotted dog');
  assertEquals(
    db.prepare('SELECT body FROM search WHERE search MATCH ?').pluck().all(
      'cat',
    ),
    ['small striped cat'],
  );
  db.exec('DROP TABLE search');
  db.exec(
    'CREATE VIRTUAL TABLE boxes USING rtree(id, min_x, max_x, min_y, max_y)',
  );
  db.prepare('INSERT INTO boxes VALUES (?, ?, ?, ?, ?)').run(1, 0, 5, 0, 5);
  assertEquals(
    db.prepare('SELECT id FROM boxes WHERE min_x <= ? AND max_x >= ?')
      .pluck().all(3, 3),
    [1],
  );
  assertEquals(
    db.prepare(`SELECT json('[1,2,3]'), json_object('name', '猫'),
      '{"plain":true}', json_extract('{"x":42}', '$.x')`).raw().get(),
    ['[1,2,3]', '{"name":"猫"}', '{"plain":true}', 42],
  );
  assertEquals(db.prepare('SELECT sqrt(9), pow(2, 10)').raw().get(), [3, 1024]);
});

function assertMatchSourceId(value: unknown): void {
  assert(typeof value === 'string');
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]+/.test(value));
}

Deno.test('mixed storage classes decode afresh across rows, modes and resets', () => {
  using db = new Database(':memory:');
  const values = [null, 1, 1.5, '猫\0💩', new Uint8Array([0, 255])];
  const stmt = db.prepare(`SELECT NULL AS value UNION ALL SELECT 1
    UNION ALL SELECT 1.5 UNION ALL SELECT ? UNION ALL SELECT x'00ff'`)
    .bind(values[3]!);
  for (let i = 0; i < 3; i++) {
    stmt.expand(false);
    assertEquals(stmt.all(), values.map((value) => ({ value })));
    assertEquals([...stmt.iterate()], values.map((value) => ({ value })));
    const raw = stmt.raw();
    assertEquals(raw.all(), values.map((value) => [value]));
    assertEquals([...raw.iterate()], values.map((value) => [value]));
    const plucked = stmt.pluck();
    assertEquals(plucked.all(), values);
    assertEquals([...plucked.iterate()], values);
    const expanded = stmt.expand();
    assertEquals(
      expanded.all(),
      values.map((value) => ({ $: { value } })),
    );
    assertEquals(
      [...expanded.iterate()],
      values.map((value) => ({ $: { value } })),
    );
  }
});

Deno.test('NaN, empty non-null values and signed numbers beyond 32 bits', () => {
  using db = new Database(':memory:');
  db.exec(
    'CREATE TABLE edge(text TEXT NOT NULL, blob BLOB NOT NULL, i INTEGER, r REAL)',
  );
  const insert = db.prepare('INSERT INTO edge VALUES (?, ?, ?, ?)');
  insert.run('', new Uint8Array(), NaN, NaN);
  assertEquals(db.prepare('SELECT * FROM edge').get(), {
    text: '',
    blob: new Uint8Array(),
    i: null,
    r: null,
  });
  for (
    const value of [
      978307200000,
      -978307200000,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
    ]
  ) {
    insert.run(String(value), new Uint8Array([1]), value, value);
    assertEquals(
      db.prepare('SELECT i, r FROM edge WHERE text = ?').raw().get(
        String(value),
      ),
      [value, value],
    );
  }
  const select = db.prepare('SELECT 4294967296 AS value');
  const first = select.get();
  const second = select.get();
  assertEquals(first, { value: 4294967296 });
  assertEquals(second, first);
  assert(first !== second);
  const firstRaw = select.raw().get();
  const secondRaw = select.raw().get();
  assertEquals(firstRaw, [4294967296]);
  assertEquals(secondRaw, firstRaw);
  assert(firstRaw !== secondRaw);
});

Deno.test('64-bit insert IDs and values honor statement and database safe integers', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE integers(id INTEGER PRIMARY KEY, value INTEGER)');
  const insert = db.prepare('INSERT INTO integers VALUES (?, ?)')
    .safeIntegers();
  for (const value of [-9223372036854775808n, 9223372036854775807n]) {
    assertEquals(insert.run(value, value), {
      changes: 1,
      lastInsertRowid: value,
    });
    assertEquals(
      db.prepare('SELECT value FROM integers WHERE id = ?').safeIntegers()
        .pluck().get(value),
      value,
    );
  }
  insert.safeIntegers(false);
  assertEquals(insert.run(4294967296, 4294967296).lastInsertRowid, 4294967296);
  db.defaultSafeIntegers();
  assertEquals(
    db.prepare('SELECT value FROM integers ORDER BY id').pluck().all(),
    [
      -9223372036854775808n,
      4294967296n,
      9223372036854775807n,
    ],
  );
});

Deno.test('large blob results own their bytes after mutation, deletion and close', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE blobs(value BLOB)');
    const expected = Uint8Array.from({ length: 32768 }, (_, i) => i % 251);
    const input = expected.slice();
    db.prepare('INSERT INTO blobs VALUES (?)').run(input);
    input.fill(0);
    const select = db.prepare('SELECT value FROM blobs').pluck();
    const retained = select.get() as Uint8Array;
    assertEquals(retained, expected);
    const independent = select.get() as Uint8Array;
    independent.fill(255);
    assertEquals(retained, expected);
    assertEquals(select.get(), expected);
    db.exec('DELETE FROM blobs');
    assertEquals(select.get(), undefined);
    db.close();
    assertEquals(retained, expected);
  } finally {
    db.close();
  }
});

Deno.test('NUL and supplementary Unicode survive SQL, predicates, disk and every row mode', () => {
  const dir = Deno.makeTempDirSync();
  try {
    const path = `${dir}/unicode.db`;
    {
      using db = new Database(path);
      db.exec('CREATE TABLE text_values(value TEXT NOT NULL)');
      for (const value of ['ordinary', 'bar\0baz', '猫💩']) {
        db.prepare('INSERT INTO text_values VALUES (?)').run(value);
        assertEquals(
          db.prepare('SELECT value FROM text_values WHERE value = ?').pluck()
            .get(value),
          value,
        );
      }
      assertEquals(db.prepare("SELECT '💩' AS emoji").get(), { emoji: '💩' });
    }
    using reopened = new Database(path, { readonly: true });
    const stmt = reopened.prepare(
      'SELECT value FROM text_values WHERE value = ?',
    ).bind('bar\0baz');
    assertEquals(stmt.get(), { value: 'bar\0baz' });
    assertEquals(stmt.all(), [{ value: 'bar\0baz' }]);
    assertEquals([...stmt.iterate()], [{ value: 'bar\0baz' }]);
    assertEquals(stmt.raw().all(), [['bar\0baz']]);
    assertEquals([...stmt.iterate()], [['bar\0baz']]);
    assertEquals([...stmt.pluck().iterate()], ['bar\0baz']);
    assertEquals(stmt.expand().get(), { text_values: { value: 'bar\0baz' } });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('serialized images can become files and equal closed rollback-journal bytes', async () => {
  const dir = await Deno.makeTempDir();
  try {
    let bytes: Uint8Array;
    {
      using memory = new Database(':memory:');
      memory.exec(
        "CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('猫')",
      );
      bytes = memory.serialize();
    }
    const path = `${dir}/saved.db`;
    await Deno.writeFile(path, bytes);
    {
      using disk = new Database(path);
      assertEquals(disk.prepare('SELECT value FROM saved').pluck().get(), '猫');
      disk.pragma('journal_mode = DELETE');
      disk.exec("INSERT INTO saved VALUES ('💩')");
      bytes = disk.serialize();
    }
    assertEquals(bytes, await Deno.readFile(path));
    const file = new File([bytes.buffer as ArrayBuffer], 'saved.db');
    using uploaded = new Database(new Uint8Array(await file.arrayBuffer()));
    assertEquals(
      uploaded.prepare('SELECT value FROM saved ORDER BY rowid').pluck().all(),
      ['猫', '💩'],
    );
    assertThrows(() => new Database(file as never), TypeError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('JSON-looking TEXT stays text and complex scalar inputs are rejected', () => {
  using db = new Database(':memory:');
  const query = db.prepare('SELECT ?');
  for (const value of [new Date(0), { nested: 1 }, [1, 2]]) {
    assertThrows(() => query.get([value] as never), TypeError);
  }
  const named = db.prepare('SELECT @value');
  assertThrows(() => named.get({ value: { nested: 1 } } as never), TypeError);
  assertEquals(query.pluck().get('{"value":[1,2]}'), '{"value":[1,2]}');
  assertEquals(query.pluck().get('reusable'), 'reusable');
});

Deno.test('scalar and aggregate callbacks preserve every thrown value and allow reuse', () => {
  using db = new Database(':memory:');
  for (const value of [undefined, null, 7, 'failure', Object.create(null)]) {
    let fail = true;
    db.function('scalar', () => {
      if (fail) throw value;
      return 42;
    });
    db.aggregate('step_failure', {
      step() {
        if (fail) throw value;
        return 42;
      },
    });
    db.aggregate('result_failure', {
      step: () => 42,
      result(state) {
        if (fail) throw value;
        return state;
      },
    });
    for (const fn of ['scalar', 'step_failure', 'result_failure']) {
      fail = true;
      const stmt = db.prepare(`SELECT ${fn}()`).pluck();
      let caught = false;
      try {
        stmt.get();
      } catch (error) {
        caught = true;
        assert(error === value);
      }
      assert(
        caught,
        `${fn} must throw even when the thrown value is undefined`,
      );
      assert(!stmt.busy);
      fail = false;
      assertEquals(stmt.get(), 42);
      assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
    }
  }
});

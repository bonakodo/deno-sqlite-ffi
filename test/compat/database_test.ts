import '../setup.ts';
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import Database, { SqliteError } from '../../src/mod.ts';
import { NativeCapabilityError } from '../../src/native/mod.ts';

Deno.test('database options and closed connection validation', () => {
  for (const value of [null, true, [], 1]) {
    assertThrows(() => new Database(':memory:', value as never), TypeError);
  }
  for (
    const config of [
      { nativeBinding: 'x' },
      { readOnly: true },
      { memory: true },
      { readonly: 1 },
      { fileMustExist: 'yes' },
      { timeout: -1 },
      { timeout: 1.5 },
      { verbose: 1 },
    ]
  ) assertThrows(() => new Database(':memory:', config as never), TypeError);
  assertThrows(() => new Database(':memory:', { readonly: true }), TypeError);
  assertThrows(
    () => new Database(':memory:', { timeout: 2 ** 31 }),
    RangeError,
  );
  assertThrows(() => new Database(4 as never), TypeError);
  const db = new Database();
  assertEquals(db.name, '');
  assert(db.memory);
  assertThrows(() => db.unsafeMode(), NativeCapabilityError);
  db.close();
  assertEquals(db.inTransaction, false);
  assertThrows(() => db.exec('SELECT 1'), TypeError);
  assertThrows(() => db.defaultSafeIntegers(), TypeError);
  assertThrows(() => db.transaction(() => {}), TypeError);
  assertThrows(() => new SqliteError(1 as never, 'X'), TypeError);
});

Deno.test('disk persistence, readonly, fileMustExist, WAL, locks, and backup', async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertThrows(
      () => new Database(`${dir}/missing.db`, { fileMustExist: true }),
      SqliteError,
    );
    using db = new Database(`${dir}/source.db`, { timeout: 0 });
    assertEquals(db.pragma('journal_mode=WAL', { simple: true }), 'wal');
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1),(2)');
    using ro = new Database(`${dir}/source.db`, { readonly: true });
    assert(ro.readonly && !ro.memory);
    assertEquals(ro.prepare('SELECT count(*) FROM t').pluck().get(), 2);
    assertThrows(() => ro.exec('DELETE FROM t'), SqliteError, 'readonly');
    using other = new Database(`${dir}/source.db`, { timeout: 0 });
    db.exec('BEGIN IMMEDIATE');
    assertEquals(
      assertThrows(() => other.exec('INSERT INTO t VALUES(3)'), SqliteError)
        .code,
      'SQLITE_BUSY',
    );
    db.exec('ROLLBACK');
    const progress = await db.backup(`${dir}/backup.db`);
    assertEquals(progress.remainingPages, 0);
    using restored = new Database(`${dir}/backup.db`);
    assertEquals(restored.prepare('SELECT x FROM t').pluck().all(), [1, 2]);
    await assertRejects(
      () => db.backup(`${dir}/missing/backup.db`),
      SqliteError,
    );
    await assertRejects(
      () => db.backup(`${dir}/bad-schema.db`, { attached: 'absent' }),
      SqliteError,
    );
    for (
      const [destination, options] of [['', {}], [':memory:', {}], [
        `${dir}/bad.db`,
        { progress: 1 },
      ], [`${dir}/bad.db`, { attached: '' }]] as const
    ) {
      await assertRejects(
        () => db.backup(destination, options as never),
        TypeError,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('backup progress, pause, cancellation and closure', async () => {
  const dir = await Deno.makeTempDir();
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE t(data); INSERT INTO t VALUES (zeroblob(1000000))');
    let calls = 0;
    await db.backup(`${dir}/copy.db`, {
      progress: () => ++calls === 1 ? 0 : 100,
    });
    assert(calls >= 2);
    const error = new Error('cancel');
    assertEquals(
      await assertRejects(() =>
        db.backup(`${dir}/cancel.db`, {
          progress() {
            throw error;
          },
        })
      ),
      error,
    );
    for (const value of [NaN, 'invalid', null]) {
      await assertRejects(
        () =>
          db.backup(`${dir}/invalid.db`, { progress: () => value as never }),
        TypeError,
      );
    }
    const pending = db.backup(`${dir}/closed.db`);
    db.close();
    await assertRejects(() => pending, TypeError, 'closed');
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('serialization owns bytes and supports readonly and attached databases', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(42)');
  const bytes = db.serialize();
  using restored = new Database(bytes);
  bytes.fill(0);
  assertEquals(restored.prepare('SELECT x FROM t').pluck().get(), 42);
  using ro = new Database(db.serialize(), { readonly: true });
  assertThrows(() => ro.exec('INSERT INTO t VALUES(3)'), SqliteError);
  db.exec(
    "ATTACH ':memory:' AS aux; CREATE TABLE aux.t(x); INSERT INTO aux.t VALUES(7)",
  );
  using attached = new Database(db.serialize({ attached: 'aux' }));
  assertEquals(attached.prepare('SELECT x FROM t').pluck().get(), 7);
  assertThrows(() => db.serialize({ attached: 'absent' }), SqliteError);
  using malformed = new Database(new Uint8Array([1, 2, 3]));
  assertThrows(
    () => malformed.prepare('SELECT * FROM sqlite_schema').all(),
    SqliteError,
  );
});

Deno.test('pragma, explain, verbose, and SQL preparation errors', () => {
  const logs: string[] = [];
  using db = new Database(':memory:', { verbose: (sql) => logs.push(sql) });
  db.prepare('SELECT ?').get(3);
  assertEquals(logs, ['SELECT 3.0']);
  assertEquals(db.pragma('user_version=7'), []);
  assertEquals(db.pragma('user_version', { simple: true }), 7);
  assertEquals(db.pragma('unknown_pragma', { simple: true }), undefined);
  assertEquals(db.pragma('unknown_pragma'), []);
  assertEquals(db.pragma('user_version'), [{ user_version: 7 }]);
  assert(db.explain('SELECT ?').length > 0);
  assert(db.explain('QUERY PLAN SELECT 1').length > 0);
  assertThrows(() => db.explain('SELECT 1; SELECT 2'), RangeError);
  assertThrows(() => db.prepare('SELECT broken('), SqliteError);
  assertThrows(() => db.prepare('SELECT 1; broken('));
  assertEquals(db.prepare('SELECT 1; -- comment').get(), { '1': 1 });
  assertThrows(
    () => db.pragma('user_version', { simple: 1 } as never),
    TypeError,
  );
  assertThrows(() => db.exec(null as never), TypeError);
  db.exec(' -- only a comment');
  assertThrows(() => db.transaction(null as never), TypeError);
  db.defaultSafeIntegers(false);
  assertThrows(() => db.defaultSafeIntegers(1 as never), TypeError);
  assertThrows(
    () => db.prepare('SELECT 1; PRAGMA foreign_keys=OFF'),
    RangeError,
  );
  assertEquals(db.pragma('foreign_keys', { simple: true }), 1);
  assertEquals(db.prepare('SELECT 1; ; /* comment */ -- end').pluck().get(), 1);
});

Deno.test('backup begins with progress before copying, and clamps page counts', async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = new Database(':memory:');
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(1)');
    let calls = 0;
    await db.backup(`${dir}/copy.db`, {
      progress(info) {
        if (!calls++) {
          assertEquals(info.remainingPages, info.totalPages);
          return -1;
        }
        return Infinity;
      },
    });
    assertEquals(calls, 2);
    await db.backup(`${dir}/rounded.db`, { progress: () => 1.5 });
    await db.backup(`${dir}/null.db`, { progress: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

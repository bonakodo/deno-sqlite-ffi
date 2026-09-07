import './setup.ts';
/** Inject return failures at the native boundary; never pass invalid pointers to SQLite. */
import { assertEquals, assertThrows } from '@std/assert';
import Database, { SqliteError } from '../src/mod.ts';
import { native } from '../src/native/loader.ts';
import type { Symbols } from '../src/native/symbols.ts';
import { resultError } from '../src/errors.ts';

function fault<K extends keyof Symbols>(
  name: K,
  replacement: Symbols[K],
  run: () => void,
): void {
  const s = native();
  const original = s[name];
  s[name] = replacement;
  try {
    run();
  } finally {
    s[name] = original;
  }
}

Deno.test('native allocation and initialization failures clean up', () => {
  fault(
    'sqlite3_busy_timeout',
    () => 7,
    () => assertThrows(() => new Database(':memory:'), SqliteError),
  );
  using db = new Database(':memory:');
  db.exec('CREATE TABLE t(x)');
  const data = db.serialize();
  fault(
    'sqlite3_malloc64',
    () => null,
    () => assertThrows(() => new Database(data), Error, 'allocation'),
  );
  fault('sqlite3_deserialize', (_db, _schema, bytes) => {
    native().sqlite3_free(bytes);
    return 1;
  }, () => assertThrows(() => new Database(data), SqliteError));
  fault('sqlite3_serialize', (_db, _schema, out) => {
    new BigInt64Array((out as BigInt64Array).buffer)[0] = 1n;
    return null;
  }, () => assertThrows(() => db.serialize(), SqliteError));
  fault(
    'sqlite3_prepare_v2',
    () => 0,
    () => assertThrows(() => db.explain('SELECT 1'), RangeError),
  );
  assertEquals(
    resultError('unknown', 999999).code,
    'UNKNOWN_SQLITE_ERROR_999999',
  );
});

Deno.test('failed open closes the SQLite error handle exactly once', () => {
  const directory = Deno.makeTempDirSync();
  const close = native().sqlite3_close_v2;
  let closes = 0;
  try {
    fault('sqlite3_close_v2', (pointer) => {
      closes++;
      return close(pointer);
    }, () => {
      const error = assertThrows(() => new Database(directory), SqliteError);
      assertEquals(error.code, 'SQLITE_CANTOPEN');
    });
    assertEquals(closes, 1);
  } finally {
    Deno.removeSync(directory);
  }
});

Deno.test('callback registration failures release unsafe callbacks', () => {
  using db = new Database(':memory:');
  fault('sqlite3_create_function_v2', () => 1, () => {
    assertThrows(() => db.function('scalar', () => 1), SqliteError);
    assertThrows(() => db.aggregate('agg', { step: () => 1 }), SqliteError);
  });
  fault(
    'sqlite3_create_window_function',
    () => 1,
    () =>
      assertThrows(
        () => db.aggregate('window', { step: () => 1, inverse: () => 1 }),
        SqliteError,
      ),
  );
  fault(
    'sqlite3_create_module_v2',
    () => 1,
    () =>
      assertThrows(() =>
        db.table('table', {
          columns: ['x'],
          rows: function* () {
            yield [1];
          },
        }), SqliteError),
  );
  db.aggregate('agg', { step: () => 1 });
  fault(
    'sqlite3_aggregate_context',
    () => null,
    () =>
      assertThrows(() => db.prepare('SELECT agg()').get(), Error, 'allocation'),
  );
  assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
});

Deno.test('partial prepare and repeated aggregate errors preserve cleanup', () => {
  using db = new Database(':memory:');
  const prepare = native().sqlite3_prepare_v2;
  fault('sqlite3_prepare_v2', (...args) => {
    prepare(...args);
    return 1;
  }, () => assertThrows(() => db.prepare('SELECT 1'), SqliteError));
  const error = new Error('first callback');
  db.aggregate('fails', {
    step: (_state: unknown, _x) => {
      throw error;
    },
  });
  fault(
    'sqlite3_result_error',
    () => {},
    () =>
      assertEquals(
        assertThrows(() =>
          db.prepare('WITH t(x) AS (VALUES(1),(2),(3)) SELECT fails(x) FROM t')
            .get()
        ),
        error,
      ),
  );
  assertEquals(db.prepare('SELECT 1').pluck().get(), 1);
});

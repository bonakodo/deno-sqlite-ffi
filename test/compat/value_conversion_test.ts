import '../setup.ts';
import { assertEquals, assertThrows } from '@std/assert';
import Database, { type SqlValue } from '../../src/mod.ts';

Deno.test('number reads match bigint conversion at integer rounding boundaries', () => {
  using db = new Database(':memory:');
  const read = db.prepare('SELECT ?').pluck();
  let received: SqlValue = null;
  db.function('number_arg', (value) => {
    received = value;
    return null;
  });
  db.function('integer_arg', { safeIntegers: true }, (value) => {
    received = value;
    return null;
  });
  const numberArg = db.prepare('SELECT number_arg(?)');
  const integerArg = db.prepare('SELECT integer_arg(?)');
  const values = new Set<bigint>([
    0n,
    -9223372036854775808n,
    9223372036854775807n,
  ]);
  for (let exponent = 0n; exponent < 63n; exponent++) {
    const power = 1n << exponent;
    for (const offset of [-3n, -1n, 0n, 1n, 3n]) {
      values.add(power + offset);
      values.add(-power + offset);
    }
  }
  for (const value of values) {
    assertEquals(read.safeIntegers(false).get(value), Number(value));
    assertEquals(read.safeIntegers().get(value), value);
    numberArg.get(value);
    assertEquals(received, Number(value));
    integerArg.get(value);
    assertEquals(received, value);
  }
});

Deno.test('text and callback values survive resets, rebinds, and close', () => {
  const db = new Database(':memory:');
  const texts = [
    '',
    'plain ASCII',
    '猫💩',
    'before\0after',
    '\0\0',
    'a'.repeat(8192),
  ];
  const retained: SqlValue[] = [];
  const blob = new Uint8Array([0, 255, 1]);
  try {
    db.function('retain', { varargs: true }, (...values) => {
      retained.push(...values);
      return null;
    });
    const read = db.prepare('SELECT ?').pluck();
    const callback = db.prepare('SELECT retain(?, ?)');
    for (const value of texts) {
      retained.push(read.get(value)!);
      callback.get(value, blob);
    }
    // TextDecoder ignores a leading BOM and replaces invalid UTF-8. Keep that
    // behavior even when SQLite returns text that was not bound as a JS string.
    assertEquals(read.get('\ufeff猫\0💩'), '猫\0💩');
    assertEquals(
      db.prepare("SELECT CAST(x'efbbbf61ff0062' AS TEXT)").pluck().get(),
      'a\ufffd\0b',
    );
    const malformed = db.prepare('SELECT CAST(? AS TEXT)').pluck();
    const decoder = new TextDecoder();
    for (
      const bytes of [
        [0x80],
        [0xff, 0xff],
        [0xc0, 0x80],
        [0xe0, 0x80, 0x80],
        [0xed, 0xa0, 0x80],
        [0xf4, 0x90, 0x80, 0x80],
        [0xe1, 0x80, 0],
        [0xf0, 0x9f, 0, 0],
        [0xef, 0xbb, 0xbf, 0],
      ]
    ) {
      const input = new Uint8Array(bytes);
      assertEquals(malformed.get(input), decoder.decode(input));
    }
    read.get('replace SQLite storage');
    blob.fill(7);
  } finally {
    db.close();
  }
  assertEquals(
    retained,
    texts.flatMap((value) => [value, value, new Uint8Array([0, 255, 1])]),
  );
});

Deno.test('cached parameter layouts preserve mixed binding and error recovery', () => {
  using db = new Database(':memory:');
  db.exec('CREATE TABLE bindings(value)');
  const mixed = db.prepare('SELECT ?, :same, @same, ?, $last').raw();
  const named = { same: 'named', last: new Uint8Array() };
  assertEquals(mixed.get([1], named, [null]), [
    1,
    'named',
    'named',
    null,
    new Uint8Array(),
  ]);
  assertEquals(mixed.get(named, 2, [3]), [
    2,
    'named',
    'named',
    3,
    new Uint8Array(),
  ]);
  assertThrows(() => mixed.get(1, {}, 2), RangeError, 'same');
  assertThrows(() => mixed.get(1, named, 2, {}), TypeError, 'one named');
  assertThrows(() => mixed.get(1, named, [false]), TypeError);
  assertThrows(() => mixed.get(1, named), RangeError, 'Too few');
  assertThrows(() => mixed.get(1, named, 2, 3), RangeError, 'Too many');
  const numbered = db.prepare('SELECT ?2, ?1, ?').raw();
  assertEquals(numbered.get({ '1': 4, '2': 5 }, [6]), [5, 4, 6]);
  const inherited = Object.create({ same: 7, last: 8 });
  assertEquals(mixed.get(9, inherited, 10), [9, 7, 7, 10, 8]);
  const reprepare = db.prepare('SELECT ?, :named FROM bindings').raw();
  db.exec(
    'ALTER TABLE bindings ADD COLUMN extra; INSERT INTO bindings VALUES (1, 2)',
  );
  assertEquals(reprepare.get([11], { named: 12 }), [11, 12]);
  assertEquals(mixed.get(13, { same: 14, last: 15 }, 16), [13, 14, 14, 16, 15]);
});

Deno.test('reused text buffers preserve permanent binds and callback results', () => {
  using db = new Database(':memory:');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const permanent = db.prepare('SELECT ?, ?, ?').raw().bind(
    'first\0猫',
    '',
    'last💩',
  );
  db.function('echo_text', (value) => value);
  const echo = db.prepare('SELECT echo_text(?), echo_text(?)').raw();
  for (
    const value of [
      '',
      '\ud800',
      '\udfff',
      'left\ud800right\udfff',
      '猫\0💩'.repeat(100),
      'x'.repeat(21845),
      '猫'.repeat(21846),
      'large\0💩'.repeat(16384),
    ]
  ) {
    assertEquals(echo.get(value, 'next'), [
      decoder.decode(encoder.encode(value)),
      'next',
    ]);
    assertEquals(permanent.get(), ['first\0猫', '', 'last💩']);
  }
  const nested = db.prepare('SELECT ?').pluck();
  assertEquals(
    db.prepare('SELECT ?, :next').raw().get('first', {
      get next() {
        return nested.get('nested💩')!;
      },
    }),
    ['first', 'nested💩'],
  );
  assertEquals(permanent.get(), ['first\0猫', '', 'last💩']);
});

Deno.test('scalar callbacks use actual argument counts and retain converted values', () => {
  const db = new Database(':memory:');
  const blob = new Uint8Array([0, 255, 1]);
  const retained: SqlValue[][] = [];
  try {
    for (const safeIntegers of [false, true]) {
      db.function('capture', { varargs: true, safeIntegers }, (...values) => {
        retained.push(values);
        return undefined;
      });
      for (
        const values of [
          [],
          [9223372036854775807n],
          ['猫\0💩', blob],
          [null, 1.5, -9223372036854775808n],
        ] as SqlValue[][]
      ) {
        const placeholders = values.map(() => '?').join(',');
        assertEquals(
          db.prepare(`SELECT capture(${placeholders})`).pluck().get(values),
          null,
        );
      }
    }
  } finally {
    db.close();
  }
  blob.fill(7);
  assertEquals(retained, [
    [],
    [Number(9223372036854775807n)],
    ['猫\0💩', new Uint8Array([0, 255, 1])],
    [null, 1.5, Number(-9223372036854775808n)],
    [],
    [9223372036854775807n],
    ['猫\0💩', new Uint8Array([0, 255, 1])],
    [null, 1.5, -9223372036854775808n],
  ]);
});

Deno.test('zero through three argument callbacks preserve thrown values and reuse', () => {
  using db = new Database(':memory:');
  let shouldThrow = true;
  let thrown: unknown;
  db.function('failure', { varargs: true }, () => {
    if (shouldThrow) throw thrown;
    return 42;
  });
  for (let count = 0; count <= 3; count++) {
    const args = Array.from({ length: count }, () => '1').join(',');
    const query = db.prepare(`SELECT failure(${args})`).pluck();
    for (const error of [undefined, new Error('callback')]) {
      thrown = error;
      shouldThrow = true;
      let caught = false;
      try {
        query.get();
      } catch (actual) {
        caught = true;
        assertEquals(actual, error);
      }
      assertEquals(caught, true);
      shouldThrow = false;
      assertEquals(query.get(), 42);
    }
  }
});

import { assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import Database from '../../src/mod.ts';

using db = new Database(':memory:');
db.exec('CREATE TABLE t(before_change); INSERT INTO t VALUES(5)');
const cold = db.prepare('SELECT * FROM t');
const statement = db.prepare('SELECT 7 AS value');
const original = globalThis.Function;
let compilations = 0;
try {
  globalThis.Function = new Proxy(original, {
    construct(target, args, newTarget) {
      compilations++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  assertEquals(cold.get(), { before_change: 5 });
  assertEquals(db.prepare('SELECT * FROM t').raw().get(), [5]);
  assertEquals(db.prepare('SELECT * FROM t').pluck().get(), 5);
  assertEquals(db.prepare('SELECT * FROM t').expand().get(), {
    t: { before_change: 5 },
  });
  assertEquals(compilations, 0);
  assertEquals(cold.get(), { before_change: 5 });
  assertEquals(compilations, 1);
  db.exec('ALTER TABLE t RENAME COLUMN before_change TO after_change');
  assertEquals(cold.get(), { after_change: 5 });
  assertEquals(cold.get(), { after_change: 5 });
} finally {
  globalThis.Function = original;
}
const failure = new SyntaxError('Injected row compiler failure');
try {
  // Isolate constructor failure injection in this subprocess. The library must
  // preserve errors other than V8's explicit code-generation denial.
  globalThis.Function = new Proxy(original, {
    construct() {
      throw failure;
    },
  });
  assertStrictEquals(assertThrows(() => statement.all()), failure);
} finally {
  globalThis.Function = original;
}
assertEquals(statement.all(), [{ value: 7 }]);

import Database from '../../src/mod.ts';
import { native } from '../../src/native/loader.ts';

const gc = (globalThis as unknown as { gc(): void }).gc;
async function collect(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (condition()) return;
  }
  throw new Error('Garbage collection did not release the native resource');
}

using db = new Database(':memory:');
db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(1),(2)');
const stmt = db.prepare('SELECT * FROM t');
(() => {
  const iterator = stmt.iterate();
  iterator.next();
})();
await collect(() => !stmt.busy);
db.exec('INSERT INTO t VALUES(3)');

// These fixtures replace native calls to count resource releases.
const s = native() as {
  -readonly [K in keyof ReturnType<typeof native>]: ReturnType<
    typeof native
  >[K];
};
let finalized = 0;
const finalize = s.sqlite3_finalize;
s.sqlite3_finalize = (p) => {
  finalized++;
  return finalize(p);
};
(() => {
  db.prepare('SELECT 2');
})();
await collect(() => finalized > 0);
s.sqlite3_finalize = finalize;

let closed = 0;
const close = s.sqlite3_close_v2;
s.sqlite3_close_v2 = (p) => {
  closed++;
  return close(p);
};
(() => {
  new Database(':memory:');
})();
await collect(() => closed > 0);
s.sqlite3_close_v2 = close;
console.log('Iterator, statement, and database GC fallback verified');

// Lifetime regressions from denodrivers/sqlite3 PRs #3, #5, #59, #70, #79.
// Rewritten for this API; see NOTICE for upstream attribution.
import { assertEquals } from '@std/assert';
import Database, { type Statement } from '../../src/mod.ts';
import { native } from '../../src/native/loader.ts';

const gc = (globalThis as unknown as { gc(): void }).gc;
const turn = () => new Promise((resolve) => setTimeout(resolve, 5));
async function collect(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    gc();
    await turn();
    if (condition()) return;
  }
  throw new Error('Garbage collection did not collect the retained statements');
}

{
  using db = new Database(':memory:');
  const permanent = db.prepare('SELECT ? AS text, ? AS blob');
  (() => {
    const bytes = new Uint8Array([1, 2, 3]);
    permanent.bind('owned\0猫'.repeat(100), bytes);
    bytes.fill(9);
  })();
  gc();
  await turn();
  for (let i = 0; i < 20; i++) {
    assertEquals(permanent.get(), {
      text: 'owned\0猫'.repeat(100),
      blob: new Uint8Array([1, 2, 3]),
    });
  }
  db.function('collect_now', () => {
    gc();
    return 1;
  });
  const temporary = db.prepare('SELECT collect_now(), ?, ?').raw();
  for (let i = 0; i < 20; i++) {
    assertEquals(
      temporary.get(['temporary'.repeat(1000), new Uint8Array([5, 6, 7])]),
      [1, 'temporary'.repeat(1000), new Uint8Array([5, 6, 7])],
    );
  }
  db.exec('CREATE TABLE users(name TEXT NOT NULL)');
  for (let i = 0; i < 10000; i++) {
    db.prepare('INSERT INTO users VALUES (?)').run(`user-${i}`);
    if (i % 500 === 0) {
      gc();
      await turn();
    }
  }
  assertEquals(
    db.prepare('SELECT name FROM users ORDER BY rowid').pluck().all(),
    Array.from({ length: 10000 }, (_, i) => `user-${i}`),
  );
}
await turn();

const db = new Database(':memory:');
let retained: Statement[] | undefined = Array.from(
  { length: 100 },
  (_, i) => db.prepare(`SELECT ${i}`),
);
let collected = 0;
const registry = new FinalizationRegistry(() => collected++);
retained.forEach((stmt) => registry.register(stmt, 1));
// These fixtures replace native calls to count resource releases.
const symbols = native() as {
  -readonly [K in keyof ReturnType<typeof native>]: ReturnType<
    typeof native
  >[K];
};
const finalize = symbols.sqlite3_finalize;
let calls = 0;
symbols.sqlite3_finalize = (p) => {
  calls++;
  return finalize(p);
};
try {
  db.close();
  assertEquals(calls, 100);
  retained = undefined;
  await collect(() => collected === 100);
  // Let the wrapper's finalizers run even if our registry ran first.
  for (let i = 0; i < 5; i++) {
    gc();
    await turn();
  }
  assertEquals(calls, 100);
  db.close();
  assertEquals(calls, 100);
} finally {
  symbols.sqlite3_finalize = finalize;
  db.close();
}

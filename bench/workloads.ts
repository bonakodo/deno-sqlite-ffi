import type { SqlFunction } from '../src/types.ts';

/** The common API exercised by all three libraries. */
interface BenchmarkDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: (string | number | Uint8Array)[]): unknown;
    get(...params: (string | number)[]): unknown;
    all(): unknown[];
    iterate?(): Iterable<unknown>;
    iter?(): Iterable<unknown>;
  };
  transaction(fn: () => void): () => void;
  function(name: string, fn: SqlFunction): unknown;
  close(): unknown;
}

export function registerBenchmarks(
  db: BenchmarkDatabase,
  comparison?: { name: string; baseline?: boolean },
): void {
  globalThis.addEventListener('unload', () => db.close());
  // Use the original just-js connection settings for the shared fixture.
  // https://github.com/just-js/benchmarks/tree/43987cefc863eda8701b64baa03a76a3c81ccee7/02-sqlite
  db.exec('PRAGMA auto_vacuum = none');
  db.exec('PRAGMA temp_store = memory');
  db.exec('PRAGMA locking_mode = exclusive');
  db.exec('PRAGMA user_version = 100');
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT, data BLOB)');
  const insert = db.prepare('INSERT INTO rows(value,data) VALUES (?,?)');
  const blob = new Uint8Array(1024).fill(42);
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) insert.run(`row ${i}`, blob);
  })();
  const scalar = db.prepare('SELECT 1 AS value');
  const userVersion = db.prepare('pragma user_version');
  const lookup = db.prepare('SELECT id,value FROM rows WHERE id=?');
  const all = db.prepare('SELECT id,value FROM rows LIMIT 100');
  // @db/sqlite calls this method iter; bind each library's native method once.
  const iterate = (all.iterate ?? all.iter)?.bind(all);
  if (!iterate) throw new Error('Benchmark requires row iteration');
  const blobQuery = db.prepare('SELECT data FROM rows WHERE id=1');
  const update = db.prepare('UPDATE rows SET value=? WHERE id=?');
  db.function('identity', (x) => x);
  const callback = db.prepare('SELECT identity(?) AS value');
  const batch = db.transaction(() => {
    for (let i = 1; i <= 100; i++) update.run('updated', i);
  });

  // Check the fixtures and results once, outside the timed loops.
  const check = (ok: boolean) => {
    if (!ok) throw new Error('Benchmark fixture validation failed');
  };
  check((scalar.get() as { value: number }).value === 1);
  check(
    (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number })
      .auto_vacuum === 0,
  );
  check(
    (db.prepare('PRAGMA temp_store').get() as { temp_store: number })
      .temp_store === 2,
  );
  check(
    (db.prepare('PRAGMA locking_mode').get() as { locking_mode: string })
      .locking_mode === 'exclusive',
  );
  for (let i = 0; i < 3; i++) {
    check((userVersion.get() as { user_version: number }).user_version === 100);
  }
  const row = lookup.get(500) as { id: number; value: string };
  check(row.id === 500 && row.value === 'row 499');
  const rows = all.all() as { id: number; value: string }[];
  check(rows.length === 100);
  check(rows.every((row, i) => row.id === i + 1 && row.value === `row ${i}`));
  check(JSON.stringify([...iterate()]) === JSON.stringify(rows));
  const data = (blobQuery.get() as { data: Uint8Array }).data;
  check(data instanceof Uint8Array && data.length === 1024);
  check(data.every((byte) => byte === 42));
  check((callback.get(42) as { value: number }).value === 42);
  batch();
  check((all.all() as { value: string }[]).every((r) => r.value === 'updated'));

  const bench = (
    name: string,
    fn: () => void,
    options: { group?: string; baseline?: boolean } = {},
  ) => {
    Deno.bench({
      name: comparison ? `${name} / ${comparison.name}` : name,
      ...(comparison
        ? { group: name, baseline: comparison.baseline ?? false }
        : options),
      fn,
    });
  };
  bench('prepared scalar get', () => {
    scalar.get();
  });
  bench('prepared indexed lookup', () => {
    lookup.get(500);
  });
  bench('100 rows via all', () => {
    all.all();
  }, { group: 'read 100 rows', baseline: true });
  bench('100 rows via iterate', () => {
    for (const _ of iterate()) { /* Consume all rows. */ }
  }, { group: 'read 100 rows' });
  bench('1 KiB blob read', () => {
    blobQuery.get();
  });
  bench('100 updates in one transaction', () => {
    batch();
  });
  bench('scalar JavaScript callback', () => {
    callback.get(42);
  });
  bench('just-js prepared pragma user_version', () => {
    userVersion.get();
  });
}

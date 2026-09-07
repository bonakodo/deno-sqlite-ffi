/** Compare prepare/first-read costs against a saved source revision. */
import OptimizedDatabase from '../src/mod.ts';

if (!Deno.args[0]) {
  throw new Error(
    'Pass a baseline module path relative to the repository root after --',
  );
}
const { default: OriginalDatabase } = await import(
  new URL(Deno.args[0], new URL('../', import.meta.url)).href
);

interface Row {
  id: number;
  value: string;
}
interface Statement extends Disposable {
  get(...parameters: number[]): unknown;
  all(): unknown[];
  run(...parameters: (number | string)[]): unknown;
}
interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  transaction(fn: () => void): () => void;
  close(): unknown;
}

function register(db: Database, name: string, baseline: boolean): void {
  globalThis.addEventListener('unload', () => db.close());
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT)');
  {
    using insert = db.prepare('INSERT INTO rows VALUES (?, ?)');
    db.transaction(() => {
      for (let id = 1; id <= 1000; id++) insert.run(id, `row ${id - 1}`);
    })();
  }
  {
    using scalar = db.prepare('SELECT 1 AS value');
    using lookup = db.prepare('SELECT id,value FROM rows WHERE id=?');
    using all = db.prepare('SELECT id,value FROM rows LIMIT 100');
    const row = lookup.get(500) as Row;
    const rows = all.all() as Row[];
    if (
      (scalar.get() as { value: number }).value !== 1 ||
      row.id !== 500 || row.value !== 'row 499' || rows.length !== 100 ||
      !rows.every((row, index) =>
        row.id === index + 1 && row.value === `row ${index}`
      )
    ) throw new Error(`${name} fixture validation failed`);
  }

  function bench(group: string, fn: () => void): void {
    Deno.bench({ name: `${group} / ${name}`, group, baseline, fn });
  }
  bench('prepare + scalar get + dispose', () => {
    using statement = db.prepare('SELECT 1 AS value');
    statement.get();
  });
  bench('prepare + indexed lookup + dispose', () => {
    using statement = db.prepare('SELECT id,value FROM rows WHERE id=?');
    statement.get(500);
  });
  bench('prepare + 100 rows all + dispose', () => {
    using statement = db.prepare('SELECT id,value FROM rows LIMIT 100');
    statement.all();
  });

  // Exercise changing result shapes, beyond the optimized 128-factory cache.
  // Prebuild the same SQL strings for both versions to exclude string creation.
  const distinctShapes = Array.from(
    { length: 256 },
    (_, index) => `SELECT 1 AS value_${index}`,
  );
  let shapeIndex = 0;
  bench('prepare + scalar get + dispose, 256 result shapes', () => {
    using statement = db.prepare(distinctShapes[shapeIndex]!);
    shapeIndex = (shapeIndex + 1) & 255;
    statement.get();
  });
}

register(new OriginalDatabase(':memory:'), 'original', true);
register(new OptimizedDatabase(':memory:'), 'optimized', false);

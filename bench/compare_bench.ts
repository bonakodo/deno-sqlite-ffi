/** Run all three implementations in Deno with deno task bench:compare. */
import { Database as DbSqlite } from '@db/sqlite';
import BetterSqlite3 from 'better-sqlite3';
import Database from '../src/mod.ts';
import { registerBenchmarks } from './workloads.ts';

const ffi = new Database(':memory:');
const better = new BetterSqlite3(':memory:');
// Both FFI libraries load the same engine through DENO_SQLITE_PATH.
const dbSqlite = new DbSqlite(':memory:');
console.error(JSON.stringify({
  runtime: Deno.version,
  platform: Deno.build,
  libraries: {
    '@bonakodo/sqlite': ffi.prepare('SELECT sqlite_version() AS version').get(),
    '@db/sqlite@0.13.0': dbSqlite.prepare('SELECT sqlite_version() AS version')
      .get(),
    'better-sqlite3@13.0.3': better.prepare(
      'SELECT sqlite_version() AS version',
    )
      .get(),
  },
}));

registerBenchmarks(ffi, { name: '@bonakodo/sqlite', baseline: true });
registerBenchmarks(better, { name: 'better-sqlite3@13.0.3' });
registerBenchmarks(dbSqlite, { name: '@db/sqlite@0.13.0' });

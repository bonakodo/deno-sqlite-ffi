# @bonakodo/sqlite

Synchronous SQLite for Deno, using the SQLite C API through `Deno.dlopen`.
The API targets better-sqlite3 13.0.3 and uses `Uint8Array` for binary data.
There are no Node APIs, npm dependencies, binary downloads, or runtime C helpers.

Requires Deno 2.0.0 or newer and SQLite 3.35.0 or newer. The source build uses
the pinned SQLite 3.53.4 submodule. Supported targets are Linux and macOS on
x64/arm64, and Windows on x64. Each worker owns its connections and callbacks.

## Features

- **Fastest SQLite library in our Deno benchmarks (September 7, 2026):**
  Ahead of `better-sqlite3` 13.0.3 and `@db/sqlite` 0.13.0 across the tested
  in-memory workloads on Apple M1 Max. See the [benchmark snapshot](#benchmark-snapshot)
  for timings and test conditions.
- **Prepared queries:** Named and positional parameters, reusable bindings,
  typed rows, iteration, and object, array, or scalar results.
- **Transactions:** Automatic commit and rollback, nested savepoints, and
  deferred, immediate, and exclusive modes.
- **JavaScript SQL extensions:** Custom scalar, aggregate, and window functions,
  plus virtual tables backed by generators or table factories.
- **Database copies:** Serialize to `Uint8Array`, restore from bytes, and run
  incremental backups with progress callbacks and retries for temporary locks.
- **Big integers and binary data:** Signed 64-bit `bigint` values through
  `safeIntegers()` and blobs through `Uint8Array`.
- **Resource cleanup:** `using` support for databases and statements, iterator
  cleanup on early loop exit, and separate connections in each worker.
- **Kysely:** Implements Kysely 0.29.5's SQLite interface,
  including readonly query parameters.
- **SpatiaLite:** Geometry columns, GeoJSON, and spatial queries through
  `loadExtension()`.
- **ICU:** Unicode case mapping and locale-aware collations through
  `loadExtension()`.

Install SpatiaLite and ICU extensions that match the selected SQLite library.
See the [extension tests](#tests-and-benchmarks)
for setup and tested behavior.

## Install the package

Add the package to your Deno project:

```sh
deno add jsr:@bonakodo/sqlite@0.1.0
```

This adds the import mapping used in the examples below. Install and select a
SQLite shared library before running them.

## Install SQLite

Install a shared SQLite library yourself and set `DENO_SQLITE_PATH` to its
absolute path. The library never searches for, downloads, or builds SQLite.

macOS with Homebrew:

```sh
brew install sqlite
export DENO_SQLITE_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

Debian or Ubuntu:

```sh
sudo apt-get install libsqlite3-0
dpkg -L libsqlite3-0
export DENO_SQLITE_PATH=/usr/lib/x86_64-linux-gnu/libsqlite3.so.0
```

Use the path printed by `dpkg` for your architecture; arm64 normally uses
`/usr/lib/aarch64-linux-gnu/libsqlite3.so.0`.
On Windows, install the x64 SQLite DLL and set the path in your shell:

```powershell
$env:DENO_SQLITE_PATH = 'C:\SQLite\sqlite3.dll'
```

Set the environment variable before the first database or native initialization.
Its value must be an absolute path; `auto` and relative paths are not accepted.
The selected library and any initialization failure remain cached for the
current Deno isolate. Importing the package does not read the environment or
load a library.

Loading calls `sqlite3_initialize()` and checks its result before reporting
success. This also supports stock SQLite builds with `SQLITE_OMIT_AUTOINIT`.
Initialization errors raise a cached `NativeLoadError`.

## Use the API

```ts
import Database from '@bonakodo/sqlite';

using db = new Database(':memory:');
db.exec('CREATE TABLE cats (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO cats(name) VALUES (@name)');
insert.run({ name: 'Mochi' });

const cat = db.prepare<{ id: number; name: string }>(
  'SELECT * FROM cats WHERE id = ?',
).get(1);
console.log(cat);
```

Save the code above as `main.ts` and run it with the environment grant scoped to
the path variable:

```sh
deno run --allow-env=DENO_SQLITE_PATH --allow-ffi main.ts
```

Deno requires unrestricted `--allow-ffi` for pointer access, even when
`DENO_SQLITE_PATH` selects one binary. A path-scoped FFI grant cannot run this
library. SQLite accesses database files through native code. Deno's `--allow-read` and
`--allow-write` flags do not restrict that native file access.

Use `close()` or `using` to release connections. Closing a connection finalizes
its statements and cancels pending backups. Statements also support
`Symbol.dispose` for early release. Iterators reset on completion, `return()`,
or early loop exit; dispose of an iterator before closing its database.
GC provides fallback cleanup, but it does not guarantee when cleanup runs.

### Transactions and integer values

```ts
import Database from '@bonakodo/sqlite';

using db = new Database(':memory:');
db.exec('CREATE TABLE items (value INTEGER)');
const insert = db.prepare('INSERT INTO items VALUES (?)');
const insertMany = db.transaction((values: bigint[]) => {
  for (const value of values) insert.run(value);
});
insertMany.immediate([42n, 9223372036854775807n]);
console.log(db.prepare('SELECT value FROM items').safeIntegers().pluck().all());
```

Transactions preserve the callback's arguments, return value, and `this`.
Each transaction and mode function exposes its owning connection through
readonly `.database`. The `.default`, `.deferred`, `.immediate`, and
`.exclusive` mode references are also readonly.
Nested transactions use savepoints. Callbacks must be synchronous; returned
promises cause rollback and a `TypeError`. Do not manually commit or roll back
inside a transaction callback.

Integers return as `number` by default, which can lose precision beyond the
JavaScript safe-integer range. Use statement `safeIntegers()` or database
`defaultSafeIntegers()` to return `bigint`. Bigint parameters must fit signed
64-bit integers. Text and blobs copy into SQLite when bound; returned blobs
and serialized database images own their bytes.

### Supported methods

| Area                 | API                                                               |
| -------------------- | ----------------------------------------------------------------- |
| Database             | `prepare`, `exec`, `pragma`, `explain`, `transaction`, `close`    |
| Database properties  | `name`, `open`, `memory`, `readonly`, `inTransaction`             |
| Statements           | `run`, `get`, `all`, `iterate`, `bind`, `toString`                |
| Result modes         | `pluck`, `raw`, `expand`, `columns`, `safeIntegers`               |
| Statement properties | `database`, `source`, `reader`, `readonly`, `busy`                |
| SQL callbacks        | `function`, `aggregate`, including moving windows via `inverse`   |
| Virtual tables       | `table` with a generator or a factory for `CREATE VIRTUAL TABLE`  |
| Database copies      | `serialize`, construction from `Uint8Array`, incremental `backup` |
| Other                | `loadExtension`, `defaultSafeIntegers`, `SqliteError`             |

`run()` returns `{ changes, lastInsertRowid }`; `get()` returns `undefined`
when no row matches. Anonymous parameters accept values and arrays; named
parameters accept objects without the `@`, `:`, or `$` prefix. Permanent
`bind()` prevents later rebinding. Result modes are mutually exclusive.
Positional arrays can be readonly, including query-builder arrays typed as
`readonly unknown[]`; each value still passes runtime validation. The test
suite checks Kysely 0.29.5's SQLite interface without adding a dependency.

Backups reject source and destination paths that SQLite's VFS reports as
identical, including relative paths and Unix symlinks. Hard links, case
aliases, and Windows symlinks can report different paths; choose a distinct
destination file. Backups keep retrying temporary lock conflicts and honor
progress callbacks that pause copying.

The callback, virtual-table, serialization, and backup examples are in
[examples/advanced.ts](examples/advanced.ts). Upstream method behavior is
described in the [better-sqlite3 13.0.3 API](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md).

### Compatibility and capabilities

- Binary inputs and outputs use `Uint8Array`, never Node `Buffer`. Use ESM
  imports and `new Database(...)`.
- `nativeBinding` is rejected. Select stock SQLite through `DENO_SQLITE_PATH`.
- `unsafeMode()` throws `NativeCapabilityError`. The package does not enable
  SQLite's defensive mode: portable variadic configuration calls require a
  helper binary, which this package does not ship.
- System SQLite versions and build options determine available SQL features,
  query plans, SQL error messages, and compile-time defaults. Foreign keys are
  enabled when a connection opens. Features such as FTS5 or math functions
  require a library compiled with those features.
- UTF-8 storage and ICU collation are separate features. Stock SQLite's
  `upper`, `lower`, and `LIKE` usually fold only ASCII characters. The source
  build does not enable ICU; explicitly load a matching ICU extension for
  Unicode case folding and locale-aware collations. SpatiaLite likewise
  requires an extension that matches the selected SQLite library.
- When a custom Linux SQLite library loads extensions that bring another
  SQLite build into the process, link it with `-Wl,-Bsymbolic-functions`.
  This keeps its internal calls within that library. Our Linux source build
  sets this flag; without it, loading SpatiaLite before the first query can
  route calls into a different SQLite build and crash.
- Optional native APIs are checked separately. Metadata, functions, windows,
  virtual tables, serialization, deserialization, extensions, and backup can
  be unavailable without preventing core queries. Missing metadata produces
  a capability error rather than guessed column origins.
- SQLite failures use `SqliteError.code` with the extended result-code name.
  API validation uses `TypeError` or `RangeError`. JavaScript callback failures
  retain the original thrown value. Host file errors and SQLite-version errors
  can differ from better-sqlite3's bundled engine.

Inspect or require capabilities explicitly:

```ts
import {
  initializeNative,
  nativeStatus,
} from '@bonakodo/sqlite/diagnostics.ts';

console.log(nativeStatus()); // Does not load a library.
console.log(initializeNative({ require: ['metadata', 'functions', 'backup'] }));
```

The diagnostics entry point also exports `NativeConfigError`, `NativeLoadError`,
`NativeCompatibilityError`, and `NativeCapabilityError`. The shared library
stays loaded for the lifetime of its isolate.

## Build from the submodule

Install a C compiler and make on Linux/macOS. On Windows, run from an x64 MSVC
Developer Command Prompt with `cl` and `nmake` available. No separate Tcl
installation is needed for the library build.

```sh
git submodule update --init --recursive
deno task build:native
```

The build prints the absolute library path. Build products stay in `build/`;
the SQLite submodule stays unchanged. The script uses upstream configure/make
on Unix and `Makefile.msc` on Windows. It enables column metadata, FTS5, RTree,
JSON, math functions, serialization, and extension loading.

Development tasks use `DENO_SQLITE_PATH` when set. Otherwise, `test`, `coverage`,
and `bench` build the pinned library and pass its path to their child process.
When testing an installed library, build the source once to generate the
headers needed by the C layout and extension tests.

## Tests and benchmarks

```sh
deno task check
deno task test
deno task test:compat
deno task coverage
deno task bench
deno task bench --filter 'prepared indexed lookup'
deno task bench --json
deno task bench:compare
deno task bench:compare --filter 'prepared indexed lookup'
deno task bench:compare --filter just-js
```

The tests include API validation, disk persistence, readonly files, WAL locks,
transactions, binary/integer boundaries, callbacks, virtual tables, backup,
GC cleanup, worker isolation, missing capabilities, permissions, and native
failure injection. C probes validate the structure offsets used by virtual
tables. Adapted compatibility cases retain their upstream notice in `NOTICE`.

Real ICU and SpatiaLite tests run separately with explicit library paths:

```sh
DENO_SQLITE_PATH=/absolute/path/to/libsqlite3.so \
DENO_SQLITE_ICU_PATH=/absolute/path/to/sqlite-icu.so \
DENO_SQLITE_SPATIALITE_PATH=/absolute/path/to/mod_spatialite.so \
deno task test:extensions
```

The task checks all three paths and does not install or discover extensions.
The [Linux extension CI job](.github/workflows/test.yml) shows how to build
`sqlite/ext/icu/icu.c` against installed ICU and install SpatiaLite explicitly.
These tests cover Unicode case mapping, Danish collation, spatial metadata,
geometry-column writes with `RETURNING`, and spatial queries against both
the pinned and system SQLite libraries.

`coverage` requires exactly **100% executable TypeScript source line coverage**
and writes `coverage/lcov.info`. It also reports branch and function coverage.
It does not measure SQLite C coverage or claim to replace SQLite's upstream
test suite. The frozen version-4 lockfile supports both Deno 2.0 and current
Deno without silently changing dependency versions.

Benchmarks use `Deno.bench` with prepared statements and an in-memory database.
They cover scalar reads, indexed lookup, 100-row collection and iteration,
1 KiB blobs, 100 updates per transaction, JavaScript SQL callbacks, and the
just-js prepared `PRAGMA user_version` read. Results
depend on the host, Deno version, and SQLite build; no timing threshold gates CI.

`bench:compare` runs the same eight workloads against this library,
`better-sqlite3` 13.0.3, and `@db/sqlite` 0.13.0, all under Deno. It uses a separate locked dependency setup
under `bench/`.

All eight cases share one database per library and the setup in
[bench/workloads.ts](bench/workloads.ts).

### Benchmark snapshot

Apple M1 Max, macOS arm64, Deno 2.9.6, SQLite 3.53.4; measured September 7, 2026.
Microseconds per operation, lower is faster:

| Workload                       | @bonakodo/sqlite | better-sqlite3 13.0.3 | @db/sqlite 0.13.0 |
| ------------------------------ | ---------------: | --------------------: | ----------------: |
| Prepared scalar read           |            0.073 |                 0.247 |             0.240 |
| Read 100 rows with `all()`     |           14.016 |                16.916 |            22.577 |
| 100 updates in one transaction |           49.019 |                75.579 |            93.779 |
| just-js prepared PRAGMA read   |            0.123 |                 0.290 |             0.286 |

The first three rows show the median of three run means. The just-js row records two runs of 10 rounds × 10 million calls per library in separate processes, with reversed library order:
**8.14 million calls/sec**, 2.36× faster than better-sqlite3 and 2.33× faster than
@db/sqlite. The current shared suite uses `Deno.bench` for all eight cases.
These are in-memory workloads, not disk or whole-application timings.

Prepared queries cache parameter layouts and result shapes while tracking
SQLite schema recompilation. Connections stay within one Deno isolate and use
`SQLITE_OPEN_NOMUTEX`; separate workers open separate connections.

GitHub Actions builds from the submodule on Linux/macOS x64 and arm64 and
Windows x64, tests Deno 2.0.0 and current stable, and includes Ubuntu/Homebrew
system-library jobs. CI also checks docs, coverage, and a benchmark smoke case.

## License

MIT for this package. SQLite is public domain. Adapted better-sqlite3
test behavior and Kysely type contract carry the upstream MIT notice in `NOTICE`.

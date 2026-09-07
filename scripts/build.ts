/** Build the pinned SQLite sources, without changing the submodule. */
import { filePath, root, run } from './common.ts';

export const libraryPath = filePath(
  new URL(
    `build/${
      Deno.build.os === 'windows'
        ? 'sqlite3.dll'
        : Deno.build.os === 'darwin'
        ? 'libsqlite3.dylib'
        : 'libsqlite3.so'
    }`,
    root,
  ),
);

export async function build(): Promise<void> {
  const cwd = filePath(new URL('build/', root));
  await Deno.mkdir(cwd, { recursive: true });
  const source = filePath(new URL('sqlite/', root));
  const flags = [
    'SQLITE_ENABLE_COLUMN_METADATA',
    'SQLITE_ENABLE_FTS5',
    'SQLITE_ENABLE_RTREE',
    'SQLITE_ENABLE_MATH_FUNCTIONS',
    'SQLITE_ENABLE_DBSTAT_VTAB',
    'SQLITE_ENABLE_SERIALIZE',
    'SQLITE_DEFAULT_FOREIGN_KEYS=1',
    'SQLITE_DQS=0',
  ].map((flag) => `-D${flag}`).join(' ');
  if (Deno.build.os === 'windows') {
    await run('nmake', [
      '/f',
      `${source}/Makefile.msc`,
      `TOP=${source}`,
      'sqlite3.dll',
      `OPTS=${flags}`,
    ], { cwd });
  } else {
    await run('sh', [
      `${source}/configure`,
      '--disable-tcl',
      '--fts5',
      '--rtree',
      '--column-metadata',
      `CFLAGS=-O2 -fPIC ${flags}`,
      // Extensions can load another SQLite globally. Keep this library's
      // internal function calls bound to its own implementation on ELF.
      ...(Deno.build.os === 'linux'
        ? ['LDFLAGS=-Wl,-Bsymbolic-functions']
        : []),
    ], { cwd });
    await run('make', [
      '-j',
      String(navigator.hardwareConcurrency),
      libraryPath.split('/').pop()!,
    ], { cwd });
  }
  console.log(`DENO_SQLITE_PATH=${libraryPath}`);
}
if (import.meta.main) await build();

import './setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import { createLoader, type LoaderRuntime } from '../src/native/loader.ts';
import { symbols } from '../src/native/symbols.ts';
import {
  NativeCapabilityError,
  NativeCompatibilityError,
  NativeConfigError,
  NativeLoadError,
} from '../src/native/errors.ts';
import { initializeNative, nativeStatus } from '../src/native/mod.ts';

Deno.test('native library reports the installed version and features', () => {
  const status = initializeNative({
    require: [
      'metadata',
      'functions',
      'windows',
      'tables',
      'serialize',
      'deserialize',
      'backup',
      'extensions',
    ],
  });
  assertEquals(status.state, 'loaded');
  assert(status.version);
  assertEquals(nativeStatus().path, Deno.env.get('DENO_SQLITE_PATH'));
});

function fixture(
  overrides: Partial<LoaderRuntime> = {},
  missing: string[] = [],
  version = 3053004,
) {
  let closes = 0;
  const fake: Record<string, (() => unknown) | null> = Object.fromEntries(
    Object.keys(symbols).map((key) => [
      key,
      missing.includes(key) ? null : () => 0,
    ]),
  );
  fake.sqlite3_libversion_number = () => version;
  fake.sqlite3_libversion = (() => Deno.UnsafePointer.create(1n)) as never;
  const loader = createLoader({
    os: 'linux',
    arch: 'x86_64',
    path: () => '/sqlite.so',
    string: () => '3.53.4',
    open: () => ({
      symbols: fake as never,
      close() {
        closes++;
      },
    }),
    ...overrides,
  });
  return { loader, symbols: fake, closes: () => closes };
}

Deno.test('loader initializes SQLite once and closes failed initialization', () => {
  const good = fixture();
  let initializes = 0;
  good.symbols.sqlite3_initialize = () => {
    initializes++;
    return 0;
  };
  assertEquals(good.loader.status().state, 'uninitialized');
  assertEquals(initializes, 0);
  assertEquals(good.loader.initialize().state, 'loaded');
  good.loader.initialize();
  good.loader.get();
  assertEquals(initializes, 1);
  assertEquals(good.closes(), 0);

  const failed = fixture();
  failed.symbols.sqlite3_initialize = () => 7;
  const error = assertThrows(
    () => failed.loader.initialize(),
    NativeLoadError,
    'SQLite initialization failed with error code 7',
  );
  assertEquals(failed.loader.status().state, 'failed');
  assertEquals(failed.loader.status().error, error);
  assertEquals(failed.loader.status().capabilities, {});
  assertEquals(failed.closes(), 1);
  assertEquals(assertThrows(() => failed.loader.get()), error);
  assertEquals(failed.closes(), 1);

  const missing = fixture({}, ['sqlite3_initialize']);
  assertThrows(
    () => missing.loader.initialize(),
    NativeCompatibilityError,
    'sqlite3_initialize',
  );
  assertEquals(missing.closes(), 1);
});

Deno.test('loader validates configuration and caches failures', () => {
  for (const value of [undefined, '', 'auto', './lib.so', '/x\0']) {
    const { loader } = fixture({ path: () => value });
    assertEquals(loader.status().state, 'uninitialized');
    const error = assertThrows(() => loader.initialize(), NativeConfigError);
    assertEquals(assertThrows(() => loader.initialize()), error);
    assertEquals(loader.status().state, 'failed');
  }
  for (
    const [os, arch] of [['freebsd', 'x86_64'], ['linux', 'x86'], [
      'windows',
      'aarch64',
    ]] as const
  ) {
    assertThrows(
      () => fixture({ os, arch }).loader.initialize(),
      NativeConfigError,
    );
  }
  assertThrows(() =>
    fixture({
      path() {
        throw new Error('permission');
      },
    }).loader.initialize(), NativeConfigError);
  assertThrows(() =>
    fixture({
      open() {
        throw new Error('dlopen');
      },
    }).loader.initialize(), NativeLoadError);
  const bad = fixture({}, ['sqlite3_step']);
  assertThrows(() =>
    fixture({
      string() {
        throw new Error('pointer permission');
      },
    }).loader.initialize(), NativeLoadError);
  assertThrows(() => bad.loader.initialize(), NativeCompatibilityError);
  assertEquals(bad.closes(), 1);
  assertThrows(
    () => fixture({}, [], 3034000).loader.initialize(),
    NativeCompatibilityError,
  );
});

Deno.test('loader checks optional features without poisoning core', () => {
  const { loader } = fixture({}, [
    'sqlite3_column_table_name',
    'sqlite3_value_type',
    'sqlite3_db_filename',
  ]);
  assertEquals(loader.initialize().capabilities.metadata, false);
  assertThrows(
    () => loader.initialize({ require: ['metadata'] }),
    NativeCapabilityError,
  );
  assertEquals(loader.status().state, 'loaded');
  assertEquals(loader.status().capabilities.windows, false);
  assertEquals(loader.status().capabilities.tables, false);
  assertEquals(loader.status().capabilities.backup, false);
  assertThrows(
    () => loader.initialize({ require: ['backup'] }),
    NativeCapabilityError,
  );
  assert(loader.get().sqlite3_step);
  for (
    const path of ['C:\\SQLite\\sqlite3.dll', '\\\\server\\share\\sqlite3.dll']
  ) {
    assertEquals(
      fixture({ os: 'windows', path: () => path }).loader.initialize().path,
      path,
    );
  }
});

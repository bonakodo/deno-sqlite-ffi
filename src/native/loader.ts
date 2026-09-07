import {
  NativeCapabilityError,
  NativeCompatibilityError,
  NativeConfigError,
  NativeLoadError,
} from './errors.ts';
import { type Capability, groups, type Symbols, symbols } from './symbols.ts';

/** Snapshot of the current isolate's native library. */
export interface NativeStatus {
  /** Loading state; inspecting status does not load SQLite. */
  readonly state: 'uninitialized' | 'loaded' | 'failed';
  /** Absolute path selected from DENO_SQLITE_PATH. */
  readonly path: string | null;
  /** SQLite version, once loaded. */
  readonly version: string | null;
  /** Features detected from complete symbol groups. */
  readonly capabilities: Readonly<Partial<Record<Capability, boolean>>>;
  /** Last initialization failure, if any. */
  readonly error: Error | null;
}
/** Features which must be available when initialization returns. */
export interface NativeInitializationOptions {
  /** Required optional features. */
  require?: readonly Capability[];
}
export interface LoaderRuntime {
  os: string;
  arch: string;
  path(): string | undefined;
  open(
    path: string,
  ): Pick<Deno.DynamicLibrary<typeof symbols>, 'symbols' | 'close'>;
  string(pointer: Deno.PointerObject): string;
}
export function createLoader(runtime: LoaderRuntime) {
  let state: NativeStatus = {
    state: 'uninitialized',
    path: null,
    version: null,
    capabilities: {},
    error: null,
  };
  let handle: ReturnType<LoaderRuntime['open']> | undefined;
  function initialize(options: NativeInitializationOptions = {}): NativeStatus {
    if (state.state === 'failed') throw state.error;
    if (state.state === 'uninitialized') {
      try {
        if (
          !['linux', 'darwin', 'windows'].includes(runtime.os) ||
          !['x86_64', 'aarch64'].includes(runtime.arch) ||
          (runtime.os === 'windows' && runtime.arch !== 'x86_64')
        ) {
          throw new NativeConfigError(
            'Unsupported operating system or architecture',
          );
        }
        let path: string | undefined;
        try {
          path = runtime.path();
        } catch (cause) {
          throw new NativeConfigError('Allow --allow-env=DENO_SQLITE_PATH', {
            cause,
          });
        }
        const absolute = runtime.os === 'windows'
          ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path ?? '')
          : path?.startsWith('/');
        if (!path || path.includes('\0') || !absolute) {
          throw new NativeConfigError(
            'DENO_SQLITE_PATH must be an absolute library path',
          );
        }
        state = { ...state, path };
        try {
          handle = runtime.open(path);
        } catch (cause) {
          throw new NativeLoadError(
            `Cannot load SQLite at ${path}; check the file, architecture, and --allow-ffi permission`,
            { cause },
          );
        }
        const optional = new Set<string>([
          ...Object.values(groups).flat(),
          'sqlite3_compileoption_get',
        ]);
        const missing = Object.keys(symbols).filter((key) =>
          !optional.has(key) && !handle!.symbols[key as keyof typeof symbols]
        );
        if (missing.length) {
          throw new NativeCompatibilityError(
            `Missing SQLite core symbols: ${missing.join(', ')}`,
          );
        }
        if (handle.symbols.sqlite3_libversion_number!() < 3035000) {
          throw new NativeCompatibilityError(
            'SQLite 3.35.0 or newer is required',
          );
        }
        let version: string;
        try {
          version = runtime.string(handle.symbols.sqlite3_libversion!()!);
        } catch (cause) {
          throw new NativeLoadError(
            'SQLite pointer access requires unrestricted --allow-ffi; a path-scoped grant is insufficient',
            { cause },
          );
        }
        const capabilities = Object.fromEntries(
          Object.entries(groups).map((
            [name, keys],
          ) => [name, keys.every((key) => handle!.symbols[key] !== null)]),
        ) as Record<Capability, boolean>;
        capabilities.windows &&= capabilities.functions;
        capabilities.tables &&= capabilities.functions;
        // Stock builds can disable automatic initialization. This call is
        // harmless when another isolate or application has initialized SQLite.
        const rc = handle.symbols.sqlite3_initialize!();
        if (rc !== 0) {
          throw new NativeLoadError(
            `SQLite initialization failed with error code ${rc}`,
          );
        }
        state = {
          ...state,
          state: 'loaded',
          version,
          capabilities,
          error: null,
        };
      } catch (error) {
        handle?.close();
        handle = undefined;
        state = { ...state, state: 'failed', error: error as Error };
        throw error;
      }
    }
    for (const capability of options.require ?? []) {
      if (!state.capabilities[capability]) {
        throw new NativeCapabilityError(capability);
      }
    }
    return status();
  }
  function status(): NativeStatus {
    return { ...state, capabilities: { ...state.capabilities } };
  }
  return {
    initialize,
    status,
    get: (): Symbols => {
      initialize();
      return handle!.symbols as Symbols;
    },
  };
}
const loader = createLoader({
  os: Deno.build.os,
  arch: Deno.build.arch,
  path: () => Deno.env.get('DENO_SQLITE_PATH'),
  open: (path) => Deno.dlopen(path, symbols),
  string: (pointer) => Deno.UnsafePointerView.getCString(pointer),
});
/**
 * Load and validate the user-selected SQLite library. No download occurs.
 *
 * Reads the absolute path from `DENO_SQLITE_PATH` on first use. Requires
 * `--allow-env=DENO_SQLITE_PATH` and unrestricted `--allow-ffi`.
 * Later calls reuse the loaded library; loading failures persist for the
 * current isolate. A missing optional capability does not unload the library.
 *
 * @param options Optional capabilities to require in addition to core SQLite.
 * @returns A snapshot of the loaded library and its capabilities.
 * @throws {NativeConfigError} If the platform, path, or environment access is invalid.
 * @throws {NativeLoadError} If Deno cannot load or initialize the library.
 * @throws {NativeCompatibilityError} If core symbols or SQLite 3.35.0 are missing.
 * @throws {NativeCapabilityError} If a requested optional capability is absent.
 */
export function initializeNative(
  options?: NativeInitializationOptions,
): NativeStatus {
  return loader.initialize(options);
}
/**
 * Inspect native status without loading the library or reading the environment.
 * This call needs no permissions.
 *
 * @returns A snapshot with a separate capabilities map. Changing the snapshot
 * does not change the loader's state.
 */
export function nativeStatus(): NativeStatus {
  return loader.status();
}
export function native(): Symbols {
  return loader.get();
}
export function requireCapability(capability: Capability): void {
  initializeNative({ require: [capability] });
}

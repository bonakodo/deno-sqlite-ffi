/**
 * Explicit initialization and diagnostics for a user-installed SQLite library.
 *
 * Use {@link nativeStatus} to inspect the loader without loading SQLite.
 * Use {@link initializeNative} to check required capabilities before opening a
 * database. Each Deno worker has its own loader state.
 *
 * @example
 * ```ts
 * import { initializeNative } from '@bonakodo/sqlite/diagnostics.ts';
 *
 * const status = initializeNative({ require: ['serialize', 'backup'] });
 * console.assert(status.state === 'loaded');
 * console.assert(status.capabilities.serialize === true);
 * ```
 * @module
 */
export { initializeNative, nativeStatus } from './loader.ts';
export type { NativeInitializationOptions, NativeStatus } from './loader.ts';
export type { Capability } from './symbols.ts';
export {
  NativeCapabilityError,
  NativeCompatibilityError,
  NativeConfigError,
  NativeLoadError,
} from './errors.ts';

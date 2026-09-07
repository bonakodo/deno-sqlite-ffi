/** Run real extension regressions with explicitly supplied native libraries. */
import { run } from './common.ts';

const names = [
  'DENO_SQLITE_PATH',
  'DENO_SQLITE_ICU_PATH',
  'DENO_SQLITE_SPATIALITE_PATH',
] as const;
const env: Record<string, string> = {};
for (const name of names) {
  const path = Deno.env.get(name);
  const absolute = Deno.build.os === 'windows'
    ? /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])/i
    : /^\//;
  if (!path || !absolute.test(path) || path.includes('\0')) {
    throw new TypeError(`${name} must be an absolute native library path`);
  }
  env[name] = path;
}
await run(Deno.execPath(), [
  'test',
  '--allow-ffi',
  `--allow-env=${names.join(',')}`,
  ...Deno.args,
  'test/extensions_test.ts',
], { env });

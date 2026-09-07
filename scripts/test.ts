import { build, libraryPath } from './build.ts';
import { run } from './common.ts';
const path = Deno.env.get('DENO_SQLITE_PATH');
if (!path) await build();
await run(Deno.execPath(), [
  'test',
  '--ignore=test/extensions_test.ts',
  '--allow-ffi',
  '--allow-env=DENO_SQLITE_PATH',
  '--allow-read',
  '--allow-write',
  '--allow-run',
  ...Deno.args,
], { env: { DENO_SQLITE_PATH: path ?? libraryPath } });

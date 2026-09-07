import { build, libraryPath } from './build.ts';
import { run } from './common.ts';
const path = Deno.env.get('DENO_SQLITE_PATH');
const compare = Deno.args[0] === '--compare';
if (!path) await build();
await run(Deno.execPath(), [
  'bench',
  '--allow-ffi',
  ...(compare
    ? [
      '--config=bench/deno.jsonc',
      '--allow-read',
      '--allow-env',
    ]
    : ['--config=deno.jsonc', '--allow-env=DENO_SQLITE_PATH']),
  ...Deno.args.slice(compare ? 1 : 0),
  compare ? 'bench/compare_bench.ts' : 'bench/sqlite_bench.ts',
], { env: { DENO_SQLITE_PATH: path ?? libraryPath } });

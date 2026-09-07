import { build, libraryPath } from './build.ts';
import { run } from './common.ts';

const deno = Deno.execPath();
await run(deno, ['fmt', '--check']);
await run(deno, ['lint']);
const entrypoints = ['src/mod.ts', 'src/native/mod.ts'];
await run(deno, [
  'check',
  ...entrypoints,
  ...[...Deno.readDirSync('scripts')].filter((entry) =>
    entry.name.endsWith('.ts')
  ).map((entry) => `scripts/${entry.name}`),
  'examples/basic.ts',
  'examples/advanced.ts',
  'bench/sqlite_bench.ts',
]);
await run(deno, ['doc', '--lint', ...entrypoints]);
const docConfig = '--config=scripts/deno.doc.jsonc';
// Deno does not discover examples on classes re-exported by an entry point.
const docSources = [
  ...entrypoints,
  'src/api/database.ts',
  'src/api/statement.ts',
];
await run(deno, ['check', '--doc', docConfig, ...docSources]);
const path = Deno.env.get('DENO_SQLITE_PATH');
if (!path) await build();
const env = { DENO_SQLITE_PATH: path ?? libraryPath };
const permissions = [
  '--allow-env=DENO_SQLITE_PATH',
  '--allow-ffi',
];
await run(deno, ['test', '--doc', docConfig, ...permissions, ...docSources], {
  env,
});
for (const example of ['examples/basic.ts', 'examples/advanced.ts']) {
  await run(deno, ['run', ...permissions, example], { env });
}

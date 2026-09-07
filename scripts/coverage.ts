/** Collect real integration and native-failure coverage and enforce every source line. */
import { build, libraryPath } from './build.ts';
import { filePath, root, run } from './common.ts';

const path = Deno.env.get('DENO_SQLITE_PATH');
if (!path) await build();
const directory = filePath(new URL('coverage/', root));
await Deno.mkdir(directory, { recursive: true });
const raw = await Deno.makeTempDir({ prefix: 'sqlite-coverage-' });
try {
  await run(Deno.execPath(), [
    'test',
    '--ignore=test/extensions_test.ts',
    '--allow-ffi',
    '--allow-env=DENO_SQLITE_PATH',
    '--allow-read',
    '--allow-write',
    '--allow-run',
    `--coverage=${raw}`,
  ], { env: { DENO_SQLITE_PATH: path ?? libraryPath } });
  const include = '/src/';
  await run(Deno.execPath(), ['coverage', `--include=${include}`, raw]);
  const report = await new Deno.Command(Deno.execPath(), {
    args: ['coverage', '--lcov', `--include=${include}`, raw],
    stdout: 'piped',
    stderr: 'inherit',
  }).output();
  if (!report.success) throw new Error('Coverage report failed');
  const lcov = new TextDecoder().decode(report.stdout);
  await Deno.writeTextFile(`${directory}/lcov.info`, lcov);
  const total = [...lcov.matchAll(/^LF:(\d+)$/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  const covered = [...lcov.matchAll(/^LH:(\d+)$/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  if (!total || covered !== total) {
    throw new Error(`Source line coverage must be 100%: ${covered}/${total}`);
  }
  console.log(
    `Source line coverage: 100% (${covered}/${total}). SQLite C coverage is not measured by Deno.`,
  );
} finally {
  await Deno.remove(raw, { recursive: true });
}

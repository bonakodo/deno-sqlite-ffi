/** Required development verification: never skip absent proofs or use stale traces. */
import { build, libraryPath } from './build.ts';
import { filePath, root, run } from './common.ts';
import { checkProofMutants } from './verification_negative.ts';

const mode = Deno.args[0] ?? 'all';
if (!['all', 'proofs', 'model', 'negative', 'replay'].includes(mode)) {
  throw new Error(`Unknown verification mode: ${mode}`);
}
const project = filePath(new URL('verification/lean/', root));
const localBin = filePath(new URL('build/lean-toolchain/bin/', root));
const suffix = Deno.build.os === 'windows' ? '.exe' : '';
let bin = Deno.env.get('LEAN_BIN');
if (!bin) {
  try {
    await Deno.stat(`${localBin}/lean${suffix}`);
    bin = localBin;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
const lean = bin ? `${bin}/lean${suffix}` : `lean${suffix}`;
const lake = bin ? `${bin}/lake${suffix}` : `lake${suffix}`;
const env = {
  PATH: bin
    ? `${bin}${Deno.build.os === 'windows' ? ';' : ':'}${
      Deno.env.get('PATH') ?? ''
    }`
    : Deno.env.get('PATH') ?? '',
};
let version: Deno.CommandOutput;
try {
  version = await new Deno.Command(lean, {
    args: ['--version'],
    cwd: project,
    env,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
} catch (error) {
  throw new Error(
    'Lean is required. Run deno task verify:install or set LEAN_BIN to the pinned toolchain bin directory.',
    { cause: error },
  );
}
const pin = (await Deno.readTextFile(`${project}/lean-toolchain`)).trim();
const expected = pin.split(':v')[1];
const actual = new TextDecoder().decode(version.stdout);
if (
  !version.success || !expected ||
  !actual.startsWith(`Lean (version ${expected},`)
) {
  throw new Error(
    `Required ${pin}; got ${
      actual.trim() || new TextDecoder().decode(version.stderr)
    }`,
  );
}
console.log(actual.trim());
// Clean every time: a checked-in trace or an old executable cannot satisfy this job.
await run(lake, ['clean'], { cwd: project, env });
await run(lake, ['build'], { cwd: project, env });
const audit = await new Deno.Command(lake, {
  args: ['env', 'lean', 'Audit.lean'],
  cwd: project,
  env,
  stdout: 'piped',
  stderr: 'piped',
}).output();
const auditText = new TextDecoder().decode(audit.stdout);
console.log(auditText.trim());
if (!audit.success) {
  throw new Error(new TextDecoder().decode(audit.stderr) || auditText);
}
const names = [
  'initial_invariant',
  'transition_preserves',
  'finite_preservation',
  'allocation_finalize_at_most_once',
  'no_use_after_finalize',
  'iterator_count_matches_owners',
  'iterator_release_once',
  'guard_clears',
  'reentry_preserves',
  'cleanup_releases',
  'reachable_allocation_safety',
  'iterator_count_is_handle_count',
  'repeated_return_preserves',
  'operation_guard_clears',
  'address_reuse_reachable',
  'failed_row_releases_reachable',
  'busy_rejection_reachable',
  'partial_prepare_reachable',
  'callback_reentry_success_reachable',
  'callback_throw_reachable',
  'busy_close_preserves',
  'busy_statement_preserves',
  'statement_cleanup_releases',
  'repeated_dispose_preserves',
  'reset_reentry_observes_released_owner',
];
for (const name of names) {
  const line = auditText.split('\n').find((line) =>
    line.startsWith(`'Lifecycle.${name}' `)
  );
  if (!line) throw new Error(`Missing theorem axiom audit: ${name}`);
  if (line.includes('does not depend on any axioms')) continue;
  const dependencies = line.match(/depends on axioms: \[(.*)\]/)?.[1];
  if (dependencies === undefined) {
    throw new Error(`Unexpected axiom audit output: ${line}`);
  }
  for (
    const axiom of dependencies.split(',').map((part) => part.trim()).filter(
      Boolean,
    )
  ) {
    if (!['propext', 'Classical.choice', 'Quot.sound'].includes(axiom)) {
      throw new Error(`Unexpected axiom in ${name}: ${axiom}`);
    }
  }
}
if (mode !== 'proofs') {
  if (mode === 'all' || mode === 'negative') {
    await checkProofMutants(lake, project, env);
  }
  const path = Deno.env.get('DENO_SQLITE_PATH');
  if (!path) await build();
  const modelEnv = {
    ...env,
    DENO_SQLITE_PATH: path ?? libraryPath,
    LEAN_LIFECYCLE: `${project}/.lake/build/bin/lifecycle${suffix}`,
  };
  const commands = mode === 'all'
    ? [['run'], ['negative']]
    : mode === 'model'
    ? [['run', ...Deno.args.slice(1)]]
    : [[mode, ...Deno.args.slice(1)]];
  for (const args of commands) {
    await run(Deno.execPath(), [
      'run',
      '-A',
      'verification/model/main.ts',
      ...args,
    ], { env: modelEnv });
  }
}

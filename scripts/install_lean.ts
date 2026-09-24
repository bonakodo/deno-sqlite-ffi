/** Install the pinned development toolchain locally; do not edit shell settings. */
import { filePath, root, run } from './common.ts';

const version = '4.28.0';
if (Deno.args.length > 1) {
  throw new Error('Usage: deno task verify:install [cached-release-archive]');
}
const releases: Record<string, { platform: string; sha256: string }> = {
  'darwin-aarch64': {
    platform: 'darwin_aarch64',
    sha256: '61942f9d1907db918020154a517c87fb64841e48cebb0032fc0909df8d189a05',
  },
  'darwin-x86_64': {
    platform: 'darwin',
    sha256: '4c97da10a926d906adf33fc998a2546a4103ea0cdf995cecefc1baa31fedc008',
  },
  'linux-x86_64': {
    platform: 'linux',
    sha256: 'ceb3a3f844f7aebf63245e2b51c28d5b0ed38942c19f93cf3febd520302160bd',
  },
  'linux-aarch64': {
    platform: 'linux_aarch64',
    sha256: 'c865801261c747d4f15d08beca9abc20aca907904abbb284de25a37f4b4558bc',
  },
};
const release = releases[`${Deno.build.os}-${Deno.build.arch}`];
if (!release) {
  throw new Error(
    'Install Lean 4.28.0 manually on this platform; see verification/README.md',
  );
}
const pin =
  (await Deno.readTextFile(new URL('verification/lean/lean-toolchain', root)))
    .trim();
if (pin !== `leanprover/lean4:v${version}`) {
  throw new Error(
    'Update the installer version and release hashes to match lean-toolchain',
  );
}
const name = `lean-${version}-${release.platform}`;
const target = filePath(new URL('build/lean-toolchain/', root));
try {
  await Deno.stat(target);
  throw new Error(
    `Toolchain directory already exists: ${target}. Remove it explicitly to reinstall.`,
  );
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await Deno.mkdir(new URL('build/', root), { recursive: true });
const temp = await Deno.makeTempDir({
  dir: filePath(new URL('build/', root)),
  prefix: 'lean-install-',
});
try {
  const archive = `${temp}/${name}.tar.zst`;
  if (Deno.args[0]) {
    await Deno.copyFile(Deno.args[0], archive);
  } else {await run('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--connect-timeout',
      '30',
      '--max-time',
      '900',
      '--output',
      archive,
      `https://github.com/leanprover/lean4/releases/download/v${version}/${name}.tar.zst`,
    ]);}
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(archive)),
  );
  const actual = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== release.sha256) {
    throw new Error(`Lean archive SHA-256 mismatch: ${actual}`);
  }
  await run('tar', ['--zstd', '-xf', archive, '-C', temp]);
  await Deno.rename(`${temp}/${name}`, target);
  await run(`${target}/bin/lean`, ['--version']);
  console.log(`Installed pinned Lean in ${target}`);
} finally {
  await Deno.remove(temp, { recursive: true });
}

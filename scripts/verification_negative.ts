/** Compile isolated broken models; a successful build is a failed negative control. */
import { filePath, root } from './common.ts';

async function copySource(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.name === '.lake') continue;
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copySource(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

export async function checkProofMutants(
  lake: string,
  project: string,
  env: Record<string, string>,
): Promise<void> {
  const output = filePath(new URL('build/verification-controls/', root));
  await Deno.mkdir(output, { recursive: true });
  const mutations = [
    {
      name: 'missing-iterator-release',
      from: '(calls ++ [.reset]) outcome (-1)',
      to: '(calls ++ [.reset]) outcome 0',
    },
    {
      name: 'repeated-finalization',
      from: 'return record id { c with live := false } [.finalize] "disposed"',
      to:
        'return record id { c with live := false } [.finalize, .finalize] "disposed"',
    },
  ];
  for (const mutation of mutations) {
    const temp = await Deno.makeTempDir({
      dir: output,
      prefix: `${mutation.name}-`,
    });
    try {
      await copySource(project, temp);
      const path = `${temp}/Lifecycle/Model.lean`;
      const source = await Deno.readTextFile(path);
      if (source.split(mutation.from).length !== 2) {
        throw new Error(
          `Negative control must change exactly one expression: ${mutation.name}`,
        );
      }
      await Deno.writeTextFile(
        path,
        source.replace(mutation.from, mutation.to),
      );
      const result = await new Deno.Command(lake, {
        args: ['build'],
        cwd: temp,
        env,
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      const log = new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);
      await Deno.writeTextFile(`${output}/${mutation.name}.log`, log);
      if (
        result.success || !log.includes('Proofs.lean') ||
        !log.includes('unsolved goals')
      ) {
        throw new Error(
          `Expected a failed lifecycle proof for ${mutation.name}, got exit ${result.code}:\n${log}`,
        );
      }
      console.log(`Lean negative control rejected ${mutation.name}`);
    } finally {
      await Deno.remove(temp, { recursive: true });
    }
  }
}

import { assert } from '@std/assert';

Deno.test('bound data and explicit close remain safe through garbage collection', async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--v8-flags=--expose-gc',
      '--allow-ffi',
      '--allow-env=DENO_SQLITE_PATH',
      'test/fixtures/ownership.ts',
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const result = await child.output();
    assert(result.success, new TextDecoder().decode(result.stderr));
  } finally {
    clearTimeout(timer);
  }
});

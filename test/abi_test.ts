import './setup.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';
import Database from '../src/mod.ts';
import { libraryPath } from '../scripts/build.ts';
import { filePath, root, run } from '../scripts/common.ts';
import { layout } from '../src/api/tables.ts';

async function compile(
  name: string,
  directory: string,
  shared = true,
  defines: string[] = [],
): Promise<string> {
  const windows = Deno.build.os === 'windows';
  const source = filePath(new URL(`test/fixtures/${name}.c`, root));
  const out = `${directory}/${name}${
    shared
      ? windows ? '.dll' : Deno.build.os === 'darwin' ? '.dylib' : '.so'
      : windows
      ? '.exe'
      : ''
  }`;
  const include = filePath(new URL('build/', root));
  await run(
    windows ? 'cl' : 'cc',
    windows
      ? [
        '/nologo',
        ...defines.map((define) => `/D${define}`),
        ...(shared ? ['/LD'] : []),
        `/I${include}`,
        source,
        `/Fe:${out}`,
      ]
      : [
        ...(shared
          ? [Deno.build.os === 'darwin' ? '-dynamiclib' : '-shared', '-fPIC']
          : []),
        ...defines.map((define) => `-D${define}`),
        '-I',
        include,
        source,
        '-o',
        out,
      ],
    { cwd: directory },
  );
  return out;
}

Deno.test('C compiler verifies every virtual-table structure layout', async () => {
  assertEquals(layout, {
    module: 200,
    vtab: 24,
    cursor: 8,
    index: 96,
    constraint: 12,
    usage: 8,
  });
  const dir = await Deno.makeTempDir();
  try {
    await run(await compile('layout', dir, false), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('native extension loading and entry point errors', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const extension = await compile('extension', dir);
    using db = new Database(':memory:');
    // Loader messages vary by OS and locale; Windows omits the symbol name.
    const error = assertThrows(
      () => db.loadExtension(extension, 'absent'),
      Database.SqliteError,
    );
    assertEquals(error.code, 'SQLITE_ERROR');
    assert(error.message.length > 0);
    db.loadExtension(extension);
    assertEquals(db.prepare('SELECT extension_answer()').pluck().get(), 42);
    using second = new Database(':memory:');
    second.loadExtension(extension, 'sqlite3_extension_init');
    assertEquals(second.prepare('SELECT extension_answer()').pluck().get(), 42);
    assertThrows(() => db.loadExtension(`${dir}/absent`));
    assertThrows(() => db.loadExtension(extension, ''), TypeError);
    assertThrows(
      () => db.prepare('SELECT load_extension(?)').get(extension),
      Error,
      'not authorized',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('subprocess imports, permission failures, and incomplete native library', async () => {
  const dir = await Deno.makeTempDir();
  const diagnostics = new URL('src/native/mod.ts', root).href;
  const module = new URL('src/mod.ts', root).href;
  try {
    const path = await compile('incomplete', dir);
    const script = `${dir}/probe.ts`;
    const scenarios = [
      {
        args: [] as string[],
        body: `await import(${JSON.stringify(module)}); if ((await import(${
          JSON.stringify(diagnostics)
        })).nativeStatus().state !== 'uninitialized') throw Error('eager load');`,
      },
      {
        args: ['--allow-env=DENO_SQLITE_PATH'],
        error: 'NativeLoadError',
        path: Deno.env.get('DENO_SQLITE_PATH')!,
      },
      {
        args: [
          '--allow-env=DENO_SQLITE_PATH',
          `--allow-ffi=${Deno.env.get('DENO_SQLITE_PATH')!}`,
        ],
        error: 'NativeLoadError',
        path: Deno.env.get('DENO_SQLITE_PATH')!,
      },
      { args: [], error: 'NativeConfigError', path },
      {
        args: ['--allow-env=DENO_SQLITE_PATH', '--allow-ffi'],
        error: 'NativeCompatibilityError',
        path,
      },
    ];
    for (const scenario of scenarios) {
      await Deno.writeTextFile(
        script,
        scenario.body ??
          `import { initializeNative } from ${
            JSON.stringify(diagnostics)
          }; try { initializeNative(); throw Error('unexpected success'); } catch (error) { if (error.name !== ${
            JSON.stringify(scenario.error)
          }) throw error; }`,
      );
      const result = await new Deno.Command(Deno.execPath(), {
        args: ['run', '--no-config', '--no-prompt', ...scenario.args, script],
        env: { DENO_SQLITE_PATH: scenario.path ?? path },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('stock OMIT_AUTOINIT library initializes before its first query', async () => {
  const dir = await Deno.makeTempDir();
  const module = new URL('src/mod.ts', root).href;
  const diagnostics = new URL('src/native/mod.ts', root).href;
  try {
    const script = `${dir}/probe.ts`;
    for (const fail of [false, true]) {
      const path = await compile(
        'initialization',
        dir,
        true,
        fail ? ['SQLITE_TEST_INITIALIZE_FAIL'] : [],
      );
      await Deno.writeTextFile(
        script,
        `import Database from ${JSON.stringify(module)};
import { initializeNative, nativeStatus, NativeLoadError } from ${
          JSON.stringify(diagnostics)
        };
if (nativeStatus().state !== 'uninitialized') throw Error('eager load');
${
          fail
            ? `let failure;
try { initializeNative(); } catch (error) { failure = error; }
if (!(failure instanceof NativeLoadError) || !failure.message.includes('error code 7')) throw Error('missing initialization error');
if (nativeStatus().state !== 'failed') throw Error('incorrect failed status');
try { new Database(':memory:'); throw Error('unexpected retry'); } catch (error) { if (error !== failure) throw error; }`
            : `if (initializeNative().state !== 'loaded') throw Error('not loaded');
using db = new Database(':memory:');
if (db.prepare('SELECT 1').pluck().get() !== 1) throw Error('query failed');
if (initializeNative().state !== 'loaded') throw Error('reload failed');`
        }`,
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--no-config',
          '--no-prompt',
          '--allow-env=DENO_SQLITE_PATH',
          '--allow-ffi',
          script,
        ],
        env: { DENO_SQLITE_PATH: path },
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const result = await child.output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    'source ELF library keeps its internal calls when an extension exports SQLite symbols',
  // This regression checks the linker flag on our source build. System SQLite
  // may use other binding rules; macOS and Windows do not use ELF lookup.
  ignore: Deno.build.os !== 'linux',
  async fn() {
    const dir = await Deno.makeTempDir();
    const module = new URL('src/mod.ts', root).href;
    try {
      const extension = await compile('symbol_collision', dir);
      const script = `${dir}/probe.ts`;
      await Deno.writeTextFile(
        script,
        `import Database from ${JSON.stringify(module)};
using db = new Database(':memory:');
db.loadExtension(${JSON.stringify(extension)});
db.exec('CREATE TABLE kept(value); INSERT INTO kept VALUES (42)');
if (db.prepare('SELECT value FROM kept').pluck().get() !== 42) throw Error('wrong query result');`,
      );
      // Do not warm up schema queries before loading the extension: a resolved
      // lazy symbol would hide the missing ELF linker protection.
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--no-config',
          '--no-prompt',
          '--allow-env=DENO_SQLITE_PATH',
          '--allow-ffi',
          script,
        ],
        env: { DENO_SQLITE_PATH: libraryPath },
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const result = await child.output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('runtime dependency graph contains no Node or npm imports', async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ['info', '--json', 'src/mod.ts'],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  assert(result.success);
  const graph = JSON.parse(new TextDecoder().decode(result.stdout));
  for (const module of graph.modules) {
    assert(!/^(node:|npm:)/.test(module.specifier), module.specifier);
  }
});

Deno.test('garbage collection releases abandoned native resources', async () => {
  await run(Deno.execPath(), [
    'run',
    '--v8-flags=--expose-gc',
    '--allow-ffi',
    '--allow-env=DENO_SQLITE_PATH',
    'test/fixtures/gc.ts',
  ]);
});

Deno.test('workers own separate connections and callbacks', async () => {
  const workers = [1, 2].map(() =>
    new Worker(new URL('./fixtures/worker.ts', import.meta.url), {
      type: 'module',
    })
  );
  try {
    const rows = await Promise.all(
      workers.map((worker, i) =>
        new Promise((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => {
            event.preventDefault();
            reject(new Error(event.message));
          };
          worker.postMessage(i + 1);
        })
      ),
    );
    assertEquals(rows, [{ value: 2 }, { value: 4 }]);
  } finally {
    for (const worker of workers) worker.terminate();
  }
});

import '../setup.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import Database, { SqliteError } from '../../src/mod.ts';

async function rejectsSameFile(
  db: Database,
  destination: string,
  attached = 'main',
): Promise<void> {
  let progressCalls = 0;
  // Bound this regression so a repeated SQLITE_BUSY never hangs the suite.
  const timer = setTimeout(() => db.close(), 5000);
  try {
    const error = await assertRejects(
      () =>
        db.backup(destination, {
          attached,
          progress() {
            progressCalls++;
          },
        }),
      SqliteError,
      'Backup source and destination must be distinct files',
    );
    assertEquals(error.code, 'SQLITE_ERROR');
    assertEquals(progressCalls, 0);
    assert(db.open);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test('backup rejects identical and relative source paths without changing data', async () => {
  const directory = await Deno.makeTempDir({ dir: '.' });
  const absolute = await Deno.realPath(directory);
  try {
    using db = new Database(`${absolute}/source.db`);
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42)');
    for (
      const destination of [
        `${absolute}/source.db`,
        `${directory}/source.db`,
        `${absolute}/./source.db`,
        `  ${absolute}/source.db  `,
      ]
    ) {
      await rejectsSameFile(db, destination);
      assertEquals(db.prepare('SELECT x FROM t').pluck().get(), 42);
    }
    using readonly = new Database(`${absolute}/source.db`, { readonly: true });
    await rejectsSameFile(readonly, `${absolute}/source.db`);

    await db.backup(`${absolute}/copy.db`);
    using copy = new Database(`${absolute}/copy.db`);
    assertEquals(copy.prepare('SELECT x FROM t').pluck().get(), 42);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: 'backup rejects Unix VFS symlink aliases of the source',
  // Windows uses GetFullPathName, which does not resolve symlink identity.
  ignore: Deno.build.os === 'windows',
  async fn() {
    const directory = await Deno.makeTempDir();
    try {
      const source = `${directory}/source.db`;
      const alias = `${directory}/alias.db`;
      using db = new Database(source);
      db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42)');
      await Deno.symlink(source, alias);
      await rejectsSameFile(db, alias);
      using throughAlias = new Database(alias);
      await rejectsSameFile(throughAlias, source);
      assertEquals(throughAlias.prepare('SELECT x FROM t').pluck().get(), 42);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test('backup compares the selected attached database and allows temporary sources', async () => {
  const directory = await Deno.makeTempDir();
  try {
    using db = new Database(':memory:');
    db.prepare('ATTACH ? AS aux').run(`${directory}/attached.db`);
    db.exec('CREATE TABLE aux.t(x); INSERT INTO aux.t VALUES (7)');
    await rejectsSameFile(db, `${directory}/attached.db`, 'aux');
    const progress = await db.backup(`${directory}/attached-copy.db`, {
      attached: 'aux',
    });
    assertEquals(progress.remainingPages, 0);
    using restored = new Database(`${directory}/attached-copy.db`);
    assertEquals(restored.prepare('SELECT x FROM t').pluck().get(), 7);

    using temporary = new Database('');
    temporary.exec('CREATE TABLE t(x); INSERT INTO t VALUES (9)');
    await temporary.backup(`${directory}/temporary-copy.db`);
    using temporaryCopy = new Database(`${directory}/temporary-copy.db`);
    assertEquals(temporaryCopy.prepare('SELECT x FROM t').pluck().get(), 9);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('backup identity checks and copying need only FFI and native-path permissions', async () => {
  const directory = await Deno.makeTempDir();
  const module = new URL('../../src/mod.ts', import.meta.url).href;
  try {
    const script = `${directory}/backup.ts`;
    await Deno.writeTextFile(
      script,
      `import Database, { SqliteError } from ${JSON.stringify(module)};
using db = new Database(${JSON.stringify(`${directory}/source.db`)});
db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42)');
let rejected = false;
try {
  await db.backup(${JSON.stringify(`${directory}/./source.db`)});
} catch (error) {
  if (!(error instanceof SqliteError) || error.code !== 'SQLITE_ERROR') throw error;
  rejected = true;
}
if (!rejected) throw Error('same-file backup succeeded');
await db.backup(${JSON.stringify(`${directory}/copy.db`)});
using copy = new Database(${JSON.stringify(`${directory}/copy.db`)});
if (copy.prepare('SELECT x FROM t').pluck().get() !== 42) throw Error('incorrect copy');
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        'run',
        '--no-config',
        '--no-prompt',
        '--allow-ffi',
        '--allow-env=DENO_SQLITE_PATH',
        script,
      ],
      env: { DENO_SQLITE_PATH: Deno.env.get('DENO_SQLITE_PATH')! },
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
    await Deno.remove(directory, { recursive: true });
  }
});

import './setup.ts';
import { assert, assertEquals } from '@std/assert';
import Database from '../src/mod.ts';
import { native } from '../src/native/loader.ts';
import type { Symbols } from '../src/native/symbols.ts';

Deno.test('isolated connections and backups use SQLite multi-thread mode', async () => {
  const s: { sqlite3_open_v2: Symbols['sqlite3_open_v2'] } = native();
  const open = s.sqlite3_open_v2;
  const flags: number[] = [];
  const directory = Deno.makeTempDirSync();
  s.sqlite3_open_v2 = (path, out, mode, vfs) => {
    flags.push(mode);
    return open(path, out, mode, vfs);
  };
  try {
    using db = new Database(':memory:');
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES(42)');
    await db.backup(`${directory}/copy.db`);
    using copy = new Database(`${directory}/copy.db`, { readonly: true });
    assertEquals(copy.prepare('SELECT x FROM t').pluck().get(), 42);
    assert(flags.every((mode) => (mode & 0x8000) !== 0));
    assertEquals(flags.map((mode) => mode & ~0x8000), [6, 6, 1]);
  } finally {
    s.sqlite3_open_v2 = open;
    Deno.removeSync(directory, { recursive: true });
  }
});

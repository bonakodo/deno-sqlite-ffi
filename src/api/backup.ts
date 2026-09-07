import { requireCapability } from '../native/loader.ts';
import { cstring, string } from '../native/memory.ts';
import { SqliteError } from '../errors.ts';
import type { BackupOptions, BackupProgress } from '../types.ts';
import { Connection } from './connection.ts';
import { options, text } from './validation.ts';

export async function backup(
  connection: Connection,
  destination: string,
  config: BackupOptions,
): Promise<BackupProgress> {
  connection.assertIdle();
  text(destination, 'Backup destination', false);
  destination = destination.trim();
  if (!destination || destination === ':memory:') {
    throw new TypeError('Backup destination must be a disk file');
  }
  options(config);
  const attached = config.attached ?? 'main';
  text(attached, 'Attached database', false);
  if (config.progress != null && typeof config.progress !== 'function') {
    throw new TypeError('Backup progress must be a function');
  }
  requireCapability('backup');
  const target = new Connection(destination, 6, 0, null);
  const s = connection.sql;
  // Use SQLite's VFS paths without requiring Deno filesystem permissions.
  // Memory and temporary source databases have no persistent filename.
  const sourcePath = string(
    s.sqlite3_db_filename(connection.pointer, cstring(attached)),
  );
  const targetPath = string(
    s.sqlite3_db_filename(target.pointer, cstring('main')),
  );
  if (sourcePath && sourcePath === targetPath) {
    target.close();
    throw new SqliteError(
      'Backup source and destination must be distinct files',
      'SQLITE_ERROR',
    );
  }
  const handle = s.sqlite3_backup_init(
    target.pointer,
    cstring('main'),
    connection.pointer,
    cstring(attached),
  );
  if (!handle) {
    try {
      target.check(s.sqlite3_extended_errcode(target.pointer));
    } finally {
      target.close();
    }
  }
  let closed = false;
  let cancelled = false;
  function cleanup(): void {
    if (!closed) {
      closed = true;
      s.sqlite3_backup_finish(handle);
      target.close();
      connection.resources.delete(resource);
    }
  }
  const resource = {
    close() {
      cancelled = true;
      cleanup();
    },
  };
  connection.resources.add(resource);
  let pages = 0;
  let initial = true;
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled) throw new TypeError('Database closed during backup');
      const rc = s.sqlite3_backup_step(handle, pages);
      if (rc !== 5 && rc !== 6) target.check(rc);
      const progress = {
        totalPages: s.sqlite3_backup_pagecount(handle),
        remainingPages: s.sqlite3_backup_remaining(handle),
      };
      if (rc === 101) return progress;
      if (initial) {
        initial = false;
        pages = 100;
      }
      const next = config.progress?.(progress);
      if (next !== undefined) {
        if (typeof next !== 'number' || Number.isNaN(next)) {
          throw new TypeError(
            'Backup progress must return a number or undefined',
          );
        }
        pages = Math.max(0, Math.min(0x7fffffff, Math.round(next)));
      }
    }
  } finally {
    cleanup();
  }
}

import type { Row, SqlValue, TableDefinition, TableFactory } from '../types.ts';
import { requireCapability } from '../native/loader.ts';
import { allocate, cstring, string, view } from '../native/memory.ts';
import type { Connection } from './connection.ts';
import { argumentsFromNative, result } from './values.ts';
import { boolean, options, safeOption, text } from './validation.ts';

// Public SQLite structures on the supported 64-bit ABIs. A compiled C probe
// verifies every size/offset used here on each CI target.
export const layout = {
  module: 200,
  vtab: 24,
  cursor: 8,
  index: 96,
  constraint: 12,
  usage: 8,
} as const;
interface Definition extends TableDefinition {
  parameters: string[];
  safeIntegers: boolean;
}
interface Cursor {
  definition: Definition;
  iterator?: Generator<Row | SqlValue[], void, unknown>;
  current: Row | SqlValue[] | undefined;
  args: (SqlValue | undefined)[];
  rowid: bigint;
}
function definition(value: TableDefinition, safe: boolean): Definition {
  options(value);
  if (!Array.isArray(value.columns) || !value.columns.length) {
    throw new TypeError('Virtual tables require a nonempty columns array');
  }
  if (
    typeof value.rows !== 'function' ||
    Object.prototype.toString.call(value.rows) !== '[object GeneratorFunction]'
  ) throw new TypeError('Virtual table rows must be a generator function');
  const parameters = value.parameters ??
    Array.from({ length: value.rows.length }, (_, i) => `$${i + 1}`);
  if (!Array.isArray(parameters)) {
    throw new TypeError('Virtual table parameters must be an array');
  }
  const names = [...value.columns, ...parameters];
  for (const name of names) text(name, 'Virtual table column name', false);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new TypeError(
      'Virtual table column and parameter names must be unique',
    );
  }
  if (value.directOnly !== undefined) boolean(value.directOnly, 'directOnly');
  return {
    ...value,
    columns: [...value.columns],
    parameters: [...parameters],
    safeIntegers: safeOption(value.safeIntegers, safe),
  };
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function registerTable(
  connection: Connection,
  name: string,
  source: TableDefinition | TableFactory,
): void {
  connection.assertIdle(true);
  text(name, 'Virtual table name', false);
  requireCapability('tables');
  const fixed = typeof source === 'function'
    ? undefined
    : definition(source, connection.safe);
  const s = connection.sql;
  const tables = new Map<bigint, Definition>();
  const cursors = new Map<bigint, Cursor>();
  const callbacks: Deno.UnsafeCallback[] = [];
  const module = new Uint8Array(layout.module);
  const moduleView = new DataView(module.buffer);
  moduleView.setInt32(0, 1, true);
  function method<const P extends readonly Deno.NativeType[]>(
    offset: number,
    parameters: P,
    fn: (...args: Deno.FromNativeParameterTypes<P>) => number,
  ): Deno.PointerObject {
    const callback = new Deno.UnsafeCallback(
      { parameters, result: 'i32' },
      ((...args: Deno.FromNativeParameterTypes<P>) => {
        try {
          return fn(...args);
        } catch (error) {
          connection.error ??= { value: error };
          return 1;
        }
      }) as Deno.UnsafeCallbackFunction<P, 'i32'>,
    );
    callbacks.push(callback);
    moduleView.setBigUint64(
      offset,
      Deno.UnsafePointer.value(callback.pointer),
      true,
    );
    return callback.pointer;
  }
  const connect = method(16, [
    'pointer',
    'pointer',
    'i32',
    'pointer',
    'pointer',
    'pointer',
  ], (db, _aux, argc, argv, out, _error) => {
    const args: string[] = [];
    for (let i = 3; i < argc; i++) {
      args.push(string(new Deno.UnsafePointerView(argv!).getPointer(i * 8))!);
    }
    const d = fixed ??
      definition((source as TableFactory)(...args), connection.safe);
    const columns = [
      ...d.columns.map(quote),
      ...d.parameters.map((p) => `${quote(p)} HIDDEN`),
    ];
    connection.check(
      s.sqlite3_declare_vtab(
        db,
        cstring(`CREATE TABLE x(${columns.join(',')})`),
      ),
    );
    if (d.directOnly) connection.check(s.sqlite3_vtab_config(db, 3));
    const p = allocate(new Uint8Array(layout.vtab));
    tables.set(Deno.UnsafePointer.value(p), d);
    view(out!, 8).setBigUint64(0, Deno.UnsafePointer.value(p), true);
    return 0;
  });
  if (!fixed) {
    moduleView.setBigUint64(8, Deno.UnsafePointer.value(connect), true);
  }
  method(24, ['pointer', 'pointer'], (vtab, info) => {
    const d = tables.get(Deno.UnsafePointer.value(vtab))!;
    const iv = view(info!, layout.index);
    const n = iv.getInt32(0, true);
    const constraints = new Deno.UnsafePointerView(info!).getPointer(8);
    const usage = new Deno.UnsafePointerView(info!).getPointer(32);
    const selected: number[] = [];
    for (let i = 0; i < n; i++) {
      const cv = view(
        Deno.UnsafePointer.offset(constraints!, i * layout.constraint)!,
        layout.constraint,
      );
      const column = cv.getInt32(0, true) - d.columns.length;
      if (column < 0 || column >= d.parameters.length || cv.getUint8(4) !== 2) {
        continue;
      }
      if (!cv.getUint8(5)) return 19;
      if (selected.includes(column)) continue;
      selected.push(column);
      const uv = view(
        Deno.UnsafePointer.offset(usage!, i * layout.usage)!,
        layout.usage,
      );
      uv.setInt32(0, selected.length, true);
      uv.setUint8(4, 1);
    }
    const index = allocate(cstring(JSON.stringify(selected)));
    iv.setBigUint64(48, Deno.UnsafePointer.value(index), true);
    iv.setInt32(56, 1, true);
    iv.setFloat64(64, 1000000 / (selected.length + 1), true);
    iv.setBigInt64(72, 1000n, true);
    return 0;
  });
  const disconnect = method(32, ['pointer'], (vtab) => {
    tables.delete(Deno.UnsafePointer.value(vtab));
    s.sqlite3_free(vtab);
    return 0;
  });
  if (!fixed) {
    moduleView.setBigUint64(40, Deno.UnsafePointer.value(disconnect), true);
  }
  method(48, ['pointer', 'pointer'], (vtab, out) => {
    const p = allocate(new Uint8Array(layout.cursor));
    view(p, 8).setBigUint64(0, Deno.UnsafePointer.value(vtab), true);
    cursors.set(Deno.UnsafePointer.value(p), {
      definition: tables.get(Deno.UnsafePointer.value(vtab))!,
      current: undefined,
      args: [],
      rowid: 0n,
    });
    view(out!, 8).setBigUint64(0, Deno.UnsafePointer.value(p), true);
    return 0;
  });
  method(56, ['pointer'], (p) => {
    const cursor = cursors.get(Deno.UnsafePointer.value(p))!;
    cursors.delete(Deno.UnsafePointer.value(p));
    try {
      cursor.iterator?.return();
    } finally {
      s.sqlite3_free(p);
    }
    return 0;
  });
  function next(cursor: Cursor): number {
    const next = cursor.iterator!.next();
    cursor.current = next.done ? undefined : next.value;
    if (!next.done) {
      if (!cursor.current || typeof cursor.current !== 'object') {
        throw new TypeError('Virtual table rows must be objects or arrays');
      }
      if (
        Array.isArray(cursor.current) &&
        cursor.current.length !== cursor.definition.columns.length
      ) throw new TypeError('Virtual table row length does not match columns');
    }
    cursor.rowid++;
    return 0;
  }
  method(
    64,
    ['pointer', 'i32', 'pointer', 'i32', 'pointer'],
    (p, _index, index, argc, argv) => {
      const cursor = cursors.get(Deno.UnsafePointer.value(p))!;
      cursor.iterator?.return();
      const selected = JSON.parse(string(index)!) as number[];
      const values = argumentsFromNative(
        s,
        argc,
        argv,
        cursor.definition.safeIntegers,
      );
      cursor.args = Array(cursor.definition.parameters.length).fill(undefined);
      selected.forEach((column, i) => cursor.args[column] = values[i]);
      cursor.iterator = cursor.definition.rows(...cursor.args);
      cursor.rowid = 0n;
      return next(cursor);
    },
  );
  method(
    72,
    ['pointer'],
    (p) => next(cursors.get(Deno.UnsafePointer.value(p))!),
  );
  method(
    80,
    ['pointer'],
    (p) =>
      cursors.get(Deno.UnsafePointer.value(p))!.current === undefined ? 1 : 0,
  );
  method(88, ['pointer', 'pointer', 'i32'], (p, context, i) => {
    const cursor = cursors.get(Deno.UnsafePointer.value(p))!;
    const d = cursor.definition;
    const row = cursor.current!;
    result(
      s,
      context,
      i >= d.columns.length
        ? cursor.args[i - d.columns.length]
        : Array.isArray(row)
        ? row[i]
        : row[d.columns[i]!],
    );
    return 0;
  });
  method(96, ['pointer', 'pointer'], (p, out) => {
    view(out!, 8).setBigInt64(
      0,
      cursors.get(Deno.UnsafePointer.value(p))!.rowid,
      true,
    );
    return 0;
  });
  try {
    connection.check(
      s.sqlite3_create_module_v2(
        connection.pointer,
        cstring(name),
        Deno.UnsafePointer.of(module),
        null,
        null,
      ),
    );
  } catch (error) {
    for (const c of callbacks) c.close();
    throw error;
  }
  connection.resources.add({
    afterClose: true,
    close() {
      for (const c of callbacks) c.close();
      module.fill(0);
    },
  });
}

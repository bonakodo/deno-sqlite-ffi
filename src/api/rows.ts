import type { Connection } from './connection.ts';
import { column, metadata } from './values.ts';
import { string } from '../native/memory.ts';
import type { Symbols } from '../native/symbols.ts';

export type RowMode = 'object' | 'pluck' | 'raw' | 'expand';

type RowFactory = (
  read: typeof column,
  symbols: Symbols,
  pointer: Deno.PointerObject,
  safe: boolean,
) => () => unknown;

// Cache only unbound factories, never readers that hold a native pointer.
// Limit both the number of shapes and the size of each retained source string.
const factories = new Map<string, RowFactory>();
const maxFactories = 128;
const maxCachedSourceLength = 16_384;
let codeGenerationAllowed = true;

function genericFactory(
  count: number,
  names: string[] | undefined,
  tables: string[] | undefined,
): RowFactory {
  return (read, s, p, safe) => () => {
    if (!names) {
      const values = new Array(count);
      for (let i = 0; i < count; i++) values[i] = read(s, p, i, safe);
      return values;
    }
    const row: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      let target = row;
      if (tables) {
        const table = tables[i]!;
        if (!Object.hasOwn(row, table)) {
          Object.defineProperty(row, table, {
            value: {},
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        target = row[table] as Record<string, unknown>;
      }
      Object.defineProperty(target, names[i]!, {
        value: read(s, p, i, safe),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return row;
  };
}

/** Read a one-off row without allocating metadata arrays or compiling code. */
export function readOneRow(
  connection: Connection,
  pointer: Deno.PointerObject,
  mode: RowMode,
  safe: boolean,
): unknown {
  const s = connection.sql;
  if (mode === 'pluck') return column(s, pointer, 0, safe);
  const count = s.sqlite3_column_count(pointer);
  if (mode === 'raw') {
    const values = new Array(count);
    for (let i = 0; i < count; i++) values[i] = column(s, pointer, i, safe);
    return values;
  }
  const row: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const name = string(s.sqlite3_column_name(pointer, i))!;
    let target = row;
    if (mode === 'expand') {
      const table = metadata(connection, pointer, i).table ?? '$';
      if (!Object.hasOwn(row, table)) {
        Object.defineProperty(row, table, {
          value: {},
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      target = row[table] as Record<string, unknown>;
    }
    Object.defineProperty(target, name, {
      value: column(s, pointer, i, safe),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return row;
}

/** Compile the result shape once; read each cell's storage class on every row. */
export function createRowReader(
  connection: Connection,
  pointer: Deno.PointerObject,
  mode: RowMode,
  safe: boolean,
): () => unknown {
  const s = connection.sql;
  if (mode === 'pluck') return () => column(s, pointer, 0, safe);
  const count = s.sqlite3_column_count(pointer);
  const names = mode === 'raw' ? undefined : Array.from(
    { length: count },
    (_, i) => string(s.sqlite3_column_name(pointer, i))!,
  );
  const tables = mode === 'expand'
    ? Array.from(
      { length: count },
      (_, i) => metadata(connection, pointer, i).table ?? '$',
    )
    : undefined;
  const cells = Array.from(
    { length: count },
    (_, i) => `column(s,p,${i},safe)`,
  );
  let expression: string;
  if (mode === 'raw') expression = `[${cells.join(',')}]`;
  else {
    // Computed, JSON-quoted keys preserve __proto__, duplicate labels and any
    // characters in SQL aliases without allowing aliases to become code.
    const fields = cells.map((cell, i) =>
      `[${JSON.stringify(names![i])}]:${cell}`
    );
    if (mode === 'expand') {
      const groups = new Map<string, string[]>();
      for (let i = 0; i < count; i++) {
        const table = tables![i]!;
        const fieldsForTable = groups.get(table) ?? [];
        fieldsForTable.push(fields[i]!);
        groups.set(table, fieldsForTable);
      }
      expression = `{${
        [...groups].map(([table, fields]) =>
          `[${JSON.stringify(table)}]:{${fields.join(',')}}`
        ).join(',')
      }}`;
    } else expression = `{${fields.join(',')}}`;
  }
  let factory = factories.get(expression);
  if (!factory) {
    if (codeGenerationAllowed) {
      try {
        factory = new Function(
          'column',
          's',
          'p',
          'safe',
          `return () => (${expression});`,
        ) as RowFactory;
      } catch (error) {
        // V8 rejects the constructor with EvalError when string code generation
        // is disabled. Keep syntax bugs and all reader errors visible.
        if (!(error instanceof EvalError)) throw error;
        codeGenerationAllowed = false;
      }
    }
    factory ??= genericFactory(count, names, tables);
    if (expression.length <= maxCachedSourceLength) {
      if (factories.size === maxFactories) {
        factories.delete(factories.keys().next().value!);
      }
      factories.set(expression, factory);
    }
  }
  return factory(column, s, pointer, safe);
}

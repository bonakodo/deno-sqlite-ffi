import { requireCapability } from '../native/loader.ts';
import {
  copy,
  encoder,
  encodeText,
  string,
  text,
  transient,
} from '../native/memory.ts';
import type { Symbols } from '../native/symbols.ts';
import type { BindParameter, SqlValue } from '../types.ts';
import type { Connection } from './connection.ts';
import { integer } from './validation.ts';

export interface BindingLayout {
  readonly count: number;
  readonly names: readonly (string | null)[] | null;
}
/** SQLite keeps parameter indexes and names fixed across automatic reprepare. */
export function bindingLayout(
  s: Symbols,
  statement: Deno.PointerObject,
): BindingLayout {
  const count = s.sqlite3_bind_parameter_count(statement);
  let names: (string | null)[] | null = null;
  for (let i = 0; i < count; i++) {
    const name = string(s.sqlite3_bind_parameter_name(statement, i + 1));
    if (name) {
      names ??= new Array<string | null>(count).fill(null);
      names[i] = name.slice(1);
    }
  }
  return { count, names };
}

const emptyBlob = new Uint8Array(1);

export function bind(
  connection: Connection,
  statement: Deno.PointerObject,
  parameters: BindParameter[],
  layout: BindingLayout = bindingLayout(connection.sql, statement),
): void {
  const s = connection.sql;
  // Ordinary scalar arguments already have the exact positional layout.
  // Allocate only when an array or named object requires flattening.
  let positional: unknown[] = parameters;
  let named: Record<string, unknown> | undefined;
  for (let i = 0; i < parameters.length; i++) {
    const parameter = parameters[i];
    if (
      parameter !== null && typeof parameter === 'object' &&
      !Array.isArray(parameter) && !(parameter instanceof Uint8Array)
    ) {
      if (named) {
        throw new TypeError('Only one named parameter object is allowed');
      }
      named = parameter as Record<string, unknown>;
      if (positional === parameters) positional = parameters.slice(0, i);
    } else if (Array.isArray(parameter)) {
      if (positional === parameters) positional = parameters.slice(0, i);
      positional.push(...parameter);
    } else if (positional !== parameters) positional.push(parameter);
  }
  let used = 0;
  const { count, names } = layout;
  for (let i = 1; i <= count; i++) {
    const name = names?.[i - 1];
    let value: unknown;
    if (name !== null && name !== undefined) {
      if (!named || !(name in named)) {
        throw new RangeError(`Missing named parameter "${name}"`);
      }
      value = named[name];
    } else {
      if (used === positional.length) {
        throw new RangeError('Too few parameter values were provided');
      }
      value = positional[used++];
    }
    let rc: number;
    if (value === null) rc = s.sqlite3_bind_null(statement, i);
    else if (typeof value === 'number') {
      rc = s.sqlite3_bind_double(statement, i, value);
    } else if (typeof value === 'bigint') {
      integer(value);
      rc = s.sqlite3_bind_int64(statement, i, value);
    } else if (typeof value === 'string') {
      const encoded = encodeText(value);
      rc = s.sqlite3_bind_text(
        statement,
        i,
        encoded.bytes,
        encoded.length,
        transient(),
      );
    } else if (value instanceof Uint8Array) {
      rc = s.sqlite3_bind_blob(
        statement,
        i,
        value.length ? value : emptyBlob,
        value.length,
        transient(),
      );
    } else {throw new TypeError(
        'SQLite parameters must be numbers, bigints, strings, Uint8Arrays, or null',
      );}
    connection.check(rc);
  }
  if (used !== positional.length) {
    throw new RangeError('Too many parameter values were provided');
  }
}
export function column(
  s: Symbols,
  statement: Deno.PointerObject,
  index: number,
  safe: boolean,
): SqlValue {
  switch (s.sqlite3_column_type(statement, index)) {
    case 1: {
      return safe
        ? s.sqlite3_column_int64(statement, index)
        : s.sqlite3_column_double(statement, index);
    }
    case 2:
      return s.sqlite3_column_double(statement, index);
    case 3: {
      const p = s.sqlite3_column_text(statement, index);
      return text(p, s.sqlite3_column_bytes(statement, index));
    }
    case 4: {
      const p = s.sqlite3_column_blob(statement, index);
      return copy(p, s.sqlite3_column_bytes(statement, index));
    }
    default:
      return null;
  }
}
export function argumentsFromNative(
  s: Symbols,
  count: number,
  argv: Deno.PointerValue,
  safe: boolean,
): SqlValue[] {
  const values = new Array<SqlValue>(count);
  if (!count) return values;
  const pointers = new Deno.UnsafePointerView(argv!);
  for (let i = 0; i < count; i++) {
    values[i] = valueFromNative(s, pointers.getPointer(i * 8), safe);
  }
  return values;
}
export function valueFromNative(
  s: Symbols,
  p: Deno.PointerValue,
  safe: boolean,
): SqlValue {
  switch (s.sqlite3_value_type(p)) {
    case 1:
      return safe ? s.sqlite3_value_int64(p) : s.sqlite3_value_double(p);
    case 2:
      return s.sqlite3_value_double(p);
    case 3: {
      const bytes = s.sqlite3_value_text(p);
      return text(bytes, s.sqlite3_value_bytes(p));
    }
    case 4: {
      const bytes = s.sqlite3_value_blob(p);
      return copy(bytes, s.sqlite3_value_bytes(p));
    }
    default:
      return null;
  }
}
export function result(
  s: Symbols,
  context: Deno.PointerValue,
  value: unknown,
): void {
  if (value === null || value === undefined) s.sqlite3_result_null(context);
  else if (typeof value === 'number') s.sqlite3_result_double(context, value);
  else if (typeof value === 'bigint') {
    integer(value);
    s.sqlite3_result_int64(context, value);
  } else if (typeof value === 'string') {
    const encoded = encodeText(value);
    s.sqlite3_result_text(context, encoded.bytes, encoded.length, transient());
  } else if (value instanceof Uint8Array) {
    s.sqlite3_result_blob(
      context,
      value.length ? value : emptyBlob,
      value.length,
      transient(),
    );
  } else throw new TypeError('SQL function returned an unsupported value');
}
export function callbackError(
  connection: Connection,
  context: Deno.PointerValue,
  error: unknown,
): void {
  connection.error ??= { value: error };
  const message = encoder.encode('JavaScript callback failed');
  connection.sql.sqlite3_result_error(context, message, message.length);
}
export function metadata(
  connection: Connection,
  statement: Deno.PointerObject,
  i: number,
) {
  requireCapability('metadata');
  const s = connection.sql;
  return {
    name: string(s.sqlite3_column_name(statement, i))!,
    column: string(s.sqlite3_column_origin_name(statement, i)),
    table: string(s.sqlite3_column_table_name(statement, i)),
    database: string(s.sqlite3_column_database_name(statement, i)),
    type: string(s.sqlite3_column_decltype(statement, i)),
  };
}

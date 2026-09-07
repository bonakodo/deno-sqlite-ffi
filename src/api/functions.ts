import type {
  AggregateOptions,
  FunctionOptions,
  SqlFunction,
  SqlValue,
} from '../types.ts';
import { requireCapability } from '../native/loader.ts';
import { cstring } from '../native/memory.ts';
import { type Connection, retainFunction } from './connection.ts';
import {
  argumentsFromNative,
  callbackError,
  result,
  valueFromNative,
} from './values.ts';
import { boolean, options, safeOption, text } from './validation.ts';

const scalarSignature = {
  parameters: ['pointer', 'i32', 'pointer'],
  result: 'void',
} as const;
const finalSignature = { parameters: ['pointer'], result: 'void' } as const;
export function functionConfig(
  connection: Connection,
  name: string,
  config: FunctionOptions,
  length: number,
) {
  connection.assertIdle(true);
  text(name, 'Function name', false);
  options(config);
  for (const key of ['varargs', 'deterministic', 'directOnly'] as const) {
    if (config[key] !== undefined) boolean(config[key], key);
  }
  if (length < 0 || length > 127) {
    throw new RangeError('SQL functions must have between 0 and 127 arguments');
  }
  requireCapability('functions');
  return {
    argc: config.varargs ? -1 : length,
    flags: 1 | (config.deterministic ? 0x800 : 0) |
      (config.directOnly ? 0x80000 : 0),
    safe: safeOption(config.safeIntegers, connection.safe),
  };
}
export function registerFunction(
  connection: Connection,
  name: string,
  config: FunctionOptions,
  fn: SqlFunction,
): void {
  if (typeof fn !== 'function') throw new TypeError('Expected an SQL function');
  const { argc, flags, safe } = functionConfig(
    connection,
    name,
    config,
    fn.length,
  );
  const s = connection.sql;
  const callback = new Deno.UnsafeCallback(
    scalarSignature,
    (context, count, argv) => {
      try {
        let value: SqlValue | undefined;
        if (count === 0) value = fn();
        else if (count === 1 || count === 2) {
          const pointers = new Deno.UnsafePointerView(argv!);
          const first = valueFromNative(s, pointers.getPointer(0), safe);
          value = count === 1
            ? fn(first)
            : fn(first, valueFromNative(s, pointers.getPointer(8), safe));
        } else value = fn(...argumentsFromNative(s, count, argv, safe));
        result(s, context, value);
      } catch (error) {
        callbackError(connection, context, error);
      }
    },
  );
  try {
    connection.check(
      s.sqlite3_create_function_v2(
        connection.pointer,
        cstring(name),
        argc,
        flags,
        null,
        callback.pointer,
        null,
        null,
        null,
      ),
    );
  } catch (error) {
    callback.close();
    throw error;
  }
  retainFunction(connection, name, argc, {
    afterClose: true,
    close: () => callback.close(),
  });
}
export function registerAggregate<T>(
  connection: Connection,
  name: string,
  config: AggregateOptions<T>,
): void {
  options(config);
  if (typeof config.step !== 'function') {
    throw new TypeError('An aggregate requires a step function');
  }
  if (config.result !== undefined && typeof config.result !== 'function') {
    throw new TypeError('Aggregate result must be a function');
  }
  if (config.inverse !== undefined && typeof config.inverse !== 'function') {
    throw new TypeError('Aggregate inverse must be a function');
  }
  const { argc, flags, safe } = functionConfig(
    connection,
    name,
    config,
    Math.max(0, config.step.length - 1),
  );
  if (config.inverse) requireCapability('windows');
  const s = connection.sql;
  const states = new Map<bigint, T>();
  function key(context: Deno.PointerValue): bigint {
    const p = s.sqlite3_aggregate_context(context, 1);
    if (!p) throw new Error('SQLite aggregate memory allocation failed');
    const k = Deno.UnsafePointer.value(p);
    if (!states.has(k)) {
      states.set(
        k,
        typeof config.start === 'function'
          ? (config.start as () => T)()
          : config.start === undefined
          ? null as T
          : config.start,
      );
    }
    return k;
  }
  function update(fn: AggregateOptions<T>['step']) {
    return new Deno.UnsafeCallback(scalarSignature, (context, count, argv) => {
      if (connection.error) return;
      try {
        const k = key(context);
        const value = fn(
          states.get(k)!,
          ...argumentsFromNative(s, count, argv, safe),
        );
        if (value !== undefined) states.set(k, value);
      } catch (error) {
        callbackError(connection, context, error);
      }
    });
  }
  function output(final: boolean) {
    return new Deno.UnsafeCallback(finalSignature, (context) => {
      const p = s.sqlite3_aggregate_context(context, 0);
      const existing = Deno.UnsafePointer.value(p);
      try {
        if (connection.error) return;
        const value = states.get(key(context))!;
        result(s, context, config.result ? config.result(value) : value);
      } catch (error) {
        callbackError(connection, context, error);
      } finally {
        if (final) {
          states.delete(existing);
          const p = s.sqlite3_aggregate_context(context, 0);
          states.delete(Deno.UnsafePointer.value(p));
        }
      }
    });
  }
  const step = update(config.step);
  const final = output(true);
  const inverse = config.inverse ? update(config.inverse) : undefined;
  const value = inverse ? output(false) : undefined;
  const callbacks = [step, final, inverse, value].filter((c) =>
    c !== undefined
  );
  try {
    connection.check(
      inverse
        ? s.sqlite3_create_window_function(
          connection.pointer,
          cstring(name),
          argc,
          flags,
          null,
          step.pointer,
          final.pointer,
          value!.pointer,
          inverse.pointer,
          null,
        )
        : s.sqlite3_create_function_v2(
          connection.pointer,
          cstring(name),
          argc,
          flags,
          null,
          null,
          step.pointer,
          final.pointer,
          null,
        ),
    );
  } catch (error) {
    for (const c of callbacks) c.close();
    throw error;
  }
  retainFunction(connection, name, argc, {
    afterClose: true,
    close() {
      for (const c of callbacks) c.close();
      states.clear();
    },
  });
}

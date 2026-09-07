export function text(
  value: unknown,
  name: string,
  empty = true,
): asserts value is string {
  if (
    typeof value !== 'string' || value.includes('\0') ||
    (!empty && !value.length)
  ) {
    throw new TypeError(
      `${name} must be ${
        empty ? 'a' : 'a nonempty'
      } string without NUL characters`,
    );
  }
}
export function options(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected an options object');
  }
}
export function boolean(
  value: unknown,
  name: string,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
}
export function toggle(value: unknown): boolean {
  boolean(value, 'toggle');
  return value;
}
export function integer(value: unknown): asserts value is bigint {
  if (
    typeof value !== 'bigint' || value < -9223372036854775808n ||
    value > 9223372036854775807n
  ) throw new RangeError('BigInt must fit in a signed 64-bit SQLite integer');
}
export function safeOption(
  value: boolean | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  boolean(value, 'safeIntegers');
  return value;
}

/** Recognize a tail made entirely of SQL whitespace, semicolons, and comments. */
export function hasSql(tail: string): boolean {
  return tail.replace(/(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/g, '')
    .length > 0;
}

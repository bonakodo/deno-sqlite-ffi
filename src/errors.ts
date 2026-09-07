import { codes } from './codes.ts';
/** An SQLite error with an extended result-code name. */
export class SqliteError extends Error {
  /** Error class name. */
  override name = 'SqliteError';
  /** SQLite's extended result-code name. */
  readonly code: string;
  /** Create an SQLite error from a message and code name. */
  constructor(message: string, code: string) {
    if (typeof message !== 'string' || typeof code !== 'string') {
      throw new TypeError('SqliteError expects a message and a code string');
    }
    super(message);
    this.code = code;
  }
}
export function resultError(message: string, code: number): SqliteError {
  return new SqliteError(
    message,
    codes[code] ?? `UNKNOWN_SQLITE_ERROR_${code}`,
  );
}

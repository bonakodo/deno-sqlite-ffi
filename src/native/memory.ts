import { native } from './loader.ts';
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
let transientPointer: Deno.PointerObject | undefined;
export const transient = (): Deno.PointerObject =>
  transientPointer ??= Deno.UnsafePointer.create(0xffffffffffffffffn)!;
export function cstring(value: string): Uint8Array {
  return encoder.encode(value + '\0');
}
const textScratch = { bytes: new Uint8Array(256), length: 0 };
/** Consume immediately with SQLITE_TRANSIENT; the next call reuses this buffer. */
export function encodeText(
  value: string,
): { bytes: Uint8Array; length: number } {
  // Three bytes per UTF-16 code unit cover even unmatched surrogates. Do not
  // retain large strings, or allocate their worst-case size before encoding.
  const capacity = value.length * 3;
  if (capacity > 65536) {
    const bytes = encoder.encode(value);
    return { bytes, length: bytes.length };
  }
  if (capacity > textScratch.bytes.length) {
    textScratch.bytes = new Uint8Array(2 ** Math.ceil(Math.log2(capacity)));
  }
  textScratch.length = encoder.encodeInto(value, textScratch.bytes).written;
  return textScratch;
}
export function string(pointer: Deno.PointerValue): string | null {
  return pointer ? Deno.UnsafePointerView.getCString(pointer) : null;
}
/** Decode SQLite-owned text before the next step or reset can release it. */
export function text(pointer: Deno.PointerValue, length: number): string {
  if (!length) return '';
  const value = Deno.UnsafePointerView.getCString(pointer!);
  // Equal UTF-16 and byte lengths exclude multibyte text and embedded NULs.
  // Decode those cases by their full byte length, preserving the decoder's BOM
  // and malformed UTF-8 behavior without first copying SQLite's bytes.
  if (value.length === length) return value;
  return decoder.decode(
    new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(pointer!, length)),
  );
}
export function pointer(value: BigUint64Array): Deno.PointerValue {
  return Deno.UnsafePointer.create(value[0]!);
}
export function view(p: Deno.PointerObject, length: number): DataView {
  return new DataView(Deno.UnsafePointerView.getArrayBuffer(p, length));
}
export function copy(p: Deno.PointerValue, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (length) Deno.UnsafePointerView.copyInto(p!, bytes);
  return bytes;
}
export function allocate(bytes: Uint8Array): Deno.PointerObject {
  const p = native().sqlite3_malloc64(BigInt(Math.max(bytes.length, 1)));
  if (!p) throw new Error('SQLite memory allocation failed');
  new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(p, bytes.length)).set(
    bytes,
  );
  return p;
}

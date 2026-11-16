/**
 * Reading and writing Gateway JSON safely, so the CLI reads IDs exactly as the Yomi web client
 * does.
 *
 * The service's IDs are i64: a number past 2^53 would lose digits in `JSON.parse`, so
 * `parseGatewayJson` turns such integers into strings first, and `id` reads either form as a
 * decimal string. IDs are kept as strings and written back with `i64`.
 */
export function parseGatewayJson(raw: string): unknown {
  return JSON.parse(
    raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?(?:0|[1-9]\d*)$/.test(token) && !Number.isSafeInteger(Number(token))
        ? JSON.stringify(token)
        : token,
    ),
  ) as unknown;
}

export type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Gateway object');
  return value as Json;
}
/** An optional nested object: `{}` when absent. */
export function optionalObject(value: unknown): Json {
  return value === undefined || value === null ? {} : object(value);
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Gateway string');
  return value;
}
/** An optional string: `''` when absent (thrift optional fields are often left out). */
export function text(value: unknown): string {
  return value === undefined || value === null ? '' : string(value);
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Invalid Gateway number');
  return value;
}
/** An optional number: `0` when absent. */
export function count(value: unknown): number {
  return value === undefined || value === null ? 0 : number(value);
}
export function integer(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Unsafe Gateway integer');
  return result;
}
export function id(value: unknown): string {
  const result = typeof value === 'string' ? value : String(integer(value));
  if (!/^(0|[1-9][0-9]*)$/.test(result) || BigInt(result) > 9223372036854775807n)
    throw new Error('Invalid Gateway ID');
  return result;
}
/** An optional ID: `''` when absent or zero. */
export function optionalId(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === 0) return '';
  const result = id(value);
  return result === '0' ? '' : result;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid Gateway boolean');
  return value;
}
/** An optional boolean: `false` when absent. */
export function flag(value: unknown): boolean {
  return value === undefined || value === null ? false : boolean(value);
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Gateway array');
  return value;
}
/** An optional list: `[]` when absent. */
export function list(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : array(value);
}

/** An https media URL, or `''` when the server sent none. */
export function image(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const raw = string(value);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid media URL');
  return raw;
}

/** A decimal ID from a response, numbers and strings alike; `''` otherwise. */
export function idOf(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return '';
}

/**
 * Writes a decimal ID into a JSON body as a bare i64 number, digits intact, for the Gateway's
 * i64 fields. `JSON.stringify` would quote it; `encodeBody` writes it bare.
 */
export class I64 {
  constructor(public readonly digits: string) {
    if (!/^(0|-?[1-9][0-9]*)$/.test(digits)) throw new Error('Invalid i64');
  }
  toJSON() {
    return this.digits;
  }
}
export function i64(value: string | number): I64 {
  return new I64(String(value));
}
/** A body already encoded (a frozen request): `encodeBody` writes it unchanged. */
export class RawBody {
  constructor(public readonly text: string) {
    parseGatewayJson(text);
  }
}

/** JSON text of a request body; `I64` values are written as bare numbers. */
export function encodeBody(body: unknown): string {
  if (body instanceof RawBody) return body.text;
  const marks: string[] = [];
  const raw = JSON.stringify(body, function (this: unknown, key: string, value: unknown) {
    const original = (this as Record<string, unknown> | null)?.[key];
    if (original instanceof I64 || typeof original === 'bigint') {
      marks.push(original instanceof I64 ? original.digits : original.toString());
      return '\u0000i64:' + (marks.length - 1) + '\u0000';
    }
    return value;
  });
  return raw.replace(/"\\u0000i64:(\d+)\\u0000"/g, (_match, index: string) => marks[Number(index)]);
}

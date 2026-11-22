// Guards for the JSON the tool reads (the app's API, CDP, files): nothing is cast, every value is narrowed.

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): Json {
  if (!isRecord(value)) throw new Error(`${what}: expected an object`);
  return value;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A numeric field, or an error naming it. */
export function needNum(obj: Json, key: string, what: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: ${key} is not a number`);
  return v;
}

export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

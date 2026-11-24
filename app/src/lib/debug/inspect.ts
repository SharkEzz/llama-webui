/**
 * What the Stores tab needs to show a state as a tree and a change as a diff, on the values themselves: nothing is
 * copied or made JSON first (a store can hold the monitor's history, the logs), a branch is read only when opened.
 */

/** A value that opens on children: an object, an array, a `Map`, a `Set` (not a function, a date, typed bytes). */
export function isBranch(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !ArrayBuffer.isView(value)
  );
}

/** The children of a branch, label and value; a store's actions (its functions) are left out. */
export function childrenOf(value: object): [string, unknown][] {
  if (value instanceof Map) return [...value].map(([k, v]) => [String(k), v]);
  if (value instanceof Set) return [...value].map((v, i) => [String(i), v]);
  if (Array.isArray(value)) return value.map((v: unknown, i) => [String(i), v]);
  return Object.entries(value).filter(([, v]) => typeof v !== 'function');
}

/** How many children a branch has, without listing them. */
export function sizeOf(value: object): number {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  return childrenOf(value).length;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A value on one line: `"text"`, `12`, `Array(3)`, `Map(2)`, `{ id, name, … }`. */
export function preview(value: unknown, max = 80): string {
  if (typeof value === 'string') return clip(JSON.stringify(value), max);
  if (typeof value === 'function') return 'ƒ';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object' || value === null) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = childrenOf(value).map(([k]) => k);
  if (keys.length === 0) return '{}';
  const whole = `{ ${keys.join(', ')} }`;
  if (whole.length <= max) return whole;
  // Cut between two keys, never inside one.
  const shown: string[] = [];
  for (const key of keys) {
    if (`{ ${[...shown, key, '…'].join(', ')} }`.length > max) break;
    shown.push(key);
  }
  return `{ ${[...shown, '…'].join(', ')} }`;
}

/** A path to a child: `.name`, `[3]`, `["a key"]`. */
export function childPath(parent: string, key: string, inArray: boolean): string {
  if (inArray) return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? parent === ''
      ? key
      : `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

export interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

const MISSING = Symbol('missing');

/**
 * Where `next` differs from `prev`, path by path, at most `maxEntries` (then `truncated`). A value the same in both
 * (`Object.is`, what a store shares between two states) is not looked into; below `maxDepth`, a different branch is
 * one change.
 */
export function diffPaths(
  prev: unknown,
  next: unknown,
  { root = '', maxEntries = 100, maxDepth = 8 } = {},
): { entries: DiffEntry[]; truncated: boolean } {
  const entries: DiffEntry[] = [];
  let truncated = false;
  const add = (entry: DiffEntry) => {
    if (entries.length < maxEntries) entries.push(entry);
    else truncated = true;
  };
  const walk = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (truncated || Object.is(a, b)) return;
    if (typeof a === 'function' && typeof b === 'function') return;
    if (a === MISSING) {
      add({ path, kind: 'added', after: b });
      return;
    }
    if (b === MISSING) {
      add({ path, kind: 'removed', before: a });
      return;
    }
    const sameKind =
      isBranch(a) &&
      isBranch(b) &&
      Array.isArray(a) === Array.isArray(b) &&
      a instanceof Map === b instanceof Map &&
      a instanceof Set === b instanceof Set;
    if (!sameKind || depth >= maxDepth) {
      add({ path, kind: 'changed', before: a, after: b });
      return;
    }
    const inArray = Array.isArray(a) || a instanceof Set;
    const before = new Map(childrenOf(a));
    const after = new Map(childrenOf(b));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const child = childPath(path, key, inArray);
      walk(before.has(key) ? before.get(key) : MISSING, after.has(key) ? after.get(key) : MISSING, child, depth + 1);
    }
  };
  walk(prev, next, root, 0);
  return { entries, truncated };
}

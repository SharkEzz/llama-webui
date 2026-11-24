import { Predicate } from 'effect';

/**
 * A value as JSON can hold it: a `Map` becomes an object, a `Set` an array, a function and `undefined` go, a cycle
 * becomes `"<cycle>"`. Store states hold all of these.
 */
export function toPlain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'function' || value === undefined) return undefined;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  try {
    if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), toPlain(v, seen)]));
    if (value instanceof Set) return [...value].map((v) => toPlain(v, seen));
    if (Array.isArray(value)) return value.map((v) => toPlain(v, seen) ?? null);
    if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const plain = toPlain(v, seen);
      if (plain !== undefined) out[k] = plain;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Keys whose string is text a person wrote or a model replied: replaced by its length. The text is found by the name
 * of its key, not read: a new text field of the chat's schemas goes here (`json.test.ts` fails until it does).
 */
export const TEXT_KEYS: ReadonlySet<string> = new Set(['content', 'reasoning', 'systemPrompt', 'prompt', 'title']);
/** Keys holding environment variables (`{ NAME: value }`): the names stay, the values go. */
const ENV_KEYS = new Set(['env']);
/** Options of llama-server whose value is a secret. */
const SECRET_FLAGS = ['--api-key', '--hf-token'];

const HOME = /(?:\/home|\/Users)\/[^/\s"'`:;,)]+|\/root(?=\/|\b)/g;
const SECRET_IN_TEXT = new RegExp(`(${SECRET_FLAGS.join('|')})(=|\\s+)\\S+`, 'g');

function redactString(s: string): string {
  return s.replaceAll(HOME, '<home>').replaceAll(SECRET_IN_TEXT, '$1$2<hidden>');
}

/**
 * `value` (plain, see `toPlain`) without what a person would not publish: a home folder becomes `<home>`, the value
 * of an environment variable and of `--api-key` or `--hf-token` becomes `<hidden>`, and the text of a conversation
 * (its messages, its reasoning, its system prompt, its title) becomes `<N chars>`. What is left can still be private:
 * a model's name, a folder outside the home.
 */
export function redact(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key !== undefined && TEXT_KEYS.has(key)) return `<${value.length} chars>`;
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      const previous: unknown = value[i - 1];
      if (Predicate.isString(previous) && SECRET_FLAGS.includes(previous) && Predicate.isString(v)) return '<hidden>';
      return redact(v);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        key !== undefined && ENV_KEYS.has(key)
          ? '<hidden>'
          : ENV_KEYS.has(k) && (typeof v !== 'object' || v === null)
            ? '<hidden>'
            : redact(v, k);
    }
    return out;
  }
  return value;
}

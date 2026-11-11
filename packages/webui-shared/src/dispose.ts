/**
 * Disposal key: `Symbol.dispose`, otherwise the same fallback as the code `Bun.build` emits for `using`
 * (`Symbol.for('Symbol.dispose')`), for browsers that do not have `Symbol.dispose` yet.
 */
const DISPOSE: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

/**
 * `fn` called on exiting the block that holds it with `using`, even on an exception or a `return`:
 * `busy = true; using _busy = defer(() => (busy = false));` replaces a `try { … } finally { busy = false; }`.
 */
export function defer(fn: () => void): Disposable {
  return { [DISPOSE]: fn };
}

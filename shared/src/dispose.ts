/**
 * Clé de libération : `Symbol.dispose`, sinon le même repli que le code produit par `Bun.build` pour `using`
 * (`Symbol.for('Symbol.dispose')`), pour les navigateurs qui n'ont pas encore `Symbol.dispose`.
 */
const DISPOSE: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

/**
 * `fn` appelée à la sortie du bloc qui la tient par `using`, même sur une exception ou un `return` :
 * `busy = true; using _busy = defer(() => (busy = false));` remplace un `try { … } finally { busy = false; }`.
 */
export function defer(fn: () => void): Disposable {
  return { [DISPOSE]: fn };
}

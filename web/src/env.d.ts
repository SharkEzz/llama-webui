// CSS imports handled by Bun's bundler.
declare module '*.css';

// The app project has no Bun or Node types (src/lib/no-node-types.ts): the bundler's hot-reload hook, which
// `lib/ws.ts` uses, is declared here.
interface ImportMeta {
  readonly hot?: { dispose(cb: () => void): void };
}

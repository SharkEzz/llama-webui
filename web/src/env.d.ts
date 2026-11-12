// CSS imports handled by Vite.
declare module '*.css';

// The app project has no Node types (src/lib/no-node-types.ts): Vite's hot-reload hook, which `lib/ws.ts` uses, is
// declared here.
interface ImportMeta {
  readonly hot?: { dispose(cb: () => void): void };
}

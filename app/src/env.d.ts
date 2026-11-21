// CSS imports handled by Vite.
declare module '*.css';

// The project does not load `vite/client`: Vite's hot-reload hook, which `lib/ws.ts` uses, is declared here.
interface ImportMeta {
  readonly hot?: { dispose(cb: () => void): void };
}

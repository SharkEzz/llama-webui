// CSS imports handled by Vite.
declare module '*.css';

// The project does not load `vite/client`: what the code reads of it is declared here, Vite's hot-reload hook
// (`lib/ws.ts`) and `env.DEV`, true in development (the debug window: React times renders there only).
interface ImportMeta {
  readonly hot?: { dispose: (cb: () => void) => void };
  readonly env: { readonly DEV: boolean };
}

// True inside the executable built by `bun run compile`. The `typeof` guard lets the modules that read it load on
// Node too; this file goes away with the standalone executable (N8).
export const isStandalone: boolean = typeof Bun !== 'undefined' && Bun.isStandaloneExecutable;

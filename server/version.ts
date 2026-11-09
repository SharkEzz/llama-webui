/** Replaced at compile time by `scripts/compile.ts`; absent when running from source. */
declare const LLAMA_WEBUI_VERSION: string | undefined;

/**
 * Version of llama-webui, reported by `/api/health` and shown in the status bar. The compiled executable gets
 * `git describe --tags --always --dirty` at compile time (the tag, else the short commit hash, `-dirty` for
 * uncommitted changes); from source (`bun run dev`, `bun run start`) it is `dev`.
 */
export const APP_VERSION: string = typeof LLAMA_WEBUI_VERSION === 'string' ? LLAMA_WEBUI_VERSION : 'dev';

/** Replaced by `vite build` (`define` in vite.config.ts); absent when running from source (`pnpm dev`). */
declare const LLAMA_WEBUI_VERSION: string | undefined;

/**
 * Version of llama-webui, reported by `/api/health` and shown in the status bar. The build gets
 * `git describe --tags --always --dirty` (the tag, else the short commit hash, `-dirty` for uncommitted changes; the
 * package.json version without git); in development it is `dev`.
 */
export const APP_VERSION: string = typeof LLAMA_WEBUI_VERSION === 'string' ? LLAMA_WEBUI_VERSION : 'dev';

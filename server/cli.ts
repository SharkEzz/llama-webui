import { parseArgs } from 'node:util';
import { isStandalone } from './standalone';

/** Launch options: flag, else environment variable, else default. */
export interface CliOptions {
  host: string;
  port: number;
  /** Absent: `dataDir()` default rule ($XDG_DATA_HOME/llama-webui, else ~/.local/share/llama-webui). */
  dataDir?: string;
}

export type CliResult = { kind: 'run'; options: CliOptions } | { kind: 'help' } | { kind: 'error'; message: string };

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7860;

const SOURCE_USAGE = `  bun run dev [options]      development (bun --hot, HMR)
  bun run start [options]    production`;
const STANDALONE_USAGE = '  llama-webui [options]';

/** `--help`; the usage lines depend on how it runs: compiled executable or from source. */
export const helpText = (standalone = isStandalone) => `llama-webui: web UI to drive llama-server \
(API, WebSocket and UI in a single Bun process).

Usage:
${standalone ? STANDALONE_USAGE : SOURCE_USAGE}

Options:
  --host <address>       listen address (default: ${DEFAULT_HOST}); 0.0.0.0 to open it to the local network
                         (no authentication)
                         env: LLAMA_WEBUI_HOST
  --port <port>          HTTP port of the UI, API and WebSocket (default: ${DEFAULT_PORT})
                         env: LLAMA_WEBUI_PORT
  --data-dir <path>      data directory (SQLite database); default: $XDG_DATA_HOME/llama-webui,
                         else ~/.local/share/llama-webui
                         env: LLAMA_WEBUI_DATA_DIR
  -h, --help             show this help

A flag takes precedence over the matching environment variable.

Hugging Face downloads (Models page):
  HF_TOKEN               access token (gated or private repos, higher rate limits); without it, the token
                         saved by \`hf auth login\` is used (HF_TOKEN_PATH, else $HF_HOME/token,
                         default ~/.cache/huggingface/token)
  HF_ENDPOINT            Hugging Face endpoint or mirror (default: https://huggingface.co)
`;

function parsePort(raw: string, source: string): number | string {
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return `invalid ${source}: “${raw}” (integer from 1 to 65535)`;
  return port;
}

/** Reads the arguments (without `bun` or the script) and the environment; never exits, reads nothing else. */
export function parseCli(argv: string[], env: Record<string, string | undefined> = process.env): CliResult {
  let values: { host?: string; port?: string; 'data-dir'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'data-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
  if (values.help) return { kind: 'help' };

  const host = values.host ?? (env.LLAMA_WEBUI_HOST || DEFAULT_HOST);
  if (!host) return { kind: 'error', message: 'empty --host' };

  let port = DEFAULT_PORT;
  const rawPort = values.port ?? (env.LLAMA_WEBUI_PORT || undefined);
  if (rawPort !== undefined) {
    const parsed = parsePort(rawPort, values.port !== undefined ? '--port' : 'LLAMA_WEBUI_PORT');
    if (typeof parsed === 'string') return { kind: 'error', message: parsed };
    port = parsed;
  }

  const dataDir = values['data-dir'] ?? (env.LLAMA_WEBUI_DATA_DIR || undefined);
  if (dataDir === '') return { kind: 'error', message: 'empty --data-dir' };

  return { kind: 'run', options: { host, port, ...(dataDir ? { dataDir } : {}) } };
}

/** Process launch options; prints the help (code 0) or the error (code 2) and exits when needed. */
export function cliOptionsOrExit(argv = process.argv.slice(2)): CliOptions {
  const res = parseCli(argv);
  if (res.kind === 'run') return res.options;
  if (res.kind === 'help') {
    process.stdout.write(helpText());
    process.exit(0);
  }
  process.stderr.write(`llama-webui: ${res.message}\n\n${helpText()}`);
  process.exit(2);
}

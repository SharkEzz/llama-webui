import { parseArgs } from 'node:util';

/** Options de lancement : flag, sinon variable d'environnement, sinon défaut. */
export interface CliOptions {
  host: string;
  port: number;
  /** Absent : règle par défaut de `dataDir()` ($XDG_DATA_HOME/llama-webui, sinon ~/.local/share/llama-webui). */
  dataDir?: string;
}

export type CliResult = { kind: 'run'; options: CliOptions } | { kind: 'help' } | { kind: 'error'; message: string };

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7860;

export const HELP_TEXT = `llama-webui : interface web pour piloter llama-server (API, WebSocket et UI dans un seul process Bun).

Usage :
  bun run dev [options]      développement (bun --hot, HMR)
  bun run start [options]    production

Options :
  --host <adresse>       adresse d'écoute (défaut : ${DEFAULT_HOST}) ; 0.0.0.0 pour ouvrir au réseau local
                         (aucune authentification)
                         env : LLAMA_WEBUI_HOST
  --port <port>          port HTTP de l'UI, de l'API et du WebSocket (défaut : ${DEFAULT_PORT})
                         env : LLAMA_WEBUI_PORT
  --data-dir <chemin>    répertoire des données (base SQLite) ; défaut : $XDG_DATA_HOME/llama-webui,
                         sinon ~/.local/share/llama-webui
                         env : LLAMA_WEBUI_DATA_DIR
  -h, --help             affiche cette aide

Un flag l'emporte sur la variable d'environnement correspondante.
`;

function parsePort(raw: string, source: string): number | string {
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return `${source} invalide : « ${raw} » (entier de 1 à 65535)`;
  return port;
}

/** Lit les arguments (sans `bun` ni le script) et l'environnement ; ne quitte pas, ne lit rien d'autre. */
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
  if (!host) return { kind: 'error', message: '--host vide' };

  let port = DEFAULT_PORT;
  const rawPort = values.port ?? (env.LLAMA_WEBUI_PORT || undefined);
  if (rawPort !== undefined) {
    const parsed = parsePort(rawPort, values.port !== undefined ? '--port' : 'LLAMA_WEBUI_PORT');
    if (typeof parsed === 'string') return { kind: 'error', message: parsed };
    port = parsed;
  }

  const dataDir = values['data-dir'] ?? (env.LLAMA_WEBUI_DATA_DIR || undefined);
  if (dataDir === '') return { kind: 'error', message: '--data-dir vide' };

  return { kind: 'run', options: { host, port, ...(dataDir ? { dataDir } : {}) } };
}

/** Options de lancement du process ; affiche l'aide (code 0) ou l'erreur (code 2) et quitte si besoin. */
export function cliOptionsOrExit(argv = Bun.argv.slice(2)): CliOptions {
  const res = parseCli(argv);
  if (res.kind === 'run') return res.options;
  if (res.kind === 'help') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  process.stderr.write(`llama-webui : ${res.message}\n\n${HELP_TEXT}`);
  process.exit(2);
}

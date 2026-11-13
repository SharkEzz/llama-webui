import { parseCli } from './cli';
import { openDb } from './db/open';
import { SettingsRepo } from './db/settings';
import { type AppDeps, createDeps } from './deps';
import { useEnvProxy } from './env';
import { dbPath } from './paths';
import { createRuntime, serverView, startMonitor } from './runtime';
import { profilePaths } from './supervisor/args';
import { externalWatcher } from './supervisor/external';

const EXTERNAL_CHECK_MS = 2000;

export interface Booted {
  deps: AppDeps;
  /** Undoes everything `boot()` built, in reverse order. */
  stack: AsyncDisposableStack;
}

/**
 * Builds llama-webui and starts its effects (orphans, downloads, broadcasts, external server watch). The HTTP server is
 * Nitro's: no listening here, and no signal handler (Nitro's shutdown calls the `close` hook, which disposes `stack`).
 *
 * Each part registers what undoes it on the stack as it is created; a failure on the way undoes what was built.
 * Options come from the environment only: the dev worker has no argv, and the production launcher
 * (`bin/llama-webui.ts`) turns the flags into `LLAMA_WEBUI_HOST`/`LLAMA_WEBUI_PORT`/`LLAMA_WEBUI_DATA_DIR`.
 */
export async function boot(): Promise<Booted> {
  await using stack = new AsyncDisposableStack();
  const parsed = parseCli([]);
  if (parsed.kind !== 'run') throw new Error(parsed.kind === 'error' ? parsed.message : 'unexpected --help');
  const cli = parsed.options;
  const restoreFetch = useEnvProxy();
  if (restoreFetch) stack.defer(restoreFetch);
  const db = stack.use(openDb(dbPath(cli.dataDir)));
  const runtime = createRuntime();
  const { supervisor, logs, benchGate } = runtime;
  stack.defer(() => supervisor.stop());
  const monitor = await startMonitor(runtime, new SettingsRepo(db).get());
  stack.defer(() => monitor.stop());
  const deps = createDeps({ db, runtime, monitor, hostname: cli.host });
  const { hub, settings, conversations, chatRuns, benchRuns, sweeps, benchRunner, profiles, downloads, placement } =
    deps;
  stack.defer(() => placement.dispose());
  // Open WebSockets are closed (1001).
  stack.defer(() => hub.dispose());
  // Undone first: running replies, the benchmark and the download are saved as “stopped”, “interrupted” or resumable
  // while llama-server still runs (a reply would otherwise see the disconnect and end as “error”).
  stack.defer(() => downloads.dispose());
  stack.defer(() => benchRunner.dispose());
  stack.defer(() => chatRuns.dispose());

  // A reply left “streaming” when the last process stopped is marked “stopped”.
  conversations.stopOrphans();
  // A benchmark run left “running” is marked “interrupted”, and so is its sweep (Resume button).
  benchRuns.stopOrphans();
  sweeps.stopOrphans();
  monitor.setModelPathResolver((id) => {
    const p = profiles.get(id);
    return p ? profilePaths(p).model : null;
  });
  // Hugging Face downloads: the item left downloading resumes from its `.part`.
  downloads.resume();

  supervisor.subscribe(() => hub.broadcast({ type: 'server-state', payload: serverView(supervisor) }));
  logs.onLines((lines) => hub.broadcast({ type: 'log', payload: lines }));
  monitor.onSnapshot((s) => hub.broadcast({ type: 'snapshot', payload: s }));
  placement.onChange((p) => hub.broadcast({ type: 'placement', payload: p }));

  // External server: detected at startup then watched (leaves the “external” state when it stops).
  const checkExternal = externalWatcher({
    supervisor,
    ports: () => [settings.get().port, supervisor.lastCommand?.port],
    paused: () => benchGate.held || benchRunner.busy,
  });
  void checkExternal();
  // Cleared first at shutdown: no check runs while the rest stops.
  stack.use(setInterval(() => void checkExternal(), EXTERNAL_CHECK_MS));

  return { deps, stack: stack.move() };
}

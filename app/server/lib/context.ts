import { type Booted, boot } from './boot';
import type { AppDeps } from './deps';
import { APP_VERSION } from './version';

/**
 * The live runtime, on `globalThis`: Nitro's dev reload re-evaluates the changed file and its importers in the same
 * worker thread, without a `close` hook (the spike's S0 probe). This module imports, through `boot()`, every module the
 * runtime is built from, so it is re-evaluated, with a new `OWNER`, exactly when one of them changes.
 */
interface Live {
  /** The evaluation of this module that started it. */
  owner: object;
  booting: Promise<Booted>;
  booted?: Booted;
  failed?: true;
}

interface Registry {
  live?: Live;
  exitHook?: true;
}

const g = globalThis as { [k: symbol]: Registry | undefined };
const KEY = Symbol.for('llama-webui.runtime');
g[KEY] ??= {};
const registry: Registry = g[KEY];
const OWNER = {};

async function undo(live: Live | undefined): Promise<void> {
  const booted = await live?.booting.catch(() => null);
  await booted?.stack.disposeAsync();
}

/**
 * Starts the runtime, or keeps the live one: a reload that changed only routes (this module not re-evaluated) keeps
 * llama-server running. A reload that changed business code first undoes the previous runtime, then builds anew.
 */
export function start(): Promise<Booted> {
  const prev = registry.live;
  if (prev && prev.owner === OWNER && !prev.failed) return prev.booting;
  const live: Live = {
    owner: OWNER,
    booting: (async () => {
      await undo(prev);
      return boot();
    })(),
  };
  live.booting.then(
    (b) => {
      live.booted = b;
      console.log(`[llama-webui] ready (${APP_VERSION})`);
    },
    (err: unknown) => {
      live.failed = true;
      console.error('[llama-webui] startup failed:', err);
    },
  );
  registry.live = live;
  if (!registry.exitHook) {
    registry.exitHook = true;
    // Last resort, synchronous: the process exits without the stack (an uncaught error).
    process.on('exit', () => registry.live?.booted?.deps.runtime.supervisor.killNow());
  }
  return live.booting;
}

/** Shutdown (`close` hook): undoes the live runtime, once. */
export async function stop(): Promise<void> {
  const live = registry.live;
  registry.live = undefined;
  if (live?.booted?.deps.runtime.supervisor.managedPid != null) console.log('[llama-webui] stopping llama-server…');
  await undo(live);
}

/** The runtime once started (`middleware/00.ready.ts` waits for it); rejects when startup failed. */
export function ready(): Promise<Booted> {
  const live = registry.live;
  if (!live) return Promise.reject(new Error('llama-webui is stopping'));
  return live.booting;
}

/** The app's objects, for a handler: `middleware/00.ready.ts` has already waited for startup. */
export function deps(): AppDeps {
  const booted = registry.live?.booted;
  if (!booted) throw new Error('llama-webui is not started');
  return booted.deps;
}

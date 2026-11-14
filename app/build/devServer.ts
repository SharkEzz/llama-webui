/**
 * The server half of `vite dev`: the Effect server from source under `node --watch`, on a free loopback port, with
 * `/api` and `/ws` proxied to it. Vite keeps the public address and serves the UI with HMR; a save of a file the
 * server imports (`server/`, `packages/`) restarts the server (a new `bootId`). Stopping Vite (SIGINT, SIGTERM) stops
 * the server with SIGTERM and waits for it; a second signal kills it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Plugin } from 'vite';

/** A port nothing listens on, on 127.0.0.1. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((closed) => server.close(closed));
  return port;
}

/** Whether `child` has exited (or was never started). */
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Sends `signal` to the process group of `child` (`node --watch` and the server it runs); gone already, nothing. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || exited(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone.
  }
}

/** Resolves once something accepts a connection on `port` of 127.0.0.1, or after `ms` (the proxy then answers). */
async function reachable(port: number, ms: number): Promise<void> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const ok = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });
    if (ok) return;
    await sleep(50);
  }
}

/** The paths the server answers; the rest is Vite's. */
const API = '^/api(?:[/?]|$)';
const WS = '^/ws(?:\\?|$)';

export function devServer(): Plugin {
  let port = 0;
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  /** Undoes what `configureServer` added to the process (its signal and exit listeners). */
  let detach = () => {};

  /**
   * SIGTERM to `node --watch`, then its end: it passes the signal on to the server and exits once the server did. Not
   * to the group: the server would get it twice, and a second signal makes it exit without its stop.
   */
  const stop = (): Promise<void> => {
    const proc = child;
    if (proc === undefined || exited(proc)) return Promise.resolve();
    stopping ??= (async () => {
      const gone = once(proc, 'exit');
      proc.kill('SIGTERM');
      await gone;
    })();
    return stopping;
  };

  return {
    name: 'llama-webui:dev-server',
    apply: 'serve',

    async config() {
      port = await freePort();
      const target = `http://127.0.0.1:${port}`;
      // `changeOrigin: false`: the server's guard reads the Host and Origin the browser sent to Vite.
      return {
        server: {
          proxy: {
            [API]: { target, changeOrigin: false },
            [WS]: { target, changeOrigin: false, ws: true },
          },
        },
      };
    },

    configureServer(server) {
      const main = resolve(server.config.root, 'server/main.ts');
      // Its own process group (`detached`): a Ctrl+C in the terminal reaches Vite only, which stops the server once;
      // the server would otherwise get it twice (from the terminal and from `node --watch`) and exit without its stop.
      const proc = spawn(
        process.execPath,
        ['--watch', '--watch-preserve-output', main, '--host', '127.0.0.1', '--port', String(port)],
        { env: { ...process.env, LLAMA_WEBUI_DEV: '1' }, stdio: ['ignore', 'inherit', 'inherit'], detached: true },
      );
      child = proc;
      stopping = undefined;

      // While the server starts (or restarts after a save), an API request waits for it, as it would for the
      // production server's start, rather than failing in the proxy. Before Vite's own middlewares, its proxy included.
      const api = new RegExp(API);
      server.middlewares.use((req, _res, next) => {
        if (api.test(req.url ?? '')) void reachable(port, 10_000).then(() => next());
        else next();
      });

      // Vite stops on SIGTERM by itself (`server.close()`, then the `closeServer` hook), not on SIGINT: as a shell does
      // on Ctrl+C, it exits 130 once the server stopped, first, so that an open page gets the server's 1001.
      // A second signal kills the server and exits at once.
      let signals = 0;
      const onSignal = (signal: NodeJS.Signals) => {
        signals += 1;
        if (signals > 1) {
          signalGroup(proc, 'SIGKILL');
          process.exit(130);
        }
        if (signal === 'SIGINT')
          void stop()
            .then(() => server.close())
            .finally(() => process.exit(130));
      };
      // Whatever ends Vite, the server does not outlive it.
      const onExit = () => signalGroup(proc, 'SIGKILL');
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.on('exit', onExit);
      detach = () => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('exit', onExit);
      };
    },

    // On a stop, and on a restart of Vite (its config changed): the next `configureServer` starts a new server.
    async closeServer() {
      await stop();
      detach();
    },
  };
}

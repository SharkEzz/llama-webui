/**
 * The server half of `vite dev`: the Effect server from source under `node --watch`, on a free loopback port, with
 * `/api` and `/ws` proxied to it. Vite keeps the public address and serves the UI with HMR; a save of a file the
 * server imports (`server/`, `packages/`) restarts the server (a new `bootId`). Stopping Vite (SIGINT, SIGTERM) stops
 * the server with SIGTERM and waits for it (SIGHUP too); a second signal kills it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { constants } from 'node:os';
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

/** A connection to `port` of 127.0.0.1, once something accepts one (tried every 50 ms); none after `ms`. */
async function connection(port: number, ms: number): Promise<Socket | undefined> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const socket = await new Promise<Socket | undefined>((done) => {
      const trying = connect(port, '127.0.0.1');
      trying.once('connect', () => done(trying));
      trying.once('error', () => done(undefined));
    });
    if (socket !== undefined) return socket;
    await sleep(50);
  }
  return undefined;
}

/**
 * Whether the server accepts connections on `port()`, told by one connection kept open to it rather than by a probe
 * for each question: while it is open the server is up; it closes when the server stops (a restart of `node --watch`,
 * an exit) or drops it, and the next question waits for a server again. The connection sends nothing: Node's HTTP
 * server closes it after a minute without a request (its 408), so the next question takes a new one, and closes it at
 * once when it stops, so it holds no stop.
 */
export function serverLink(port: () => number) {
  let open: Socket | undefined;
  let waiting: Promise<boolean> | undefined;
  let closed = false;
  return {
    /**
     * `true` at once while the connection is open. Else a wait for the server, `ms` at most, shared by those who ask
     * meanwhile (they get the first one's limit): whether it accepted a connection.
     */
    up(ms: number): true | Promise<boolean> {
      if (open !== undefined) return true;
      waiting ??= connection(port(), ms).then((socket) => {
        waiting = undefined;
        if (socket === undefined) return false;
        if (closed) {
          socket.destroy();
          return false;
        }
        open = socket;
        socket.once('close', () => {
          if (open === socket) open = undefined;
        });
        // Its end is all that is read from it; it does not keep Vite running.
        socket.on('error', () => {});
        socket.resume();
        socket.unref();
        return true;
      });
      return waiting;
    },
    /** Drops the connection, and takes no other. */
    close() {
      closed = true;
      open?.destroy();
      open = undefined;
    },
  };
}

/** How long an API request waits for a server that starts. */
const SERVER_WAIT_MS = 10_000;

/** The paths the server answers; the rest is Vite's. */
const API = /^\/api(?:[/?]|$)/;
const WS = /^\/ws(?:\?|$)/;

export function devServer(): Plugin {
  let port = 0;
  let child: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  let link: ReturnType<typeof serverLink> | undefined;
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
            [API.source]: { target, changeOrigin: false },
            [WS.source]: { target, changeOrigin: false, ws: true },
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
        ['--watch', '--watch-preserve-output', main, '--host', '127.0.0.1', '--port', port.toString(10)],
        { env: { ...process.env, LLAMA_WEBUI_DEV: '1' }, stdio: ['ignore', 'inherit', 'inherit'], detached: true },
      );
      child = proc;
      stopping = undefined;

      // While the server starts (or restarts after a save), an API request waits for it, as it would for the
      // production server's start, rather than failing in the proxy. Before Vite's own middlewares, its proxy included.
      // A server that still accepts nothing after 10 s is said, and the proxy answers for it.
      const serving = serverLink(() => port);
      link = serving;
      server.middlewares.use((req, _res, next) => {
        const up = API.test(req.url ?? '') ? serving.up(SERVER_WAIT_MS) : true;
        if (up === true) {
          next();
          return;
        }
        void up.then((ok) => {
          if (!ok) {
            server.config.logger.error(
              `API not reachable on "${req.url}": the server accepted no connection in ${SERVER_WAIT_MS / 1000} s`,
              { timestamp: true },
            );
          }
          next();
        });
      });

      // Vite stops on SIGTERM by itself (`server.close()`, then the `closeServer` hook), not on SIGINT (Ctrl+C) nor
      // SIGHUP (the terminal closed): on those, the server stops first, so that an open page gets its 1001, then Vite,
      // and the exit code is a shell's (128 + the signal). A second signal kills the server and exits at once.
      let signals = 0;
      const onSignal = (signal: NodeJS.Signals) => {
        signals += 1;
        if (signals > 1) {
          signalGroup(proc, 'SIGKILL');
          process.exit(130);
        }
        if (signal !== 'SIGTERM')
          void stop()
            .then(() => server.close())
            .finally(() => process.exit(128 + constants.signals[signal]));
      };
      // When Vite exits, the server does not outlive it. A SIGKILL of Vite is the one end nothing can catch: `node
      // --watch` and the server, in their own process group, then keep running.
      const onExit = () => signalGroup(proc, 'SIGKILL');
      const signalsHandled: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signalsHandled) process.on(signal, onSignal);
      process.on('exit', onExit);
      detach = () => {
        for (const signal of signalsHandled) process.off(signal, onSignal);
        process.off('exit', onExit);
      };
    },

    // On a stop, and on a restart of Vite (its config changed): the next `configureServer` starts a new server.
    async closeServer() {
      link?.close();
      await stop();
      detach();
    },
  };
}

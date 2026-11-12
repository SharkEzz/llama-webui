// The host of the NVML sampler (`worker.ts`). Run as is by Node in its tests (erasable syntax, `node:*` only).
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** What `NvmlMonitor` drives: the sampler, with the surface of a web `Worker` (Bun's, which it was written for). */
export interface WorkerLike {
  postMessage(m: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/**
 * The sampler at `url` (the worker module), in a child process behind the `WorkerLike` surface. Not a worker thread:
 * Node's exit waits for every thread, and one stuck in an NVML call (a driver fault) would hold the process forever,
 * even on Ctrl-C. A child process is killed (SIGKILL) whatever it is doing.
 */
export function sampler(url: URL): WorkerLike {
  const child = fork(fileURLToPath(url), [], {
    // `node:ffi` is experimental: its warning would print on every start.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'advanced', // structured clone, as a worker's messages
  });
  // Never keep this process alive: neither the child nor its channel.
  child.unref();
  child.channel?.unref();
  const like: WorkerLike = {
    postMessage: (m) => {
      if (child.connected) child.send(m as object);
    },
    terminate: () => {
      child.kill('SIGKILL');
    },
    onmessage: null,
    onerror: null,
  };
  child.on('message', (data: unknown) => like.onmessage?.({ data }));
  child.on('error', (err) => like.onerror?.(err));
  // A sampler that cannot load (or crashes) exits: the same failure as an error.
  child.on('exit', (code, signal) => like.onerror?.(new Error(`the NVML sampler exited (${signal ?? code})`)));
  return like;
}

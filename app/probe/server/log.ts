import { appendFileSync } from 'node:fs';
import { isMainThread, threadId } from 'node:worker_threads';

const file = process.env.PROBE_LOG ?? '/tmp/nitro-probe.log';
export const log = (msg: string) =>
  appendFileSync(
    file,
    `${new Date().toISOString()} pid=${process.pid} ppid=${process.ppid} main=${isMainThread} tid=${threadId} ${msg}\n`,
  );

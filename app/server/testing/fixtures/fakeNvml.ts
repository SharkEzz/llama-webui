// `node fakeNvml.ts <behaviour> <dir>`: a fake NVML sampler that speaks the protocol of `collectors/nvml/protocol.ts`
// on its stdin and stdout. It appends its pid to `<dir>/pids` and each line it receives to `<dir>/received`.
// - `ready-then-sample`: answers `start` with `ready`, then sends `SNAPSHOT` every `intervalMs`; exits 0 once its
//   stdin ends.
// - `slow-ready`: as `ready-then-sample`, its `ready` 1.5 s after `start` (a driver slow to come up).
// - `sample-once`: answers `ready`, sends one sample, then nothing; exits 0 once its stdin ends.
// - `error`: answers `start` with an `error`; exits 0 once its stdin ends.
// - `silent`: never answers, and stays up once its stdin ends: only a kill ends it.
// - `exit-after-ready`: answers `ready`, sends one sample, then exits 0 after 300 ms.
// - `garbage-before-ready`: answers `start` with a line that is not a message, then stays up: only a kill ends it.
// - `garbage-after-ready`: answers `ready` and one sample, then a line that is not a message, then samples every
//   `intervalMs` and stays up: only a kill ends it.
// - `busy`: answers `ready`, then spins in a busy loop, as a sampler stuck in a native call: only SIGKILL ends it.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [behaviour = '', dir = ''] = process.argv.slice(2);

/** What the fake samples: one card, and two processes on it (the VRAM of the second one unknown). */
const SNAPSHOT = {
  gpus: [
    {
      key: 'nvidia:GPU-fake',
      vendor: 'nvidia',
      name: 'Fake GPU',
      busId: '0000:01:00.0',
      utilPct: 12,
      vramUsedBytes: 6 * 1024 ** 3,
      vramTotalBytes: 16 * 1024 ** 3,
      tempC: 40,
      powerW: 50,
    },
  ],
  procs: [
    { pid: 4242, key: 'nvidia:GPU-fake', usedBytes: 512 * 1024 ** 2 },
    { pid: 4343, key: 'nvidia:GPU-fake', usedBytes: null },
  ],
  system: { driver: '580.95.05', cudaDriver: 13000 },
};

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

appendFileSync(join(dir, 'pids'), `${process.pid}\n`);

if (behaviour === 'silent') setInterval(() => {}, 60_000);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  appendFileSync(join(dir, 'received'), `${line}\n`);
  const command = JSON.parse(line) as { type: string; intervalMs: number };
  if (command.type !== 'start') return;
  if (behaviour === 'error') send({ type: 'error', message: 'no NVML here' });
  if (behaviour === 'ready-then-sample') {
    send({ type: 'ready' });
    send({ type: 'sample', snapshot: SNAPSHOT });
    setInterval(() => send({ type: 'sample', snapshot: SNAPSHOT }), command.intervalMs).unref();
  }
  if (behaviour === 'slow-ready') {
    setTimeout(() => {
      send({ type: 'ready' });
      send({ type: 'sample', snapshot: SNAPSHOT });
      setInterval(() => send({ type: 'sample', snapshot: SNAPSHOT }), command.intervalMs).unref();
    }, 1500).unref();
  }
  if (behaviour === 'sample-once') {
    send({ type: 'ready' });
    send({ type: 'sample', snapshot: SNAPSHOT });
  }
  if (behaviour === 'exit-after-ready') {
    send({ type: 'ready' });
    send({ type: 'sample', snapshot: SNAPSHOT });
    setTimeout(() => process.exit(0), 300);
  }
  if (behaviour === 'garbage-before-ready') {
    setInterval(() => {}, 60_000);
    process.stdout.write('not a message\n');
  }
  if (behaviour === 'garbage-after-ready') {
    setInterval(() => send({ type: 'sample', snapshot: SNAPSHOT }), command.intervalMs);
    send({ type: 'ready' });
    send({ type: 'sample', snapshot: SNAPSHOT });
    setTimeout(() => process.stdout.write('Stray output of a native library\n'), 300);
  }
  if (behaviour === 'busy') {
    // A handler as the real sampler's runtime installs: blocked in the loop, it never runs, and SIGTERM ends nothing.
    process.on('SIGTERM', () => process.exit(0));
    send({ type: 'ready' });
    // The write leaves before the loop starts: the loop never yields.
    setTimeout(() => {
      for (;;);
    }, 50);
  }
});
lines.on('close', () => {
  if (['ready-then-sample', 'slow-ready', 'sample-once', 'error'].includes(behaviour)) process.exit(0);
});

import { assert, describe, it } from '@effect/vitest';
import type { GpuReading } from '@llama-webui/shared';
import { Array as Arr, Effect, Option } from 'effect';
import type { AmdCard } from '../collectors/amdgpu.ts';
import type { Collectors } from '../collectors/Collectors.ts';
import { collectGpus } from './gpus.ts';

const card = (pdev: string, node: string): AmdCard => ({
  card: node,
  pdev,
  devicePath: `/sys/devices/${pdev}`,
  hwmonPath: null,
  name: `AMD GPU ${pdev}`,
  nodes: [node],
});

const reading = (c: AmdCard): GpuReading => ({
  key: `amd:${c.pdev}`,
  vendor: 'amd',
  name: c.name,
  busId: c.pdev,
  utilPct: 0,
  vramUsedBytes: 0,
  vramTotalBytes: 0,
  tempC: null,
  powerW: null,
});

/** The collectors with `cards` (asleep when listed in `asleep`) and no NVIDIA card; the calls of `procVram` recorded. */
const collectorsWith = (cards: ReadonlyArray<AmdCard>, asleep: ReadonlyArray<string> = []) => {
  const calls: Array<ReadonlySet<string>> = [];
  const collectors: Collectors['Service'] = {
    nvidia: {
      gpus: Effect.succeed([]),
      procVram: () => Effect.succeed(new Map()),
      refreshApps: Effect.void,
      configure: () => Effect.void,
    },
    nvidiaSource: Effect.succeed('nvml'),
    nvmlSystem: Effect.succeed(null),
    amd: {
      cards,
      read: (c) => Effect.succeed(reading(c)),
      procVram: (_pid, skipNodes) =>
        Effect.sync(() => {
          calls.push(skipNodes);
          return new Map([[`amd:${cards[0]?.pdev ?? ''}`, 1024]]);
        }),
      suspended: (c) => Effect.succeed(asleep.includes(c.pdev)),
    },
    proc: () => Effect.succeedNone,
    system: Effect.succeedNone,
    disk: Effect.succeedNone,
    configure: () => Effect.void,
  };
  return { collectors, calls };
};

describe('collectGpus', () => {
  it.effect("reads the process's descriptors when an AMD card is read, skipping the nodes of the others", () =>
    Effect.gen(function* () {
      const { collectors, calls } = collectorsWith([card('0000:08:00.0', 'card1'), card('0000:0d:00.0', 'card2')]);
      const gpus = yield* collectGpus({ collectors, pid: 42, hiddenGpus: ['0000:0d:00.0'] });
      assert.deepStrictEqual(calls, [new Set(['card2'])]);
      const used = Arr.findFirst(gpus, (g) => g.busId === '0000:08:00.0');
      assert.deepStrictEqual(
        Option.map(used, (g) => g.procVramBytes),
        Option.some(1024),
      );
    }),
  );

  it.effect('does not read the descriptors of the process when no AMD card is read (hidden or asleep)', () =>
    Effect.gen(function* () {
      const { collectors, calls } = collectorsWith(
        [card('0000:08:00.0', 'card1'), card('0000:0d:00.0', 'card2')],
        ['0000:08:00.0'],
      );
      const gpus = yield* collectGpus({ collectors, pid: 42, hiddenGpus: ['0000:0d:00.0'] });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(
        Arr.map(gpus, (g) => [g.busId, g.procVramBytes]),
        [
          ['0000:08:00.0', 0],
          ['0000:0d:00.0', 0],
        ],
      );
    }),
  );

  it.effect('does not read the descriptors of the process on a machine without an AMD card', () =>
    Effect.gen(function* () {
      const { collectors, calls } = collectorsWith([]);
      yield* collectGpus({ collectors, pid: 42, hiddenGpus: [] });
      assert.deepStrictEqual(calls, []);
    }),
  );
});

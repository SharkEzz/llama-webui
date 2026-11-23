import { Array as Arr } from 'effect';
import type { ModelMemory } from 'llamacpp-js/models';
import { describe, expect, test } from 'vitest';
import { placementFromMemory } from './placementMemory.ts';

const sampleMemory: ModelMemory = {
  n_ctx: 8192,
  devices: [
    { kind: 'device', name: 'CUDA0', total: 24_000, free: 10_000, model: 12_000, context: 1500, compute: 500 },
    { kind: 'host', name: 'Host', model: 0, context: 0, compute: 200 },
    { kind: 'host', name: 'EmptyHost', model: 0, context: 0, compute: 0 },
  ],
};

describe('placementFromMemory', () => {
  test('keeps remote RPC buffers unmapped while still resolving a local Vulkan GPU', () => {
    const placement = placementFromMemory({
      memory: {
        n_ctx: 8192,
        devices: [
          { kind: 'device', name: 'RPC0', model: 12_000, context: 1500, compute: 500 },
          { kind: 'device', name: 'Vulkan0', model: 4000, context: 500, compute: 250 },
        ],
      },
      gpus: [{ busId: '0000:01:00.0', vendor: 'amd' }],
    });
    expect(Arr.map(placement?.buffers ?? [], ({ device, busId }) => ({ device, busId }))).toEqual([
      { device: 'RPC0', busId: null },
      { device: 'Vulkan0', busId: '0000:01:00.0' },
    ]);
  });

  test('converts non-zero devices to PlacementBuffers and matches an unambiguous single GPU', () => {
    const p = placementFromMemory({
      memory: sampleMemory,
      gpus: [{ busId: '0000:01:00.0', vendor: 'nvidia' }],
    });
    expect(p).toEqual({
      launchSeq: 0,
      layers: null,
      source: 'sse',
      buffers: [
        { device: 'CUDA0', busId: '0000:01:00.0', modelBytes: 12_000, kvBytes: 1500, computeBytes: 500 },
        { device: 'Host', busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 200 },
      ],
    });
  });

  test('never guesses busId across multiple GPUs of the same vendor, but uses log busIds when present', () => {
    const gpus = [
      { busId: '0000:01:00.0', vendor: 'nvidia' as const },
      { busId: '0000:02:00.0', vendor: 'nvidia' as const },
    ];
    const withoutLogs = placementFromMemory({ memory: sampleMemory, gpus });
    expect(withoutLogs?.buffers[0]?.busId).toBeNull();

    const withLogs = placementFromMemory({
      memory: sampleMemory,
      gpus,
      busIds: new Map([['CUDA0', '0000:02:00.0']]),
      launchSeq: 4,
      layers: { offloaded: 49, total: 49 },
      p2p: 'active',
    });
    expect(withLogs).toEqual({
      launchSeq: 4,
      layers: { offloaded: 49, total: 49 },
      p2p: 'active',
      source: 'sse',
      buffers: [
        { device: 'CUDA0', busId: '0000:02:00.0', modelBytes: 12_000, kvBytes: 1500, computeBytes: 500 },
        { device: 'Host', busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 200 },
      ],
    });
  });

  test('returns null when every device reports zero bytes', () => {
    expect(
      placementFromMemory({
        memory: { n_ctx: 4096, devices: [{ kind: 'host', name: 'Host', model: 0, context: 0, compute: 0 }] },
      }),
    ).toBeNull();
  });
});

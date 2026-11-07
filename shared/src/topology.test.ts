import { expect, test } from 'bun:test';
import type { SlotView, Snapshot } from './monitor';
import type { ServerState } from './server';
import { hostDevice, pcieBps, phaseOf, placementTotals } from './topology';

const slot = (o: Partial<SlotView>): SlotView => ({
  id: 0,
  nCtx: 8000,
  processing: false,
  idTask: null,
  nPromptTokens: 0,
  nPromptProcessed: 0,
  nDecoded: 0,
  nRemain: null,
  ...o,
});

const snap = (o: Partial<Snapshot>): Snapshot => ({ health: 'ok', slots: null, ...o }) as unknown as Snapshot;

const ready: ServerState = { kind: 'ready', profile: 'p', profileId: 1, pid: 1, port: 8080, since: 0 };

test('phaseOf: no server, stopping or crashed → stopped', () => {
  expect(phaseOf(undefined, null)).toBe('stopped');
  expect(phaseOf({ kind: 'idle' }, snap({}))).toBe('stopped');
  expect(phaseOf({ kind: 'stopping', profile: 'p', profileId: 1, pid: 1, port: 1 }, snap({}))).toBe('stopped');
  expect(phaseOf({ kind: 'crashed', profile: 'p', profileId: 1, exitCode: 1, signal: null, at: 0 }, snap({}))).toBe(
    'stopped',
  );
});

test('phaseOf: starting, or ready while health is still loading → loading', () => {
  expect(phaseOf({ ...ready, kind: 'starting' }, null)).toBe('loading');
  expect(phaseOf(ready, snap({ health: 'loading' }))).toBe('loading');
});

test('phaseOf: ready with no busy slot → idle', () => {
  expect(phaseOf(ready, null)).toBe('idle');
  expect(phaseOf(ready, snap({ slots: [slot({})] }))).toBe('idle');
  expect(phaseOf({ kind: 'external', pid: null, port: 8080 }, snap({ slots: [] }))).toBe('idle');
});

test('phaseOf: a slot still reading its prompt → prompt, then generating', () => {
  expect(phaseOf(ready, snap({ slots: [slot({ processing: true, nPromptTokens: 100, nPromptProcessed: 40 })] }))).toBe(
    'prompt',
  );
  expect(
    phaseOf(
      ready,
      snap({ slots: [slot({ processing: true, nPromptTokens: 100, nPromptProcessed: 100, nDecoded: 3 })] }),
    ),
  ).toBe('generating');
  // One slot generating, another one reading a prompt: the prompt phase wins (it is the one moving data).
  expect(
    phaseOf(
      ready,
      snap({
        slots: [
          slot({ id: 0, processing: true, nPromptTokens: 10, nPromptProcessed: 10, nDecoded: 5 }),
          slot({ id: 1, processing: true, nPromptTokens: 50, nPromptProcessed: 1 }),
        ],
      }),
    ),
  ).toBe('prompt');
});

test('pcieBps: payload rate for a generation and width, unknown when either is missing', () => {
  expect(pcieBps(3, 16)).toBeCloseTo(16 * 0.985e9, -7);
  expect(pcieBps(4, 4)).toBeCloseTo(4 * 1.969e9, -7);
  expect(pcieBps(5, 8)).toBeCloseTo(8 * 3.938e9, -7);
  expect(pcieBps(null, 16)).toBeNull();
  expect(pcieBps(4, 0)).toBeNull();
  expect(pcieBps(9, 16)).toBeNull();
});

test('hostDevice: CPU-side buffers are not GPUs', () => {
  expect(hostDevice('CPU')).toBe(true);
  expect(hostDevice('CPU_Mapped')).toBe(true);
  expect(hostDevice('CUDA_Host')).toBe(true);
  expect(hostDevice('CPU_REPACK')).toBe(true);
  expect(hostDevice('CUDA0')).toBe(false);
  expect(hostDevice('ROCm0')).toBe(false);
  expect(hostDevice('Vulkan3')).toBe(false);
});

test('placementTotals: model bytes on GPUs vs host', () => {
  const t = placementTotals({
    launchSeq: 0,
    layers: { offloaded: 49, total: 49 },
    buffers: [
      { device: 'CUDA0', busId: '0000:01:00.0', modelBytes: 100, kvBytes: 10, computeBytes: 1 },
      { device: 'CPU_Mapped', busId: null, modelBytes: 50, kvBytes: 0, computeBytes: 0 },
      { device: 'CUDA_Host', busId: null, modelBytes: 0, kvBytes: 0, computeBytes: 5 },
    ],
  });
  expect(t).toEqual({ modelBytes: 150, gpuModelBytes: 100, hostModelBytes: 50 });
});

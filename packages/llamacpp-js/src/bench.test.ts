import { expect, test } from 'bun:test';
import { ERROR_LINE, OOM_LINE, parseBenchJson, parseBenchProgress, parseDeviceList } from './bench.ts';

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../../../testdata/llama-bench/${name}`).text();

test('parseBenchJson reads pp and tg from a real run', async () => {
  const r = parseBenchJson(await fixture('ok.json'))!;
  expect(r.pp!.tps).toBeCloseTo(9817.38, 1);
  expect(r.pp!.tokens).toBe(64);
  expect(r.tg!.tps).toBeCloseTo(410.81, 1);
  expect(r.tg!.tokens).toBe(16);
  expect(r.tg!.stddev).toBeGreaterThan(0);
  expect(r.build).toBe('b12119 (6f1e65437)');
});

test('parseBenchJson gives null on the truncated output of a failed load', async () => {
  expect(parseBenchJson(await fixture('oom-stdout.json'))).toBeNull();
});

test('parseBenchProgress reads the --progress lines', () => {
  expect(parseBenchProgress('llama-bench: benchmark 2/2: generation run 1/2')).toEqual({
    phase: 'generation',
    test: 2,
    tests: 2,
    run: 1,
    runs: 2,
  });
  expect(parseBenchProgress('llama-bench: benchmark 1/2: warmup prompt run')).toEqual({
    phase: 'warmup',
    test: 1,
    tests: 2,
    run: null,
    runs: null,
  });
  expect(parseBenchProgress('llama-bench: benchmark 1/2: starting')).toBeNull();
  expect(parseBenchProgress('ggml_cuda_init: found 2 CUDA devices')).toBeNull();
});

test('parseDeviceList keeps names with parentheses', async () => {
  const d = parseDeviceList(await fixture('list-devices.txt'));
  expect(d).toHaveLength(7);
  expect(d.find((x) => x.id === 'Vulkan3')).toEqual({
    id: 'Vulkan3',
    name: 'AMD Radeon RX 9070 XT (RADV GFX1201)',
    totalMib: 16304,
    freeMib: 16225,
    backend: 'Vulkan',
  });
  expect(d.find((x) => x.id === 'BLAS')?.backend).toBe('BLAS');
});

test('ERROR_LINE and OOM_LINE pick the lines that say why a tool stopped', async () => {
  const lines = (await fixture('oom-stderr.txt')).split('\n');
  expect(lines.some((l) => OOM_LINE.test(l))).toBe(true);
  expect(ERROR_LINE.test('llama_model_load: error loading model: tensor data is not within bounds')).toBe(true);
  expect(ERROR_LINE.test("terminate called after throwing an instance of 'std::runtime_error' what(): x")).toBe(true);
  expect(ERROR_LINE.test('load_tensors: offloaded 49/49 layers to GPU')).toBe(false);
});

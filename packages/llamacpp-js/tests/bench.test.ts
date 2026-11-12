import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_LINE, OOM_LINE, parseBenchJson, parseBenchProgress, parseDeviceList } from '../src/bench.ts';
import { closeTo, fixture } from './helpers.ts';

const bench = (name: string) => fixture(`llama-bench/${name}`);

test('parseBenchJson reads pp and tg from a real run', async () => {
  const r = parseBenchJson(await bench('ok.json'))!;
  closeTo(r.pp!.tps, 9817.38, 1);
  assert.equal(r.pp!.tokens, 64);
  closeTo(r.tg!.tps, 410.81, 1);
  assert.equal(r.tg!.tokens, 16);
  assert.ok(r.tg!.stddev > 0);
  assert.equal(r.build, 'b12119 (6f1e65437)');
});

test('parseBenchJson gives null on the truncated output of a failed load', async () => {
  assert.equal(parseBenchJson(await bench('oom-stdout.json')), null);
});

test('parseBenchProgress reads the --progress lines', () => {
  assert.deepEqual(parseBenchProgress('llama-bench: benchmark 2/2: generation run 1/2'), {
    phase: 'generation',
    test: 2,
    tests: 2,
    run: 1,
    runs: 2,
  });
  assert.deepEqual(parseBenchProgress('llama-bench: benchmark 1/2: warmup prompt run'), {
    phase: 'warmup',
    test: 1,
    tests: 2,
    run: null,
    runs: null,
  });
  assert.equal(parseBenchProgress('llama-bench: benchmark 1/2: starting'), null);
  assert.equal(parseBenchProgress('ggml_cuda_init: found 2 CUDA devices'), null);
});

test('parseDeviceList keeps names with parentheses', async () => {
  const d = parseDeviceList(await bench('list-devices.txt'));
  assert.equal(d.length, 7);
  assert.deepEqual(
    d.find((x) => x.id === 'Vulkan3'),
    {
      id: 'Vulkan3',
      name: 'AMD Radeon RX 9070 XT (RADV GFX1201)',
      totalMib: 16304,
      freeMib: 16225,
      backend: 'Vulkan',
    },
  );
  assert.equal(d.find((x) => x.id === 'BLAS')?.backend, 'BLAS');
});

test('ERROR_LINE and OOM_LINE pick the lines that say why a tool stopped', async () => {
  const lines = (await bench('oom-stderr.txt')).split('\n');
  assert.equal(
    lines.some((l) => OOM_LINE.test(l)),
    true,
  );
  assert.equal(ERROR_LINE.test('llama_model_load: error loading model: tensor data is not within bounds'), true);
  assert.equal(ERROR_LINE.test("terminate called after throwing an instance of 'std::runtime_error' what(): x"), true);
  assert.equal(ERROR_LINE.test('load_tensors: offloaded 49/49 layers to GPU'), false);
});

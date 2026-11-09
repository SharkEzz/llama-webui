import { expect, test } from 'bun:test';
import {
  type BenchParams,
  BenchSpecSchema,
  benchArgs,
  ignoredByBench,
  isOomError,
  OOM_ERROR,
  paramsFromServerArgs,
  serverArgs,
} from './bench';

test('paramsFromServerArgs splits a real profile into fields and the rest', () => {
  expect(
    paramsFromServerArgs([
      '--jinja',
      '-fa',
      'on',
      '-np',
      '1',
      '-c',
      '40000',
      '--spec-type',
      'draft-mtp',
      '-ngl',
      'all',
      '--device=CUDA0,Vulkan3',
      '-ot',
      'exps=CPU',
      '--override-tensor',
      'a=CUDA0,b=CPU',
      '-ts',
      '3,1',
      '--cache-type-k',
      'q8_0',
      '-fa',
    ]),
  ).toEqual({
    params: {
      fa: 'on',
      ngl: 'all',
      dev: ['CUDA0', 'Vulkan3'],
      ot: ['exps=CPU', 'a=CUDA0', 'b=CPU'],
      ts: [3, 1],
      ctk: 'q8_0',
    },
    rest: ['--jinja', '-np', '1', '-c', '40000', '--spec-type', 'draft-mtp'],
  });
});

test('an unreadable value stays in the rest with its flag', () => {
  expect(paramsFromServerArgs(['-ngl', 'beaucoup', '-t', '8'])).toEqual({
    params: { t: 8 },
    rest: ['-ngl', 'beaucoup'],
  });
});

test('each tool gets its own separators', () => {
  const p: BenchParams = { ngl: 'all', dev: ['CUDA0', 'CUDA1'], ts: [3, 1], ot: ['exps=CPU', 'a=CUDA0'], fa: 'on' };
  expect(benchArgs(p)).toEqual([
    '-ngl',
    '999',
    '-ot',
    'exps=CPU;a=CUDA0',
    '-dev',
    'CUDA0/CUDA1',
    '-ts',
    '3/1',
    '-fa',
    'on',
  ]);
  expect(serverArgs(p)).toEqual([
    '-ngl',
    'all',
    '-ot',
    'exps=CPU,a=CUDA0',
    '-dev',
    'CUDA0,CUDA1',
    '-ts',
    '3,1',
    '-fa',
    'on',
  ]);
  expect(paramsFromServerArgs(serverArgs(p)).params).toEqual(p);
});

test('ignoredByBench flags every speculative flag, not only --spec-type (#30)', () => {
  const args = ['--spec-draft-n-max', '16', '--spec-default', '-md', 'd.gguf', '--n-gpu-layers-draft', '99', '-t', '8'];
  expect(ignoredByBench(args).map((i) => i.flag)).toEqual([
    '--spec-draft-n-max',
    '--spec-default',
    '-md',
    '--n-gpu-layers-draft',
  ]);
});

test('ignoredByBench names context and speculative decoding', () => {
  expect(ignoredByBench(['-c', '40000', '--spec-type', 'draft-mtp', '--jinja']).map((i) => i.flag)).toEqual([
    '-c',
    '--spec-type',
  ]);
});

test('BenchSpecSchema refuses managed flags in serverArgs at their index', () => {
  const r = BenchSpecSchema.safeParse({
    kind: 'server',
    modelPath: '/m/a.gguf',
    mmprojPath: null,
    profileId: null,
    params: {},
    serverArgs: ['--jinja', '-ngl', '20', '--port', '9'],
  });
  expect(r.success).toBe(false);
  expect(r.error!.issues.map((i) => i.path)).toEqual([
    ['serverArgs', 1],
    ['serverArgs', 3],
  ]);
  expect(r.error!.issues[0]!.message).toBe('-ngl: use the -ngl field');
});

test('isOomError recognizes the current and the legacy out-of-memory errors', () => {
  expect(isOomError(`${OOM_ERROR}: unable to allocate CUDA1 buffer`)).toBe(true);
  expect(isOomError('Mémoire insuffisante : unable to allocate CUDA1 buffer')).toBe(true);
  expect(isOomError('llama-bench exited (code 2)')).toBe(false);
  expect(isOomError(null)).toBe(false);
});

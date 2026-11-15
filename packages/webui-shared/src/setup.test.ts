import { expect, test } from 'vitest';
import { ctxFromArgs } from './bench.ts';
import { isLoopback } from './setup.ts';
import { isSetupCheck } from './tuning.ts';

test('isSetupCheck: keeps machine checks, drops those needing a model or a running server', () => {
  for (const id of [
    'cpu.governor',
    'cpu.thp',
    'cpu.numa',
    'nvidia.persistence.0000:01:00.0',
    'build.age',
    'kernel.iommu',
  ])
    expect(isSetupCheck(id)).toBe(true);
  for (const id of [
    'cpu.memlock',
    'cpu.swappiness',
    'kernel.disk',
    'kernel.disk-speed',
    'kernel.swap',
    'nvidia.pcie.0000:01:00.0',
    'amd.pcie.0000:03:00.0',
    'build.simd',
  ])
    expect(isSetupCheck(id)).toBe(false);
});

test('ctxFromArgs: short, long and = forms; the last one wins; absent or invalid is undefined', () => {
  expect(ctxFromArgs(['-ngl', '99', '-c', '4096'])).toBe(4096);
  expect(ctxFromArgs(['--ctx-size', '8192'])).toBe(8192);
  expect(ctxFromArgs(['--ctx-size=16384'])).toBe(16384);
  expect(ctxFromArgs(['-c', '4096', '--ctx-size=32768'])).toBe(32768);
  expect(ctxFromArgs(['-ngl', '99'])).toBeUndefined();
  expect(ctxFromArgs(['-c', 'abc'])).toBeUndefined();
  expect(ctxFromArgs(['-c'])).toBeUndefined();
});

test('isLoopback', () => {
  expect(isLoopback('127.0.0.1')).toBe(true);
  expect(isLoopback('localhost')).toBe(true);
  expect(isLoopback('::1')).toBe(true);
  expect(isLoopback('0.0.0.0')).toBe(false);
  expect(isLoopback('192.168.0.20')).toBe(false);
});

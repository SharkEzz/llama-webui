import { expect, test } from 'vitest';
import { type CallFrame, type CpuProfile, type Origin, summarizeProfile } from './cpuprofile.ts';

const frame = (functionName: string, url = 'file:///app.js'): CallFrame => ({
  functionName,
  url,
  lineNumber: 0,
  columnNumber: 0,
});
const origin = (f: CallFrame): Origin => ({
  fn: f.functionName,
  module: f.url,
  line: f.lineNumber,
  group: f.functionName.startsWith('(') ? f.functionName : 'app',
});
// root → a → b, plus idle and GC; 1 ms per sample
const profile: CpuProfile = {
  nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 4, 5] },
    { id: 2, callFrame: frame('a'), children: [3] },
    { id: 3, callFrame: frame('b') },
    { id: 4, callFrame: frame('(idle)') },
    { id: 5, callFrame: frame('(garbage collector)') },
  ],
  samples: [2, 2, 3, 4, 4, 4, 5],
  timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000],
};

test('self time, inclusive time and groups of a profile', () => {
  const s = summarizeProfile(profile, origin);
  expect(s.totalMs).toBe(7);
  expect(s.activeMs).toBe(4); // a, a, b, GC
  expect(s.gcMs).toBe(1);
  expect(s.topSelf.find((r) => r.fn === 'a')?.ms).toBe(2);
  expect(s.topInclusive.find((r) => r.fn === 'a')?.ms).toBe(3);
  expect(s.byGroup.find((g) => g.group === 'app')?.ms).toBe(3);
});

test('a recursive function counts its inclusive time once per stack', () => {
  const recursive: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2] },
      { id: 2, callFrame: frame('walk'), children: [3] },
      { id: 3, callFrame: frame('walk') },
    ],
    samples: [3, 3],
    timeDeltas: [1000, 1000],
  };
  expect(summarizeProfile(recursive, origin).topInclusive.find((r) => r.fn === 'walk')?.ms).toBe(2);
});

test('a profile with no sample, or only idle, sums to zero', () => {
  expect(summarizeProfile({ ...profile, samples: [], timeDeltas: [] }, origin)).toMatchObject({
    totalMs: 0,
    activeMs: 0,
    gcMs: 0,
  });
  expect(summarizeProfile({ ...profile, samples: [4, 4], timeDeltas: [1000, 1000] }, origin).activeMs).toBe(0);
});

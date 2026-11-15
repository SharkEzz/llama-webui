import { expect, test } from 'vitest';
import { classify, countLines, median, upstreamRefs } from './measure.ts';

test('classify sorts paths by pattern, not by folder names of the Nitro server', () => {
  expect(classify('app/server/lib/db/sqlite.ts')).toBe('server');
  expect(classify('app/server/profiles/Profiles.ts')).toBe('server');
  expect(classify('app/server/lib/db/sqlite.test.ts')).toBe('serverTests');
  expect(classify('app/server/lib/testing/launch.ts')).toBe('serverTests');
  expect(classify('app/server/lib/contract/cases.ts')).toBe('serverTests');
  expect(classify('app/server/api.gen.ts')).toBeNull();
  expect(classify('packages/webui-shared/src/profile.ts')).toBe('shared');
  expect(classify('packages/webui-shared/src/profile.test.ts')).toBe('sharedTests');
  expect(classify('app/src/lib/api.ts')).toBe('web');
  expect(classify('app/src/features/chat/Chat.tsx')).toBe('web');
  expect(classify('app/src/lib/api.test.ts')).toBe('webTests');
  expect(classify('app/src/components/ui/button.tsx')).toBeNull();
  expect(classify('app/build/licenses.ts')).toBe('build');
  expect(classify('app/bin/llama-webui.ts')).toBe('build');
  expect(classify('app/vite.config.ts')).toBe('build');
});

test('classify never counts the reference folders', () => {
  expect(classify('app/server-legacy/lib/boot.ts')).toBeNull();
  expect(classify('repos/effect/packages/effect/src/Effect.ts')).toBeNull();
  expect(classify('app/server/lib/contract/golden.json')).toBeNull();
  expect(classify('site/src/root.tsx')).toBeNull();
});

test('countLines counts newlines, as wc -l', () => {
  expect(countLines('')).toBe(0);
  expect(countLines('a\nb\n')).toBe(2);
  expect(countLines('a\nb')).toBe(1);
});

test('median of an odd and of an even number of values', () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test('upstreamRefs finds owner/repo#N references with their line', () => {
  expect(upstreamRefs('a\n// see nitrojs/nitro#5133 and h3js/srvx#12\nb')).toEqual([
    { line: 2, ref: 'nitrojs/nitro#5133' },
    { line: 2, ref: 'h3js/srvx#12' },
  ]);
  expect(upstreamRefs('color: #5133; issue #76')).toEqual([]);
});

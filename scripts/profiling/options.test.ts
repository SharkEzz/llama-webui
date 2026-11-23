import { expect, test } from 'vitest';
import { baseRunName, parseOptions, UsageError } from './options.ts';

const NOW = new Date(2026, 10, 23, 9, 5);
const parse = (...argv: string[]) => parseOptions(argv, NOW);

test('--base names the ref measured first, as the run <name>.base', () => {
  const options = parse('chat', '--base', 'origin/master', '--name', 'pr-12');
  expect(options).toMatchObject({ command: 'run', scenarios: ['chat'], base: 'origin/master', compare: null });
  expect(baseRunName(options.name)).toBe('pr-12.base');
  expect(parse('chat').base).toBeNull();
});

test('--base is refused with --compare, with --no-build, and for a ref that reads as an option', () => {
  expect(() => parse('chat', '--base', 'master', '--compare', 'before')).toThrow(UsageError);
  expect(() => parse('chat', '--base', 'master', '--compare', 'before')).toThrow('one reference at a time');
  expect(() => parse('chat', '--base', 'master', '--no-build')).toThrow('the base has no build to reuse');
  expect(() => parse('chat', '--base=-x')).toThrow('--base takes a git ref');
  expect(() => parse('chat', '--base=')).toThrow('--base takes a git ref');
});

test('a run without a name is named by the date and time, and scenarios keep their order of the list', () => {
  const options = parse('load', 'idle');
  expect(options.name).toBe('2026-11-23-0905');
  expect(options.scenarios).toEqual(['idle', 'load']);
});

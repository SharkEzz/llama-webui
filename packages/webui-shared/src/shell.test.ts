import { expect, test } from 'vitest';
import { shellQuote, shellSplit } from './shell.ts';

test('shellQuote', () => {
  expect(shellQuote(['a', 'b c', "it's", ''])).toBe(`a 'b c' 'it'\\''s' ''`);
});

test('shellSplit undoes shellQuote', () => {
  for (const a of [['a', 'b c', "it's", '', '--chat-template', '{{ x }}'], [], ['-c', '8192'], ["'", "a'b'c", '  ']]) {
    expect(shellSplit(shellQuote(a))).toEqual(a);
  }
});

test('shellSplit reads what a user types: spaces separate, quotes group', () => {
  expect(shellSplit(`--ctx-size 8192 -ngl 99 --chat-template "a b"`)).toEqual([
    '--ctx-size',
    '8192',
    '-ngl',
    '99',
    '--chat-template',
    'a b',
  ]);
  expect(shellSplit('  a   b  ')).toEqual(['a', 'b']);
  expect(shellSplit('')).toEqual([]);
  expect(shellSplit(`"say \\"hi\\"" 'x\\y'`)).toEqual([`say "hi"`, 'x\\y']);
  expect(shellSplit(`a\\ b ""`)).toEqual(['a b', '']);
  expect(shellSplit(`--x="a b"c`)).toEqual(['--x=a bc']);
});

test('shellSplit says why it cannot read a line', () => {
  expect(shellSplit(`a "b`)).toEqual({ error: 'unclosed quote' });
  expect(shellSplit("a 'b")).toEqual({ error: 'unclosed quote' });
  expect(shellSplit('a \\')).toEqual({ error: 'trailing backslash' });
});

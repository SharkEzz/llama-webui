import { expect, test } from 'vitest';
import { lastLines, parseComment, reply, withoutPaths } from './comment.ts';

const args = (body: string) => {
  const parsed = parseComment(body);
  return parsed.ok ? parsed.args : parsed.error;
};

test('a bare /profiling measures everything; scenarios and --profile are taken from the first line', () => {
  expect(args('/profiling')).toEqual(['all']);
  expect(args('/profiling chat  dashboard chat')).toEqual(['chat', 'dashboard']);
  expect(args('  /profiling all --profile 6\r\nand a word about why')).toEqual(['all', '--profile', '6']);
  expect(args('/profiling --profile=12 idle')).toEqual(['idle', '--profile', '12']);
});

test('anything that is not a scenario or --profile <integer> is refused, and never echoed', () => {
  expect(args('/profiling chat; rm -rf ~')).toBe('word 1 after `/profiling` is neither a scenario nor `--profile`');
  expect(args('/profiling $(id)')).toContain('word 1');
  expect(args('/profiling chat --name x')).toContain('word 2');
  expect(args('/profiling --base master')).toContain('word 1');
  expect(args('/profiling --profile')).toContain('`--profile` takes a profile id');
  expect(args('/profiling --profile -1')).toContain('`--profile` takes a profile id');
  expect(args('/profiling --profile 6;id')).toContain('`--profile` takes a profile id');
});

test('a comment that is not the command is refused', () => {
  expect(args('/profilingx')).toContain('does not start with');
  expect(args('please /profiling')).toContain('does not start with');
  expect(args('')).toContain('does not start with');
  expect(args('thanks\n/profiling')).toContain('does not start with');
});

test('every argument a comment yields is a scenario name, --profile or digits', () => {
  for (const body of ['/profiling', '/profiling all', '/profiling load pages --profile 3', '/profiling --profile=9'])
    for (const arg of args(body)) expect(arg).toMatch(/^([a-z]+|--profile|\d+)$/);
});

test('paths of the runner are replaced, the longest first', () => {
  const paths = { '<home>': '/home/me', '<repo>': '/home/me/work/repo', '<none>': undefined, '<root>': '/' };
  expect(withoutPaths('see /home/me/work/repo/.cache/x and /home/me/data', paths)).toBe(
    'see <repo>/.cache/x and <home>/data',
  );
});

test('the last lines of a log come without colours or blank lines', () => {
  expect(lastLines('one\n\n\u001B[33mtwo\u001B[0m\nthree\n', 2)).toBe('two\nthree');
});

const input = {
  summary: null,
  exitCode: null,
  log: '',
  sha: '0123456789abcdef',
  base: 'master',
  runUrl: 'https://example.invalid/run/1',
  paths: { '<home>': '/home/me' },
};

test('the answer is the summary when the pass wrote one, with the commit and the run', () => {
  const text = reply({ ...input, summary: '## Profiling: `a` against `b`\n\nNone.\n', exitCode: 0 });
  expect(text).toBe(
    '## Profiling: `a` against `b`\n\nNone.\n\nCommit `012345678` against `master` · [workflow run](https://example.invalid/run/1)\n',
  );
  expect(reply({ ...input, summary: 'S\n', exitCode: 1 })).toContain('The command ended with exit code 1.');
});

test('the answer of a pass without a comparison is why, from the end of its output, without the runner’s paths', () => {
  const refused = reply({ ...input, exitCode: 2, log: 'profiling: port 7870 is in use\n' });
  expect(refused).toContain('## Profiling refused to run');
  expect(refused).toContain('```text\nprofiling: port 7870 is in use\n```');
  const failed = reply({ ...input, exitCode: 1, log: 'vite failed: see /home/me/work/build.log\n```\n' });
  expect(failed).toContain('## Profiling failed');
  expect(failed).toContain('see <home>/work/build.log');
  expect(failed).not.toContain('/home/me');
  expect(failed.match(/```/g)).toHaveLength(2);
  expect(reply(input)).toContain('## Profiling did not start');
});

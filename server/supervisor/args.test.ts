import { expect, test } from 'bun:test';
import { P2P_LOG_LINE, type Profile, type ProfileInput, shellQuote, shellSplit } from '@llama-webui/shared';
import { binaryPath, buildCommand, launchLines, profilePaths } from './args';

const settings = { binary: 'llama-server', host: '0.0.0.0', port: 8080 };
const p = (input: ProfileInput): Profile => ({ ...input, id: 1, source: 'ui', createdAt: 0, updatedAt: 0 });

test('builds argv with pdeathsig and mandatory flags', () => {
  const cmd = buildCommand(
    p({ name: 'q', model: 'm.gguf', mmproj: 'p.gguf', cwd: '~/Models', args: ['-c', '40000'], env: {} }),
    settings,
    '/home/x',
  );
  expect(cmd.argv).toEqual([
    'setpriv',
    '--pdeathsig',
    'KILL',
    '--',
    'llama-server',
    '-m',
    'm.gguf',
    '-mm',
    'p.gguf',
    '-c',
    '40000',
    '-lv',
    '4',
    '--host',
    '0.0.0.0',
    '--port',
    '8080',
    '--metrics',
    '--slots',
    '--props',
  ]);
  expect(cmd.cwd).toBe('/home/x/Models');
  expect(cmd.port).toBe(8080);
  expect(cmd.host).toBe('0.0.0.0');
  expect(cmd.profileName).toBe('q');
  expect(cmd.profileId).toBe(1);
});

test('~ in model and mmproj is expanded for llama-server, which runs without a shell', () => {
  const cmd = buildCommand(
    p({ name: 'q', model: '~/Models/m.gguf', mmproj: '~/Models/p.gguf', args: [], env: {} }),
    settings,
    '/home/x',
  );
  expect(cmd.argv.slice(5, 9)).toEqual(['-m', '/home/x/Models/m.gguf', '-mm', '/home/x/Models/p.gguf']);
  expect(cmd.display).toContain('-m /home/x/Models/m.gguf');
});

test('profilePaths: the files as llama-server opens them, from its cwd, ~ expanded everywhere', () => {
  expect(
    profilePaths({ name: 'q', model: 'm.gguf', mmproj: 'sub/p.gguf', cwd: '~/Models', args: [], env: {} }, '/home/x'),
  ).toEqual({
    cwd: '/home/x/Models',
    model: '/home/x/Models/m.gguf',
    mmproj: '/home/x/Models/sub/p.gguf',
  });
  expect(profilePaths({ name: 'q', model: '~/Models/m.gguf', args: [], env: {} }, '/home/x')).toEqual({
    cwd: process.cwd(),
    model: '/home/x/Models/m.gguf',
    mmproj: null,
  });
  expect(profilePaths({ name: 'q', model: '/abs/m.gguf', cwd: '/elsewhere', args: [], env: {} }, '/home/x').model).toBe(
    '/abs/m.gguf',
  );
});

test('profile port/host override server', () => {
  const cmd = buildCommand(p({ name: 'q', model: 'm', host: '127.0.0.1', port: 8091, args: [], env: {} }), settings);
  expect(cmd.argv.join(' ')).toContain('--host 127.0.0.1 --port 8091');
  expect(cmd.port).toBe(8091);
});

test('display omits setpriv prefix and quotes spaces', () => {
  const cmd = buildCommand(p({ name: 'q', model: 'm.gguf', args: ['--alias', 'a b'], env: {} }), settings);
  expect(cmd.display.startsWith('llama-server -m m.gguf')).toBe(true);
  expect(cmd.display).toContain("'a b'");
});

test('env merges process env with profile env', () => {
  const cmd = buildCommand(p({ name: 'q', model: 'm', args: [], env: { FOO: '1' } }), settings);
  expect(cmd.env.FOO).toBe('1');
  expect(cmd.env.PATH).toBeDefined();
});

test('cwd defaults to process.cwd()', () => {
  const cmd = buildCommand(p({ name: 'q', model: 'm', args: [], env: {} }), settings);
  expect(cmd.cwd).toBe(process.cwd());
});

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

test('adds -lv 4 so the buffer sizes are logged, unless the profile sets a verbosity (#16)', () => {
  const argv = (args: string[], env: Record<string, string> = {}) =>
    buildCommand(p({ name: 'q', model: 'm.gguf', args, env }), settings, '/home/x').argv;
  expect(argv([]).join(' ')).toContain(' -lv 4 --host');
  for (const own of [['-lv', '2'], ['--verbosity', '5'], ['--log-verbosity=1'], ['-v'], ['--verbose']]) {
    expect(argv(own).join(' ')).not.toContain('-lv 4');
  }
  expect(argv([], { LLAMA_ARG_LOG_VERBOSITY: '3' }).join(' ')).not.toContain('-lv 4');
});

test('the binary setting is run with ~ expanded (#32)', () => {
  expect(binaryPath({ binary: '~/llama.cpp/build/bin/llama-server' }, '/home/x')).toBe(
    '/home/x/llama.cpp/build/bin/llama-server',
  );
  expect(binaryPath({ binary: 'llama-server' }, '/home/x')).toBe('llama-server');
  const cmd = buildCommand(
    p({ name: 'q', model: 'm.gguf', args: [], env: {} }),
    { ...settings, binary: '~/b/llama-server' },
    '/home/x',
  );
  expect(cmd.argv[4]).toBe('/home/x/b/llama-server');
});

test('launchLines: the launch line, plus the peer-to-peer one when GGML_CUDA_P2P is set, whatever its value', () => {
  const plain = buildCommand(p({ name: 'q', model: 'm.gguf', args: [], env: {} }), settings);
  // The variable may come from llama-webui's own environment: the test must not depend on it.
  delete plain.env.GGML_CUDA_P2P;
  expect(launchLines(plain)).toEqual([`[llama-webui] launch: ${plain.display}`]);
  // llama.cpp only checks that the variable exists: an empty value enables it too.
  for (const value of ['1', '0', '']) {
    const cmd = buildCommand(p({ name: 'q', model: 'm.gguf', args: [], env: { GGML_CUDA_P2P: value } }), settings);
    expect(launchLines(cmd)).toEqual([`[llama-webui] launch: ${cmd.display}`, P2P_LOG_LINE]);
  }
});

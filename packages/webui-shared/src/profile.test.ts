import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import { issuesOf } from './api/errors.ts';
import { ProfileInput, parseProfileImport, STRICT } from './profile.ts';

const decode = Schema.decodeUnknownResult(ProfileInput, STRICT);

/** The issues of an input that must not decode. */
const issues = (input: unknown) => {
  const result = decode(input);
  if (Result.isSuccess(result)) throw new Error('expected the input to be refused');
  return issuesOf(result.failure.issue);
};

test('llama-tui import: whole config', async () => {
  const raw = JSON.parse(await readFile(join(import.meta.dirname, '../../../testdata/llama-tui-config.json'), 'utf8'));
  const r = parseProfileImport(raw);
  expect(r.profiles.map((p) => p.name)).toEqual(['qwen3.8-27b-mtp', 'qwen3.8-27b-mtp (optimisé) (optimisé)']);
  expect(r.rejected).toEqual([]);
});

test('import: valid ones kept, invalid ones explained', () => {
  const r = parseProfileImport({
    profiles: [
      { name: 'ok', model: 'm.gguf' },
      { name: 'no-model' },
      { name: 'reserved', model: 'm.gguf', args: ['--port', '9000'] },
      { name: 'ok', model: 'other.gguf' },
    ],
  });
  expect(r.profiles.map((p) => p.name)).toEqual(['ok']);
  expect(r.rejected.map((x) => x.name)).toEqual(['no-model', 'reserved', 'ok']);
  expect(r.rejected[0]?.reason).toBe('required (model)');
  expect(r.rejected[1]?.reason).toBe('--port is managed by llama-webui (use the profile fields) (args.0)');
  expect(r.rejected[2]?.reason).toBe('duplicate name in the file');
});

test('import: single profile and array', () => {
  expect(parseProfileImport({ name: 'a', model: 'm' }).profiles).toHaveLength(1);
  expect(
    parseProfileImport([
      { name: 'a', model: 'm' },
      { name: 'b', model: 'm' },
    ]).profiles,
  ).toHaveLength(2);
});

test('ProfileInput: a missing or empty name or model says so', () => {
  expect(issues({})).toEqual([
    { path: ['name'], message: 'required' },
    { path: ['model'], message: 'required' },
  ]);
  expect(issues({ name: '', model: 3 })).toEqual([
    { path: ['name'], message: 'cannot be empty' },
    { path: ['model'], message: 'required' },
  ]);
});

test('ProfileInput: the port is an integer from 1 to 65535', () => {
  const at = (port: unknown) => issues({ name: 'a', model: 'm', port });
  expect(at(0)).toEqual([{ path: ['port'], message: 'port between 1 and 65535' }]);
  expect(at(65536)).toEqual([{ path: ['port'], message: 'port between 1 and 65535' }]);
  expect(at(1.5)).toEqual([{ path: ['port'], message: 'expected an integer' }]);
  expect(at('80')).toEqual([{ path: ['port'], message: 'expected a number' }]);
  for (const port of [1, 65535])
    expect(Result.isSuccess(decode({ name: 'a', model: 'm', port })), `${port}`).toBe(true);
});

test('ProfileInput: a reserved flag is refused where it stands, in both forms', () => {
  expect(issues({ name: 'a', model: 'm', args: ['-c', '4096', '--host=0.0.0.0', '-m', 'x'] })).toEqual([
    { path: ['args', '2'], message: '--host is managed by llama-webui (use the profile fields)' },
    { path: ['args', '3'], message: '-m is managed by llama-webui (use the profile fields)' },
  ]);
});

test('ProfileInput: an unknown key is refused, so a stored profile is not an input', () => {
  expect(issues({ name: 'a', model: 'm', id: 1 })).toEqual([{ path: ['id'], message: 'unknown key' }]);
});

test('ProfileInput: args and env default to empty, an absent optional field stays absent', () => {
  const result = decode({ name: 'a', model: 'm' });
  expect(result).toEqual(Result.succeed({ name: 'a', model: 'm', args: [], env: {} }));
  expect(Result.isSuccess(result) && 'mmproj' in result.success).toBe(false);
});

test('import: a body that holds no profile is one skip, an item that is not an object is explained', () => {
  const none = { profiles: [], rejected: [{ name: '(file)', reason: 'no profile found in this JSON' }] };
  for (const raw of [null, 3, 'x', {}, { profiles: 'x' }])
    expect(parseProfileImport(raw), JSON.stringify(raw)).toEqual(none);
  const r = parseProfileImport([3, { name: 'a' }]);
  expect(r.profiles).toEqual([]);
  expect(r.rejected).toEqual([
    { name: '(unnamed)', reason: 'Expected object' },
    { name: 'a', reason: 'required (model)' },
  ]);
  const twice = parseProfileImport([
    { name: 'a', model: 'm' },
    { name: 'a', model: 'n' },
  ]);
  expect(twice.profiles.map((p) => p.model)).toEqual(['m']);
  expect(twice.rejected).toEqual([{ name: 'a', reason: 'duplicate name in the file' }]);
});

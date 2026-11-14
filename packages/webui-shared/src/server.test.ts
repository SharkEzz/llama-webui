import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import { SeqParam } from './api/params.ts';
import { activeProfileId, ServerState, serverView } from './server.ts';

const running = { profile: 'qwen', profileId: 2, pid: 10, host: '127.0.0.1', port: 9000 } as const;
const crashed: ServerState = {
  kind: 'crashed',
  profile: 'qwen',
  profileId: 2,
  exitCode: 1,
  signal: null,
  at: 1_700_000_000_000,
};

test('activeProfileId is the profile while starting, ready or stopping, null otherwise', () => {
  expect(activeProfileId({ kind: 'starting', ...running, since: 1 })).toBe(2);
  expect(activeProfileId({ kind: 'ready', ...running, since: 1 })).toBe(2);
  expect(activeProfileId({ kind: 'stopping', ...running })).toBe(2);
  expect(activeProfileId({ kind: 'idle' })).toBeNull();
  expect(activeProfileId(crashed)).toBeNull();
  expect(activeProfileId({ kind: 'external', pid: 7, port: 8080 })).toBeNull();
});

test('serverView: the profile of the state, else of the last command, else null; the command survives a stop', () => {
  const last = { display: 'x', profileId: 4 };
  expect(serverView({ state: { kind: 'idle' }, last })).toEqual({
    state: { kind: 'idle' },
    command: 'x',
    profileId: 4,
  });
  expect(serverView({ state: crashed, last })).toEqual({ state: crashed, command: 'x', profileId: 2 });
  const external: ServerState = { kind: 'external', pid: null, port: 8080 };
  expect(serverView({ state: external, last: null })).toEqual({ state: external, command: null, profileId: null });
});

test('a crashed state without a message encodes without the key', () => {
  const encoded = Schema.encodeResult(ServerState)(crashed);
  expect(encoded).toEqual(Result.succeed(crashed));
  expect(Result.map(encoded, (state) => 'message' in state)).toEqual(Result.succeed(false));
});

test('SeqParam reads 0 and 12, refuses -1, 1.5, "abc" and ""', () => {
  const decode = Schema.decodeUnknownResult(SeqParam);
  expect(decode('0')).toEqual(Result.succeed(0));
  expect(decode('12')).toEqual(Result.succeed(12));
  for (const input of ['-1', '1.5', 'abc', '']) expect(Result.isFailure(decode(input)), input).toBe(true);
});

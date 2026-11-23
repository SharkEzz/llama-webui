import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import { SeqParam } from './api/params.ts';
import {
  activeProfileId,
  isServerLoading,
  isServerSleeping,
  loadProgressPct,
  loadStageLabel,
  ServerState,
  serverView,
  stateLoadProgress,
} from './server.ts';

const running = { profile: 'qwen', profileId: 2, pid: 10, host: '127.0.0.1', port: 9000 } as const;
const crashed: ServerState = {
  kind: 'crashed',
  profile: 'qwen',
  profileId: 2,
  exitCode: 1,
  signal: null,
  at: 1_700_000_000_000,
};

test('activeProfileId is the profile while starting, ready, sleeping or stopping, null otherwise', () => {
  expect(activeProfileId({ kind: 'starting', ...running, since: 1 })).toBe(2);
  expect(activeProfileId({ kind: 'ready', ...running, since: 1 })).toBe(2);
  expect(activeProfileId({ kind: 'sleeping', ...running, since: 1 })).toBe(2);
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

test('loadProgressPct combines stages and clamps values, loadStageLabel maps known stages', () => {
  expect(loadProgressPct({ stages: ['text_model'], current: 'text_model', value: 0.42 })).toBeCloseTo(42);
  expect(loadProgressPct({ stages: ['text_model', 'mmproj_model'], current: 'text_model', value: 0.5 })).toBeCloseTo(
    25,
  );
  expect(loadProgressPct({ stages: ['text_model', 'mmproj_model'], current: 'mmproj_model', value: null })).toBeCloseTo(
    50,
  );
  expect(loadProgressPct({ stages: [], current: 'text_model', value: 1.5 })).toBe(100);
  expect(loadProgressPct({ stages: [], current: 'mmproj_model', value: null })).toBeNull();
  expect(loadStageLabel('text_model')).toBe('Model');
  expect(loadStageLabel('spec_model')).toBe('Draft model');
  expect(loadStageLabel('mmproj_model')).toBe('Projector');
  expect(loadStageLabel('custom_stage')).toBe('custom_stage');
});

test('loadStageLabel displays stages that match inherited object keys verbatim', () => {
  expect(loadStageLabel('constructor')).toBe('constructor');
  expect(loadStageLabel('toString')).toBe('toString');
  expect(loadStageLabel('__proto__')).toBe('__proto__');
});

test('loading and sleeping helpers handle managed and external states', () => {
  const progress = { stages: ['text_model'], current: 'text_model', value: 0.3 };
  const starting: ServerState = { kind: 'starting', ...running, since: 1, progress };
  const sleeping: ServerState = { kind: 'sleeping', ...running, since: 2 };
  const extLoading: ServerState = { kind: 'external', pid: 7, port: 8080, status: 'loading', progress };
  const extSleeping: ServerState = { kind: 'external', pid: 7, port: 8080, status: 'sleeping' };
  expect(isServerLoading(starting)).toBe(true);
  expect(isServerLoading(extLoading)).toBe(true);
  expect(isServerLoading(sleeping)).toBe(false);
  expect(isServerSleeping(sleeping)).toBe(true);
  expect(isServerSleeping(extSleeping)).toBe(true);
  expect(stateLoadProgress(starting)).toEqual(progress);
  expect(stateLoadProgress(extLoading)).toEqual(progress);
  expect(stateLoadProgress(extSleeping)).toBeNull();
  expect(Schema.encodeResult(ServerState)(sleeping)).toEqual(Result.succeed(sleeping));
  expect(Schema.encodeResult(ServerState)(extLoading)).toEqual(Result.succeed(extLoading));
});

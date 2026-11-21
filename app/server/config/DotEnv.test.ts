import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect, test } from 'vitest';
import { applyDotEnv, loadDotEnv } from './DotEnv.ts';

/** `.env` text applied over an environment that sets `LW_ENV_B` (and `extra`): what `LW_ENV_A` and `LW_ENV_B` become. */
const apply = (text: string, options?: { override?: boolean }, extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { LW_ENV_B: 'from-env', ...extra };
  applyDotEnv(env, text, options);
  return [env.LW_ENV_A, env.LW_ENV_B];
};

describe('applyDotEnv', () => {
  test('applyDotEnv: the file fills what the environment lacks, a variable already set wins', () => {
    expect(apply('LW_ENV_A=from-file\nLW_ENV_B=from-file\n')).toEqual(['from-file', 'from-env']);
  });

  test('applyDotEnv: { override: true } (--env-override) lets the file override the environment', () => {
    expect(apply('LW_ENV_B=from-file\n', { override: true })).toEqual([undefined, 'from-file']);
  });

  test('applyDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=1 in the environment lets the file override it', () => {
    expect(apply('LW_ENV_A=from-file\nLW_ENV_B=from-file\n', {}, { LLAMA_WEBUI_ENV_OVERRIDE: '1' })).toEqual([
      'from-file',
      'from-file',
    ]);
  });

  test('applyDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=true in the file itself lets it override the environment', () => {
    expect(apply('LLAMA_WEBUI_ENV_OVERRIDE=true\nLW_ENV_B=from-file\n')).toEqual([undefined, 'from-file']);
  });

  test('applyDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=0 keeps the environment', () => {
    expect(apply('LW_ENV_B=from-file\n', {}, { LLAMA_WEBUI_ENV_OVERRIDE: '0' })).toEqual([undefined, 'from-env']);
  });

  it.effect('loadDotEnv: no file, nothing happens', () =>
    // Every read of the no-op file system fails with NotFound.
    loadDotEnv({ override: true }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({}))),
  );
});
